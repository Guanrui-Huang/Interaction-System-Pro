import type { ReactNode, Ref } from 'react';
import '../styles/global.css';
import { AssistantTrigger } from './AssistantTrigger';
import { FloatingLinesBackground } from './FloatingLinesBackground';
import { TopNavigation, type NavigationPage } from './TopNavigation';

export function LayoutShell({ activePage, children, onNavigate, onOpenAi, assistantTriggerRef }: { activePage: NavigationPage; children: ReactNode; onNavigate?: (page: NavigationPage) => void; onOpenAi: () => void; assistantTriggerRef?: Ref<HTMLButtonElement> }) {
  return <div className="app-background layout-shell"><FloatingLinesBackground /><TopNavigation activePage={activePage} onNavigate={onNavigate} /><main className="layout-content">{children}</main><AssistantTrigger ref={assistantTriggerRef} onClick={onOpenAi} /></div>;
}
