/**
 * QA 探针（渲染进程入口）——「PDF 就地编辑 → 保存」真实运行期验证。
 *
 * 这一次不是 node 无头复跑，而是把**生产模块**放进真实 Chromium：
 *   - `replacePdfText` 走真实渲染进程（canvas 是 Chromium 原生 canvas，不是 @napi-rs 替身）；
 *   - 读 / 写盘一律经 `window.api.pdf.*`（真实 preload + 真实 ipcMain 处理器 + 真实 pathAcl）。
 *
 * 目的：补齐此前报告中明确标注为「静态核验」的缺口 —— 通道名一致 ≠ 运行期真的能跑通，
 * 尤其是 pdf:read / pdf:write 前置的路径白名单（pathAcl）只有运行期才知道会不会把写盘挡掉。
 */
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { replacePdfText } from '../../../../src/renderer/src/utils/pdfInPlaceReplace'

declare const window: Window & {
  api: { pdf: Record<string, (...a: unknown[]) => Promise<unknown>> }
  __PROBE_CFG__: {
    docPath: string
    backupPath: string
    backupElsewherePath: string
    saveAsTarget: string
    unauthorizedPath: string
  }
  __probeRun: () => Promise<unknown>
}

interface Row {
  name: string
  pass: boolean
  detail: string
}
const rows: Row[] = []
const ok = (name: string, pass: boolean, detail = ''): void => {
  rows.push({ name, pass, detail })
}
const info = (m: string): void => {
  rows.push({ name: '· ' + m, pass: true, detail: '' })
}

