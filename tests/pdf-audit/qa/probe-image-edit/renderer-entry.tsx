/**
 * QA 探针（渲染进程入口）——图片四按钮的 DOM 级 e2e。
 *
 * 这不是"直接调函数"，而是把**生产组件 PdfInPlaceEditor** 用真实 React 挂进真实
 * Chromium，然后派发真实 DOM 事件（mousedown/mousemove/mouseup、click、change、keydown）
 * 去点按钮、选文件、拖拽放置，最后点顶部「保存」经**真实 preload / 真实 IPC** 落盘。
 *
 * 两处替身（无头环境绕不过，且都做了记录）：
 *   - <input type=file> 的原生选择框：patch 掉 click，直接给 input.files 塞 File + 派发 change；
 *   - 原生保存对话框：主进程侧用 PLAN 队列驱动。
 */
import { createRoot, type Root } from 'react-dom/client'
import { useRef, useEffect, type ReactElement } from 'react'
import PdfInPlaceEditor, { type PdfInPlaceEditorHandle } from '../../../../src/renderer/src/pages/PdfInPlaceEditor'

declare const window: Window & {
  api: { pdf: Record<string, (...a: unknown[]) => Promise<unknown>> }
  __PROBE_CFG__: {
    cases: Record<string, { path: string; pngDataUrl: string; jpegDataUrl: string }>
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

/* ------------------------------------------------------------------ *
 * 0. 基础设施：toast 记录 / 文件框 patch / DOM 工具
 * ------------------------------------------------------------------ */

interface Toast {
  level: string
  text: string
}
const toasts: Toast[] = []
function observeToasts(): void {
  const seen = new WeakSet<Node>()
  const grab = (n: Element): void => {
    if (seen.has(n)) return
    seen.add(n)
    const notice = n.matches('.ant-message-notice') ? n : n.querySelector('.ant-message-notice')
    if (!notice || seen.has(notice)) return
    seen.add(notice)
    const cls = notice.querySelector('[class*=ant-message-]')?.className ?? ''
    const m = /ant-message-(success|warning|info|error|loading)/.exec(cls)
    toasts.push({ level: m ? m[1] : 'unknown', text: (notice.textContent || '').trim() })
  }
  const mo = new MutationObserver((recs) => {
    for (const r of recs) for (const n of Array.from(r.addedNodes)) if (n.nodeType === 1) grab(n as Element)
  })
  mo.observe(document.body, { childList: true, subtree: true })
}

/** 原生文件选择框会阻塞无头环境：拦掉 click，改由探针直接塞 FileList */
const fileClickLog: string[] = []
function patchFileInput(): void {
  const proto = HTMLInputElement.prototype
  const orig = proto.click
  proto.click = function (this: HTMLInputElement) {
    if (this.type === 'file') {
      fileClickLog.push(this.accept || '')
      return
    }
    return orig.call(this)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(label: string, fn: () => T | null, timeout = 10000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error('等待超时：' + label)
    await sleep(50)
  }
}

const $$ = (sel: string): Element[] => Array.from(document.querySelectorAll(sel))

/** 按可见文字找元素（默认找 button） */
function byText(text: string, sel = 'button', exact = false): HTMLElement | null {
  for (const el of $$(sel)) {
    const t = (el.textContent || '').trim()
    if (exact ? t === text : t.includes(text)) return el as HTMLElement
  }
  return null
}

function mustByText(text: string, sel = 'button', exact = false): HTMLElement {
  const el = byText(text, sel, exact)
  if (!el) throw new Error(`找不到含文字「${text}」的 ${sel}`)
  return el
}

function clickEl(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  el.click()
}

/** React 受控 input：必须走原生 setter + input 事件，否则 React 认为值没变 */
function setReactInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 给隐藏的 <input type=file> 塞一个真 File（等价于用户在系统框里选了文件） */
function chooseFile(dataUrl: string, name: string, mime: string): void {
  const input = $$('input[type=file]')[0] as HTMLInputElement | undefined
  if (!input) throw new Error('找不到 <input type=file>')
  const bin = atob(dataUrl.split(',')[1])
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  const file = new File([arr], name, { type: mime })
  const dt = new DataTransfer()
  dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function keydown(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

/* ------------------------------------------------------------------ *
 * 1. 挂载 / 卸载生产组件
 * ------------------------------------------------------------------ */

interface Mounted {
  host: HTMLDivElement
  root: Root
  api: () => PdfInPlaceEditorHandle | null
  pending: () => number
  unmount: () => void
}

let pendingValue = 0

async function mount(caseKey: string): Promise<Mounted> {
  const cfg = window.__PROBE_CFG__.cases[caseKey]
  const docs = window.api.pdf as unknown as { pickPdfs: () => Promise<Array<{ path: string }>>; read: (p: string) => Promise<Uint8Array | null> }
  // 走真实 pdf:pick-pdfs 处理器（主进程侧真实 allowPath 登记），再读字节
  const picked = await docs.pickPdfs()
  const path = picked[0]?.path
  if (!path) throw new Error('pickPdfs 未返回素材')
  if (path.replace(/\\/g, '/') !== cfg.path.replace(/\\/g, '/')) throw new Error(`pickPdfs 路径不符：${path}`)
  const bytes = await docs.read(path)
  if (!bytes) throw new Error('pdf:read 返回 null')

  pendingValue = 0
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;inset:0;background:#fff'
  document.body.appendChild(host)
  const root = createRoot(host)
  const apiRef: { current: PdfInPlaceEditorHandle | null } = { current: null }

  function Host(): React.ReactElement {
    const r = useRef<PdfInPlaceEditorHandle | null>(null)
    useEffect(() => {
      apiRef.current = r.current
    })
    apiRef.current = r.current
    return (
      <PdfInPlaceEditor
        path={path}
        name={cfg.path.split(/[\\/]/).pop() ?? 'x.pdf'}
        bytes={bytes}
        apiRef={r}
        onPendingChange={(n) => {
          pendingValue = n
        }}
        onSaved={() => undefined}
        onExit={() => undefined}
      />
    )
  }
  root.render(<Host />)

  await waitFor('编辑器加载出第 1 页底图', () => document.querySelector('img[alt="第 1 页"]'))
  await waitFor('文字行叠加层出现', () => $$('div[title^="点一下改这一行"]').length > 0, 15000)

  return {
    host,
    root,
    api: () => apiRef.current,
    pending: () => pendingValue,
    unmount: () => {
      root.unmount()
      host.remove()
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. 页面 / 图片框 / 列表的读取工具
 * ------------------------------------------------------------------ */

function pageBox(pageNo1: number): HTMLElement {
  const img = document.querySelector(`img[alt="第 ${pageNo1} 页"]`) as HTMLElement | null
  if (!img) throw new Error(`找不到第 ${pageNo1} 页`)
  return img.parentElement as HTMLElement
}

/** 图片外框：带 title="第 N 页 · #k · W×Hpt" 的 div */
function imgFrames(): HTMLElement[] {
  return $$('div[title*="· #"]') as HTMLElement[]
}

const frameStyle = (el: HTMLElement): string => window.getComputedStyle(el).borderTopStyle + '|' + window.getComputedStyle(el).borderTopColor

function listItems(): HTMLElement[] {
  return $$('button').filter((b) => /^第 \d+ 页 · #\d+ · \d+×\d+pt/.test((b.textContent || '').trim())) as HTMLElement[]
}

/** 在页面上拖一个矩形（真实 mousedown/mousemove/mouseup） */
async function dragOnPage(pageNo1: number, lx1: number, ly1: number, lx2: number, ly2: number): Promise<void> {
  const box = pageBox(pageNo1)
  const b = box.getBoundingClientRect()
  const target = (box.querySelector('img') as HTMLElement) ?? box
  target.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: b.left + lx1, clientY: b.top + ly1 })
  )
  await sleep(30)
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: b.left + lx2, clientY: b.top + ly2 }))
  await sleep(30)
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: b.left + lx2, clientY: b.top + ly2 }))
  await sleep(120)
}

