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

it('stacks dashboard metrics, primary and support regions at an 820px viewport', () => {
  const narrowStart = css.indexOf('@media (max-width: 899px)');
  const narrowEnd = css.indexOf('@media (max-width: 1180px)', narrowStart);
  const narrowCss = css.slice(narrowStart, narrowEnd);

  expect(narrowStart).toBeGreaterThanOrEqual(0);
  expect(narrowEnd).toBeGreaterThan(narrowStart);
  expect(820).toBeLessThanOrEqual(899);
  expect(narrowCss).toMatch(/\.report-data-dashboard,\s*\.report-data-dashboard\[data-support-count="1"\]\s*\{[^}]*grid-template-areas:\s*"metrics"\s+"primary"\s+"support";[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/su);
  expect(narrowCss).toMatch(/\.report-data-dashboard\[data-support-count="0"\]\s*\{[^}]*grid-template-areas:\s*"metrics"\s+"primary";/su);
  expect(narrowCss).toMatch(/\.report-data-dashboard__support\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/su);
});
