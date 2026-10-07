/* 知识库流水线 — 无头冒烟测试（依赖注入，无需 electron / 真实转换工具） */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeBuilder } from '../src/main/knowledgeBase/builder.ts'
import type {
  BuilderRegistry,
  BuilderIndexer,
  BuilderTempCleaner
} from '../src/main/knowledgeBase/builder.ts'

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, extra = ''): void => {
  if (cond) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name} ${extra}`)
  }
}

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.html', '.htm'])
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function makeFakes() {
  const calls = { ingest: 0, ingestText: 0, convert: 0, describe: 0 }
  const registry: BuilderRegistry = {
    findConverter(src: string, tgt: string): string | undefined {
      const s = src.toLowerCase()
      if ((s === '.docx' || s === '.pdf' || s === '.xlsx') && (tgt === '.txt' || tgt === '.html')) return 'fake'
      return undefined
    },
    async convert(input) {
      calls.convert++
      const tp = join(input.outputDir!, `converted_${Date.now()}_${calls.convert}.txt`)
      writeFileSync(tp, '转换后的文本内容 用于本地检索索引。')
      return {
        success: true,
        sourcePath: input.sourcePath,
        targetPath: tp,
        targetFormat: input.targetFormat,
        converterName: 'fake',
        duration: 0,
        error: '',
        fileSizeBefore: 0,
        fileSizeAfter: 0
      }
    }
  }
  const indexer: BuilderIndexer = {
    async ingest(filePath: string, describer?: (p: string) => Promise<string | null>) {
      calls.ingest++
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
      if (TEXT_EXTS.has(ext)) return { success: true, filePath, chunkCount: 3 }
      if (IMG_EXTS.has(ext)) {
        if (describer) {
          calls.describe++
          await describer(filePath)
        }
        return { success: true, filePath, chunkCount: 1 }
      }
      return { success: false, filePath, chunkCount: 0, error: '不支持的文件类型' }
    },
    async ingestText(filePath: string, text: string) {
      calls.ingestText++
      return { success: true, filePath, chunkCount: Math.max(1, Math.ceil(text.length / 10)) }
    }
  }
  const tempCleaner: BuilderTempCleaner = {
    createTempDir(): string {
      return mkdtempSync(join(tmpdir(), 'kbtest-'))
    },
    cleanupFile(p: string): void {
      try {
        rmSync(p, { force: true })
      } catch {
        /* ignore */
      }
    },
    cleanupDir(p: string): void {
      try {
        rmSync(p, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
  const describer = async (): Promise<string | null> => '图片视觉描述'
  return { calls, registry, indexer, tempCleaner, describer, builder: new KnowledgeBuilder({ registry, indexer, tempCleaner, describer }) }
}

async function main(): Promise<void> {
  const t = makeFakes()
  const root = mkdtempSync(join(tmpdir(), 'kbdoc-'))
  const txtFile = join(root, 'note.txt')
  const docxFile = join(root, 'report.docx')
  const pngFile = join(root, 'pic.png')
  const pptxFile = join(root, 'slide.pptx')
  writeFileSync(txtFile, 'hello world')
  writeFileSync(docxFile, 'binary')
  writeFileSync(pngFile, 'binary')
  writeFileSync(pptxFile, 'binary')

  // A. pickTextTarget 选择优先级
  check('pickTextTarget(.docx)=.txt', t.builder.pickTextTarget('.docx') === '.txt')
  check('pickTextTarget(.pptx)=undefined', t.builder.pickTextTarget('.pptx') === undefined)

  // B. 单文件：文本直接索引
  const r1 = await t.builder.build([{ path: txtFile, kind: 'file' }])
  check('txt → ingested', r1.ingested === 1 && r1.items[0].status === 'ingested')

  // C. 单文件：docx 经转换后索引
  const r2 = await t.builder.build([{ path: docxFile, kind: 'file' }])
  check('docx → ingested-converted', r2.ingestedConverted === 1 && r2.items[0].status === 'ingested-converted')
  check('docx 转换被调用', t.calls.convert >= 1)
  check('docx 经 ingestText 建索引', t.calls.ingestText >= 1)

  // D. 单文件：图片经 describer 索引
  const r3 = await t.builder.build([{ path: pngFile, kind: 'file' }])
  check('png → ingested(image)', r3.ingested === 1 && r3.items[0].status === 'ingested' && t.calls.describe >= 1)

  // E. 单文件：pptx 无文本目标 → 跳过
  const r4 = await t.builder.build([{ path: pptxFile, kind: 'file' }])
  check('pptx → skipped', r4.skipped === 1 && r4.items[0].status === 'skipped')

  // F. 目录递归：混合类型汇总
  const r5 = await t.builder.build([{ path: root, kind: 'dir' }])
  check(
    'dir: 1 ingested + 1 converted + 1 image + 1 skipped',
    r5.ingested === 2 && r5.ingestedConverted === 1 && r5.skipped === 1,
    JSON.stringify({ ingested: r5.ingested, converted: r5.ingestedConverted, skipped: r5.skipped })
  )

  // G. 临时文件清理：转换产生的中间文件已删除
  const convItem = r2.items[0]
  check('转换中间文件已清理', !!convItem.viaPath && !existsSync(convItem.viaPath), `viaPath=${convItem.viaPath}`)

  rmSync(root, { recursive: true, force: true })
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

void main()
