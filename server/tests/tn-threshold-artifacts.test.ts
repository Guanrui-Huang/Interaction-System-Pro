import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type JsonObject = Record<string, unknown>;

function collectTnMetrics(value: unknown, path: string, result: Array<{ path: string; metric: JsonObject }>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTnMetrics(item, `${path}[${index}]`, result));
    return;
  }
  if (!value || typeof value !== 'object') return;

  const object = value as JsonObject;
  if (object.key === 'tn' && Object.hasOwn(object, 'limit')) result.push({ path, metric: object });
  for (const [key, nested] of Object.entries(object)) {
    collectTnMetrics(nested, `${path}.${key}`, result);
  }
}

function collectTnTableRows(value: unknown, path: string, result: Array<{ path: string; row: unknown[] }>): void {
  if (Array.isArray(value)) {
    if (value[0] === '总氮（TN）') result.push({ path, row: value });
    value.forEach((item, index) => collectTnTableRows(item, `${path}[${index}]`, result));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as JsonObject)) {
    collectTnTableRows(nested, `${path}.${key}`, result);
  }
}

describe('tracked TN presentation artifacts', () => {
  it('uses the approved 3 mg/L limit for every JSON metric object keyed tn', () => {
    const trackedJsonFiles = execFileSync('git', ['ls-files', '-z', '*.json'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    const tnMetrics: Array<{ path: string; metric: JsonObject }> = [];

    for (const file of trackedJsonFiles) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      collectTnMetrics(parsed, file, tnMetrics);
    }

    expect(tnMetrics.length).toBeGreaterThan(0);
    expect(tnMetrics.map(({ path, metric }) => ({ path, limit: metric.limit }))).toEqual(
      tnMetrics.map(({ path }) => ({ path, limit: 3 })),
    );
  });

  it('keeps TN evidence-table limits free of the stale 15 mg/L threshold', () => {
    const trackedJsonFiles = execFileSync('git', ['ls-files', '-z', '*.json'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    const tnRows: Array<{ path: string; row: unknown[] }> = [];

    for (const file of trackedJsonFiles) {
      collectTnTableRows(JSON.parse(readFileSync(file, 'utf8')) as unknown, file, tnRows);
    }
    expect(tnRows.length).toBeGreaterThan(0);
    expect(tnRows.map(({ path, row }) => ({ path, limit: row[3] }))).toEqual(
      tnRows.map(({ path }) => ({ path, limit: 3 })),
    );

  });
});
