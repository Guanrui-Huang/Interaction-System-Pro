# 报告图表可读性与指标均衡布局实施计划

> **执行要求：** 实施本计划时使用 `test-driven-development`，逐任务先写失败测试；涉及界面细节时遵循 `impeccable` 的 craft floor；声称完成前使用 `verification-before-completion`。

**目标：** 在 1920×1080 报告大屏中让 8 个指标卡保持单行、辅助图标签清晰、同图指标不撞色，并让雷达图真实分数可见且差异更易辨认。

**架构：** 在数据看板边界建立共享的指标配色上下文，趋势图和条形图按指标键取色；独立原子图则建立局部有序配色。指标卡列数和雷达展示半径分别抽成纯函数，以便用单元测试锁定均衡布局与轻度差异增强。CSS 仅放大画布辅助图标签并压紧 8 列卡片，不改变缩略图和既有指标文字字号。

**技术栈：** React 19、TypeScript、D3、CSS、Vitest + Testing Library、Playwright。

---

## 执行前约束

- 工作分支为 `main`；保留并且不要暂存用户已有改动：
  - `.superpowers/sdd/task-1-report.md`
  - `server/.env.example`
- 在第一次编辑界面文件前完整读取：

```bash
sed -n '1,260p' /Users/xiaoshen001/.codex/skills/impeccable/reference/craft-floor.md
```

- 每个任务只暂存该任务列出的文件；不要使用 `git add .`。
- 下列文档目录被 gitignore 忽略，添加计划文档时使用 `git add -f`。

## 任务 1：建立不撞色的共享指标调色板

**文件：**

- 修改：`src/charts/chart-theme.ts`
- 新建：`src/features/ai/report/visuals/ReportChartThemeContext.tsx`
- 修改：`src/features/ai/report/visuals/DataDashboardVisual.tsx`
- 修改：`src/features/ai/report/visuals/TrendVisual.tsx`
- 修改：`src/features/ai/report/visuals/ComparisonBarsVisual.tsx`
- 测试：`src/tests/chart-theme.test.ts`
- 测试：`src/tests/report-visuals.test.tsx`

### 步骤 1：先写调色板失败测试

将 `chart-theme.test.ts` 的“7 色”断言改为 8 色，并新增有序分配测试：

```ts
import { chartThemesForMetrics, CHART_THEME } from '../charts/chart-theme';

it('provides eight distinct report gradients', () => {
  expect(CHART_THEME.bars).toHaveLength(8);
  expect(new Set(CHART_THEME.bars.map(({ family }) => family)).size).toBe(8);
});

it('allocates stable unique themes in first-seen order', () => {
  const themes = chartThemesForMetrics([
    { key: 'quality', label: '出水水质得分' },
    { key: 'energy', label: '电耗得分' },
    { key: 'carbonEmission', label: '碳排放量' },
    { key: 'carbonReduction', label: '碳减排量' },
    { key: 'quality', label: '出水水质得分' },
  ]);

  expect(themes.get('quality')?.family).toBe('water');
  expect(themes.get('energy')?.family).toBe('treatment');
  expect(themes.get('carbonEmission')?.family)
    .not.toBe(themes.get('carbonReduction')?.family);
  expect(themes.get('quality')).toEqual(CHART_THEME.bars[0]);
});
```

在 `report-visuals.test.tsx` 增加组合看板测试：同一个指标在趋势线和条形柱上的 `data-series-theme` / `data-bar-theme` 相同，同一条形图的不同 `data-metric-key` 主题唯一；另加一个独立条形图用例，确认两个“碳”指标不再同时为粉色。

### 步骤 2：运行测试并确认失败

```bash
pnpm vitest run src/tests/chart-theme.test.ts src/tests/report-visuals.test.tsx
```

预期：因缺少第八主题、`chartThemesForMetrics`、配色 context 与指标数据属性而失败。

### 步骤 3：实现纯调色板分配器

在 `chart-theme.ts`：

- `BarThemeFamily` 增加 `signal`。
- 在现有 7 色后增加珊瑚渐变，例如 `#C94B31 → #FF714D`。
- 导出 `BarTheme`、`ChartMetricIdentity`。
- 新增纯函数，前 8 个首次出现的键依次分配 8 个主题；重复键复用原主题：

```ts
export function chartThemesForMetrics(metrics: readonly ChartMetricIdentity[]) {
  const themes = new Map<string, BarTheme>();
  for (const metric of metrics) {
    if (themes.has(metric.key)) continue;
    themes.set(metric.key, BAR_THEMES[themes.size % BAR_THEMES.length]!);
  }
  return themes;
}
```

