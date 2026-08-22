const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

export function formatMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  if (Math.abs(value) >= 10_000) return `${numberFormat.format(value / 10_000)} 万元`;
  return `${numberFormat.format(value)} 元`;
}
