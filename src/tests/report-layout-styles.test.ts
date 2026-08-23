import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles/ai.css'), 'utf8');

it('keeps the thumbnail rail unchanged and widens only the conversation rail', () => {
  expect(css).toContain('--report-rail-width: clamp(10.5rem, 13vw, 15rem);');
  expect(css).toContain('--report-chat-width: clamp(18rem, 18vw, 20rem);');
  expect(css).toMatch(/grid-template-columns:\s*var\(--report-rail-width\)\s+minmax\(0,\s*1fr\)\s+var\(--report-chat-width\)/u);
});

it('uses content-sized opposing chat bubbles with a two-thirds user cap', () => {
  expect(css).toMatch(/\.report-conversation__message--user\s*\{[^}]*justify-self:\s*end;[^}]*inline-size:\s*fit-content;[^}]*max-inline-size:\s*66\.666%;/su);
  expect(css).toMatch(/\.report-conversation__message--assistant\s*\{[^}]*justify-self:\s*start;[^}]*inline-size:\s*fit-content;[^}]*max-inline-size:\s*100%;/su);
  expect(css).toMatch(/\.report-conversation__text\s*\{[^}]*overflow-wrap:\s*anywhere;/su);
});

it('uses a three-column header after moving the action cluster', () => {
  expect(css).toMatch(/\.report-header\s*\{[^}]*grid-template-columns:\s*minmax\(18rem,\s*1fr\)\s+max-content\s+max-content;/su);
});

it('preserves the exact narrow-screen single-column report layout', () => {
  const narrowStart = css.indexOf('@media (max-width: 899px)');
  const narrowEnd = css.indexOf('@media (max-width: 1180px)', narrowStart);
  const narrowCss = css.slice(narrowStart, narrowEnd);
  const narrowWorkspaceRule = narrowCss.match(/\.report-workspace\s*\{[^}]*\}/su)?.[0] ?? '';

  expect(narrowStart).toBeGreaterThanOrEqual(0);
  expect(narrowEnd).toBeGreaterThan(narrowStart);
  expect(narrowWorkspaceRule).toMatch(/grid-template-areas:\s*"header"\s+"rail"\s+"canvas"\s+"subtitle"\s+"chat";/u);
  expect(narrowWorkspaceRule).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
  expect(narrowWorkspaceRule).toMatch(/grid-template-rows:\s*auto\s+auto\s+minmax\(0,\s*1fr\)\s+auto\s+auto;/u);
});

it('keeps the composer toolbar compact and grouped', () => {
  expect(css).toMatch(/\.report-conversation__composer-toolbar\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*\.55rem;[^}]*min-width:\s*0;/su);
  expect(css).toMatch(/\.report-conversation__leading-controls,\s*\.report-conversation__composer-actions\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*\.28rem;[^}]*min-width:\s*0;/su);
  expect(css).toMatch(/\.report-narration-actions\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*\.28rem;[^}]*padding:\s*0\s+\.28rem;[^}]*margin:\s*0\s+\.08rem;[^}]*border-inline:\s*1px\s+solid\s+rgb\(111\s+175\s+192\s*\/\s*18%\);/su);
  expect(css).toMatch(/\.report-conversation__composer-toolbar button\s*\{[^}]*width:\s*31px;[^}]*min-width:\s*31px;[^}]*height:\s*31px;/su);
  expect(css).toMatch(/\.report-conversation__composer-toolbar button svg\s*\{[^}]*width:\s*17px;[^}]*height:\s*17px;/su);
});

