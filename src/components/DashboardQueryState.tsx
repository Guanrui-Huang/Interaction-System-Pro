type DashboardQueryStateProps = {
  status: 'loading' | 'error';
  loadingMessage: string;
  onRetry: () => void;
};

export function DashboardQueryState({ status, loadingMessage, onRetry }: DashboardQueryStateProps) {
  if (status === 'loading') {
    return <div className="dashboard-loading" role="status">{loadingMessage}</div>;
  }

  return (
    <div className="dashboard-request-error" role="alert">
      <span aria-hidden="true">!</span>
      <div>
        <strong>运行数据加载失败</strong>
        <p>请检查本地数据服务连接后重新加载。</p>
      </div>
      <button type="button" onClick={onRetry}>重新加载</button>
    </div>
  );
}
