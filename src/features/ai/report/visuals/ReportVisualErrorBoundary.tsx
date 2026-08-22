import { Component, type ErrorInfo, type ReactNode } from 'react';

export class ReportVisualErrorBoundary extends Component<
  { label: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The UI intentionally exposes no model output, stack trace or private evidence metadata.
  }

  render() {
    if (this.state.failed) {
      return <p className="report-visual__error" role="alert">{this.props.label}暂时无法显示，请查看本页证据数据。</p>;
    }
    return this.props.children;
  }
}
