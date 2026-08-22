import '../../styles/global.css';
import { FloatingLinesBackground } from '../../components/FloatingLinesBackground';
import { GlassPanel } from '../../components/GlassPanel';

export function LoginPage({ onEnter }: { onEnter: () => void }) {
  function enterDashboard(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onEnter();
  }

  return <main className="app-background login-page">
    <FloatingLinesBackground />
    <div className="login-brand brand-lockup" aria-label="智慧污水处理厂">
      <div className="brand-mark" aria-hidden="true"><span>水</span></div>
      <div><h1 className="brand-name">智慧污水处理厂</h1><p className="brand-meta">AI 智能运营指挥中心</p></div>
    </div>
    <GlassPanel className="login-card" accent>
      <section className="login-identity" aria-label="系统接入说明">
        <div><div className="identity-icon" aria-hidden="true" /><h2 className="identity-title">系统接入</h2><p className="identity-copy">智慧污水处理厂运营指挥中心，仅限授权人员进入。</p></div>
        <div><p className="network-state">系统安全连接</p><p className="network-address">本地部署 · 运行状态正常</p></div>
      </section>
      <section className="login-form-area" aria-label="登录组件">
        <div className="login-tabs" role="tablist" aria-label="登录方式"><button type="button" role="tab" aria-selected="true" className="login-tab login-tab--active">账号登录</button><button type="button" role="tab" aria-selected="false" className="login-tab">扫码登录</button></div>
        <form className="login-form" onSubmit={enterDashboard}>
          <label className="field-label"><span>账号</span><input className="cyber-input" aria-label="账号" placeholder="请输入账号" autoComplete="username" /></label>
          <label className="field-label"><span>密码<a className="field-hint" href="#密码提示">忘记密码</a></span><input className="cyber-input" aria-label="密码" type="password" placeholder="请输入密码" autoComplete="current-password" /></label>
          <label className="remember-row"><input type="checkbox" />保持本次连接</label>
          <button className="enter-button" type="submit">进入智慧中枢</button>
        </form>
      </section>
    </GlassPanel>
    <footer className="login-footer"><span>本地部署版本 1.0</span><span>·</span><span>安全协议已启用</span></footer>
  </main>;
}
