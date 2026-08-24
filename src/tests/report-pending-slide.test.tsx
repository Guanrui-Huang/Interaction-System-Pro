import { render, screen, within } from '@testing-library/react';
import type { SlideOutline } from '../../shared/report';
import { ReportPendingSlideView } from '../features/ai/report/ReportPendingSlideView';

const pendingOutline: SlideOutline = {
  id: 'slide-1',
  order: 0,
  title: '总氮与能耗综合分析',
  purpose: '说明关键变化',
  role: 'answer',
  layout: 'visual-focus',
  evidencePolicy: 'data',
  visualKind: 'trend-line',
  evidenceKeys: ['tn'],
  status: 'generating',
};

it('renders canvas and thumbnail structures without fabricated content', () => {
  const { container } = render(
    <>
      <ReportPendingSlideView mode="canvas" />
      <ReportPendingSlideView mode="thumbnail" />
    </>,
  );

  expect(container.querySelector('[data-slide-state="pending"][data-slide-mode="canvas"]')).toBeInTheDocument();
  expect(container.querySelector('[data-slide-state="pending"][data-slide-mode="thumbnail"]')).toBeInTheDocument();
  expect(screen.queryByText('分析中')).not.toBeInTheDocument();
  expect(screen.queryByText(/\d+(?:\.\d+)?\s*(?:mg\/L|分|%)/u)).not.toBeInTheDocument();
});

it('uses only real outline metadata in the pending canvas', () => {
  const { container } = render(<ReportPendingSlideView outline={pendingOutline} mode="canvas" />);

  const canvas = container.querySelector('[data-slide-state="pending"][data-slide-mode="canvas"]');
  expect(canvas).not.toBeNull();
  expect(within(canvas as HTMLElement).getByRole('heading', { name: '总氮与能耗综合分析' })).toBeVisible();
  expect(canvas?.querySelectorAll('[data-pending-module]').length).toBeGreaterThanOrEqual(3);
  expect(within(canvas as HTMLElement).queryByText('生成中')).not.toBeInTheDocument();
});
