import { describe, expect, it } from 'vitest';
import { createWphiDataset } from '../src/domain/wphi-demo';
import { refreshWphiDataset } from '../src/domain/wphi-dataset';
import { createServer } from '../src/app';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('WPHI displayed data and controls',()=>{
  it('builds a recent-month scenario with six low-score days and a recovery', () => {
    const data = createWphiDataset('2026-11-11', { varyRecentMonth: true });
    const month = data.daily.slice(-30);
    const scores = month.map(row => row.wphi!.score!);

    expect(scores.filter(score => score < 90)).toHaveLength(6);
    expect(Math.max(...scores) - Math.min(...scores)).toBeGreaterThan(25);
    expect(Math.min(...scores)).toBeGreaterThanOrEqual(65);
    expect(scores.at(-1)).toBeGreaterThanOrEqual(90);
    for (const row of month) {
      expect(Number.isFinite(row.wphi!.metrics.tnCv)).toBe(true);
      const included = row.wphi!.dimensions.filter(dimension => dimension.included);
      expect(row.wphi!.score).toBeCloseTo(included.reduce((total, dimension) => total + dimension.score!, 0) / included.length, 10);
      const reading = data.wphi!.history.find(reading => reading.date === row.date)!;
      expect(row).toMatchObject({ tn: reading.tnOut, processedM3: reading.inflowM3,
        blowerKwh: reading.blowerKwh, carbonSourceKg: reading.carbonKg });
    }
  });

  it('keeps the earlier records and the manufacturer example when varying the recent month', () => {
    const original = createWphiDataset('2026-11-11');
    const varied = createWphiDataset('2026-11-11', { varyRecentMonth: true });

    expect(varied.daily.slice(0, -30)).toEqual(original.daily.slice(0, -30));
    expect(varied.wphi!.history.slice(0, -30)).toEqual(original.wphi!.history.slice(0, -30));
    expect(varied.daily.find(row => row.date === '2026-08-09')!.wphi!.score).toBeCloseTo(96.34920634920636, 10);
  });

  it('extends simulated readings through a requested date while retaining existing records', () => {
    const original = createWphiDataset();
    const updated = createWphiDataset('2026-11-11');

    expect(updated.daily.at(-1)?.date).toBe('2026-11-11');
    expect(updated.daily.slice(original.daily.length).at(0)?.date).toBe('2026-08-10');
    expect(updated.daily).toHaveLength(460);
    expect(updated.daily.slice(0, original.daily.length)).toEqual(original.daily);
    expect(updated.wphi!.history.slice(0, original.wphi!.history.length)).toEqual(original.wphi!.history);
    expect(updated.daily.every(row => Number.isFinite(row.wphi?.metrics.tnCv))).toBe(true);
  });

  it('has numeric CV for every displayed day, including the first',()=>{
    const data=createWphiDataset();
    expect(data.daily).toHaveLength(366);
    expect(data.wphi!.history).toHaveLength(396);
    expect(data.daily.every(r=>Number.isFinite(r.wphi?.metrics.tnCv))).toBe(true);
    expect(data.daily.at(-1)?.wphi?.metrics.tnCv).toBeCloseTo(20,8);
    expect(data.health.score).toBeCloseTo(96.34920634920636,10);
  });
  it('recomputes every exposed snapshot consistently after target changes',()=>{
    const data=createWphiDataset(); data.wphi!.config.targets.tnOut=6;
    refreshWphiDataset(data);
    expect(data.daily.at(-1)?.wphi?.dimensions[0]?.score).toBe(100);
    expect(data.health.score).toBe(data.daily.at(-1)?.wphi?.score);
  });
  it('validates configuration, handles daily abnormal reporting and maintenance',async()=>{
    const data=createWphiDataset(); const app=createServer({dataset:data});
    expect((await request(app).get('/api/dashboard/wphi')).status).toBe(200);
    const invalid=structuredClone(data.wphi!.config); invalid.targets.tnOut=0;
    expect((await request(app).put('/api/dashboard/wphi/config').send(invalid)).status).toBe(400);
    const date=data.daily.at(-1)!.date;
    expect((await request(app).put('/api/dashboard/wphi/report').send({date,systemNormal:false,reason:'仪表检修'})).status).toBe(200);
    expect(data.daily.at(-1)!.wphi!.metrics.abnormalDays).toBe(1);
    const config=structuredClone(data.wphi!.config); config.maintenance=true;
    expect((await request(app).put('/api/dashboard/wphi/config').send(config)).status).toBe(200);
    expect(data.health.score).toBeNull();
    expect((await request(app).get('/api/dashboard/health')).body.health.wphi.status).toBe('maintenance');
  });
  it('restores saved targets, dimension switches and daily reports on a new server instance',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'wphi-state-'));
    try {
      const statePath=join(directory,'settings.json');
      const data=createWphiDataset();
      const first=createServer({dataset:data,wphiStatePath:statePath});
      const config=structuredClone(data.wphi!.config);
      config.targets.tnOut=6;
      config.enabled.blowerEnergy=false;
      const date=data.daily.at(-1)!.date;
      expect((await request(first).put('/api/dashboard/wphi/config').send(config)).status).toBe(200);
      expect((await request(first).put('/api/dashboard/wphi/report').send({date,systemNormal:false,reason:'曝气设备维护'})).status).toBe(200);
      const restarted=createServer({dataset:createWphiDataset(),wphiStatePath:statePath});
      const restored=(await request(restarted).get('/api/dashboard/wphi')).body;
      expect(restored.config).toEqual(config);
      expect(restored.reading).toMatchObject({systemNormal:false,abnormalReason:'曝气设备维护'});
      expect(restored.snapshot.metrics.abnormalDays).toBe(1);
      expect(restored.snapshot.dimensions.find((d:{key:string})=>d.key==='blowerEnergy')).toMatchObject({included:false,score:null});
      expect(restored.snapshot.score).toBeCloseTo(data.health.score!,10);
    } finally {
      rmSync(directory,{recursive:true,force:true});
    }
  });
});
