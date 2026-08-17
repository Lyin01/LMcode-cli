import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Label used in logs and the fallback UI to identify which panel crashed. */
  name?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Contains render errors to a single panel. Without this, any malformed IPC
 * payload crashing one panel would unmount the whole app tree (and drop all
 * event subscriptions with it).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.name ? `: ${this.props.name}` : ''}]`, error, info)
  }

  private readonly handleRetry = () => {
    this.setState({ error: null })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertTriangle size={22} className="text-[var(--lm-error)]" />
          <p className="text-[14px] text-[var(--lm-text-secondary)]">
            {this.props.name ? `「${this.props.name}」` : ''}渲染出错：{error.message}
          </p>
          <button
            onClick={this.handleRetry}
            className="rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] px-3 py-1.5 text-[14px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
