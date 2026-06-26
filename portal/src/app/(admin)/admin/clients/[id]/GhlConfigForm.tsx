'use client';

import { useState } from 'react';

interface Props {
  clientId: string;
  hasToken: boolean;
  currentLocationId: string;
  currentShowBookings: boolean;
  currentShowBookRate: boolean;
}

export default function GhlConfigForm({ clientId, hasToken, currentLocationId, currentShowBookings, currentShowBookRate }: Props) {
  const [token, setToken] = useState('');
  const [locationId, setLocationId] = useState(currentLocationId);
  const [showBookings, setShowBookings] = useState(currentShowBookings);
  const [showBookRate, setShowBookRate] = useState(currentShowBookRate);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [clearingConfirmed, setClearingConfirmed] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    const body: Record<string, unknown> = {
      show_bookings: showBookings,
      show_book_rate: showBookRate,
      ghl_location_id: locationId.trim(),
    };
    if (token.trim().length > 0) body.ghl_token = token.trim();
    await fetch(`/api/admin/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setSaving(false);
    setSaved(true);
    setToken(''); // Never leave a token visible after save.
    setTimeout(() => setSaved(false), 2500);
  }

  async function handleClear() {
    if (!clearingConfirmed) { setClearingConfirmed(true); return; }
    setSaving(true);
    await fetch(`/api/admin/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ghl_token_clear: true, show_bookings: false }),
    });
    setSaving(false);
    setClearingConfirmed(false);
    window.location.reload();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">
          Private Integration Token
          <span className="ml-1 text-slate-500 font-normal">
            {hasToken ? '(leave blank to keep current)' : '(required to enable bookings)'}
          </span>
        </label>
        <textarea
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder={hasToken ? '••••••••  (token is stored — paste a new one to replace)' : 'pit-…'}
          rows={2}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono resize-none"
        />
        <p className="mt-1 text-xs text-slate-500">
          Generate in GHL Settings → Private Integrations. Token needs at least <span className="font-mono text-slate-400">contacts.readonly</span>. Bookings are scoped to one GHL sub-account per client; multi-location umbrella clients are not yet supported.
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">
          Location ID
          <span className="ml-1 text-slate-500 font-normal">(required — GHL&apos;s API does not infer this from the token)</span>
        </label>
        <input
          type="text"
          value={locationId}
          onChange={e => setLocationId(e.target.value)}
          placeholder="ImpeLA9D5A19bjdUsRvq"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
        />
        <p className="mt-1 text-xs text-slate-500">
          Find this in the GHL URL when viewing the sub-account: <span className="font-mono">app.gohighlevel.com/v2/location/<strong className="text-slate-300">LOCATION_ID</strong>/dashboard</span>.
        </p>
      </div>

      <div className="p-3 bg-slate-800/50 border border-slate-700/60 rounded-lg space-y-3">
        <div className="flex items-start gap-3">
          <input
            id="show-bookings"
            type="checkbox"
            checked={showBookings}
            onChange={e => setShowBookings(e.target.checked)}
            disabled={!hasToken && token.trim().length === 0}
            className="mt-0.5 w-4 h-4 rounded border-slate-600 bg-slate-900 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 disabled:opacity-50"
          />
          <label htmlFor="show-bookings" className="text-xs text-slate-300 leading-relaxed cursor-pointer">
            <span className="font-medium block">Show &ldquo;Bookings&rdquo; KPI card on this client&apos;s dashboard</span>
            <span className="text-slate-500 mt-0.5 block">
              Counts booked-contact attribution rows from GHL within the selected date range. Independent of the &ldquo;Leads KPI source&rdquo; choice — bookings can be shown without changing where leads come from.
            </span>
          </label>
        </div>

        <div className="flex items-start gap-3 pl-7">
          <input
            id="show-book-rate"
            type="checkbox"
            checked={showBookRate}
            onChange={e => setShowBookRate(e.target.checked)}
            disabled={!showBookings}
            className="mt-0.5 w-4 h-4 rounded border-slate-600 bg-slate-900 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 disabled:opacity-50"
          />
          <label htmlFor="show-book-rate" className={`text-xs leading-relaxed cursor-pointer ${showBookings ? 'text-slate-300' : 'text-slate-500'}`}>
            <span className="font-medium block">Also show book rate (bookings &divide; leads &times; 100%)</span>
            <span className="text-slate-500 mt-0.5 block">
              When on, the Bookings card shows the book rate as a subtitle, e.g. <span className="font-mono text-slate-400">4 &middot; 44%</span>. Only available when the Bookings card is shown.
            </span>
          </label>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={saving || (!hasToken && token.trim().length === 0)}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
        </button>
        {hasToken && (
          <button
            type="button"
            onClick={handleClear}
            disabled={saving}
            className="px-3 py-2 text-xs text-rose-400 hover:text-rose-300 border border-rose-500/30 hover:border-rose-500/60 rounded-lg transition-colors"
          >
            {clearingConfirmed ? 'Click again to confirm' : 'Remove token'}
          </button>
        )}
      </div>
    </form>
  );
}