保留 `barThemeForMetric()` 供单指标和旧调用使用，不再让多指标图直接依靠语义匹配决定所有颜色。

### 步骤 4：实现看板配色上下文

新建 `ReportChartThemeContext.tsx`，包含：

- `metricIdentitiesForAtomicVisual(visual)`：从 trend、bars、ring、radar、scatter、kpi 中提取 `{ key, label }`。
- `ReportChartThemeProvider`：接收按首次出现顺序整理的指标集合并缓存 `Map`。
- `useReportChartThemes(metrics)`：优先读看板 Map；没有 provider 时为当前图创建局部有序 Map；单指标缺省时再调用 `barThemeForMetric()`。

`DataDashboardVisual` 的完整画布模式按以下顺序收集指标：

```ts
const paletteMetrics = [
  ...visual.summaryMetrics,
  ...metricIdentitiesForAtomicVisual(visual.primary),
  ...supporting.flatMap(metricIdentitiesForAtomicVisual),
];
```

用 provider 包住摘要、主图与辅助图。缩略图也通过局部图表配色路径渲染，但不改变缩略图布局。

### 步骤 5：迁移趋势图和条形图

- `TrendVisual` 一次调用 `useReportChartThemes(visual.series)`，渲染 defs、图例和线条时复用同一数组。
- `ComparisonBarsVisual` 一次调用 `useReportChartThemes(visual.items)`。
- 在线条和柱子上分别增加 `data-metric-key={item.key}`，保留已有主题数据属性以便验收。
- 同图前两项必须是青蓝、蓝绿；第 3 项后按已确认色板继续分配。

### 步骤 6：运行测试并提交

```bash
pnpm vitest run src/tests/chart-theme.test.ts src/tests/report-visuals.test.tsx
git add src/charts/chart-theme.ts src/features/ai/report/visuals/ReportChartThemeContext.tsx src/features/ai/report/visuals/DataDashboardVisual.tsx src/features/ai/report/visuals/TrendVisual.tsx src/features/ai/report/visuals/ComparisonBarsVisual.tsx src/tests/chart-theme.test.ts src/tests/report-visuals.test.tsx
git commit -m "feat: coordinate report chart colors"
```

## 任务 2：让 8 个指标单行并均衡防御性换行

**文件：**

- 修改：`src/features/ai/report/visuals/DataDashboardVisual.tsx`
- 修改：`src/styles/ai.css`
- 测试：`src/tests/report-visuals.test.tsx`
- 测试：`src/tests/report-layout-styles.test.ts`

### 步骤 1：先写列数算法失败测试

从 `DataDashboardVisual.tsx` 导出 `summaryGridForMetricCount()`，在组件测试中覆盖：

```ts
it.each([
  { count: 7, columns: 7, rows: 1 },
  { count: 8, columns: 8, rows: 1 },
  { count: 9, columns: 5, rows: 2 },
  { count: 10, columns: 6, rows: 2 },
  { count: 11, columns: 7, rows: 2 },
  { count: 12, columns: 7, rows: 2 },
  { count: 13, columns: 8, rows: 2 },
  { count: 16, columns: 8, rows: 2 },
])('balances $count metrics as $columns columns', ({ count, columns, rows }) => {
  expect(summaryGridForMetricCount(count)).toEqual({ columns, rows });
});
```

把原来的“8 个指标为 7 列 2 行”DOM 断言改成 8 列 1 行。

在样式合同测试中新增断言：8 列仅收紧 gap、卡片横向 padding 和 `dd` 间距，`.report-data-dashboard__metric dt` 与 `strong` 字号仍为 `.94rem`、`1.8rem`；标签允许自然换行。

### 步骤 2：确认失败

```bash
pnpm vitest run src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts
```

预期：固定 7 列逻辑和缺少 8 列样式钩子导致失败。

### 步骤 3：实现均衡算法

算法保持最多 8 列，并只接受“第二行数量严格超过第一行一半”的两行结果：

```ts
export function summaryGridForMetricCount(metricCount: number) {
  const count = Math.max(0, Math.floor(metricCount));
  if (count <= 8) return { columns: Math.max(count, 1), rows: count === 0 ? 0 : 1 };

  for (let columns = 8; columns >= 1; columns -= 1) {
    const secondRow = count - columns;
    if (secondRow <= columns && secondRow > columns / 2) return { columns, rows: 2 };
  }
  return { columns: 8, rows: Math.ceil(count / 8) };
}
```