it('keeps the mint send control contrasted through hover and focus', () => {
  const genericHoverStart = css.indexOf('.report-conversation__composer-toolbar button:hover:not(:disabled)');
  const mintStateStart = css.indexOf('.report-conversation__composer-actions button:last-child,');
  const mintStateEnd = css.indexOf('}', mintStateStart);
  const mintStateRule = css.slice(mintStateStart, mintStateEnd + 1);

  expect(genericHoverStart).toBeGreaterThanOrEqual(0);
  expect(mintStateStart).toBeGreaterThan(genericHoverStart);
  expect(mintStateRule).toMatch(/button:last-child:hover:not\(:disabled\)/u);
  expect(mintStateRule).toMatch(/button:last-child:focus-visible/u);
  expect(mintStateRule).toMatch(/color:\s*#07131b;/u);
  expect(mintStateRule).toMatch(/border-color:\s*transparent;/u);
  expect(mintStateRule).toMatch(/background:\s*var\(--report-mint\);/u);
});

it('uses the approved no-scroll 1920 dashboard geometry', () => {
  expect(css).toMatch(/\.report-workspace__canvas\s*\{[^}]*overflow:\s*hidden;/su);
  expect(css).toMatch(/\.report-slide--canvas\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/su);
  expect(css).toMatch(/\.report-data-dashboard\s*\{[^}]*grid-template-areas:\s*"metrics metrics"\s*"primary support";[^}]*grid-template-columns:\s*minmax\(0,\s*1\.7fr\)\s+minmax\(18rem,\s*1fr\);/su);
  expect(css).toMatch(/\.report-data-dashboard__metrics\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--report-summary-columns\),\s*minmax\(0,\s*1fr\)\);/su);
  expect(css).toMatch(/\.report-data-dashboard__support\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1\.7fr\)\s+minmax\(0,\s*1fr\);/su);
});

it('uses a compact two-row canvas with a floating subtitle and balanced dashboard heading', () => {
  expect(css).toMatch(/\.report-workspace\s*\{[^}]*grid-template-areas:\s*"header header header"\s+"rail canvas chat";[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\);/su);
  expect(css).toMatch(/\.report-workspace__canvas\s*\{[^}]*padding:\s*clamp\(10px,\s*1\.25vw,\s*20px\);/su);
  expect(css).toMatch(/\.report-slide--canvas\s*\{[^}]*gap:\s*clamp\(10px,\s*1\.35vw,\s*22px\);[^}]*padding:\s*clamp\(14px,\s*1\.65vw,\s*28px\);/su);
  expect(css).toMatch(/\.report-slide--visual-data-dashboard\.report-slide--canvas\s+\.report-slide__heading\s*\{[^}]*grid-template-columns:\s*max-content\s+minmax\(0,\s*1fr\);[^}]*grid-template-areas:\s*"meta title"\s+"takeaway takeaway";/su);
  expect(css).toMatch(/\.report-slide--visual-data-dashboard\.report-slide--canvas\s+\.report-slide__heading\s*>\s*p:first-child\s*\{[^}]*grid-area:\s*meta;/su);
  expect(css).toMatch(/\.report-slide--visual-data-dashboard\.report-slide--canvas\s+\.report-slide__heading\s+h2\s*\{[^}]*grid-area:\s*title;[^}]*text-wrap:\s*balance;/su);
  expect(css).toMatch(/\.report-slide--visual-data-dashboard\.report-slide--canvas\s+\.report-slide__takeaway\s*\{[^}]*grid-area:\s*takeaway;/su);
  expect(css).toMatch(/\.report-subtitle-bar\s*\{[^}]*position:\s*fixed;[^}]*pointer-events:\s*none;[^}]*background:\s*transparent;/su);
  expect(css).toMatch(/\.report-subtitle-bar__text\s*\{[^}]*color:\s*#fff;[^}]*text-align:\s*center;[^}]*text-shadow:/su);
  expect(css).toMatch(/\.report-subtitle-bar__status\s*\{[^}]*position:\s*absolute;[^}]*width:\s*1px;[^}]*height:\s*1px;/su);
});

it('pins the one-support dashboard at the 63/37 split with a single full-height support row', () => {
  expect(css).toMatch(/\.report-data-dashboard\[data-support-count="1"\]\s*\{[^}]*grid-template-areas:\s*"metrics metrics"\s*"primary support";[^}]*grid-template-columns:\s*minmax\(0,\s*1\.7fr\)\s+minmax\(18rem,\s*1fr\);[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\);/su);
  expect(css).toMatch(/\.report-data-dashboard\[data-support-count="1"\]\s+\.report-data-dashboard__support\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/su);
});