/* ================================================================== *
 * 场景
 * ================================================================== */

const meta: Record<string, unknown> = {}

window.__probeRun = async (): Promise<unknown> => {
  observeToasts()
  patchFileInput()

  const cfg = window.__PROBE_CFG__.cases

  /* ================= S1 图片列表枚举 / 选中 / 缩略图 / 虚线框 ================= */
  {
    const m = await mount('list')
    const t0 = toasts.length
    clickEl(mustByText('图片列表'))
    await waitFor('图片列表出现条目', () => (listItems().length ? listItems() : null), 20000)
    const items = listItems()
    const texts = items.map((b) => (b.textContent || '').trim())
    info('S1 列表条目：' + JSON.stringify(texts))
    ok('S1 列表列出 4 张位图（第1页2张 + 第2页1张 + 第3页1张）', items.length === 4, String(items.length))
    ok('S1 条目文案含页码/序号/尺寸/像素', /^第 1 页 · #1 · \d+×\d+pt · \d+×\d+px$/.test(texts[0] ?? ''), texts[0] ?? '')
    ok('S1 同页两张图序号为 #1 / #2', texts.some((t) => t.startsWith('第 1 页 · #1')) && texts.some((t) => t.startsWith('第 1 页 · #2')), JSON.stringify(texts))
    ok('S1 跨页枚举到第 2 / 第 3 页', texts.some((t) => t.startsWith('第 2 页')) && texts.some((t) => t.startsWith('第 3 页')))

    const frames = imgFrames()
    ok('S1 页面上出现 4 个图片外框', frames.length === 4, String(frames.length))
    ok(
      'S1 未选中时外框是蓝色虚线（非实线）',
      frames.every((f) => window.getComputedStyle(f).borderTopStyle === 'dashed'),
      frames.map((f) => window.getComputedStyle(f).borderTopStyle).join(',')
    )

    clickEl(items[0])
    await sleep(200)
    const st = frameStyle(frames[0])
    ok('S1 选中后该框变实线高亮', st.startsWith('solid'), st)
    ok('S1 选中后列表项有选中态', window.getComputedStyle(items[0]).borderTopStyle === 'solid', window.getComputedStyle(items[0]).borderTopStyle)
    const thumb = await waitFor('选中项缩略图', () => document.querySelector('img[alt="选中图片预览"]') as HTMLImageElement | null, 20000)
    ok('S1 下方出现该图缩略图（dataURL）', thumb.src.startsWith('data:image/'), thumb.src.slice(0, 30) + '… len=' + thumb.src.length)
    ok('S1 工具条出现「已选：第 1 页 · 第 1 处」标签', !!byText('已选：第 1 页 · 第 1 处', 'span'), '')
    ok('S1 枚举/选中过程不应有任何告警', toasts.slice(t0).filter((t) => t.level === 'warning').length === 0, JSON.stringify(toasts.slice(t0)))

    m.unmount()
  }

  /* ================= S2 删除图片：同色块覆盖（采样色）+ 待删除态 + 撤销/重做 + 保存 ================= */
  {
    const m = await mount('delete')
    clickEl(mustByText('图片列表'))
    await waitFor('图片列表出现条目', () => (listItems().length ? listItems() : null), 20000)
    const items = listItems()
    const p1f1 = items.find((b) => (b.textContent || '').includes('第 1 页 · #1'))!
    clickEl(p1f1)
    await sleep(200)

    const t0 = toasts.length
    clickEl(mustByText('删除图片'))
    await sleep(600)

    const listText = listItems().map((b) => (b.textContent || '').trim())
    ok('S2 列表项出现「待删除」标记', listText.some((t) => t.includes('待删除')), JSON.stringify(listText))
    ok('S2 工具条出现「已标记删除」标签', !!byText('已标记删除', 'span'), '')
    ok('S2 工具条出现待保存图片计数', !!byText('处图片改动待保存', 'span'), (byText('处图片改动待保存', 'span')?.textContent ?? '').trim())

    const frames = imgFrames()
    const redFrame = frames.find((f) => window.getComputedStyle(f).borderTopColor.replace(/\s/g, '') === 'rgba(207,19,34,0.85)')
    ok('S2 被删图片的框变红色虚线', !!redFrame && window.getComputedStyle(redFrame).borderTopStyle === 'dashed', redFrame ? frameStyle(redFrame) : '未找到红框')

    const savedBtn = mustByText('保存', 'button')
    ok('S2 顶部保存按钮变为可点且文案含图片计数', !savedBtn.hasAttribute('disabled') && (savedBtn.textContent || '').includes('处图片'), (savedBtn.textContent || '').trim())
    ok('S2 onPendingChange 把图片改动计入待保存数', m.pending() > 0, 'pendingCount=' + m.pending() + '，apiRef=' + m.api()?.pendingCount())
    ok('S2 采样成功时不应出现「未能采样」告警', toasts.slice(t0).every((t) => !t.text.includes('未能从页面像素采样')), JSON.stringify(toasts.slice(t0)))
    ok('S2 给出「并非真正抹除」的显式提示', toasts.slice(t0).some((t) => t.text.includes('并非真正抹除')), JSON.stringify(toasts.slice(t0)))

    // 撤销 → 待删除应回滚
    clickEl(mustByText('撤销') || $$('button').find((b) => (b.textContent || '').includes('撤销'))!)
    await sleep(300)
    ok('S2 撤销后「待删除」标记消失', !listItems().some((b) => (b.textContent || '').includes('待删除')), JSON.stringify(listItems().map((b) => (b.textContent || '').trim())))
    ok('S2 撤销后待保存数归零', m.pending() === 0, String(m.pending()))
    // 重做 → 恢复
    clickEl($$('button').find((b) => (b.textContent || '').includes('重做'))!)
    await sleep(300)
    ok('S2 重做后「待删除」标记恢复', listItems().some((b) => (b.textContent || '').includes('待删除')), JSON.stringify(listItems().map((b) => (b.textContent || '').trim())))

    clickEl(mustByText('保存'))
    await waitFor('保存后按钮回到「已保存」', () => byText('已保存', 'button'), 20000)
    ok('S2 点保存后顶部按钮变为「已保存」', !!byText('已保存', 'button'), '')
    meta.deleteSample = { recordedToasts: toasts.slice(t0).map((t) => t.level + ':' + t.text) }
    m.unmount()
  }

  /* ================= S3 删除全页图：采样必失败 → 白底兜底 + 黄条告警 ================= */
  {
    const m = await mount('deleteFail')
    clickEl(mustByText('图片列表'))
    await waitFor('图片列表出现条目', () => (listItems().length ? listItems() : null), 20000)
    const p3 = listItems().find((b) => (b.textContent || '').includes('第 3 页'))!
    clickEl(p3)
    await sleep(200)
    const t0 = toasts.length
    clickEl(mustByText('删除图片'))
    await sleep(800)
    const warns = toasts.slice(t0).filter((t) => t.level === 'warning')
    ok('S3 采样失败时弹出黄条告警', warns.length > 0, JSON.stringify(toasts.slice(t0)))
    ok(
      'S3 告警文案指明「未能采样 / 退回白色」',
      warns.some((t) => t.text.includes('未能从页面像素采样到覆盖色') && t.text.includes('退回白色')),
      JSON.stringify(warns)
    )
    clickEl(mustByText('保存'))
    await waitFor('保存后按钮回到「已保存」', () => byText('已保存', 'button'), 20000)
    meta.deleteFailToasts = toasts.slice(t0).map((t) => t.level + ':' + t.text)
    m.unmount()
  }

  /* ================= S4 替换图片 ================= */
  {
    const m = await mount('replace')
    clickEl(mustByText('图片列表'))
    await waitFor('图片列表出现条目', () => (listItems().length ? listItems() : null), 20000)
    clickEl(listItems().find((b) => (b.textContent || '').includes('第 2 页'))!)
    await sleep(200)
    const t0 = toasts.length
    clickEl(mustByText('替换图片'))
    await sleep(200)
    ok('S4 点「替换图片」真的尝试打开文件框', fileClickLog.length > 0, JSON.stringify(fileClickLog))
    chooseFile(cfg.replace.pngDataUrl, 'qa-replace.png', 'image/png')
    await sleep(600)
    ok('S4 提示已标记替换', toasts.slice(t0).some((t) => t.text.includes('已标记替换第 2 页图片')), JSON.stringify(toasts.slice(t0)))
    ok('S4 列表项出现「待替换」标记', listItems().some((b) => (b.textContent || '').includes('待替换')), JSON.stringify(listItems().map((b) => (b.textContent || '').trim())))
    ok('S4 工具条出现「已标记替换」标签', !!byText('已标记替换', 'span'), '')
    clickEl(mustByText('保存'))
    await waitFor('保存后按钮回到「已保存」', () => byText('已保存', 'button'), 20000)
    m.unmount()
  }

  /* ================= S5 插入图片：待放置态 → Esc 取消 → 重新插入并拖拽放置 ================= */
  {
    const m = await mount('insert')
    const t0 = toasts.length
    clickEl(mustByText('插入图片'))
    await sleep(200)
    chooseFile(cfg.insert.pngDataUrl, 'qa-insert.png', 'image/png')
    await sleep(400)
    ok('S5 选中文件后出现「待放置：qa-insert.png」标签', !!byText('待放置：qa-insert.png', 'span'), (byText('待放置', 'span')?.textContent ?? '').trim())
    ok('S5 提示拖拽矩形确定区域', toasts.slice(t0).some((t) => t.text.includes('拖出一个矩形')), JSON.stringify(toasts.slice(t0)))

    // Esc 取消待放置
    keydown('Escape')
    await sleep(300)
    ok('S5 Esc 取消待放置态（标签消失）', !byText('待放置', 'span'), '')
    ok('S5 Esc 给出「已取消插入图片」提示', toasts.some((t) => t.text.includes('已取消插入图片')), JSON.stringify(toasts.slice(-4)))

    // 重新插入并拖拽放置
    const t1 = toasts.length
    clickEl(mustByText('插入图片'))
    await sleep(150)
    chooseFile(cfg.insert.pngDataUrl, 'qa-insert.png', 'image/png')
    await sleep(300)
    const box = pageBox(1)
    const scale = box.getBoundingClientRect().width / 595.28
    const drag = { lx1: 120, ly1: 120, lx2: 340, ly2: 260 }
    await dragOnPage(1, drag.lx1, drag.ly1, drag.lx2, drag.ly2)
    ok('S5 松开后提示「已放置图片」', toasts.slice(t1).some((t) => t.text.includes('已放置图片')), JSON.stringify(toasts.slice(t1)))
    ok('S5 放置后待放置标签消失', !byText('待放置', 'span'), '')
    ok('S5 onPendingChange 计入插入操作', m.pending() > 0, String(m.pending()))
    meta.insert = {
      scale,
      drag,
      expectedPdfRect: {
        x: drag.lx1 / scale,
        y: 841.89 - drag.ly2 / scale,
        width: (drag.lx2 - drag.lx1) / scale,
        height: (drag.ly2 - drag.ly1) / scale
      }
    }
    clickEl(mustByText('保存'))
    await waitFor('保存后按钮回到「已保存」', () => byText('已保存', 'button'), 20000)
    m.unmount()
  }

  /* ================= S6 交叉场景：改一行文字 + 删一张图，同时保存 ================= */
  {
    const m = await mount('cross')
    const runs = $$('div[title^="点一下改这一行"]') as HTMLElement[]
    ok('S6 页面加载出可点击文字行', runs.length > 0, String(runs.length))
    const targetRun = runs.find((r) => (r.getAttribute('title') || '').length > 0)!
    targetRun.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    await sleep(250)
    const input = await waitFor('文字编辑输入框', () => document.querySelector('input[placeholder^="输入新的文字"]') as HTMLInputElement | null)
    setReactInputValue(input, '交叉场景改后的文字 CROSSNEW')
    await sleep(100)
    clickEl(mustByText('确定'))
    await sleep(300)
    ok('S6 文字改动计入待保存数', m.pending() > 0, String(m.pending()))

    clickEl(mustByText('图片列表'))
    await waitFor('图片列表出现条目', () => (listItems().length ? listItems() : null), 20000)
    clickEl(listItems().find((b) => (b.textContent || '').includes('第 1 页 · #2'))!)
    await sleep(200)
    clickEl(mustByText('删除图片'))
    await sleep(600)
    const btnText = (mustByText('保存').textContent || '').trim()
    ok('S6 保存按钮同时报出文字与图片两类改动', btnText.includes('处文字') && btnText.includes('处图片'), btnText)
    clickEl(mustByText('保存'))
    await waitFor('保存后按钮回到「已保存」', () => byText('已保存', 'button'), 20000)
    m.unmount()
  }

  /* ================= S7 仅图片改动时 pendingCount 必须 > 0（离开守卫的输入条件） ================= */
  {
    const m = await mount('guard')
    ok('S7 刚打开时 pendingCount = 0', m.pending() === 0, String(m.pending()))
    clickEl(mustByText('图片列表'))
    await waitFor('图片列表出现条目', () => (listItems().length ? listItems() : null), 20000)
    clickEl(listItems()[0])
    await sleep(200)
    clickEl(mustByText('删除图片'))
    await sleep(600)
    ok('S7 只做图片改动（没碰文字）时 pendingCount > 0 → DocsViewer 的离开守卫据此弹确认', m.pending() > 0, 'pendingCount=' + m.pending())
    m.unmount()
  }

  return { rows, meta, fileClickLog, toasts }
}
