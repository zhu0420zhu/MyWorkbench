/**
 * 文本页 → Markdown（从 pdfRender.ts 拆出：markdown 组装不依赖 pdf.js，
 * 供面板与无头验收直接使用；pdfRender.ts 原地 re-export 保持既有导入不变）。
 */

export interface PdfTextPage {
  pageIndex: number
  lines: string[]
}

/** 文本页 → Markdown（简单标题/列表启发式） */
export function pagesToMarkdown(pages: PdfTextPage[], sourceName: string): string {
  const out: string[] = [`# ${sourceName.replace(/\.pdf$/i, '')}`, '']
  for (const p of pages) {
    out.push(`## 第 ${p.pageIndex + 1} 页`, '')
    for (const line of p.lines) {
      if (/^\d+[.、)]\s*/.test(line) || /^[-*•]\s*/.test(line)) {
        out.push(`- ${line.replace(/^[-*•]\s*/, '')}`)
      } else if (line.length <= 40 && /[：:]\s*$/.test(line) === false && p.lines.indexOf(line) < 3) {
        out.push(`### ${line}`)
      } else {
        out.push(line)
      }
      out.push('')
    }
    out.push('---', '')
  }
  return out.join('\n')
}
