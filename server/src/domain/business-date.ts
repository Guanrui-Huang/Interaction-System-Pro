const BUSINESS_ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isBusinessIsoDate(value: string): boolean {
  const match = BUSINESS_ISO_DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > 31) return false;

  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function formatBusinessIsoDate(value: Date): string | undefined {
  if (Number.isNaN(value.getTime())) return undefined;
  const year = value.getUTCFullYear();
  const formatted = [
    String(year).padStart(4, '0'),
    String(value.getUTCMonth() + 1).padStart(2, '0'),
    String(value.getUTCDate()).padStart(2, '0'),
  ].join('-');
  return isBusinessIsoDate(formatted) ? formatted : undefined;
}

export function isBusinessDateRange(value: { from: string; to: string }): boolean {
  return isBusinessIsoDate(value.from) && isBusinessIsoDate(value.to) && value.from <= value.to;
}
