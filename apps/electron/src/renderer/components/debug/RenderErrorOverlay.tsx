/**
 * RenderErrorOverlay：临时调试用 —— 把 React 渲染错误显示在屏幕上，
 * 而不是让 Error Boundary 卸载整树（白屏）。定位后删除。
 */

import * as React from 'react'

interface State {
  error: Error | null
  componentStack: string | null
}

let externalPush: ((err: Error, stack: string) => void) | null = null

/** 全局接收错误：从 window 上接收。供 main.tsx 在 catch 后调用。 */
export function pushRenderError(error: Error, componentStack?: string): void {
  externalPush?.(error, componentStack ?? '')
}

export class RenderErrorOverlay extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { error: null, componentStack: null }

  override componentDidMount(): void {
    externalPush = (err, stack) => this.setState({ error: err, componentStack: stack })
  }

  override componentWillUnmount(): void {
    externalPush = null
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[RenderErrorOverlay]', error, info.componentStack)
    this.setState({ error, componentStack: info.componentStack ?? null })
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    const stack = this.state.componentStack ?? ''
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.85)',
          color: '#ff6b6b',
          padding: 24,
          fontFamily: 'ui-monospace, Menlo, monospace',
          fontSize: 13,
          whiteSpace: 'pre-wrap',
          overflow: 'auto',
          zIndex: 99999,
        }}
      >
        <div style={{ color: '#fff', fontSize: 18, fontWeight: 700, marginBottom: 12 }}>
          React Render Error (debug overlay)
        </div>
        <div style={{ color: '#ff6b6b', fontWeight: 600 }}>{this.state.error.name}: {this.state.error.message}</div>
        <pre style={{ color: '#ddd', marginTop: 8 }}>{this.state.error.stack}</pre>
        {stack ? <pre style={{ color: '#aaa', marginTop: 12 }}>{stack}</pre> : null}
      </div>
    )
  }
}
