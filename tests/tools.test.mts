// 工具集单测（node 24 type-stripping 直接运行：node tools.test.mts）
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getFileCategory,
  getFileCategoryName,
  formatFileSize,
  scanDirectory,
  safeRename,
  moveFile,
  copyFileResumable,
  computeFileHash,
  getFileInfo,
  deleteFile,
  DirectoryAnalyzer,
  getDiskInfo,
  findDuplicates,
  DuplicateDetector,
  FileWatcher
} from '../src/main/tools/index.ts'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log('  ✓ ' + msg)
  } else {
    failed++
    console.error('  ✗ FAIL: ' + msg)
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'lingmo-tools-'))
}

// ---- fileUtils ----
const cat1 = getFileCategory('a.pdf')
assert(cat1 === 'documents', `分类：pdf → documents（实际 ${cat1}）`)
const cat2 = getFileCategory('b.PNG')
assert(cat2 === 'images', '分类：PNG（大小写不敏感）→ images')
assert(getFileCategory('c.xyz') === 'other', '分类：未知后缀 → other')
assert(getFileCategoryName('documents') === '文档', '类别中文名')
assert(formatFileSize(512) === '512 B', '格式化：512 B')
assert(formatFileSize(2048) === '2.00 KB', '格式化：2.00 KB')
assert(formatFileSize(5 * 1024 * 1024) === '5.00 MB', '格式化：5.00 MB')

{
  const dir = await makeTempDir()
  await fs.writeFile(join(dir, 'a.txt'), 'hello')
  await fs.writeFile(join(dir, 'b.png'), Buffer.from([1, 2, 3]))
  await fs.mkdir(join(dir, 'sub'))
  await fs.writeFile(join(dir, 'sub', 'c.md'), 'world')
  await fs.mkdir(join(dir, 'node_modules'))
  await fs.writeFile(join(dir, 'node_modules', 'd.js'), 'x')

  const all = await scanDirectory(dir)
  assert(all.length === 4, `扫描递归：4 个文件（实际 ${all.length}）`)
  assert(all.every((f) => f.size > 0 && f.category), '扫描：每项含 size/category')
  const txtOnly = await scanDirectory(dir, { includeExtensions: ['.txt', '.md'] })
  assert(txtOnly.length === 2, '扫描：后缀过滤')
  const noExclude = await scanDirectory(dir, { excludeDirs: ['node_modules'] })
  assert(noExclude.length === 3, '扫描：排除目录')

  // 哈希
  const h = await computeFileHash(join(dir, 'a.txt'))
  const expect = createHash('md5').update('hello').digest('hex')
  assert(h === expect, 'MD5 哈希与手工计算一致')

  // 安全重命名（冲突加序号）
  const ok = await safeRename(join(dir, 'a.txt'), 'a2.txt')
  assert(ok, '重命名成功')
  await fs.writeFile(join(dir, 'a2.txt'), 'first')
  await fs.writeFile(join(dir, 'a.txt'), 'second')
  const ok2 = await safeRename(join(dir, 'a.txt'), 'a2.txt')
  assert(ok2, '重命名冲突时加序号')
  const exists = await fs
    .readdir(dir)
    .then((l) => l.filter((n) => n.startsWith('a2_')).length > 0)
  assert(exists, '冲突文件生成 a2_1.txt 序号')

  // 移动
  const mv = await moveFile(join(dir, 'b.png'), join(dir, 'moved'))
  assert(mv.success && (await fs.stat(join(dir, 'moved', 'b.png'))).size === 3, '移动文件到子目录')

  // 断点续传复制
  const big = join(dir, 'big.bin')
  await fs.writeFile(big, Buffer.alloc(3000000, 7))
  const cp = await copyFileResumable(big, join(dir, 'big-copy.bin'))
  assert(cp.success && cp.bytes_written === 3000000, '断点续传复制完整')
  const cp2 = await copyFileResumable(big, join(dir, 'big-copy.bin'))
  assert(cp2.success && cp2.bytes_written === 3000000, '目标已完整时直接成功')

  // 文件信息 + 删除
  const info = await getFileInfo(join(dir, 'big.bin'))
  assert(info !== null && info.size === 3000000 && info.is_file, '文件信息')
  const del = await deleteFile(join(dir, 'big-copy.bin'), false)
  assert(del && !(await fs.stat(join(dir, 'big-copy.bin')).catch(() => null)), '永久删除')

  await fs.rm(dir, { recursive: true, force: true })
}