it('keeps dashboard panels and charts on the full-height propagation chain', () => {
  expect(css).toMatch(/\.report-data-dashboard__primary,\s*\.report-data-dashboard__support\s*>\s*section\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(min-content,\s*1fr\);[^}]*min-height:\s*0;/su);
  expect(css).not.toMatch(/\.report-data-dashboard__primary,\s*\.report-data-dashboard__support\s*>\s*section\s*\{[^}]*overflow:\s*hidden;/su);
  expect(css).toMatch(/\.report-data-dashboard__primary,\s*\.report-data-dashboard__support\s*>\s*section\s*\{[^}]*min-height:\s*0;/su);
  expect(css).toMatch(/\.report-slide--visual-data-dashboard\.report-slide--canvas\s+>\s+\.report-slide__visual\s+>\s+\.report-visual-renderer--canvas\s*\{[^}]*min-height:\s*0;[^}]*height:\s*100%;/su);
  expect(css).toMatch(/\.report-data-dashboard\s+\.report-visual-renderer,\s*\.report-data-dashboard\s+\.report-visual,\s*\.report-data-dashboard\s+\.report-visual__graphic\s*\{[^}]*min-height:\s*0;[^}]*height:\s*100%;/su);
  expect(css).toMatch(/\.report-data-dashboard\s+\.report-chart\s*\{[^}]*height:\s*100%;[^}]*max-height:\s*none;/su);
  expect(css).toMatch(/\.report-data-dashboard__support\s*>\s*section\[data-panel-kind=['"]comparison-bars['"]\]\s*\{[^}]*min-height:\s*13\.5rem;/su);
});

it('raises the desktop report readability scale without changing thumbnail sizing', () => {
  expect(css).toMatch(/\.report-slide--visual-data-dashboard\.report-slide--canvas\s*\{[^}]*padding-inline:\s*14px;/su);
  expect(css).toMatch(/\.report-data-dashboard__metrics\s*\{[^}]*gap:\s*\.3rem;/su);
  expect(css).toMatch(/\.report-data-dashboard__metric\s*\{[^}]*padding:\s*\.72rem\s+\.75rem;/su);
  expect(css).toMatch(/\.report-data-dashboard__metric\s+dt\s*\{[^}]*font-size:\s*\.94rem;/su);
  expect(css).toMatch(/\.report-data-dashboard__metric\s+strong\s*\{[^}]*font:\s*[^;}]*1\.8rem/isu);
  expect(css).toMatch(/\.report-data-dashboard__panel-label\s*\{[^}]*font-size:\s*\.94rem;/su);
  expect(css).toMatch(/\.report-visual-icon\s*\{[^}]*width:\s*1\.25rem;[^}]*height:\s*1\.25rem;/su);
  expect(css).toMatch(/\.report-visual-renderer--thumbnail\s+\.report-chart\s*\{[^}]*max-height:\s*78px;/su);
});

it('enforces desktop chart drawing bounds after panel labels and chrome consume the grid row', () => {
  expect(css).toMatch(/\.report-data-dashboard\s+\.report-chart--bars\s*\{[^}]*min-inline-size:\s*300px;[^}]*min-block-size:\s*180px;/su);
  expect(css).toMatch(/\.report-data-dashboard\s+\.report-chart--radar\s*\{[^}]*min-inline-size:\s*220px;[^}]*min-block-size:\s*220px;/su);
  expect(css).toMatch(/\.report-data-dashboard\s+\.report-chart--ring\s*\{[^}]*min-inline-size:\s*200px;[^}]*min-block-size:\s*200px;/su);
  expect(css).toMatch(/\.report-data-dashboard__primary,\s*\.report-data-dashboard__support\s*>\s*section\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(min-content,\s*1fr\);/su);
  expect(css).not.toMatch(/\.report-data-dashboard__primary,\s*\.report-data-dashboard__support\s*>\s*section\s*\{[^}]*overflow:\s*hidden;/su);
});

it('allocates two-support dashboards evenly so the ring keeps a square short-edge fit', () => {
  expect(css).toMatch(/\.report-data-dashboard\[data-support-count="2"\]\s+\.report-data-dashboard__support\s*\{[^}]*grid-template-rows:\s*minmax\(15rem,\s*1fr\)\s+minmax\(15rem,\s*1fr\);/su);
  expect(css).toMatch(/\.report-data-dashboard__primary,\s*\.report-data-dashboard__support\s*>\s*section\s*\{[^}]*container-type:\s*size;/su);
  expect(css).toMatch(/\.report-data-dashboard\s+\.report-visual__graphic\s*\{[^}]*height:\s*100%;[^}]*container-type:\s*size;/su);
  expect(css).toMatch(/\.report-data-dashboard\s+\.report-health-ring\s*\{[^}]*width:\s*min\(100%,\s*320px,\s*100cqb\);[^}]*height:\s*min\(100%,\s*320px,\s*100cqb\);/su);
});

