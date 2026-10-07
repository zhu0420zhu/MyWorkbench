/**
 * QA 探针（渲染进程入口）——「另存为多格式」真实运行期验证。
 *
 * 目标是用户那句「另存为保存后是空白的」以及随后两项修复的**独立**复核：
 *   - 空内容守卫（#50）：实质为空时必须在弹保存对话框**之前**就明确失败；
 *   - 扩展名对齐（#51）：落盘路径的扩展名必须对齐用户在下拉里选的 format。
 *
 * 这一层只做「调用 + 断言返回值」，落盘文件内容由 run.mjs 在 Electron 退出后
 * 用完全不同的工具链（node fs / pdf.js / qpdf）独立复核。
 */
declare const window: Window & {
  api: { docs: Record<string, (...a: unknown[]) => Promise<unknown>> }
  __PROBE_CFG__: { workDir: string }
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

const EMPTY_MARK = '没有可导出的内容'

window.__probeRun = async (): Promise<unknown> => {
  const docs = window.api.docs as Record<string, (p: unknown) => Promise<{ ok: boolean; path?: string; error?: string }>>
  ok('preload 暴露 api.docs.saveAsFormat', typeof docs.saveAsFormat === 'function', typeof docs.saveAsFormat)

  const W = window.__PROBE_CFG__.workDir.replace(/\\/g, '/')
  const call = (payload: unknown) => docs.saveAsFormat(payload)

  /* ============ 1. 空内容守卫（#50）：必须"零对话框"地失败 ============
   * main 侧的对话框打桩在队列耗尽时会**抛错**，所以一旦守卫没生效、
   * 代码走到了 showSaveDialog，返回值就会变成 UNEXPECTED_DIALOG 而不是
   * EMPTY_CONTENT_ERROR —— 断言自然失败，不会静默放过。 */
  const emptyCases: Array<[string, { source: string; content: string; format: string }]> = [
    ['空串（text 源 → pdf）', { source: 'text', content: '', format: 'pdf' }],
    ['空串（text 源 → html 目标）', { source: 'text', content: '', format: 'html' }],
    ['纯空白（text 源 → html 目标）', { source: 'text', content: '   \r\n\t  ', format: 'html' }],
    ['纯空白（text 源 → docx 目标）', { source: 'text', content: '\n\n   \n', format: 'docx' }],
    ['只有标签壳 <p><br></p>（html 源）', { source: 'html', content: '<p><br></p>', format: 'pdf' }],
    ['只有 &nbsp;（html 源）', { source: 'html', content: '<div>&nbsp;</div>', format: 'html' }],
    ['只有数字实体空白（html 源）', { source: 'html', content: '<p>&#160;&#xa0;</p>', format: 'docx' }],
    ['只有注释与 script（html 源）', { source: 'html', content: '<!--x--><script>var a=1</script><style>p{}</style>', format: 'pdf' }],
    ['只有空白段落（html 源）', { source: 'html', content: '<p>   </p><p></p>', format: 'htm' }]
  ]
  for (const [label, payload] of emptyCases) {
    const r = await call({ ...payload, defaultName: 'x' })
    ok(`空内容守卫 · ${label} → 明确失败且不弹对话框`, r.ok === false && String(r.error).includes(EMPTY_MARK), `ok=${r.ok} error=${r.error}`)
    ok(`空内容守卫 · ${label} → 未产出路径`, !r.path, String(r.path))
  }

  /* 反例：同样"看着像空"但确有可见内容的，不能被守卫误杀 */
  const notEmpty: Array<[string, { source: string; content: string; format: string; defaultName: string }]> = [
    ['含单个可见字符（html 源）', { source: 'html', content: '<p><br>x</p>', format: 'html', defaultName: '反例1' }],
    ['css 里藏着文本（html 源）', { source: 'html', content: '<p style="color:red">有内容</p>', format: 'html', defaultName: '反例2' }],
    ['实体解出的可见字符（html 源）', { source: 'html', content: '<p>&amp;&lt;</p>', format: 'html', defaultName: '反例3' }]
  ]
  // 这 3 条会真的落盘，占用后续 saveDialogs 队列的第 1..3 个
  for (const [label, payload] of notEmpty) {
    const r = await call(payload)
    ok(`空内容守卫反例 · ${label} → 必须放行`, r.ok === true, `ok=${r.ok} path=${r.path} error=${r.error}`)
  }

  /* ============ 2. 扩展名对齐（#51）：对话框里输入别的扩展名也要对齐 ============ */
  const extCases: Array<[string, { source: string; content: string; format: string; defaultName: string }, string]> = [
    ['用户把文件名写成 .doc，选了 txt', { source: 'text', content: '对齐测试正文 ALIGN-1', format: 'txt', defaultName: '对齐测试' }, '/对齐测试.txt'],
    ['用户把文件名写成 .pdf，选了 html', { source: 'html', content: '<p>网页对齐 ALIGN-2</p>', format: 'html', defaultName: '网页' }, '/网页.html'],
    ['用户完全不写扩展名，选了 md', { source: 'text', content: '# 无扩展名 ALIGN-3', format: 'md', defaultName: '无扩展名' }, '/无扩展名.md'],
    ['用户写的扩展名正好正确', { source: 'text', content: '已经是正确扩展名 ALIGN-4', format: 'txt', defaultName: '已经是' }, '/已经是.txt'],
    ['大小写不同（.TXT vs txt）→ 保留用户写法但格式一致', { source: 'text', content: '大小写 ALIGN-5', format: 'txt', defaultName: '大小写' }, '/大小写.TXT']
  ]
  for (const [label, payload, expectedTail] of extCases) {
    const r = await call(payload)
    const got = r.path ? r.path.replace(/\\/g, '/') : ''
    ok(`扩展名对齐 · ${label} → 落盘后缀 ${expectedTail}`, r.ok === true && got.endsWith(expectedTail), `path=${got}`)
  }

  /* ============ 3. 观察项：text 源直写 txt/md 这条分支**没有**空内容守卫 ============
   * 守卫只加在 pdf / html 目标 / pandoc 四处；纯文本直写分支照旧写空文件。
   * 空 .txt 与"空白 PDF"性质不同（不构成"静默产出空白"），故按观察项上报，不判 FAIL。 */
  {
    const r = await call({ source: 'text', content: '   \n  ', format: 'txt', defaultName: '纯空白文本观察' })
    info(`观察：text 源 + txt 目标 + 纯空白内容 → ok=${r.ok}（该分支无空内容守卫，会写出一份空 .txt）`)
  }

  /* ============ 4. 白名单外的格式：明确拒绝，不弹对话框 ============ */
  for (const bad of ['exe', 'sh', '']) {
    const r = await call({ source: 'text', content: 'hi', format: bad, defaultName: 'x' })
    ok(`白名单外格式 "${bad || '空'}" → 明确拒绝`, r.ok === false && String(r.error).includes('不支持导出为'), `ok=${r.ok} error=${r.error}`)
  }

  /* ============ 5. 用户取消：返回 cancelled 且不落盘 ============ */
  {
    const r = await call({ source: 'text', content: '取消用例 CANCEL', format: 'txt', defaultName: '取消用例' })
    ok('用户取消保存 → ok:false / error=cancelled', r.ok === false && String(r.error).includes('cancelled'), `ok=${r.ok} error=${r.error}`)
    ok('用户取消保存 → 未返回路径', !r.path, String(r.path))
  }

  /* ============ 6. PDF 非空：真实走 LibreOffice，必须产出可打开的非空白 PDF ============ */
  {
    const body = ['季度说明 PDF-PROBE-1', '这是中文正文，用来验证另存为 PDF 不会产出空白文件。', 'ASCII line for text-layer check PROBE-ASCII-9'].join('\n')
    const r = await call({ source: 'text', content: body, format: 'pdf', defaultName: `导出未对齐名` })
    ok('PDF · 非空内容 → 导出成功', r.ok === true, `ok=${r.ok} error=${r.error}`)
    ok('PDF · 落盘扩展名被对齐为 .pdf', !!r.path && r.path.replace(/\\/g, '/').endsWith('/导出未对齐名.pdf'), String(r.path))
  }

  info(`工作目录 ${W}`)
  return { rows, expectedSaveDialogs: 3 + extCases.length + 1 + 1 + 1 }
}
