'use client';

import { useState } from 'react';

interface SheetTabRow {
  month: string; // "YYYY-MM"
  tabName: string;
}

interface Props {
  clientId: string;
  currentSheetId: string;
  currentEnabled: boolean;
  currentTabs: SheetTabRow[];
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export default function MetaKpiSheetConfigForm({
  clientId,
  currentSheetId,
  currentEnabled,
  currentTabs,
}: Props) {
  const [sheetId, setSheetId] = useState(currentSheetId);
  const [enabled, setEnabled] = useState(currentEnabled);
  const [tabs, setTabs] = useState<SheetTabRow[]>(
    currentTabs.length > 0 ? currentTabs : [{ month: currentMonthKey(), tabName: '' }]
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const hasAnyTab = tabs.some(t => t.tabName.trim());
  const toggleDisabled = !sheetId.trim() || !hasAnyTab;

  function updateTab(index: number, field: 'month' | 'tabName', value: string) {
    setTabs(prev => prev.map((t, i) => i === index ? { ...t, [field]: value } : t));
  }

  function addTabRow() {
    setTabs(prev => [...prev, { month: currentMonthKey(), tabName: '' }]);
  }

  function removeTabRow(index: number) {
    setTabs(prev => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    await fetch(`/api/admin/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meta_kpi_sheet_id: sheetId.trim(),
        show_meta_kpi_sheet: enabled,
        meta_kpi_sheet_tabs: tabs
          .filter(t => /^\d{4}-\d{2}$/.test(t.month) && t.tabName.trim())
          .map(t => ({ month: t.month, tabName: t.tabName.trim() })),
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
          <span className="ml-1 text-slate-500 font-normal">(from the sheet URL — shared across every month below)</span>
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
        <label className="block text-xs font-medium text-slate-300 mb-1.5">
          Monthly tabs
          <span className="ml-1 text-slate-500 font-normal">(one tab per calendar month — the sheet has a separate tab for each month, e.g. &ldquo;Account - July 2026&rdquo;)</span>
        </label>
        <div className="space-y-2">
          {tabs.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="month"
                value={t.month}
                onChange={e => updateTab(i, 'month', e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
              />
              <input
                type="text"
                value={t.tabName}
                onChange={e => updateTab(i, 'tabName', e.target.value)}
                placeholder="Exact tab name for this month"
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={() => removeTabRow(i)}
                className="text-xs text-rose-400 hover:text-rose-300 px-2"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addTabRow}
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            + Add month
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          A month with no row here (or whose tab fails to load) falls back to the last synced data for that month, if any — see &ldquo;Sync now&rdquo; below. Each tab expects columns <code className="text-slate-400">Campaign name</code> and <code className="text-slate-400">Reporting starts</code>; optionally <code className="text-slate-400">Bookings</code>, <code className="text-slate-400">Joins</code>, <code className="text-slate-400">Campaign Type</code>, <code className="text-slate-400">Offer</code>, <code className="text-slate-400">Location Name</code>, <code className="text-slate-400">State</code>, <code className="text-slate-400">Landing Page</code>.
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
              Adds Bookings and Joins cards, filterable by Campaign Type, Offer, Location Name, State, and Landing Page{toggleDisabled ? ' — set a spreadsheet ID and at least one month\'s tab first' : ''}.
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