组件继续输出 `--report-summary-columns`、`data-summary-columns` 和 `data-summary-rows`。

### 步骤 4：收紧 8 列卡片但不缩字

在 `ai.css` 增加只针对 `data-summary-columns="8"` 的规则：

- gap 由 `.3rem` 微调为约 `.24rem`。
- 卡片左右 padding 从 `.75rem` 微调到约 `.55rem`。
- `dt` 保持 `.94rem`，`strong` 保持 `1.8rem`。
- `dt span` 使用 `min-width: 0; overflow-wrap: anywhere; line-height: 1.25`，允许长名称在卡片内部换行。
- `dd` 可收紧 gap，但数字和单位不能互相遮挡或越界。

### 步骤 5：运行测试并提交

```bash
pnpm vitest run src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts
git add src/features/ai/report/visuals/DataDashboardVisual.tsx src/styles/ai.css src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts
git commit -m "fix: balance dense report metric rows"
```

## 任务 3：放大辅助图标签并增强雷达差异

**文件：**

- 修改：`src/features/ai/report/visuals/RadarVisual.tsx`
- 修改：`src/features/ai/report/visuals/HealthRingVisual.tsx`
- 修改：`src/styles/ai.css`
- 测试：`src/tests/report-visuals.test.tsx`
- 测试：`src/tests/report-layout-styles.test.ts`

### 步骤 1：先写雷达与环形失败测试

在 `report-visuals.test.tsx` 新增：

1. 雷达每个轴都有 `.report-radar__axis-value`，文本为原始值和单位。
2. 雷达不存在中心总分元素。
3. 导出的 `emphasizeRadarRatios()` 对 `[96, 90, 94] / 100` 保持排序，增强后的最大最小差大于原差；相同分数保持相同半径；低于 80 的值仍在 `0...1` 范围正常绘制。
4. 单位为 `分` 的健康环没有 `.report-health-ring__unit`；单位为 `%` 的环仍显示 `%`。

示例：

```ts
const emphasized = emphasizeRadarRatios([
  { value: 96, maximum: 100 },
  { value: 90, maximum: 100 },
  { value: 72, maximum: 100 },
]);
expect(emphasized[0]! - emphasized[2]!).toBeGreaterThan(.24);
expect(emphasized.every((ratio) => ratio >= 0 && ratio <= 1)).toBe(true);
```

在样式合同测试中先把条形图预期提高到 18px，并为辅助面板轴标签、雷达端点分数、环形名称增加明确字号断言；缩略图隐藏规则必须继续存在。

### 步骤 2：确认失败

```bash
pnpm vitest run src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts
```

预期：雷达无端点分数、无差异增强函数，环形仍显示“分”，CSS 仍为 14/15px。

### 步骤 3：实现雷达轻度差异增强

在 `RadarVisual.tsx` 导出纯函数：

```ts
export function emphasizeRadarRatios(
  axes: readonly Pick<RadarSpec['axes'][number], 'value' | 'maximum'>[],
  factor = 1.8,
) {
  const ratios = axes.map(({ value, maximum }) =>
    Math.max(0, Math.min(1, value / Math.max(maximum, 1))),
  );
  const mean = ratios.reduce((sum, value) => sum + value, 0) / Math.max(ratios.length, 1);
  return ratios.map((ratio) => Math.max(0, Math.min(1, mean + (ratio - mean) * factor)));
}
```

- 仅使用返回值计算 polygon/path/circle 的半径。
- 文本和无障碍表格始终使用 `axis.value` 原始值。
- 在每个真实几何端点附近渲染单独的 `.report-radar__axis-value`，内容为 `${formatReportNumber(axis.value)} ${axis.unit}`。
- 维度名继续放在外圈；根据端点在左、右或中间设置 `textAnchor`，避免文字被 360×360 viewBox 裁切。
- 为端点 circle 添加原始值及展示比例 `data-*`，便于浏览器验收。

### 步骤 4：移除评分环中的“分”并提高标签级别

`HealthRingVisual` 只在单位不是 `分` 时渲染：

```tsx
{visual.metric.unit?.trim() !== '分' && (
  <span className="report-health-ring__unit">{visual.metric.unit ?? '—'}</span>
)}
```

保留主数字、指标名称、aria label 和数据表中的真实单位。

`ai.css` 调整：

