import { describe, expect, it } from 'vitest';
import { calculateWphi, DEFAULT_WPHI_CONFIG, scoreLow, scoreHigh, type WphiReading } from '../../shared/wphi';

function sample(): WphiReading[] {
  return Array.from({ length: 30 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`, tnIn: i === 10 ? 120 : 55,
    tnOut: i === 10 ? 4.2 : i >= 23 && i < 29 ? 5 + (i % 2 ? -1 : 1) * Math.sqrt(7 / 6) : 5,
    inflowM3: 6000, blowerKwh: 950, carbonKg: 480, systemNormal: true,
  }));
}

describe('approved WPHI manufacturer rules', () => {
  it.each([[1,100],[1.25,90],[1.3,87.2],[1.5,80],[1.75,69.5],[2,60],[2.25,45],[3,0]])('low ratio %s scores %s', (r, score) => expect(scoreLow(r, 1)).toBeCloseTo(score, 8));
  it.each([[1,100],[0.9,95],[0.8,90],[0.67,80],[0.5,60],[0.25,30],[0,0]])('high ratio %s scores %s', (r, score) => expect(scoreHigh(r * 90, 90)).toBeCloseTo(score, 8));
  it('protects removal at99 percent and rejects invalid target', () => {
    expect(scoreHigh(99,100)).toBe(100);
    expect(() => scoreLow(1,0)).toThrow();
  });
  it('reproduces the full-precision document example using real seven-day samples', () => {
    const result = calculateWphi(sample(), DEFAULT_WPHI_CONFIG);
    expect(result.metrics.tnCv).toBeCloseTo(20, 8);
    expect(result.dimensions.filter(d => d.included)).toHaveLength(7);
    expect(result.dimensions.find(d => d.key === 'blowerEnergy')?.score).toBeCloseTo(98.44444444, 6);
    expect(result.score).toBeCloseTo(96.34920634920636,10);
    expect(result.grade).toBe('良好');
  });
  it('excludes no-shock and disabled dimensions from the mean', () => {
    const rows = sample().map(r => ({ ...r, tnIn: 55 }));
    const config = structuredClone(DEFAULT_WPHI_CONFIG); config.enabled.carbonConsumption = false;
    const result = calculateWphi(rows, config);
    expect(result.dimensions.filter(d => d.included)).toHaveLength(5);
    expect(result.dimensions.find(d => d.key === 'shockResistance')?.status).toBe('no-event');
    const scores = result.dimensions.filter(d => d.included).map(d => d.score!);
    expect(result.score).toBeCloseTo(scores.reduce((a,b)=>a+b,0)/5,10);
  });
  it('uses only excess beyond110 percent for shock penalties', () => {
    const rows=sample(); rows[10]!.tnOut=5;
    expect(calculateWphi(rows,DEFAULT_WPHI_CONFIG).dimensions.find(d=>d.key==='shockResistance')?.score).toBeCloseTo(85);
  });
  it('honors low-concentration exemption', () => {
    const rows=sample().map((r,i)=>({...r,tnOut:i%2?0.1:1}));
    expect(calculateWphi(rows,DEFAULT_WPHI_CONFIG).dimensions.find(d=>d.key==='effluentStability')?.score).toBe(100);
  });
  it('pauses scores for maintenance and handles all dimensions disabled', () => {
    const config=structuredClone(DEFAULT_WPHI_CONFIG); config.maintenance=true;
    const result=calculateWphi(sample(),config);
    expect(result.score).toBeNull(); expect(result.dimensions.every(d=>d.score===null)).toBe(true);
    config.maintenance=false;
    Object.keys(config.enabled).forEach(k=>{config.enabled[k as keyof typeof config.enabled]=false;});
    expect(calculateWphi(sample(),config).score).toBeNull();
  });
  it('does not mistake missing days or unreported system status for normal', () => {
    const rows=sample(); rows.splice(25,1); rows[0]!.systemNormal=null;
    const result=calculateWphi(rows,DEFAULT_WPHI_CONFIG);
    expect(result.dimensions.find(d=>d.key==='effluentStability')?.status).toBe('insufficient');
    expect(result.dimensions.find(d=>d.key==='systemStability')?.status).toBe('insufficient');
  });
});
