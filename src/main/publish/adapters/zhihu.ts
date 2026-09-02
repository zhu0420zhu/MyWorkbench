/* 知乎适配器（半自动，免签名）：
 * 知乎 Web 发布接口含 x-zse-96 签名（主进程无法生成），
 * 采用打开创作中心文章编辑页 + DOM 注入标题/正文的方式（存草稿模式），
 * 用户确认后手动发布 —— 规避签名与风控 */
import { BrowserWindow } from 'electron'
import type { PlatformAdapter, PublishContext, PublishResult } from '../adapter.ts'
import { sessionFetch } from './fetch.ts'

const PLATFORM_PARTITION = 'persist:platforms'
const EDITOR_URL = 'https://www.zhihu.com/creator/manage/creation/edit?type=article'

const INJECT_SCRIPT = (title: string, content: string): string => `
(function () {
  const setNative = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  const fire = (el, ev) => el.dispatchEvent(new Event(ev, { bubbles: true }));
  // 标题：创作页标题输入框（textarea）
  let done = false;
  const inputs = document.querySelectorAll('textarea');
  for (const el of inputs) {
    const ph = el.getAttribute('placeholder') || '';
    if (ph.includes('标题') || ph.includes('Title')) {
      setNative.call(el, ${JSON.stringify(title)});
      fire(el, 'input');
      done = true;
      break;
    }
  }
  if (!done && inputs.length > 0) {
    setNative.call(inputs[0], ${JSON.stringify(title)});
    fire(inputs[0], 'input');
  }
  // 正文：富文本编辑器（contenteditable）
  const editors = document.querySelectorAll('[contenteditable="true"]');
  if (editors.length > 0) {
    const ed = editors[0];
    ed.focus();
    ed.textContent = ${JSON.stringify(content)};
    fire(ed, 'input');
    fire(ed, 'change');
  }
  return true;
})()
`

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const zhihuAdapter: PlatformAdapter = {
  id: 'zhihu',
  name: '知乎',
  loginUrl: 'https://www.zhihu.com/signin',
  status: 'ready',
  modeLabel: '半自动存草稿（打开创作页并填入内容，确认后发布）',

  async checkLogin(ctx) {
    try {
      const res = await sessionFetch(ctx, 'https://www.zhihu.com/api/v4/me')
      if (!res.ok) return false
      const json = (await res.json()) as { id?: string }
      return Boolean(json?.id)
    } catch {
      return false
    }
  },

  async publish(input, _ctx): Promise<PublishResult> {
    const win = new BrowserWindow({
      width: 1100,
      height: 760,
      title: '知乎 · 文章编辑（确认后发布）',
      autoHideMenuBar: true,
      webPreferences: { partition: PLATFORM_PARTITION, contextIsolation: true }
    })
    try {
      await win.loadURL(EDITOR_URL)
      // 等待页面与编辑器渲染
      await delay(5000)
      await win.webContents.executeJavaScript(INJECT_SCRIPT(input.title, input.content))
      return {
        ok: true,
        platformId: 'zhihu',
        mode: 'draft',
        error: '已打开知乎创作页并填入内容，请确认无误后手动发布',
        publishedAt: Date.now()
      }
    } catch (err) {
      win.destroy()
      return { ok: false, platformId: 'zhihu', error: `打开知乎创作页失败: ${(err as Error).message}` }
    }
  }
}