- 条形图柱顶数值和底部标签均为 18px。
- 看板辅助面板中的通用轴标签提高到约 16px。
- 雷达端点分数约 15px，颜色比网格和维度名更亮。
- 环形指标名称约 14px；非评分单位约 13px。
- 不改 `.report-visual-renderer--thumbnail` 的隐藏/缩放规则。

### 步骤 5：运行测试并提交

```bash
pnpm vitest run src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts
git add src/features/ai/report/visuals/RadarVisual.tsx src/features/ai/report/visuals/HealthRingVisual.tsx src/styles/ai.css src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts
git commit -m "fix: clarify auxiliary chart labels"
```

## 任务 4：增加 1920×1080 浏览器回归

**文件：**

- 修改：`e2e/dashboard.spec.ts`

### 步骤 1：扩充 mocked 报告 fixture 并先写失败断言

- 将现有大屏密集页从 7 个摘要指标扩为 8 个。
- 使用包含两个不同“碳”指标的条形辅助图，验证不再同色。
- 新增或更新测试名：`keeps eight metrics and auxiliary labels readable at 1920x1080`。

浏览器断言应覆盖：

```ts
await expect(summaryMetrics).toHaveCount(8);
expect(new Set(cardTopValues)).toHaveLength(1);
await expect(dashboard).toHaveAttribute('data-summary-columns', '8');
await expect(dashboard).toHaveAttribute('data-summary-rows', '1');
expect(new Set(barThemes).size).toBe(barThemes.length);
expect(parseFloat(getComputedStyle(barAxisLabel).fontSize)).toBeGreaterThanOrEqual(18);
```

另检查：所有卡片和图表边界位于报告画布内，辅助图底部标签位于证据线之上，页面无横向或纵向滚动。8 列卡片允许略窄，不再沿用 7 列时代的最小宽度阈值；以不溢出且文字字号不变为准。

### 步骤 2：运行该用例并确认失败

```bash
pnpm exec playwright test e2e/dashboard.spec.ts --project=mocked --grep "keeps eight metrics and auxiliary labels readable"
```

### 步骤 3：根据真实浏览器几何做最小修正

只允许微调本计划涉及的 8 列 padding/gap、辅助标签偏移和雷达端点标签位置。不得缩小指标卡字体，不得改变标题、字幕或证据线布局。

### 步骤 4：再次运行并提交

```bash
pnpm exec playwright test e2e/dashboard.spec.ts --project=mocked --grep "keeps eight metrics and auxiliary labels readable"
git add e2e/dashboard.spec.ts src/styles/ai.css src/features/ai/report/visuals/RadarVisual.tsx
git commit -m "test: cover eight-card report chart polish"
```

如果步骤 3 未改 `src/styles/ai.css` 或 `RadarVisual.tsx`，不要把它们加入该提交。

## 任务 5：完整验证与视觉审计

### 步骤 1：运行聚焦测试

```bash
pnpm vitest run src/tests/chart-theme.test.ts src/tests/report-visuals.test.tsx src/tests/report-layout-styles.test.ts
```

### 步骤 2：运行构建

```bash
pnpm run build
```

### 步骤 3：运行 mocked E2E

```bash
pnpm run test:e2e:mocked
```

### 步骤 4：运行 Impeccable 静态检测

```bash
node /Users/xiaoshen001/.codex/skills/impeccable/scripts/detect.mjs --json src/charts/chart-theme.ts src/features/ai/report/visuals src/styles/ai.css
```

逐项处理与本次改动有关的可访问性、溢出、硬编码或视觉一致性问题；无关历史告警记录在交付说明中，不扩大本次范围。

### 步骤 5：检查工作区与提交记录

```bash
git status --short
git log --oneline -6
```

预期：只剩用户原有的 `.superpowers/sdd/task-1-report.md`、`server/.env.example` 改动；本次生产代码、测试和文档均已提交。

## 完成定义

- 8 个摘要指标在 1920×1080 同一行完整显示，字号未缩小。
- 9–16 个防御性输入按已确认规则均衡分两行。
- 同图不同指标颜色唯一，前两项为青蓝、蓝绿；同一指标跨趋势图和条形图保持同色。
- 条形、雷达、环形等辅助图标签达到大屏可读尺度且不越过证据线。
- 雷达每个端点显示真实维度分数，几何差异按 1.8 倍轻度增强并支持低于 80 分。
- 健康评分环中央不再显示单独“分”字，非评分单位仍保留。
- 聚焦 Vitest、构建、完整 mocked Playwright 和 Impeccable 检测通过。
