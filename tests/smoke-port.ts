/* 移植模块最小冒烟验证（无需 Electron 运行时）
 * 覆盖：分词器、解析器、切分器、索引器 ingest→query→持久化→删除 全链路、规则分类回退。
 * 转换引擎格式路由依赖 Electron app 运行时，由 typecheck + IPC 接线保证，此处不执行。
 */
import { tokenize, isCjk } from '../src/main/searchIndex/tokenizer.ts'
import { extractText, stripHtml } from '../src/main/searchIndex/parser.ts'
import { chunkText } from '../src/main/searchIndex/chunker.ts'
import { Indexer } from '../src/main/searchIndex/indexer.ts'
import { getFileCategory, getFileCategoryName } from '../src/main/tools/fileUtils.ts'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.error(`  FAIL  ${name}  ${detail}`)
    failures++
  }
}

async function main(): Promise<void> {
  console.log('[1] 分词器 tokenizer')
  const tcjk = tokenize('文件管理')
  check('CJK 单字 unigram', ['文', '件', '管', '理'].every((c) => tcjk.includes(c)), JSON.stringify(tcjk))
  check('CJK 相邻 bigram', tcjk.includes('文件') && tcjk.includes('管理'), JSON.stringify(tcjk))
  const ten = tokenize('Hello World 2024')
  check('英文/数字按词', ten.includes('hello') && ten.includes('world') && ten.includes('2024'), JSON.stringify(ten))
  check('isCjk 判定', isCjk('中') && !isCjk('a'))

  console.log('[2] 解析器 parser')
  check('stripHtml 去标签', stripHtml('<p>你好</p><script>x</script>') === '你好', stripHtml('<p>你好</p><script>x</script>'))
  const tmp = await fs.mkdtemp(join(tmpdir(), 'lingmo-smoke-'))
  const mdPath = join(tmp, 'note.md')
  await fs.writeFile(mdPath, '# 标题\n这是一段关于灵墨工作台的内容。', 'utf-8')
  const txt = await extractText(mdPath)
  check('extractText 读取 md', typeof txt === 'string' && txt.includes('灵墨工作台'))
  const binPath = join(tmp, 'img.png')
  await fs.writeFile(binPath, Buffer.from([1, 2, 3]))
  check('extractText 不支持类型返回 null', (await extractText(binPath)) === null)

  console.log('[3] 切分器 chunker')
  const headingText = '# 我的标题\n正文内容关于灵墨。\n第二段内容继续。'
  const hc = chunkText(headingText, 'h.md', 'docH')
  check('标题被捕获', hc.length > 0 && hc[0].heading === '我的标题', JSON.stringify(hc.map((c) => c.heading)))
  const big = Array.from({ length: 40 }, (_, i) => `第${i + 1}行：灵墨工作台全文检索索引测试内容`).join('\n')
  const bc = chunkText(big, 'b.md', 'docB')
  check('长文本切分为多块', bc.length >= 2, `len=${bc.length}`)
  check('块起始偏移递增', bc.every((c, i) => i === 0 || c.startChar > bc[i - 1].startChar))

  console.log('[4] 索引器 全链路 ingest→query→persist→delete')
  const idxPath = join(tmp, 'search-index.json')
  const idx = new Indexer(idxPath)
  await idx.load()
  const r = await idx.ingest(mdPath)
  check('ingest 成功且有分块', r.success && r.chunkCount > 0, JSON.stringify(r))
  const hits = idx.query('灵墨工作台')
  check('query 命中', hits.length > 0 && hits[0].filePath === mdPath, JSON.stringify(hits))
  check('query 不命中返回空', idx.query('飞机大炮qwerty').length === 0, JSON.stringify(idx.query('飞机大炮qwerty')))
  const stats = idx.stats()
  check('stats.docCount === 1', stats.docCount === 1, JSON.stringify(stats))
  // 持久化后重载
  const idx2 = new Indexer(idxPath)
  await idx2.load()
  check('重载后仍能 query', idx2.query('灵墨工作台').length > 0)
  const del = idx.delete(mdPath)
  check('delete 移除索引', del.deletedCount > 0)
  check('delete 后 query 落空', idx.query('灵墨工作台').length === 0)
  const stats2 = idx.stats()
  check('delete 后 docCount === 0', stats2.docCount === 0, JSON.stringify(stats2))

  console.log('[5] 规则分类（organize AI 失败回退路径）')
  check('getFileCategory(.pdf)=documents', getFileCategory('report.pdf') === 'documents', getFileCategory('report.pdf'))
  check('getFileCategory(.jpg)=images', getFileCategory('pic.jpg') === 'images', getFileCategory('pic.jpg'))
  check('getFileCategoryName(documents)=文档', getFileCategoryName('documents') === '文档', getFileCategoryName('documents'))

  await fs.rm(tmp, { recursive: true, force: true })
  console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'}`)
  if (failures > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
