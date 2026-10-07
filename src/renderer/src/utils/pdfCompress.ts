/**
 * 结构压缩（非栅格化）—— 三档真实分化的实现。
 *
 * 背景（审计 P1#4）：旧实现只切 pdf-lib 的 `useObjectStreams`：
 *   - 「低」档 `useObjectStreams:false` 会把小对象平铺，实测 1948B → 3135B（+60.9%），
 *     用户选「低压缩」反而拿到更大的文件；
 *   - 「中」「高」走同一分支，产出**逐字节相同**，三档 UI 实际只有两种行为。
 *
 * 现改为三档各自对应一组真实、可验证的动作，压缩强度严格递增：
 *   低 —— 重建页面结构（对象流 + 交叉引用流重写），**保留源文档元数据**；
 *   中 —— 在「低」基础上**清空文档元数据**（Info 各字段 + 文件标识 /ID + XMP）；
 *   高 —— 在「中」基础上**移除页面外冗余**（无外观的链接注释、不可达对象）。
 *
 * 为什么是「重建页面」而不是原地重存：pdf-lib 原地重存会连同输入的**全部文档级对象**
 * 一起保留。实测 `real-large-plain.pdf`（565444B，含 4635 个无障碍 StructElem）：
 *   - 原地 `save({useObjectStreams:true})` → 579879B（+2.6%，不减反增）；
 *   - 重建页面后 → 444293B（−21.4%）。
 *
 * 边界（必须如实告知用户）：
 *   - 重建会丢弃**无障碍标签结构（StructTree）、书签大纲、页面标签、附件**等页面外数据；
 *   - 页面的**可见内容、页尺寸、旋转、裁剪框**均保留；
 *   - 携带可见外观的注释（批注 / 图章 / 表单域）保留，只清除**无外观**的链接热区；
 *   - 本模块**不重采样图片**。图像主导的文件结构压缩收益很小，请用「图像化强压缩」。
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib'

export type CompressLevel = 'low' | 'medium' | 'high'

/** 本次结构压缩实际做了什么，用于 UI 如实回显 */
export interface StructureCompressStats {
  /** 产出不小于原文件，已保留原文件（不输出更大的文件） */
  keptOriginal: boolean
  /** 是否清空了文档元数据（中 / 高） */
  metadataCleared: boolean
  /** 移除的无外观链接注释数（高） */
  droppedLinkAnnots: number
  /** 剪除的不可达对象数（高） */
  prunedObjects: number
  /** 重建结果未通过健康检查、已退回未剪枝版本（正常为 false） */
  unsafeFallback: boolean
}

export interface StructureCompressResult {
  bytes: Uint8Array
  stats: StructureCompressStats
}

/** 清空文档元数据：Info 各字段、文件标识 /ID、XMP 元数据流。 */
function stripMetadata(doc: PDFDocument): void {
  const trailer = doc.context.trailerInfo as { Info?: unknown; ID?: unknown }
  delete trailer.Info
  delete trailer.ID
  try {
    doc.catalog.delete(PDFName.of('Metadata'))
  } catch {
    /* 没有 XMP 流时忽略 */
  }
}

/** 把源文档的可读元数据抄到新文档（“低”档保留元数据用）。 */
function copyMetadata(src: PDFDocument, dst: PDFDocument): void {
  try {
    const title = src.getTitle()
    if (title) dst.setTitle(title)
    const author = src.getAuthor()
    if (author) dst.setAuthor(author)
    const subject = src.getSubject()
    if (subject) dst.setSubject(subject)
    const keywords = src.getKeywords()
    if (keywords) dst.setKeywords(keywords.split(',').map((k) => k.trim()).filter(Boolean))
    const creator = src.getCreator()
    if (creator) dst.setCreator(creator)
    const producer = src.getProducer()
    if (producer) dst.setProducer(producer)
    const created = src.getCreationDate()
    if (created) dst.setCreationDate(created)
    const modified = src.getModificationDate()
    if (modified) dst.setModificationDate(modified)
  } catch {
    /* 元数据异常不影响压缩主流程 */
  }
}

/**
 * 剪除从 catalog / Info 不可达的间接对象。
 *
 * 重建后的文档理论上应全部可达，但 pdf-lib 的 copyPages 会留下少量悬挂引用
 * （实测每份样本稳定剪掉 1 个），且输入里的孤立对象也会被一并清掉。
 */
function pruneUnreachableObjects(doc: PDFDocument): number {
  const ctx = doc.context
  const seen = new Set<unknown>()
  const stack: unknown[] = [doc.catalog]
  if (ctx.trailerInfo.Info) stack.push(ctx.trailerInfo.Info)
  const walk = (v: unknown): void => {
    if (!v) return
    if (v instanceof PDFRef) {
      const resolved = ctx.lookup(v)
      if (resolved) stack.push(resolved)
      return
    }
    if (v instanceof PDFDict) {
      for (const [, val] of v.entries()) walk(val)
      return
    }
    if (v instanceof PDFArray) {
      for (const item of v.asArray()) walk(item)
      return
    }
    // 流对象：只关心它的字典
    const dict = (v as { dict?: unknown }).dict
    if (dict instanceof PDFDict) walk(dict)
  }
  while (stack.length) {
    const obj = stack.pop()
    if (!obj || seen.has(obj)) continue
    seen.add(obj)
    walk(obj)
  }
  let removed = 0
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(obj)) {
      ctx.delete(ref)
      removed++
    }
  }
  return removed
}

