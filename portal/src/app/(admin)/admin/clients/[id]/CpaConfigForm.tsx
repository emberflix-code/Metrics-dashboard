'use client';

import { useState } from 'react';

type RetainerMode = 'flat' | 'monthly';

interface RetainerRow {
  month: string; // "YYYY-MM"
  amount: number;
}

interface Props {
  clientId: string;
  currentSheetId: string;
  currentSheetTab: string;
  currentShowCpa: boolean;
  currentRetainerMode: RetainerMode;
  currentRetainerFlatAmount: number;
  currentRetainers: RetainerRow[];
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export default function CpaConfigForm({
  clientId,
  currentSheetId,
  currentSheetTab,
  currentShowCpa,
  currentRetainerMode,
  currentRetainerFlatAmount,
  currentRetainers,
}: Props) {
  const [sheetId, setSheetId] = useState(currentSheetId);
  const [sheetTab, setSheetTab] = useState(currentSheetTab);
  const [showCpa, setShowCpa] = useState(currentShowCpa);
  const [retainerMode, setRetainerMode] = useState<RetainerMode>(currentRetainerMode);
  const [retainerFlatAmount, setRetainerFlatAmount] = useState(String(currentRetainerFlatAmount));
  const [retainers, setRetainers] = useState<RetainerRow[]>(
    currentRetainers.length > 0 ? currentRetainers : [{ month: currentMonthKey(), amount: 0 }]
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const cpaDisabled = !sheetTab.trim();

  function updateRetainer(index: number, field: 'month' | 'amount', value: string) {
    setRetainers(prev => prev.map((r, i) => i === index
      ? { ...r, [field]: field === 'amount' ? Number(value) || 0 : value }
      : r));
  }

  function addRetainerRow() {
    setRetainers(prev => [...prev, { month: currentMonthKey(), amount: 0 }]);
  }

  function removeRetainerRow(index: number) {
    setRetainers(prev => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    await fetch(`/api/admin/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cpa_sheet_id: sheetId.trim(),
        cpa_sheet_tab: sheetTab.trim(),
        show_cpa: showCpa,
        retainer_mode: retainerMode,
        retainer_flat_amount: Number(retainerFlatAmount) || 0,
        retainers: retainerMode === 'monthly' ? retainers.filter(r => /^\d{4}-\d{2}$/.test(r.month)) : [],
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
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">
          Tab Name
          <span className="ml-1 text-slate-500 font-normal">(the leads tab — one row per lead)</span>
        </label>
        <input
          type="text"
          value={sheetTab}
          onChange={e => setSheetTab(e.target.value)}
          placeholder="Leads"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
        />
        <p className="mt-1 text-xs text-slate-500">
          Expects columns <code className="text-slate-400">Date Enrolled</code> and <code className="text-slate-400">Notes</code>. A lead counts as a &ldquo;won&rdquo; acquisition when Notes starts with <code className="text-slate-400">Won</code>.
        </p>
      </div>

      <div className="p-3 bg-slate-800/50 border border-slate-700/60 rounded-lg space-y-2">
        <div className="flex items-start gap-3">
          <input
            id="show-cpa"
            type="checkbox"
            checked={showCpa}
            onChange={e => setShowCpa(e.target.checked)}
            disabled={cpaDisabled}
            className="mt-0.5 w-4 h-4 rounded border-slate-600 bg-slate-900 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 disabled:opacity-50"
          />
          <label htmlFor="show-cpa" className="text-xs text-slate-300 leading-relaxed cursor-pointer">
            <span className="font-medium block">Show &ldquo;CPA&rdquo; KPI card on this client&apos;s dashboard</span>
            <span className="text-slate-500 mt-0.5 block">
              (Meta spend + prorated retainer) &divide; won leads in the selected date range{cpaDisabled ? ' — set a tab name first' : ''}.
            </span>
          </label>
        </div>
      </div>

      <div className="p-3 bg-slate-800/50 border border-slate-700/60 rounded-lg space-y-3">
        <label className="block text-xs font-medium text-slate-300">Retainer</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="radio"
              name="retainer-mode"
              checked={retainerMode === 'flat'}
              onChange={() => setRetainerMode('flat')}
              className="w-3.5 h-3.5 border-slate-600 bg-slate-900 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
            />
            Flat — same amount every month
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="radio"
              name="retainer-mode"
              checked={retainerMode === 'monthly'}
              onChange={() => setRetainerMode('monthly')}
              className="w-3.5 h-3.5 border-slate-600 bg-slate-900 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
            />
            Per month — set individually
          </label>
        </div>

        {retainerMode === 'flat' ? (
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Monthly retainer ($)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={retainerFlatAmount}
              onChange={e => setRetainerFlatAmount(e.target.value)}
              className="w-40 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
            />
          </div>
        ) : (
          <div className="space-y-2">
            {retainers.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="month"
                  value={r.month}
                  onChange={e => updateRetainer(i, 'month', e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={r.amount}
                  onChange={e => updateRetainer(i, 'amount', e.target.value)}
                  placeholder="Amount ($)"
                  className="w-32 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
                />
                <button
                  type="button"
                  onClick={() => removeRetainerRow(i)}
                  className="text-xs text-rose-400 hover:text-rose-300 px-2"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addRetainerRow}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              + Add month
            </button>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              A month with no row here contributes $0 to CPA for that period.
            </p>
          </div>
        )}
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
