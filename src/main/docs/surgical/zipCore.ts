/* ============================================================
 * 手术式文档编辑 · 通用 zip 读写层（基于 JSZip）
 * 纪律：本目录所有 Core 不 import electron，可进无头测试。
 * 保真口径：未修改条目以原解压字节原样回填（Buffer 引用不动），
 * 只有被手术命中的条目替换为新内容。
 * ============================================================ */

import JSZip from 'jszip'

/** 各格式 Core 的 apply 内部结果（IPC 层再包装成 shared 的 SurgicalApplyResult） */
export interface CoreApplyResult {
  changed: number
  skipped: Array<{ id: string; reason: string }>
  /** 修改后的 entries（没有任何修改时为 null，调用方无需写回） */
  entries: Map<string, Buffer | string> | null
}

/** 读取 zip，返回 条目名 → 解压内容（nodebuffer）的有序 Map（不含目录条目） */
export async function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  const zip = await JSZip.loadAsync(buf)
  const out = new Map<string, Buffer>()
  for (const name of Object.keys(zip.files)) {
    const f = zip.files[name]
    if (f.dir) continue
    out.set(name, await f.async('nodebuffer'))
  }
  return out
}

/** 重新打包：未修改条目原 Buffer 原样放入，修改条目可为 string 或新 Buffer */
export async function writeZip(entries: Map<string, Buffer | string>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, data] of entries) zip.file(name, data as string | Buffer)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}

/** 条目文本（utf8）。条目不存在返回 null */
export function entryText(entries: Map<string, Buffer>, name: string): string | null {
  const b = entries.get(name)
  return b == null ? null : b.toString('utf8')
}

/** 生成替换了某个条目文本的新 entries 映射（其余条目引用原 Buffer，一字节不动） */
export function withEntryText(
  entries: Map<string, Buffer>,
  name: string,
  text: string
): Map<string, Buffer | string> {
  const out = new Map<string, Buffer | string>()
  for (const [k, v] of entries) out.set(k, k === name ? text : v)
  return out
}
