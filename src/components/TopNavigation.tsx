import type { BusinessPage } from '../../shared/dashboard';

export type NavigationPage = BusinessPage;

const pages = [
  { id: 'overview', label: '运行总览' },
  { id: 'health', label: '健康指数得分' },
  { id: 'water-quality', label: '出水水质' },
  { id: 'energy', label: '节能降耗' }
] satisfies Array<{ id: NavigationPage; label: string }>;

export function TopNavigation({ activePage, onNavigate }: { activePage: NavigationPage; onNavigate?: (page: NavigationPage) => void }) {
  return <header className="top-navigation">
    <div className="brand-lockup" aria-label="智慧污水处理厂">
      <div className="brand-mark" aria-hidden="true"><span>水</span></div>
      <div><p className="brand-name">智慧污水处理厂</p><p className="brand-meta">AI 智能运营指挥中心</p></div>
    </div>
    <nav className="nav-links" aria-label="主导航">
      {pages.map((page) => <button key={page.id} type="button" className="nav-link" aria-current={activePage === page.id ? 'page' : undefined} onClick={() => onNavigate?.(page.id)}>{page.label}</button>)}
    </nav>
    <p className="system-meta">运行稳定 · 数据实时同步</p>
  </header>;
}
