'use client';

import { useState } from 'react';

interface Props {
  clientId: string;
  currentSheetId: string;
  currentSheetTab: string;
  currentGoogleSheetTab: string;
}

export default function SheetConfigForm({ clientId, currentSheetId, currentSheetTab, currentGoogleSheetTab }: Props) {
  const [sheetId, setSheetId] = useState(currentSheetId);
  const [sheetTab, setSheetTab] = useState(currentSheetTab);
  const [googleSheetTab, setGoogleSheetTab] = useState(currentGoogleSheetTab);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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
        <input
          type="text"
          value={sheetTab}
          onChange={e => setSheetTab(e.target.value)}
          placeholder="Sheet1"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">
          Google Ads Tab Name
          <span className="ml-1 text-slate-500 font-normal">(leave blank if no Google Ads dashboard)</span>
        </label>
        <input
          type="text"
          value={googleSheetTab}
          onChange={e => setGoogleSheetTab(e.target.value)}
          placeholder="Alloy Middleton, WI (Google)"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
        />
        <p className="mt-1 text-xs text-slate-500">
          When set, the client&apos;s dashboard shows a &quot;View Google Ads&quot; switch.
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
