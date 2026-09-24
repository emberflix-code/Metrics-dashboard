import { requireMarketerSession } from '@/lib/marketerAuth';
import { resolveDateRange } from '@/lib/dateRange';
import { detectFatigue, FATIGUE_CTR_DROP, FATIGUE_FREQUENCY, FATIGUE_MIN_SPEND, FATIGUE_WINDOW_DAYS } from '@/lib/marketer/fatigue';
import RangeSelect from '../_components/RangeSelect';
import StatTile from '../_components/StatTile';
import { fmtUsd } from '../_components/format';
import FatigueCard from './FatigueCard';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

// Creative fatigue: assets whose CTR has slid for four straight weeks or
// whose frequency is past the ceiling. The window is a fixed 4 weeks back
// from the range end, so only the picker's end date matters here.
export default async function MarketerFatiguePage({ searchParams }: { searchParams: SearchParams }) {
  await requireMarketerSession();
  const range = resolveDateRange({ preset: first(searchParams.preset), since: first(searchParams.since), until: first(searchParams.until) }, '30');
  const { range: window, rows } = await detectFatigue({ until: range.until });

  const spendFlagged = rows.reduce((s, r) => s + r.spend, 0);
  const ctrDecline = rows.filter(r => r.reasons.includes('ctr_decline')).length;
  const highFreq = rows.filter(r => r.reasons.includes('high_frequency')).length;
  const stillActive = rows.filter(r => r.activeAds > 0).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Creative fatigue</h1>
          <p className="text-sm text-slate-400">
            Assets with ≥{fmtUsd(FATIGUE_MIN_SPEND, 0)} over the {FATIGUE_WINDOW_DAYS} days ending <span className="font-mono text-slate-300">{window.until}</span> whose CTR fell four weeks running (last week ≥{Math.round(FATIGUE_CTR_DROP * 100)}% below its best) or whose frequency passed {FATIGUE_FREQUENCY}.
          </p>
        </div>
        <RangeSelect currentPreset={range.preset} currentSince={range.since} currentUntil={range.until} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Flagged assets" value={String(rows.length)} tone={rows.length > 0 ? 'warn' : 'good'} sub={`${window.since} → ${window.until}`} />
        <StatTile label="Spend on flagged" value={fmtUsd(spendFlagged, 0)} sub="over the 4-week window" />
        <StatTile label="CTR declining" value={String(ctrDecline)} sub={`${highFreq} high frequency`} />
        <StatTile label="Still in active ads" value={String(stillActive)} tone={stillActive > 0 ? 'bad' : 'neutral'} sub="the ones worth rotating now" />
      </div>

      {rows.length === 0 ? (
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-10 text-center">
          <p className="text-sm text-slate-300">No fatigued creatives in this window.</p>
          <p className="text-xs text-slate-500 mt-1">Nothing above the spend floor shows a four-week CTR slide or a frequency over {FATIGUE_FREQUENCY}.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {rows.map(r => <FatigueCard key={r.assetKey} row={r} />)}
        </div>
      )}
    </div>
  );
}
