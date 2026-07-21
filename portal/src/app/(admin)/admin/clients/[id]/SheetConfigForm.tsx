'use client';

import { useState } from 'react';
import PillTagInput from './PillTagInput';

type LeadsSource = 'meta' | 'sheet' | 'ghl';

interface Props {
  clientId: string;
  currentSheetId: string;
  currentSheetTab: string;
  currentGoogleSheetTab: string;
  currentLeadsSource: LeadsSource;
  hasGhlToken: boolean;
}

export default function SheetConfigForm({ clientId, currentSheetId, currentSheetTab, currentGoogleSheetTab, currentLeadsSource, hasGhlToken }: Props) {
  const [sheetId, setSheetId] = useState(currentSheetId);
  const [sheetTab, setSheetTab] = useState(currentSheetTab);
  const [googleSheetTab, setGoogleSheetTab] = useState(currentGoogleSheetTab);
  const [leadsSource, setLeadsSource] = useState<LeadsSource>(currentLeadsSource);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Greying-out the unavailable options is just a UX hint — the server-side
  // resolver in DashboardClient.tsx falls back to a valid source anyway.
  const sheetDisabled = !sheetTab.trim();
  const ghlDisabled = !hasGhlToken;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    await fetch(`/api/admin/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sheet_id: sheetId.trim(),
        sheet_tab: sheetTab.trim(),
        google_sheet_tab: googleSheetTab.trim(),
        leads_source: leadsSource,
      }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">
          Spreadsheet ID
          <span className="ml-1 text-slate-500 font-normal">(from the sheet URL)</span>
        </label>
        <input
          type="text"
          value={sheetId}
          onChange={e => setSheetId(e.target.value)}
          placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
        />
        <p className="mt-1 text-xs text-slate-500">
          Found in the URL: docs.google.com/spreadsheets/d/<strong className="text-slate-400">SPREADSHEET_ID</strong>/edit
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">
          Meta Tab Name
          <span className="ml-1 text-slate-500 font-normal">(Facebook/Meta data)</span>
        </label>
        <PillTagInput value={sheetTab} onChange={setSheetTab} placeholder="e.g. Sheet1" />
        <p className="mt-1 text-xs text-slate-500">
          One tab per pill. Add multiple to aggregate — e.g. <code className="text-slate-400">Alloy Middleton, WI</code> + <code className="text-slate-400">Alloy Wexford, PA</code> unions both tabs into one dataset. Press Enter or click away to add a tab name as its own pill.
        </p>
      </div>

      <div className="p-3 bg-slate-800/50 border border-slate-700/60 rounded-lg space-y-2">
        <label className="block text-xs font-medium text-slate-300">
          Leads KPI source <span className="ml-1 text-slate-500 font-normal">(which dataset feeds the &ldquo;Leads&rdquo; card on the Meta dashboard)</span>
        </label>
        <select
          value={leadsSource}
          onChange={e => setLeadsSource(e.target.value as LeadsSource)}
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
        >
          <option value="meta">Meta — Meta&apos;s pixel events (default)</option>
          <option value="sheet" disabled={sheetDisabled}>
            Google Sheet — sum of &ldquo;Leads&rdquo; column from the Meta tab above{sheetDisabled ? ' (set a Meta tab first)' : ''}
          </option>
          <option value="ghl" disabled={ghlDisabled}>
            GoHighLevel — count of booked-contact attributions{ghlDisabled ? ' (configure a GHL token first)' : ''}
          </option>
        </select>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          Per-campaign and per-asset breakdowns continue to use Meta&apos;s attribution regardless of this setting. If the chosen source becomes unavailable, the dashboard falls back to Meta automatically.
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">
          Google Ads Tab Name
          <span className="ml-1 text-slate-500 font-normal">(leave blank if no Google Ads dashboard)</span>
        </label>
        <PillTagInput value={googleSheetTab} onChange={setGoogleSheetTab} placeholder="e.g. Alloy Middleton, WI (Google)" />
        <p className="mt-1 text-xs text-slate-500">
          When set, the client&apos;s dashboard shows a &quot;View Google Ads&quot; switch. Add multiple pills to union several tabs.
        </p>
      </div>

      <button
        type="submit"
        disabled={saving}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
      >
        {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
      </button>
    </form>
  );
}