/**
 * 移除**无外观**的链接注释（/Link 且没有 /AP 外观流）。
 * 这类注释只是跳转热区，不参与绘制，删掉不改变页面像素，却常带 /A 动作与 URI 字符串。
 * 带 /AP 的链接（例如被高亮绘制的可点击区域）**保留**，避免动到可见内容。
 */
function dropLinkAnnots(doc: PDFDocument): number {
  let removed = 0
  for (const page of doc.getPages()) {
    const annots = page.node.get(PDFName.of('Annots'))
    if (!(annots instanceof PDFArray)) continue
    const items = annots.asArray()
    const kept = items.filter((item) => {
      const obj = item instanceof PDFRef ? doc.context.lookup(item) : item
      if (!(obj instanceof PDFDict)) return true
      const subtype = obj.get(PDFName.of('Subtype'))?.toString()
      const hasAppearance = !!obj.get(PDFName.of('AP'))
      if (subtype === '/Link' && !hasAppearance) {
        removed++
        return false
      }
      return true
    })
    if (kept.length === items.length) continue
    items.length = 0
    for (const k of kept) annots.push(k)
    if (!kept.length) page.node.delete(PDFName.of('Annots'))
  }
  return removed
}

/** 用「新建文档 + 逐页复制」重建页面结构，丢弃页面外对象。 */
async function rebuildPages(src: PDFDocument): Promise<PDFDocument> {
  const out = await PDFDocument.create()
  const copied = await out.copyPages(src, src.getPageIndices())
  for (const page of copied) out.addPage(page)
  return out
}

/**
 * 两种压缩模式（结构压缩 / 图像化压缩）共用的输出兜底策略：
 * **产出不得大于原文件**。产出 ≥ 原文件时返回原文件并置 `keptOriginal`，
 * 由 UI 如实说明「本档无收益」，绝不把一个更大的文件交给用户。
 *
 * 同一政策必须只有一处实现——两处各写一遍必然分叉（历史上就出现过
 * 低档把 1948B 的文件压成 3135B 的事故）。
 */
export function keepSmallerOutput(
  original: Uint8Array,
  produced: Uint8Array
): { bytes: Uint8Array; keptOriginal: boolean } {
  if (produced.byteLength >= original.byteLength) return { bytes: original, keptOriginal: true }
  return { bytes: produced, keptOriginal: false }
}

/** 产出健康检查：必须能重新解析且页数一致，否则不采用。 */
async function isHealthy(pdf: Uint8Array, expectedPages: number): Promise<boolean> {
  try {
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: true })
    return doc.getPageCount() === expectedPages
  } catch {
    return false
  }
}

/**
 * 按档位做结构压缩。**任何档位都不会输出比原文件更大的结果**：
 * 若产出 ≥ 原文件，返回原文件并置 `keptOriginal`，由 UI 如实说明「本档无收益」。
 */
export async function structureCompressPdf(
  bytes: Uint8Array,
  level: CompressLevel
): Promise<StructureCompressResult> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const pageCount = src.getPageCount()
  const original = bytes.slice()

  const stats: StructureCompressStats = {
    keptOriginal: false,
    metadataCleared: false,
    droppedLinkAnnots: 0,
    prunedObjects: 0,
    unsafeFallback: false
  }

  const build = async (aggressive: boolean): Promise<Uint8Array> => {
    const out = await rebuildPages(src)
    if (level === 'low') copyMetadata(src, out)
    else {
      stripMetadata(out)
    }
    if (aggressive) {
      stats.droppedLinkAnnots = dropLinkAnnots(out)
      stats.prunedObjects = pruneUnreachableObjects(out)
    }
    return out.save({ useObjectStreams: true, addDefaultPage: false })
  }

  const aggressive = level === 'high'
  let outBytes = await build(aggressive)
  if (aggressive && !(await isHealthy(outBytes, pageCount))) {
    // 剪枝/去链接把文档弄坏了 → 退回不做激进行动的版本，并如实标记
    stats.unsafeFallback = true
    stats.droppedLinkAnnots = 0
    stats.prunedObjects = 0
    outBytes = await build(false)
  }
  stats.metadataCleared = level !== 'low'

  // 兜底：产出坏了（不可解析 / 页数变了）或比原文件大，都不采用
  if (!(await isHealthy(outBytes, pageCount))) {
    return { bytes: original, stats: { ...stats, keptOriginal: true } }
  }
  const picked = keepSmallerOutput(original, outBytes)
  if (picked.keptOriginal) return { bytes: picked.bytes, stats: { ...stats, keptOriginal: true } }
  return { bytes: picked.bytes, stats }
}
