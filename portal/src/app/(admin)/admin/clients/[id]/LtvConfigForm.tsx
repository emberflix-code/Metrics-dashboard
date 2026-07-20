'use client';

import { useState } from 'react';

interface Props {
  clientId: string;
  currentLtvValue: number;
  currentShowLtv: boolean;
}

export default function LtvConfigForm({ clientId, currentLtvValue, currentShowLtv }: Props) {
  const [ltvValue, setLtvValue] = useState(String(currentLtvValue));
  const [showLtv, setShowLtv] = useState(currentShowLtv);
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
        ltv_value: Number(ltvValue) || 0,
        show_ltv: showLtv,
      }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">Value per sale ($)</label>
        <input
          type="number"
          min="0"
          step="0.01"
          value={ltvValue}
          onChange={e => setLtvValue(e.target.value)}
          className="w-40 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
        />
        <p className="mt-1 text-xs text-slate-500">
          LTV = won leads in the selected date range &times; this value. Won leads come from the CPA acquisitions sheet configured above.
        </p>
      </div>

      <div className="p-3 bg-slate-800/50 border border-slate-700/60 rounded-lg space-y-2">
        <div className="flex items-start gap-3">
          <input
            id="show-ltv"
            type="checkbox"
            checked={showLtv}
            onChange={e => setShowLtv(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded border-slate-600 bg-slate-900 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
          />
          <label htmlFor="show-ltv" className="text-xs text-slate-300 leading-relaxed cursor-pointer">
            <span className="font-medium block">Show &ldquo;LTV&rdquo; KPI card on this client&apos;s dashboard</span>
            <span className="text-slate-500 mt-0.5 block">
              Requires an acquisitions sheet tab to be set above (same sheet the CPA card uses).
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
