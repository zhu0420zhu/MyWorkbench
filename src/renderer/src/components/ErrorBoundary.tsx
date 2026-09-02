import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, Result } from 'antd'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** 页面级错误边界：渲染异常时降级展示，避免整应用白屏 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  private reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <Result
          status="error"
          title="页面出现异常"
          subTitle={this.state.error.message || '未知错误，请重试'}
          extra={[
            <Button type="primary" key="retry" onClick={this.reset}>
              重试
            </Button>,
            <Button key="reload" onClick={() => window.location.reload()}>
              重新加载应用
            </Button>
          ]}
        />
      )
    }
    return this.props.children
  }
}
