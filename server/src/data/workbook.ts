import XLSX from 'xlsx';
import type {
  AlertLevel,
  AlertRecord,
  DailyReading,
  DashboardDataset,
} from '../../../shared/dashboard';
import { WATER_QUALITY_METRICS } from '../../../shared/dashboard';
import { calculateHealth } from '../domain/health';
import { formatBusinessIsoDate, isBusinessIsoDate } from '../domain/business-date';

const DAILY_SHEET = '日度总览';
const WATER_QUALITY_SHEET = '出水水质';
const ENERGY_SHEET = '能效费用';
const HEALTH_SHEET = '健康指数';
const ALERT_SHEET = '预警记录';

type SpreadsheetRow = Record<string, unknown>;

function getSheetRows(workbook: XLSX.WorkBook, name: string): SpreadsheetRow[] {
  const sheet = workbook.Sheets[name];
  if (!sheet) {
    throw new Error(`WORKBOOK_SHEET_MISSING:${name}`);
  }
  return XLSX.utils.sheet_to_json<SpreadsheetRow>(sheet, { defval: null, raw: true });
}

function asNumber(value: unknown, field: string, row: number): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(result)) {
    throw new Error(`WORKBOOK_INVALID_NUMBER:${field}:${row}`);
  }
  return result;
}

function asText(value: unknown, field: string, row: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`WORKBOOK_INVALID_TEXT:${field}:${row}`);
  }
  return value.trim();
}

