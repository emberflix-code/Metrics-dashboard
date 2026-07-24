'use client';

import { useState } from 'react';

interface Props {
  clientId: string;
  current: boolean;
  /** Compact mode omits the label/description — for use inline in a table cell. */
  compact?: boolean;
}

export default function ActiveToggle({ clientId, current, compact = false }: Props) {
  const [enabled, setEnabled] = useState(current);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  async function toggle() {
    const next = !enabled;
    setEnabled(next);
    setStatus('saving');
    try {
      const res = await fetch(`/api/admin/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: next }),
      });
      if (!res.ok) { setEnabled(!next); setStatus('error'); return; }
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch {
      setEnabled(!next);
      setStatus('error');
    }
  }

  const switchButton = (
    <button
      type="button"
      onClick={toggle}
      disabled={status === 'saving'}
      title={status === 'error' ? 'Failed to save — try again' : undefined}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${enabled ? 'bg-blue-600' : 'bg-slate-600'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        {switchButton}
        {status === 'error' && <span className="text-xs text-red-400">Error</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm text-white font-medium">Active Client</p>
        <p className="text-xs text-slate-400 mt-0.5">
          When off, this client is hidden from the Agency Overview list. Their dashboard and login still work.
        </p>
      </div>
      <div className="flex items-center gap-3 ml-6 shrink-0">
        {status === 'saved' && <span className="text-xs text-emerald-400">Saved</span>}
        {status === 'error' && <span className="text-xs text-red-400">Error</span>}
        {switchButton}
      </div>
    </div>
  );
}
