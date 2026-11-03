'use client';

import { useState } from 'react';
import PillTagInput from './PillTagInput';

type GoogleDataSource = 'sheet' | 'api';

interface Props {
  clientId: string;
  currentDataSource: GoogleDataSource;
  currentCustomerIds: string[];
  currentCampaignFilter: string;
  syncedThrough: string | null;
  lastError: string | null;
}

// Google Ads dashboard source. "Google Ads API" reads google_ads_daily (synced
// daily at 6 AM ET from the accounts below), with Leads / Joins / Bookings
// from Google's own conversion tracking; "Google Sheet" keeps the Google Ads
// tab configured in the Google Sheet section.
export default function GoogleAdsConfigForm({ clientId, currentDataSource, currentCustomerIds, currentCampaignFilter, syncedThrough, lastError }: Props) {
  const [dataSource, setDataSource] = useState<GoogleDataSource>(currentDataSource);
  const [customerIds, setCustomerIds] = useState(currentCustomerIds.join(', '));
  const [campaignFilter, setCampaignFilter] = useState(currentCampaignFilter);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    await fetch(`/api/admin/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        google_data_source: dataSource,
        google_ads_customer_ids: customerIds.split(/[,\s]+/).map(s => s.trim()).filter(Boolean),
        google_campaign_filter: campaignFilter.trim(),
      }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  async function handleSync() {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch(`/api/admin/clients/${clientId}/google-sync`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setSyncMessage(json.error || `Sync failed (${res.status})`);
      } else {
        setSyncMessage((json.results || []).map((r: { customerId: string; until?: string; rows?: number; error?: string; skipped?: string }) =>
          r.error ? `${r.customerId}: ${r.error}` : r.skipped ? `${r.customerId}: ${r.skipped}` : `${r.customerId}: synced through ${r.until} (${r.rows} campaign-days)`
        ).join(' · '));
      }
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : 'Sync failed');
    }
    setSyncing(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">Google Ads data source</label>
        <select
          value={dataSource}
          onChange={e => setDataSource(e.target.value as GoogleDataSource)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
        >
          <option value="sheet">Google Sheet — the Google Ads tab in the Google Sheet section (default)</option>
          <option value="api">Google Ads API — spend, clicks and conversions straight from Google Ads</option>
        </select>
        <p className="mt-1 text-xs text-slate-500">
          With the API, Leads / Joins / Bookings are Google&apos;s lead-form, join and book-a-tour conversions. A client with no Meta ad accounts on the API source is Google-only: its dashboard opens on Google Ads and has no Meta view.
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">Google Ads account IDs</label>
        <input
          type="text"
          value={customerIds}
          onChange={e => setCustomerIds(e.target.value)}
          placeholder="989-891-4148"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
        />
        <p className="mt-1 text-xs text-slate-500">Comma-separated. Dashes are optional.</p>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">
          Google campaign filter
          <span className="ml-1 text-slate-500 font-normal">(campaign name contains any of these)</span>
        </label>
        <PillTagInput value={campaignFilter} onChange={setCampaignFilter} placeholder="e.g. #1433" />
        <p className="mt-1 text-xs text-slate-500">
          Use the club number (<code className="text-slate-400">#1433</code>), not the city — other clubs share city names. Leave empty to include every campaign in the accounts.
        </p>
      </div>

      <div className="text-xs text-slate-500">
        {syncedThrough ? <>Synced through <span className="text-slate-300 font-mono">{syncedThrough}</span></> : 'Not synced yet'}
        {lastError && <span className="block text-red-400 mt-1">Last sync error: {lastError}</span>}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
        </button>
        <button
          type="button"
          onClick={handleSync}
          disabled={syncing}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg border border-slate-700 transition-colors"
        >
          {syncing ? 'Syncing…' : 'Sync Google Ads now'}
        </button>
      </div>
      {syncMessage && <p className="text-xs text-slate-400">{syncMessage}</p>}
    </form>
  );
}
