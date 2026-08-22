import { ENERGY_PERIOD_OPTIONS, type EnergyPeriod } from './energy-periods';

export function EnergyPeriodTabs({ value, onChange }: { value: EnergyPeriod; onChange: (value: EnergyPeriod) => void }) {
  return <div className="energy-period-tabs" role="group" aria-label="节能统计周期">
    {ENERGY_PERIOD_OPTIONS.map((option) => <button
      key={option.key}
      type="button"
      aria-pressed={value === option.key}
      onClick={() => onChange(option.key)}
    >{option.label}</button>)}
  </div>;
}
