'use client';

import { useState, useEffect } from 'react';

type DataSource = 'live' | 'cached';

export interface SyncStateRow {
  accountId: string;
  accountName: string;
  status: 'idle' | 'running' | 'error';
  lastSyncedAt: string | null;
  backfillComplete: boolean;
  earliestSynced: string | null;
  lastError: string | null;
  monthsTotal: number;
  monthsDone: number;
}

interface Props {
  clientId: string;
  initialDataSource: DataSource;
  syncStates: SyncStateRow[];
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

interface MonthCoverage {
  month: string;
  since: string;
  until: string;
  insightsRows: number;
  creativesRows: number;
}

// Same preset labels as the client dashboard's own date-range picker
// (DashboardClient.tsx's DP_PRESETS/_dpPresetRange), reimplemented in plain
// browser-local time rather than account timezone — this is an admin-only
// sync tool operating on whole days, not a client-facing KPI view, so the
// account's exact timezone offset doesn't matter here the way it does for
// "which day did this lead land on." Floors at yesterday to match the same
// "today's data isn't final yet" convention used everywhere else.
const SYNC_RANGE_PRESETS = [
  { label: 'Yesterday', key: 'yesterday' },
  { label: 'Last 7 days', key: 'last_7d' },
  { label: 'Last 30 days', key: 'last_30d' },
  { label: 'This month', key: 'this_month' },
  { label: 'Last month', key: 'last_month' },
] as const;

function fmtLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function syncRangePreset(key: string): { since: string; until: string } | null {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  switch (key) {
    case 'yesterday': return { since: fmtLocalDate(yesterday), until: fmtLocalDate(yesterday) };
    case 'last_7d': { const s = new Date(yesterday); s.setDate(s.getDate() - 6); return { since: fmtLocalDate(s), until: fmtLocalDate(yesterday) }; }
    case 'last_30d': { const s = new Date(yesterday); s.setDate(s.getDate() - 29); return { since: fmtLocalDate(s), until: fmtLocalDate(yesterday) }; }
    case 'this_month': {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      const u = yesterday < s ? s : yesterday; // clamp: on the 1st, yesterday is last month
      return { since: fmtLocalDate(s), until: fmtLocalDate(u) };
    }
    case 'last_month': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      return { since: fmtLocalDate(s), until: fmtLocalDate(e) };
    }
    default: return null;
  }
}

