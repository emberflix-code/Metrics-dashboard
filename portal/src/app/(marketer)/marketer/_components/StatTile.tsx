// Small KPI tile used across the marketer pages. Server-renderable.
export default function StatTile({ label, value, sub, tone = 'neutral' }: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'neutral' | 'good' | 'bad' | 'warn';
}) {
  const valueCls = tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : tone === 'warn' ? 'text-amber-400' : 'text-white';
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`text-xl font-semibold mt-1 ${valueCls}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}
