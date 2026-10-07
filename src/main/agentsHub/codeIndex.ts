/**
 * 代码索引：符号/引用图谱（EvoFlow B2 精简版）
 * 扫描目录 → 抽函数/类/导出 → 统计同名引用次数
 */
import { promises as fs } from 'node:fs'
import { join, relative, basename } from 'node:path'
import type { CodeSymbol } from '../../shared/types.ts'

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.cpp', '.h', '.md'])
const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.cache'])

async function walk(dir: string, acc: string[], depth = 0): Promise<void> {
  if (depth > 6) return
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  for (const n of names) {
    if (SKIP.has(n) || n.startsWith('.')) continue
    const full = join(dir, n)
    let st
    try {
      st = await fs.stat(full)
    } catch {
      continue
    }
    if (st.isDirectory()) await walk(full, acc, depth + 1)
    else acc.push(full)
  }
}

function extractSymbols(file: string, text: string): CodeSymbol[] {
  const out: CodeSymbol[] = []
  const lines = text.split(/\r?\n/)
  const patterns: Array<{ re: RegExp; kind: CodeSymbol['kind'] }> = [
    { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
    { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'const' },
    { re: /^\s*(?:export\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
    { re: /^\s*def\s+([A-Za-z_][\w]*)/, kind: 'function' },
    { re: /^\s*fn\s+([A-Za-z_][\w]*)/, kind: 'function' }
  ]
  lines.forEach((line, i) => {
    for (const p of patterns) {
      const m = p.re.exec(line)
      if (m) {
        out.push({ name: m[1], kind: p.kind, file, line: i + 1 })
        break
      }
    }
  })
  return out
}

export async function buildCodeIndex(rootDir: string, allText: Map<string, string>): Promise<CodeSymbol[]> {
  const files: string[] = []
  await walk(rootDir, files)
  const symbols: CodeSymbol[] = []
  for (const f of files) {
    const ext = f.slice(f.lastIndexOf('.')).toLowerCase()
    if (!CODE_EXT.has(ext)) continue
    let text = ''
    try {
      text = await fs.readFile(f, 'utf-8')
    } catch {
      continue
    }
    allText.set(f, text)
    const rel = relative(rootDir, f) || basename(f)
    symbols.push(...extractSymbols(rel, text))
  }
  // 粗引用计数：全库文本中出现名称次数-1
  const corpus = [...allText.values()].join('\n')
  for (const s of symbols) {
    try {
      const n = corpus.split(s.name).length - 1
      s.refCount = Math.max(0, n - 1)
    } catch {
      s.refCount = 0
    }
  }
  return symbols
}

export function querySymbols(symbols: CodeSymbol[], q: string): CodeSymbol[] {
  const k = q.trim().toLowerCase()
  if (!k) return symbols.slice(0, 50)
  return symbols
    .filter((s) => s.name.toLowerCase().includes(k) || s.file.toLowerCase().includes(k))
    .slice(0, 50)
}
