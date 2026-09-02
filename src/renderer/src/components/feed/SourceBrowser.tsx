import { useEffect, useRef, useState } from 'react'
import { Button, Input, Spin, Typography, message } from 'antd'
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CloseOutlined,
  ExportOutlined,
  ReloadOutlined
} from '@ant-design/icons'
import { BROWSER_OVERLAY, isValidHttpUrl } from './feedUtils'

/**
 * 内置浏览器（Electron <webview>）。
 * 由原「多媒体页」原样抽出：地址栏 + 前进/后退/刷新/外部打开 + 加载/失败 overlay。
 * url 为 null 时不渲染任何内容。
 */
export interface SourceBrowserProps {
  /** 要打开的 http(s) 地址；null = 关闭 */
  url: string | null
  /** 关闭回调（点击右上角 ×） */
  onClose: () => void
}

export default function SourceBrowser({ url, onClose }: SourceBrowserProps) {
  // 地址栏可编辑，故用内部 state 承载「当前地址」，外部 url 变化时同步
  const [currentUrl, setCurrentUrl] = useState<string | null>(url)
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [error, setError] = useState<string>('')
  // <webview> 无 TS 内置声明，运行时方法（goBack/goForward/reload）走 any 访问
  const webviewRef = useRef<any>(null)

  useEffect(() => {
    setCurrentUrl(url)
    if (url) {
      setError('')
      setState('loading')
    } else {
      setState('idle')
    }
  }, [url])

  // 监听内置浏览器加载状态（含失败兜底）
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || !currentUrl) return
    const onStart = (): void => setState('loading')
    const onStop = (): void => setState('ok')
    const onFail = (
      _e: unknown,
      _code: number,
      desc: string,
      _url: string,
      isMainFrame?: boolean
    ): void => {
      if (isMainFrame === false) return // 忽略子资源失败，避免误报
      setError(desc || '加载失败')
      setState('error')
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-fail-load', onFail)
    }
  }, [currentUrl])

  const openExternal = (u: string): void => {
    if (isValidHttpUrl(u)) void window.api.openExternal(u)
    else message.error('链接无效，无法在外部浏览器打开')
  }

  const nav = (action: 'back' | 'forward' | 'reload'): void => {
    const wv = webviewRef.current
    if (!wv) return
    if (action === 'back') wv.goBack()
    else if (action === 'forward') wv.goForward()
    else wv.reload()
  }

  if (!currentUrl) return null

  return (
    <div className="hot-browser">
      <div className="hot-browser-bar">
        <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => nav('back')} title="后退" />
        <Button
          size="small"
          icon={<ArrowRightOutlined />}
          onClick={() => nav('forward')}
          title="前进"
        />
        <Button size="small" icon={<ReloadOutlined />} onClick={() => nav('reload')} title="刷新" />
        <Input
          size="small"
          value={currentUrl}
          onChange={(e) => setCurrentUrl(e.target.value)}
          onPressEnter={() => {
            const u = (currentUrl ?? '').trim()
            if (!isValidHttpUrl(u)) {
              message.error('请输入有效的 http(s) 网址')
              return
            }
            setError('')
            setState('loading')
            setCurrentUrl(u)
          }}
          placeholder="输入网址后回车跳转"
          style={{ flex: 1, minWidth: 120 }}
          aria-label="浏览器地址栏"
        />
        <Button
          size="small"
          icon={<ExportOutlined />}
          onClick={() => openExternal(currentUrl ?? '')}
          title="外部浏览器打开"
        />
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} title="关闭" />
      </div>
      <div style={{ position: 'relative', flex: 1, display: 'flex', minHeight: 0 }}>
        <webview
          ref={webviewRef}
          src={currentUrl}
          style={{ flex: 1, width: '100%' }}
          allowpopups
          partition="persist:hotspots"
        />
        {state === 'loading' && (
          <div style={BROWSER_OVERLAY}>
            <Spin />
            <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
              加载中…
            </Typography.Text>
          </div>
        )}
        {state === 'error' && (
          <div style={BROWSER_OVERLAY}>
            <Typography.Text type="danger">内容加载失败{error ? `：${error}` : ''}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12, marginTop: 4 }}>
              部分站点会拦截内置浏览器，可改用外部浏览器打开。
            </Typography.Text>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <Button size="small" icon={<ReloadOutlined />} onClick={() => nav('reload')}>
                重试
              </Button>
              <Button
                size="small"
                icon={<ExportOutlined />}
                onClick={() => openExternal(currentUrl ?? '')}
              >
                用浏览器打开
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