function asDate(value: unknown, row: number): string {
  if (typeof value === 'string' && isBusinessIsoDate(value)) {
    return value;
  }
  if (value instanceof Date) {
    const formatted = formatBusinessIsoDate(value);
    if (formatted) return formatted;
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      const formatted = `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
      if (isBusinessIsoDate(formatted)) return formatted;
    }
  }
  throw new Error(`WORKBOOK_INVALID_DATE:date:${row}`);
}

type DatedRow = { row: SpreadsheetRow; rowNumber: number };

function rowsByDate(rows: SpreadsheetRow[], sheet: string): Map<string, DatedRow> {
  const result = new Map<string, DatedRow>();
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const date = asDate(row.date, rowNumber);
    if (result.has(date)) {
      throw new Error(`WORKBOOK_DATE_DUPLICATE:${sheet}:${date}`);
    }
    result.set(date, { row, rowNumber });
  });
  return result;
}

function matchingRow(rows: Map<string, DatedRow>, sheet: string, date: string): DatedRow {
  const row = rows.get(date);
  if (!row) {
    throw new Error(`WORKBOOK_DATE_MISMATCH:${sheet}:${date}`);
  }
  return row;
}

function validateDateSet(rows: Map<string, DatedRow>, dates: Set<string>, sheet: string): void {
  for (const date of rows.keys()) {
    if (!dates.has(date)) {
      throw new Error(`WORKBOOK_DATE_MISMATCH:${sheet}:${date}`);
    }
  }
}

function toDailyReading(
  overview: DatedRow,
  waterQuality: DatedRow,
  energy: DatedRow,
  health: DatedRow,
): DailyReading {
  const { row: overviewRow, rowNumber: overviewRowNumber } = overview;
  const { row: waterQualityRow, rowNumber: waterQualityRowNumber } = waterQuality;
  const { row: energyRow, rowNumber: energyRowNumber } = energy;
  const { row: healthRow, rowNumber: healthRowNumber } = health;
  const tnLimit = asNumber(waterQualityRow.tnLimit, 'tnLimit', waterQualityRowNumber);
  if (tnLimit !== WATER_QUALITY_METRICS.tn.threshold) {
    throw new Error(`WORKBOOK_THRESHOLD_MISMATCH:tnLimit:${waterQualityRowNumber}`);
  }

  return {
    date: asDate(overviewRow.date, overviewRowNumber),
    processedM3: asNumber(overviewRow.processedM3, 'processedM3', overviewRowNumber),
    informationCount: asNumber(overviewRow.informationCount, 'informationCount', overviewRowNumber),
    complianceRate: asNumber(overviewRow.complianceRate, 'complianceRate', overviewRowNumber),
    tn: asNumber(waterQualityRow.tn, 'tn', waterQualityRowNumber),
    ammonia: asNumber(waterQualityRow.ammonia, 'ammonia', waterQualityRowNumber),
    tp: asNumber(waterQualityRow.tp, 'tp', waterQualityRowNumber),
    cod: asNumber(waterQualityRow.cod, 'cod', waterQualityRowNumber),
    ss: asNumber(waterQualityRow.ss, 'ss', waterQualityRowNumber),
    totalKwh: asNumber(energyRow.totalKwh, 'totalKwh', energyRowNumber),
    kwhPerM3: asNumber(energyRow.kwhPerM3, 'kwhPerM3', energyRowNumber),
    blowerKwh: asNumber(energyRow.blowerKwh, 'blowerKwh', energyRowNumber),
    carbonEmissionKg: asNumber(energyRow.carbonEmissionKg, 'carbonEmissionKg', energyRowNumber),
    carbonReductionKg: asNumber(energyRow.carbonReductionKg, 'carbonReductionKg', energyRowNumber),
    savedYuan: asNumber(energyRow.savedYuan, 'savedYuan', energyRowNumber),
    qualityScore: asNumber(healthRow.qualityScore, 'qualityScore', healthRowNumber),
    flowScore: asNumber(healthRow.flowScore, 'flowScore', healthRowNumber),
    energyScore: asNumber(healthRow.energyScore, 'energyScore', healthRowNumber),
    carbonSourceKg: asNumber(energyRow.carbonSourceKg, 'carbonSourceKg', energyRowNumber),
    carbonSourceScore: asNumber(healthRow.carbonSourceScore, 'carbonSourceScore', healthRowNumber),
  };
}

function toAlertRecord(row: SpreadsheetRow, index: number): AlertRecord {
  const rowNumber = index + 2;
  const level = asText(row.level, 'level', rowNumber);
  if (level !== '提示' && level !== '关注') {
    throw new Error(`WORKBOOK_INVALID_ALERT_LEVEL:${rowNumber}`);
  }
  return {
    date: asDate(row.date, rowNumber),
    metric: asText(row.metric, 'metric', rowNumber),
    level: level as AlertLevel,
    reason: asText(row.reason, 'reason', rowNumber),
    recommendation: asText(row.recommendation, 'recommendation', rowNumber),
  };
}

export function loadWorkbook(path: string): DashboardDataset {
  const workbook = XLSX.readFile(path, { cellDates: true });
  const overviewRows = rowsByDate(getSheetRows(workbook, DAILY_SHEET), DAILY_SHEET);
  if (overviewRows.size === 0) {
    throw new Error('WORKBOOK_DAILY_DATA_EMPTY');
  }
  const dates = new Set(overviewRows.keys());
  const waterQualityRows = rowsByDate(getSheetRows(workbook, WATER_QUALITY_SHEET), WATER_QUALITY_SHEET);
  const energyRows = rowsByDate(getSheetRows(workbook, ENERGY_SHEET), ENERGY_SHEET);
  const healthRows = rowsByDate(getSheetRows(workbook, HEALTH_SHEET), HEALTH_SHEET);
  validateDateSet(waterQualityRows, dates, WATER_QUALITY_SHEET);
  validateDateSet(energyRows, dates, ENERGY_SHEET);
  validateDateSet(healthRows, dates, HEALTH_SHEET);
  const daily = Array.from(overviewRows, ([date, overview]) => toDailyReading(
    overview,
    matchingRow(waterQualityRows, WATER_QUALITY_SHEET, date),
    matchingRow(energyRows, ENERGY_SHEET, date),
    matchingRow(healthRows, HEALTH_SHEET, date),
  )).sort((left, right) => left.date.localeCompare(right.date));
  const alerts = getSheetRows(workbook, ALERT_SHEET).map(toAlertRecord);

  alerts.forEach((alert) => {
    if (!dates.has(alert.date)) {
      throw new Error(`WORKBOOK_DATE_MISMATCH:${ALERT_SHEET}:${alert.date}`);
    }
  });

  return {
    plantName: '智慧污水处理厂',
    daily,
    alerts,
    health: calculateHealth(daily),
  };
}