// ---- diskAnalyzer ----
{
  const dir = await makeTempDir()
  await fs.writeFile(join(dir, 'doc.pdf'), Buffer.alloc(60 * 1024 * 1024)) // 60MB 大文件
  await fs.writeFile(join(dir, 'img.png'), Buffer.alloc(1024))
  await fs.writeFile(join(dir, 'code.ts'), 'console.log(1)')
  const analyzer = new DirectoryAnalyzer()
  const result = await analyzer.analyze(dir, true, 50 * 1024 * 1024)
  assert(result.total_size === 60 * 1024 * 1024 + 1024 + 14, `目录总大小（实际 ${result.total_size}）`)
  assert(result.large_file_count === 1, '大文件检测（50MB 阈值）')
  const docs = result.category_stats.find((c) => c.category === 'documents')
  assert(docs !== undefined && docs.count === 1, '类别统计：documents')
  const ext = result.extension_stats.find((e) => e.extension === '.ts')
  assert(ext !== undefined && ext.count === 1, '后缀统计：.ts')
  await fs.rm(dir, { recursive: true, force: true })

  const disk = await getDiskInfo(process.platform === 'win32' ? 'C:\\' : '/')
  assert(disk.total > 0, `磁盘信息 total>0（实际 ${disk.total}）`)
  assert(disk.total_formatted.length > 0, '磁盘信息格式化')
}

// ---- duplicateDetector ----
{
  const dir = await makeTempDir()
  const content = 'duplicate content '.repeat(100)
  await fs.writeFile(join(dir, 'same1.txt'), content)
  await fs.writeFile(join(dir, 'same2.txt'), content)
  await fs.writeFile(join(dir, 'unique.txt'), 'unique')

  const result = await findDuplicates(dir, { minSize: 1 })
  assert(result.total_groups === 1, `完全重复检测：1 组（实际 ${result.total_groups}）`)
  assert(result.total_duplicates === 1, '重复文件数 1')
  const g = result.groups[0]
  assert(g.files.length === 2 && g.keep !== null && g.delete.length === 1, '保留/删除建议')
  assert(g.savings === g.size, '节省空间 = 单个文件大小')

  // 内容相似度：指纹为 MD5（雪崩效应），仅内容几乎完全一致时分组（与原 Python 实现行为一致）
  await fs.writeFile(join(dir, 'sim1.txt'), 'abcdefghij')
  await fs.writeFile(join(dir, 'sim2.txt'), 'abcdefghij')
  const detector = new DuplicateDetector()
  const similar = await detector.detectByContentSimilarity([join(dir, 'sim1.txt'), join(dir, 'sim2.txt')], 0.8)
  assert(similar.length === 1, '内容相似检测：完全相同文件成组')
  await fs.writeFile(join(dir, 'sim3.txt'), 'zzzzzzzzzz')
  const different = await detector.detectByContentSimilarity(
    [join(dir, 'sim1.txt'), join(dir, 'sim3.txt')],
    0.8
  )
  assert(different.length === 0, '内容相似检测：完全不同不成组')
  assert(detector.fingerprintSimilarity('abcd', 'abcd') === 1.0, '指纹相似度：相同 1.0')
  assert(detector.fingerprintSimilarity('abcd', 'abce') === 0.75, '指纹相似度：3/4')
  await fs.rm(dir, { recursive: true, force: true })
}

// ---- fileWatcher ----
{
  const dir = await makeTempDir()
  const watcher = new FileWatcher()
  assert(!watcher.addWatch(join(dir, 'no-such-dir')), '监控不存在的目录 → false')
  assert(watcher.addWatch(dir, '测试目录'), '添加监控目录')
  watcher.setPollInterval(0.2)

  const events: string[] = []
  watcher.addCallback((e) => events.push(`${e.event_type}:${e.path.split(/[\\/]/).pop()}`))
  watcher.start()
  await sleep(300)

  await fs.writeFile(join(dir, 'new.txt'), 'hi')
  await sleep(500)
  await fs.writeFile(join(dir, 'new.txt'), 'hi again')
  await sleep(500)
  await fs.unlink(join(dir, 'new.txt'))
  await sleep(500)
  watcher.stop()

  assert(events.some((e) => e.startsWith('created:new.txt')), `收到创建事件（${events.join(',')}）`)
  assert(events.some((e) => e.startsWith('modified:new.txt')), '收到修改事件')
  assert(events.some((e) => e.startsWith('deleted:new.txt')), '收到删除事件')
  assert(!watcher.isRunning, 'stop 后停止')

  watcher.pause()
  watcher.resume()
  assert(watcher.watchedDirectories.length >= 1, '监控目录列表')
  await fs.rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
