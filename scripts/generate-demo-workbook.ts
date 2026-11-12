import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { TN_HEALTH_TARGET, WATER_QUALITY_METRICS, type AlertRecord, type DailyReading } from '../shared/dashboard';

export const DEMO_WORKBOOK_PATH = resolve('data/智慧污水处理厂_演示数据.xlsx');

const DEMO_START_DATE = new Date(Date.UTC(2025, 7, 9));
const DEMO_SOURCE_DAY_COUNT = 365;

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));

const dateAt = (index: number): string => {
  const date = new Date(DEMO_START_DATE);
  date.setUTCDate(date.getUTCDate() + index);
  return date.toISOString().slice(0, 10);
};

export function createDailyReadings(sourceDayCount = DEMO_SOURCE_DAY_COUNT): DailyReading[] {
  const readings = Array.from({ length: sourceDayCount }, (_, index) => {
    const phase = index / 20;
    const processedM3 = Math.round(27_600 + Math.sin(phase / 2) * 1_200 + Math.cos(phase) * 350);
    const tn = round(2.15 + Math.sin(phase) * 0.32 + (index % 29 === 0 ? 0.66 : 0));
    const ammonia = round(0.42 + Math.cos(phase * 0.9) * 0.05 + (index % 47 === 0 ? 0.07 : 0));
    const tp = round(0.28 + Math.sin(phase * 0.7) * 0.04);
    const cod = round(22.4 + Math.cos(phase * 0.6) * 1.8 + (index % 41 === 0 ? 1.2 : 0));
    const ss = round(5.8 + Math.sin(phase * 1.1) * 0.7);
    const kwhPerM3 = round(0.436 + Math.sin(phase * 0.55) * 0.012 + (index % 37 === 0 ? 0.006 : 0), 3);
    const totalKwh = Math.round(processedM3 * kwhPerM3);
    const rollingAverage = 27_600 + Math.sin(phase / 2) * 1_200;
    const flowDeviation = Math.abs(processedM3 - rollingAverage) / rollingAverage;
    const carbonSourceKg = round(processedM3 * (0.018 + Math.sin(phase * 0.4) * 0.0012), 1);

    return {
      date: dateAt(index + 1),
      processedM3,
      informationCount: 1_240_000 + index * 186,
      complianceRate: index % 29 === 0 ? 99.5 : 99.8,
      tn,
      ammonia,
      tp,
      cod,
      ss,
      totalKwh,
      kwhPerM3,
      blowerKwh: Math.round(totalKwh * 0.4),
      carbonEmissionKg: round(totalKwh * 0.581, 1),
      carbonReductionKg: round(totalKwh * 0.128 * 0.581, 1),
      savedYuan: Math.round(3_400 + index * 42 + Math.sin(phase) * 180),
      qualityScore: tn <= TN_HEALTH_TARGET ? 96 : 82,
      flowScore: Math.max(72, Math.round(100 - flowDeviation * 480)),
      energyScore: kwhPerM3 <= 0.445 ? 90 : 85,
      carbonSourceKg,
      carbonSourceScore: carbonSourceKg / processedM3 <= 0.019 ? 92 : 86,
    };
  });
  const first = readings[0]!;
  return [{ ...first, date: dateAt(0), informationCount: first.informationCount - 186 }, ...readings];
}

export function createAlertRecords(days: DailyReading[]): AlertRecord[] {
  return [
    {
      date: days[120]!.date,
      metric: '总氮（TN）',
      level: '提示',
      reason: '短时进水负荷上升，总氮浓度出现小幅波动。',
      recommendation: '持续关注曝气强度与回流比，维持当前控制策略。',
    },
    {
      date: days[208]!.date,
      metric: '吨水电耗',
      level: '关注',
      reason: '鼓风机负荷在高峰时段升高，吨水电耗接近当月上限。',
      recommendation: '复核鼓风机联动策略，优先安排低效机组检修。',
    },
    {
      date: days[311]!.date,
      metric: '碳源投加',
      level: '提示',
      reason: '夜间碳源投加量高于近七日均值。',
      recommendation: '结合进水碳氮比微调投加曲线，避免冗余投加。',
    },
  ];
}

export function writeDemoWorkbook(outputPath = DEMO_WORKBOOK_PATH): void {
  const days = createDailyReadings();
  const alerts = createAlertRecords(days);
  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(days.map(({ date, processedM3, informationCount, complianceRate }) => ({ date, processedM3, informationCount, complianceRate }))),
    '日度总览',
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(
      days.map(({ date, tn, ammonia, tp, cod, ss }) => ({ date, tn, ammonia, tp, cod, ss, tnLimit: WATER_QUALITY_METRICS.tn.threshold })),
    ),
    '出水水质',
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(
      days.map(({ date, totalKwh, kwhPerM3, blowerKwh, carbonSourceKg, carbonEmissionKg, carbonReductionKg, savedYuan }) => ({
        date,
        totalKwh,
        kwhPerM3,
        blowerKwh,
        carbonSourceKg,
        carbonEmissionKg,
        carbonReductionKg,
        savedYuan,
      })),
    ),
    '能效费用',
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(
      days.map(({ date, qualityScore, flowScore, energyScore, carbonSourceScore }) => ({
        date,
        qualityScore,
        flowScore,
        energyScore,
        carbonSourceScore,
      })),
    ),
    '健康指数',
  );
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(alerts), '预警记录');

  mkdirSync(dirname(outputPath), { recursive: true });
  XLSX.writeFile(workbook, outputPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeDemoWorkbook();
}
