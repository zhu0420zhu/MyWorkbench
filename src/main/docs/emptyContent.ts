/* ============================================================
 * 「另存为」内容判空：纯函数，不依赖 electron，可被 node --experimental-strip-types 直接加载。
 *
 * 背景：docs:save-as-format 的 pdf 分支原本不做任何内容校验，
 * content 为空串 / 纯空白（或只有标签壳，如 '<p><br></p>'）时，
 * soffice 仍会转换出一份**合法但完全空白**的 PDF 并返回 ok:true。
 * ============================================================ */

/** 命名实体：空白类还原成空格，转义类还原成原字符 */
const NAMED_ENTITIES: Record<string, string | undefined> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' '
}

/** 数字实体还原：码点属于空白则统一为空格，否则还原为原字符 */
function fromCodePointOrSpace(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return ' '
  let ch: string
  try {
    ch = String.fromCodePoint(cp)
  } catch {
    return ' '
  }
  return /\s/.test(ch) ? ' ' : ch
}

/** HTML → 可见文本（只保留「看得见」的内容，用于判空） */
export function htmlToVisibleText(html: string): string {
  return (
    html
      // 1. 整段去掉 <script> / <style>
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      // 2. 去掉 HTML 注释
      .replace(/<!--[\s\S]*?-->/g, '')
      // 3. 去掉所有标签（<br>、<br/>、<p> 等自然消失）
      .replace(/<[^>]*>/g, '')
      // 4. 命名实体
      .replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
      // 5. 数字实体（&#160; / &#xa0; 等），空白类归为空格
      .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => fromCodePointOrSpace(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_m, dec: string) => fromCodePointOrSpace(parseInt(dec, 10)))
  )
}

/**
 * 判断待导出内容是否「实质为空」。
 *
 * - source === 'text'：trim() 为空即视为空。
 * - source === 'html'：不能只看 trim()——'<p><br></p>'、'<div>&nbsp;</div>'、
 *   '<p>  </p>'、'<p>&#160;</p>' 的 trim() 都非空，但渲染出来完全空白，
 *   照样会产出空白 PDF，故先剥离标签与实体再判空。
 */
export function isEffectivelyEmptyContent(source: 'text' | 'html', content: string): boolean {
  if (typeof content !== 'string') return true
  if (source === 'text') return content.trim() === ''
  return htmlToVisibleText(content).trim() === ''
}
