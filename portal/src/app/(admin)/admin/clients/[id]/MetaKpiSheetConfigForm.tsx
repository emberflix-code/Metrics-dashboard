'use client';

import { useState } from 'react';

interface Props {
  clientId: string;
  currentSheetId: string;
  currentSheetTab: string;
  currentEnabled: boolean;
}

export default function MetaKpiSheetConfigForm({
  clientId,
  currentSheetId,
  currentSheetTab,
  currentEnabled,
}: Props) {
  const [sheetId, setSheetId] = useState(currentSheetId);
  const [sheetTab, setSheetTab] = useState(currentSheetTab);
  const [enabled, setEnabled] = useState(currentEnabled);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const toggleDisabled = !sheetId.trim() || !sheetTab.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    await fetch(`/api/admin/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meta_kpi_sheet_id: sheetId.trim(),
        meta_kpi_sheet_tab: sheetTab.trim(),
        show_meta_kpi_sheet: enabled,
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
          placeholder="1SoJFD8oyXPSecyis70x8zMZgyqSkRKorLXrkbfbVuoE"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">
          Tab Name
          <span className="ml-1 text-slate-500 font-normal">(the Account tab — one row per campaign/day)</span>
        </label>
        <input
          type="text"
          value={sheetTab}
          onChange={e => setSheetTab(e.target.value)}
          placeholder="Account"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
        />
        <p className="mt-1 text-xs text-slate-500">
          Expects columns <code className="text-slate-400">Campaign name</code> and <code className="text-slate-400">Reporting starts</code>; optionally <code className="text-slate-400">Bookings</code>, <code className="text-slate-400">Joins</code>, <code className="text-slate-400">Campaign Type</code>, <code className="text-slate-400">Offer</code>, <code className="text-slate-400">Location Name</code>, <code className="text-slate-400">State</code>, <code className="text-slate-400">Landing Page</code>.
        </p>
      </div>

      <div className="p-3 bg-slate-800/50 border border-slate-700/60 rounded-lg space-y-2">
        <div className="flex items-start gap-3">
          <input
            id="show-meta-kpi-sheet"
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            disabled={toggleDisabled}
            className="mt-0.5 w-4 h-4 rounded border-slate-600 bg-slate-900 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 disabled:opacity-50"
          />
          <label htmlFor="show-meta-kpi-sheet" className="text-xs text-slate-300 leading-relaxed cursor-pointer">
            <span className="font-medium block">Show Bookings / Joins KPI cards on this client&apos;s dashboard</span>
            <span className="text-slate-500 mt-0.5 block">
              Adds Bookings and Joins cards, filterable by Campaign Type, Offer, Location Name, State, and Landing Page{toggleDisabled ? ' — set a spreadsheet ID and tab name first' : ''}.
            </span>
          </label>
        </div>
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
