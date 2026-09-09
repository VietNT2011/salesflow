import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // F00 deliberately logs no component props because future screens may contain PII.
    console.error('Application render failed', {
      name: error.name,
      componentStack: info.componentStack,
    });
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="fatal-error">
          <p className="eyebrow">SalesFlow</p>
          <h1>Không thể hiển thị trang</h1>
          <p>Hãy tải lại trang. Nếu lỗi vẫn còn, gửi mã yêu cầu cho quản trị viên.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Tải lại
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