/** 与 node 侧无关的纯 JS 校验和，用于跨进程比对字节（renderer 无 node:crypto） */
function checksum(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < bytes.length; i++) {
    h1 = (h1 ^ bytes[i]) >>> 0
    h1 = Math.imul(h1, 16777619) >>> 0
    h2 = (h2 + Math.imul(bytes[i], i + 1)) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

const CJK = '合同金额已复核：￥12,345.67 元（中文栅格路径）'

window.__probeRun = async (): Promise<unknown> => {
  const cfg = window.__PROBE_CFG__
  const api = window.api?.pdf as Record<string, (...a: unknown[]) => Promise<unknown>>

  /* ---- 1. 真实 preload 面：生产编辑器依赖的方法必须都在 ---- */
  for (const m of ['read', 'write', 'savePath', 'pickDir', 'exists', 'pickPdfs']) {
    ok(`preload 暴露 api.pdf.${m}`, typeof api[m] === 'function', typeof api[m])
  }
  ok('渲染进程是真实 Chromium canvas（非 @napi-rs 替身）', typeof document.createElement('canvas').getContext === 'function')

  /* ---- 2. 经真实 pdf:pick-pdfs 处理器登记路径（对话框在 main 侧被打桩） ---- */
  const picked = (await api.pickPdfs()) as { path: string; name: string; size: number }[]
  ok('pdf:pick-pdfs 返回素材（主进程真实走完 allowPath 登记）', Array.isArray(picked) && picked.length === 1 && picked[0].size > 0, JSON.stringify(picked))
  if (!Array.isArray(picked) || !picked.length) return { rows, fatal: 'pickPdfs 未返回素材' }
  const pickedPath = picked[0].path
  ok('pick-pdfs 返回的路径与探针约定一致', pickedPath === cfg.docPath, `${pickedPath} vs ${cfg.docPath}`)

  /* ---- 3. pdf:read（白名单内的路径必须可读） ---- */
  const before = (await api.read(pickedPath)) as Uint8Array | null
  ok('pdf:read 在已登记路径上返回字节（ACL 放行）', !!before && before.byteLength > 0, before ? `${before.byteLength} B` : 'null')
  if (!before) return { rows, fatal: 'pdf:read 返回 null' }
  const beforeSum = checksum(before)
  const parsed = await PDFDocument.load(before)
  const pageCount = parsed.getPageCount()
  ok('素材经 pdf-lib 可解析且页数为 3', pageCount === 3, String(pageCount))

  /* ---- 4. 生产 replacePdfText：真实 Chromium 下做中文替换 + 高亮 ---- */
  const rep = {
    page: 1,
    rect: { x: 60, y: 748, width: 320, height: 22 },
    baseline: 755,
    fontSize: 14,
    color: { r: 0, g: 0, b: 0 },
    bgColor: { r: 1, g: 1, b: 1 },
    align: 'left' as const,
    newText: CJK
  }
  const anno = { page: 0, rect: { x: 60, y: 688, width: 300, height: 18 }, kind: 'highlight' as const, color: { r: 1, g: 0.9, b: 0 }, opacity: 0.35 }
  let edited: Uint8Array | null = null
  let thrown = ''
  try {
    edited = await replacePdfText(before, [rep], [anno])
  } catch (e) {
    thrown = (e as Error).message
  }
  ok('replacePdfText 在真实渲染进程内不抛异常', !thrown, thrown)
  if (!edited) return { rows, fatal: 'replacePdfText 未产出' }
  const editedSum = checksum(edited)
  ok('产出字节与输入不同（确实写了东西）', editedSum !== beforeSum, `${beforeSum} → ${editedSum}`)
  const outDoc = await PDFDocument.load(edited)
  ok('产出页数不变', outDoc.getPageCount() === 3, String(outDoc.getPageCount()))

  /* 中文栅格路径应在真实 canvas 下新增 Image XObject（证明栅格渲染真的跑通了） */
  const countImages = (doc: PDFDocument): number => {
    let n = 0
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue
      const sub = obj.dict.get(PDFName.of('Subtype'))
      if (sub?.toString() === '/Image') n++
    }
    return n
  }
  const imgIn = countImages(parsed)
  const imgOut = countImages(outDoc)
  ok('中文栅格路径在真实渲染进程内新增 Image XObject', imgOut > imgIn, `输入 ${imgIn} → 输出 ${imgOut}`)
  ok('产出仍可被 pdf-lib 解析（结构未损坏）', true, `${edited.byteLength} B`)

  /* ---- 5. 覆盖保存：pdf:write 写回原路径 ---- */
  const okWrite = (await api.write(cfg.docPath, edited)) as boolean
  ok('pdf:write 写回原文件返回 true（真实 ACL 放行同路径）', okWrite === true, String(okWrite))

  /* ---- 6. 备份写盘：同目录不同名（生产「覆盖保存」的前置步骤） ---- */
  const okBk = (await api.write(cfg.backupPath, before)) as boolean
  ok('备份写到同目录不同名 → 允许（ACL 同目录产物规则生效）', okBk === true, String(okBk))

  /* ---- 7. 反例：不同目录的备份必须被拒（证明上一条不是空转） ---- */
  const okBkOut = (await api.write(cfg.backupElsewherePath, before)) as boolean
  ok('备份写到【其它目录】→ 被拒（反例：ACL 不是全放行）', okBkOut === false, String(okBkOut))

  /* ---- 8. 反例：从未登记过的路径 --- */
  const okUn = (await api.write(cfg.unauthorizedPath, before)) as boolean
  ok('从未登记过的路径写入 → 被拒', okUn === false, String(okUn))
  const existsUn = (await api.exists([cfg.unauthorizedPath])) as boolean[]
  ok('未登记路径 pdf:exists 恒返回 false（不泄露文件系统信息）', existsUn[0] === false, JSON.stringify(existsUn))

  /* ---- 9. 另存为：savePath 登记 → write 成功 ---- */
  const target = (await api.savePath('QA-已编辑.pdf', ['pdf'])) as string | null
  ok('pdf:save-path 返回用户选定路径', target === cfg.saveAsTarget, String(target))
  if (target) {
    const okSaveAs = (await api.write(target, edited)) as boolean
    ok('另存为写入返回 true', okSaveAs === true, String(okSaveAs))
  }

  /* ---- 10. 回读覆盖后的原文件：内容必须真的变了（反驳「保存没改变」） ---- */
  const after = (await api.read(cfg.docPath)) as Uint8Array | null
  ok('覆盖后回读原文件成功', !!after && after.byteLength > 0, after ? `${after.byteLength} B` : 'null')
  if (after) {
    ok('回读字节 == 写入字节（落盘未被截断/改写）', checksum(after) === editedSum, `${checksum(after)} vs ${editedSum}`)
    ok('回读字节 != 编辑前字节（保存确实改变了文件）', checksum(after) !== beforeSum)
  }

  /* ---- 11. 观察项（非缺陷判定）：同目录规则的授权面到底有多宽 ----
   * pathAcl 的「同目录产物」规则是「只要目录里存在任一已授权路径，整个目录放行」。
   * 这里实测它对一个与业务无关的任意文件名是否也放行，作为安全面观察上报。 */
  const arbitraryName = cfg.docPath.replace(/[^\\/]+$/, 'QA-ARBITRARY-NOT-A-PDF.txt')
  const okArb = (await api.write(arbitraryName, new TextEncoder().encode('arbitrary'))) as boolean
  info(`观察：同目录下的任意文件名写入返回 ${okArb}（ACL「同目录」规则的授权面）`)

  return {
    rows,
    beforeSum,
    editedSum,
    beforeLen: before.byteLength,
    editedLen: edited.byteLength,
    docPath: cfg.docPath,
    backupPath: cfg.backupPath,
    backupElsewherePath: cfg.backupElsewherePath,
    saveAsTarget: cfg.saveAsTarget,
    unauthorizedPath: cfg.unauthorizedPath
  }
}