function CoverageTimeline({ clientId, accountId }: { clientId: string; accountId: string }) {
  const [months, setMonths] = useState<MonthCoverage[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [fillInsights, setFillInsights] = useState(true);
  const [fillCreatives, setFillCreatives] = useState(false);
  const [filling, setFilling] = useState(false);
  const [fillError, setFillError] = useState<string | null>(null);
  const [fillDone, setFillDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/clients/${clientId}/sync-coverage?account_id=${accountId}`);
        const data = await res.json();
        if (cancelled) return;
        if (!data.ok) setError(data.error || 'Failed to load coverage');
        else setMonths(data.months);
      } catch {
        if (!cancelled) setError('Network error loading coverage');
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [clientId, accountId]);

  async function handleFillGap() {
    setFilling(true);
    setFillError(null);
    setFillDone(null);
    try {
      const res = await fetch(`/api/admin/clients/${clientId}/sync-range`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, since, until, types: { insights: fillInsights, creatives: fillCreatives } }),
      });
      const data = await res.json();
      if (!data.ok) setFillError(data.error || 'Sync failed');
      else setFillDone(`Synced ${data.daysSynced} day(s). Refresh to see updated coverage.`);
    } catch {
      setFillError('Network error — sync may still be running server-side.');
    }
    setFilling(false);
  }

  if (loading) return <p className="text-[11px] text-slate-500 mt-2">Loading coverage…</p>;
  if (error) return <p className="text-[11px] text-rose-400 mt-2">{error}</p>;
  if (!months || months.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      <p className="text-[11px] text-slate-500">
        One box per calendar month, oldest (left) to most recent (right) — hover a box for exactly what&apos;s
        synced. A month needs BOTH performance numbers (spend/leads/etc.) and creative data (ad images/videos +
        their per-asset metrics) to count as full; having only one of the two shows as partial.
      </p>
      <div className="flex gap-px rounded overflow-hidden border border-slate-700/60">
        {months.map(m => {
          const hasInsights = m.insightsRows > 0;
          const hasCreatives = m.creativesRows > 0;
          const color = hasInsights && hasCreatives
            ? 'bg-emerald-500/70'
            : hasInsights || hasCreatives
              ? 'bg-amber-500/70'
              : 'bg-slate-700/40';
          const missing = hasInsights && hasCreatives
            ? 'nothing missing'
            : hasInsights
              ? 'missing creative data (ad images/videos + per-asset metrics)'
              : hasCreatives
                ? 'missing performance numbers (spend/leads/etc.)'
                : 'no data synced yet';
          return (
            <button
              key={m.month}
              type="button"
              title={`${m.month}\nPerformance numbers: ${m.insightsRows} of the month's days\nCreative data: ${m.creativesRows} of the month's days\n${missing}\n\nClick to fill this range below.`}
              onClick={() => {
                setSince(m.since);
                setUntil(m.until);
                // Pre-check whichever type is actually missing for this
                // month, so a click on a partial box defaults to fixing
                // exactly what's missing instead of re-syncing both. A
                // fully-synced (green) month has nothing missing to target,
                // so fall back to both rather than leaving neither checked
                // (which would leave the button disabled).
                const missingInsights = !hasInsights;
                const missingCreatives = !hasCreatives;
                setFillInsights(missingInsights || (!missingInsights && !missingCreatives));
                setFillCreatives(missingCreatives || (!missingInsights && !missingCreatives));
              }}
              className={`flex-1 h-4 ${color} hover:ring-2 hover:ring-inset hover:ring-white/40 cursor-pointer transition-[box-shadow]`}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-3 text-[10px] text-slate-500">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500/70 inline-block" /> full — performance + creative data both present</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500/70 inline-block" /> partial — only one of the two</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-slate-700/40 inline-block" /> none synced</span>
      </div>

      <div className="pt-1 border-t border-slate-700/40">
        <p className="text-[11px] text-slate-500 mb-1.5">Fill a specific date range on demand (doesn&apos;t affect the normal backfill order):</p>
        <div className="flex items-center gap-1.5 flex-wrap mb-2">
          {SYNC_RANGE_PRESETS.map(p => {
            const range = syncRangePreset(p.key);
            const active = !!range && since === range.since && until === range.until;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => { if (range) { setSince(range.since); setUntil(range.until); } }}
                className={`px-2 py-1 rounded text-[11px] font-medium border transition-colors ${
                  active
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-200'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="date" value={since} onChange={e => setSince(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
          />
          <span className="text-slate-500 text-xs">to</span>
          <input
            type="date" value={until} onChange={e => setUntil(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
          />
          <label className="flex items-center gap-1 text-[11px] text-slate-400">
            <input type="checkbox" checked={fillInsights} onChange={e => setFillInsights(e.target.checked)} />
            Performance
          </label>
          <label className="flex items-center gap-1 text-[11px] text-slate-400">
            <input type="checkbox" checked={fillCreatives} onChange={e => setFillCreatives(e.target.checked)} />
            Creative data
          </label>
          <button
            type="button"
            onClick={handleFillGap}
            disabled={filling || !since || !until || (!fillInsights && !fillCreatives)}
            className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white text-xs font-medium rounded transition-colors"
          >
            {filling ? 'Syncing…' : 'Sync this range'}
          </button>
        </div>
        {fillError && <p className="mt-1 text-[11px] text-rose-400">{fillError}</p>}
        {fillDone && <p className="mt-1 text-[11px] text-emerald-400">{fillDone}</p>}
      </div>
    </div>
  );
}

function statusBadge(status: SyncStateRow['status']) {
  const styles: Record<SyncStateRow['status'], string> = {
    idle: 'bg-slate-700/60 text-slate-300',
    running: 'bg-blue-500/20 text-blue-300',
    error: 'bg-rose-500/20 text-rose-300',
  };
  const labels: Record<SyncStateRow['status'], string> = {
    idle: 'Idle',
    running: 'Running…',
    error: 'Error',
  };
  return <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${styles[status]}`}>{labels[status]}</span>;
}

export default function SyncControlForm({ clientId, initialDataSource, syncStates: initialSyncStates }: Props) {
  const [dataSource, setDataSource] = useState<DataSource>(initialDataSource);
  const [savingSource, setSavingSource] = useState(false);
  const [savedSource, setSavedSource] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  // relativeTime() reads Date.now() at render time, so its output depends on
  // exactly when it runs — the server-rendered HTML and the client's first
  // hydration pass are never at the identical instant, which React flags as
  // a hydration mismatch. Render a stable placeholder on the server/first
  // client pass, then swap to the real relative time only after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [expandedAccountId, setExpandedAccountId] = useState<string | null>(null);
  const [syncingCreativesFor, setSyncingCreativesFor] = useState<string | null>(null);
  const [creativesSyncError, setCreativesSyncError] = useState<string | null>(null);
  const [syncStates, setSyncStates] = useState<SyncStateRow[]>(initialSyncStates);

  // Auto-refresh while any account is actively running (server-triggered
  // via "Sync now" clicking window.location.reload(), or another admin/tab
  // kicking one off) — polls a lightweight status-only endpoint instead of
  // reloading the whole page, so the "Running…" badge flips to Idle/Error
  // live without the admin needing to remember to refresh.
  useEffect(() => {
    const anyRunning = syncStates.some(s => s.status === 'running');
    if (!anyRunning) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/admin/clients/${clientId}/sync-status`);
        const data = await res.json();
        if (!data.ok) return;
        setSyncStates(prev => prev.map(s => {
          const updated = data.syncStates.find((r: { accountId: string }) => r.accountId === s.accountId);
          return updated ? { ...s, ...updated } : s;
        }));
      } catch { /* skip this poll, try again next interval */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [clientId, syncStates]);

  async function handleSourceChange(next: DataSource) {
    setDataSource(next);
    setSavingSource(true);
    setSavedSource(false);
    await fetch(`/api/admin/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data_source: next }),
    });
    setSavingSource(false);
    setSavedSource(true);
    setTimeout(() => setSavedSource(false), 2500);
  }

  async function handleSyncNow() {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch(`/api/admin/clients/${clientId}/sync`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) {
        setSyncError(data.error || 'Sync failed');
      } else {
        // Refresh from the server so status/timestamps reflect the completed run.
        window.location.reload();
        return;
      }
    } catch {
      setSyncError('Network error — sync may still be running server-side.');
    }
    setSyncing(false);
  }

  async function handleSyncCreativesOnly(accountId: string) {
    setSyncingCreativesFor(accountId);
    setCreativesSyncError(null);
    try {
      const res = await fetch(`/api/admin/clients/${clientId}/sync-creatives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId }),
      });
      const data = await res.json();
      if (!data.ok) {
        setCreativesSyncError(data.error || 'Sync failed');
      } else {
        window.location.reload();
        return;
      }
    } catch {
      setCreativesSyncError('Network error — sync may still be running server-side.');
    }
    setSyncingCreativesFor(null);
  }

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">Data source</label>
        <div className="flex gap-2">
          {(['live', 'cached'] as DataSource[]).map(opt => (
            <button
              key={opt}
              type="button"
              onClick={() => handleSourceChange(opt)}
              disabled={savingSource}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50 ${
                dataSource === opt
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-600'
              }`}
            >
              {opt === 'live' ? 'Live (Meta API)' : 'Cached (Postgres)'}
            </button>
          ))}
          {savedSource && <span className="self-center text-xs text-emerald-400">Saved ✓</span>}
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          Cached mode reads from a synced local copy instead of hitting Meta live — avoids row-cap errors on
          high-campaign accounts, at the cost of data only being as fresh as the last sync. This resolves
          per ad account: any account below that hasn&apos;t completed a sync yet falls back to live automatically,
          even if others have — a multi-account client is never all-or-nothing.
        </p>
      </div>

      <div className="space-y-2">
        {syncStates.length === 0 && (
          <p className="text-xs text-slate-500">No ad accounts assigned to this client yet.</p>
        )}
        {syncStates.map(s => (
          <div key={s.accountId} className="p-3 bg-slate-800/50 border border-slate-700/60 rounded-lg">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-white font-medium truncate">{s.accountName || s.accountId}</span>
              {statusBadge(s.status)}
            </div>
            <div className="mt-1 text-xs text-slate-500 space-y-0.5">
              <div>Last synced: {mounted ? relativeTime(s.lastSyncedAt) : '—'}</div>
              <div className="mt-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">
                    {s.backfillComplete
                      ? `Full history synced (${s.monthsTotal} of ${s.monthsTotal} months)`
                      : `${s.monthsDone} of ${s.monthsTotal} months backfilled`}
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-slate-700/60 overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-[width]"
                    style={{ width: `${Math.round(100 * s.monthsDone / Math.max(1, s.monthsTotal))}%` }}
                  />
                </div>
              </div>
              {!s.backfillComplete && (
                <p className="text-[11px] text-slate-500">
                  Most recent months sync first, so current performance data is usable quickly — older history fills in behind it over subsequent syncs.
                </p>
              )}
              {s.lastError && <div className="text-rose-400">Error: {s.lastError}</div>}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setExpandedAccountId(expandedAccountId === s.accountId ? null : s.accountId)}
                  className="text-blue-400 hover:text-blue-300 text-[11px] font-medium"
                >
                  {expandedAccountId === s.accountId ? 'Hide data coverage' : 'Show data coverage'}
                </button>
                <button
                  type="button"
                  onClick={() => handleSyncCreativesOnly(s.accountId)}
                  disabled={syncingCreativesFor === s.accountId || s.status === 'running'}
                  className="text-blue-400 hover:text-blue-300 disabled:opacity-50 text-[11px] font-medium"
                  title="Syncs only ad images/videos and their per-asset metrics for the Creatives tab — skips campaign/insight data entirely, so it isn't slowed down by a large account's insights backfill."
                >
                  {syncingCreativesFor === s.accountId ? 'Syncing creatives…' : 'Sync creatives only'}
                </button>
              </div>
              {creativesSyncError && syncingCreativesFor === null && (
                <p className="text-[11px] text-rose-400">{creativesSyncError}</p>
              )}
              {expandedAccountId === s.accountId && <CoverageTimeline clientId={clientId} accountId={s.accountId} />}
            </div>
          </div>
        ))}
      </div>

      <div>
        <button
          type="button"
          onClick={handleSyncNow}
          disabled={syncing || syncStates.length === 0}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
        {syncing && (
          <p className="mt-2 text-xs text-slate-500">
            Each click continues the backfill from the most recent month backward, checkpointing progress one month
            at a time — this can take a while on a large account&apos;s first run. Navigating away won&apos;t cancel it —
            the sync keeps running server-side; re-clicking while it&apos;s in progress is safe and will just report
            &ldquo;already in progress&rdquo;.
          </p>
        )}
        {syncError && <p className="mt-2 text-xs text-rose-400">{syncError}</p>}
      </div>
    </div>
  );
}
