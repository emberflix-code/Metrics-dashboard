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

export default function SyncControlForm({ clientId, initialDataSource, syncStates }: Props) {
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