it('exposes the desktop chart bounds through computed styles', () => {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const dashboard = document.createElement('div');
  dashboard.className = 'report-data-dashboard';
  document.body.append(dashboard);

  try {
    const minimums = [
      ['bars', 300, 180],
      ['radar', 220, 220],
      ['ring', 200, 200],
    ] as const;
    for (const [kind, inline, block] of minimums) {
      const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chart.setAttribute('class', `report-chart report-chart--${kind}`);
      dashboard.append(chart);
      const bounds = getComputedStyle(chart);
      expect(Number.parseFloat(bounds.minInlineSize)).toBe(inline);
      expect(Number.parseFloat(bounds.minBlockSize)).toBe(block);
    }
  } finally {
    dashboard.remove();
    style.remove();
  }
});

it('keeps health rings square and sized from their own panel bounds', () => {
  const healthRingRule = css.match(/\.report-health-ring\s*\{[^}]*\}/su)?.[0] ?? '';
  const ringSvgRule = css.match(/\.report-data-dashboard\s+\.report-chart--ring\s*\{[^}]*\}/su)?.[0] ?? '';

  expect(healthRingRule).toMatch(/width:\s*min\(100%,\s*320px\);/u);
  expect(healthRingRule).toMatch(/height:\s*auto;/u);
  expect(healthRingRule).toMatch(/aspect-ratio:\s*1\s*\/\s*1;/u);
  expect(healthRingRule).toMatch(/container-type:\s*inline-size;/u);
  expect(healthRingRule).toMatch(/margin:\s*auto;/u);
  expect(ringSvgRule).toMatch(/width:\s*100%;/u);
  expect(ringSvgRule).toMatch(/height:\s*auto;/u);
  expect(ringSvgRule).toMatch(/aspect-ratio:\s*1\s*\/\s*1;/u);
  expect(ringSvgRule).toMatch(/min-inline-size:\s*200px;/u);
  expect(ringSvgRule).toMatch(/min-block-size:\s*200px;/u);
  expect(css).toMatch(/\.report-health-ring__label\s+strong\s*\{[^}]*font:\s*[^;}]*clamp\(2\.5rem,\s*18cqi,\s*4\.5rem\)/isu);
});

it('keeps the narration status visually hidden on mobile while retaining the subtitle grid area', () => {
  const mobileStart = css.indexOf('@media (max-width: 899px)');
  const mobileEnd = css.indexOf('@media (max-width: 1180px)', mobileStart);
  const mobileCss = css.slice(mobileStart, mobileEnd);

  expect(mobileStart).toBeGreaterThanOrEqual(0);
  expect(mobileCss).toMatch(/\.report-subtitle-bar\s*\{[^}]*grid-area:\s*subtitle;/su);
  expect(mobileCss).toMatch(/\.report-subtitle-bar__status\s*\{[^}]*position:\s*absolute;[^}]*width:\s*1px;[^}]*height:\s*1px;[^}]*clip:\s*rect\(0,\s*0,\s*0,\s*0\);/su);
});

it('keeps the desktop subtitle as one centered non-interactive line above evidence', () => {
  expect(css).toMatch(/\.report-subtitle-bar\s*\{[^}]*bottom:\s*clamp\(4\.5rem/isu);
  expect(css).toMatch(/\.report-subtitle-bar\s*\{[^}]*pointer-events:\s*none;/su);
  expect(css).toMatch(/\.report-subtitle-bar__text\s*\{[^}]*max-width:\s*min\(72ch,\s*calc\(100%\s*-\s*2rem\)\);[^}]*white-space:\s*nowrap;/su);
  const subtitleRule = css.match(/\.report-subtitle-bar__text\s*\{[^}]*\}/su)?.[0] ?? '';
  expect(subtitleRule).not.toMatch(/(?:^|;)\s*overflow:\s*hidden;/u);
  expect(subtitleRule).not.toMatch(/text-overflow:\s*ellipsis;/u);
});
