import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { loadWorkbook } from '../src/data/workbook';
import { HEALTH_WEIGHTS, METRIC_DEFINITIONS, TN_HEALTH_TARGET, WATER_QUALITY_METRICS } from '../../shared/dashboard';
import { calculateReadingHealth } from '../../shared/health';

const demoWorkbookPath = resolve('data/智慧污水处理厂_演示数据.xlsx');
const waterQualitySheet = '出水水质';
const energySheet = '能效费用';
const healthSheet = '健康指数';
const domainSheets = ['日度总览', waterQualitySheet, energySheet, healthSheet] as const;

function withMutatedWorkbook(
  mutate: (workbook: XLSX.WorkBook) => void,
  verify: (path: string) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), 'smart-water-workbook-'));
  const path = join(directory, 'mutated.xlsx');

  try {
    const workbook = XLSX.readFile(demoWorkbookPath, { cellDates: true });
    mutate(workbook);
    XLSX.writeFile(workbook, path);
    verify(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('loadWorkbook', () => {
  it('uses the approved 3 mg/L TN compliance limit in the shared contract and generated water-quality sheet', () => {
    const workbook = XLSX.readFile(demoWorkbookPath, { cellDates: true });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[waterQualitySheet]!, { defval: null, raw: true });

    expect(WATER_QUALITY_METRICS.tn.threshold).toBe(3);
    expect(TN_HEALTH_TARGET).toBe(3);
    expect(rows).toHaveLength(366);
    expect(rows.every((row) => row.tnLimit === 3)).toBe(true);
  });

  it('ships 366 unique and aligned dates across all four authoritative domain sheets', () => {
    const workbook = XLSX.readFile(demoWorkbookPath, { cellDates: true });
    const datesBySheet = domainSheets.map((sheetName) => {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: null, raw: true });
      const dates = rows.map((row) => String(row.date));

      expect(rows).toHaveLength(366);
      expect(new Set(dates).size).toBe(366);
      return dates;
    });

    expect(datesBySheet[1]).toEqual(datesBySheet[0]);
    expect(datesBySheet[2]).toEqual(datesBySheet[0]);
    expect(datesBySheet[3]).toEqual(datesBySheet[0]);
  });

  it('loads a full year of coherent wastewater demo data', () => {
    const dataset = loadWorkbook(resolve('data/智慧污水处理厂_演示数据.xlsx'));

    expect(dataset.plantName).toBe('智慧污水处理厂');
    expect(dataset.daily).toHaveLength(366);
    expect(dataset.daily.some((row) => row.tn > METRIC_DEFINITIONS.tn.threshold)).toBe(true);
    expect(dataset.daily.every((row) => row.processedM3 > 0)).toBe(true);
    expect(dataset.health.weights).toBe(HEALTH_WEIGHTS);
  });

  it('returns alerts and health scores that match the daily records', () => {
    const dataset = loadWorkbook(resolve('data/智慧污水处理厂_演示数据.xlsx'));
    const latest = dataset.daily.at(-1);

    expect(dataset.alerts.length).toBeGreaterThan(0);
    expect(latest).toBeDefined();
    expect(dataset.health.score).toBe(calculateReadingHealth(latest!).score);
  });

  it('ships 366 continuous dates from 2025-08-09 through 2026-08-09', () => {
    const dataset = loadWorkbook(demoWorkbookPath);
    const dates = dataset.daily.map((row) => row.date);

    expect(dates).toHaveLength(366);
    expect(dates[0]).toBe('2025-08-09');
    expect(dates.at(-1)).toBe('2026-08-09');
    expect(new Set(dates).size).toBe(366);
    dates.slice(1).forEach((date, index) => {
      const previous = new Date(`${dates[index]}T00:00:00.000Z`);
      previous.setUTCDate(previous.getUTCDate() + 1);
      expect(date).toBe(previous.toISOString().slice(0, 10));
    });
    expect(dataset.alerts.every((alert) => dates.includes(alert.date))).toBe(true);
  });

  it('uses the water-quality sheet as the authoritative TN source', () => {
    withMutatedWorkbook((workbook) => {
      const sheet = workbook.Sheets[waterQualitySheet]!;
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
      rows[0]!.tn = 4.99;
      workbook.Sheets[waterQualitySheet] = XLSX.utils.json_to_sheet(rows);
    }, (path) => {
      expect(loadWorkbook(path).daily[0]!.tn).toBe(4.99);
    });
  });

  it('uses the energy sheet as the authoritative carbon-source dosage source', () => {
    withMutatedWorkbook((workbook) => {
      const sheet = workbook.Sheets[energySheet]!;
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
      rows[0]!.carbonSourceKg = 777;
      workbook.Sheets[energySheet] = XLSX.utils.json_to_sheet(rows);
    }, (path) => {
      expect(loadWorkbook(path).daily[0]!.carbonSourceKg).toBe(777);
    });
  });

  it('rejects a domain sheet when its dates do not match the daily overview', () => {
    withMutatedWorkbook((workbook) => {
      const sheet = workbook.Sheets[waterQualitySheet]!;
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
      rows.pop();
      workbook.Sheets[waterQualitySheet] = XLSX.utils.json_to_sheet(rows);
    }, (path) => {
      expect(() => loadWorkbook(path)).toThrow('WORKBOOK_DATE_MISMATCH');
    });
  });

  it('rejects a duplicate date in an authoritative domain sheet', () => {
    withMutatedWorkbook((workbook) => {
      const sheet = workbook.Sheets[energySheet]!;
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
      rows[1]!.date = rows[0]!.date;
      workbook.Sheets[energySheet] = XLSX.utils.json_to_sheet(rows);
    }, (path) => {
      expect(() => loadWorkbook(path)).toThrow('WORKBOOK_DATE_DUPLICATE:能效费用');
    });
  });

  it('rejects an extra misaligned date in an authoritative domain sheet', () => {
    withMutatedWorkbook((workbook) => {
      const sheet = workbook.Sheets[healthSheet]!;
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
      rows.push({ ...rows[0]!, date: '2027-01-01' });
      workbook.Sheets[healthSheet] = XLSX.utils.json_to_sheet(rows);
    }, (path) => {
      expect(() => loadWorkbook(path)).toThrow('WORKBOOK_DATE_MISMATCH:健康指数:2027-01-01');
    });
  });

  it('rejects a water-quality TN limit that conflicts with the shared compliance threshold', () => {
    withMutatedWorkbook((workbook) => {
      const sheet = workbook.Sheets[waterQualitySheet]!;
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
      rows[0]!.tnLimit = 5;
      workbook.Sheets[waterQualitySheet] = XLSX.utils.json_to_sheet(rows);
    }, (path) => {
      expect(() => loadWorkbook(path)).toThrow('WORKBOOK_THRESHOLD_MISMATCH');
    });
  });

  it.each([
    ['year zero', '0000-01-01'],
    ['a malformed month', '2026-8-01'],
    ['an impossible day', '2026-02-30'],
  ])('rejects %s as a workbook business date before sheet alignment', (_label, invalidDate) => {
    withMutatedWorkbook((workbook) => {
      const sheet = workbook.Sheets['日度总览']!;
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
      rows[0]!.date = invalidDate;
      workbook.Sheets['日度总览'] = XLSX.utils.json_to_sheet(rows);
    }, (path) => {
      expect(() => loadWorkbook(path)).toThrow('WORKBOOK_INVALID_DATE:date:2');
    });
  });

  it('preserves a supported four-digit year 0099 across every dated sheet', () => {
    const historicalDate = '0099-01-01';
    withMutatedWorkbook((workbook) => {
      const alertRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets['预警记录']!, { defval: null, raw: true });
      const originalDate = String(alertRows[0]!.date);
      for (const sheetName of domainSheets) {
        const sheet = workbook.Sheets[sheetName]!;
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
        for (const row of rows) {
          if (String(row.date) === originalDate) row.date = historicalDate;
        }
        workbook.Sheets[sheetName] = XLSX.utils.json_to_sheet(rows);
      }
      for (const row of alertRows) {
        if (String(row.date) === originalDate) row.date = historicalDate;
      }
      workbook.Sheets['预警记录'] = XLSX.utils.json_to_sheet(alertRows);
    }, (path) => {
      const dataset = loadWorkbook(path);
      expect(dataset.daily[0]?.date).toBe(historicalDate);
      expect(dataset.alerts.filter(({ date }) => date === historicalDate).length).toBeGreaterThan(0);
    });
  });
});
