'use client';

import { useState } from 'react';

interface Props {
  clientId: string;
  field: 'sort_order';
  value: number;
}

export default function InlineNumberField({ clientId, field, value }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);

  async function save() {
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n)) { setDraft(String(value)); setEditing(false); return; }
    setSaving(true);
    try {
      await fetch(`/api/admin/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: n }),
      });
      window.location.reload();
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <input
        type="number"
        autoFocus
        value={draft}
        disabled={saving}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.currentTarget.blur(); }
          if (e.key === 'Escape') { setDraft(String(value)); setEditing(false); }
        }}
        className="w-16 bg-slate-800 border border-blue-500 rounded px-2 py-1 text-xs text-white focus:outline-none text-right"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="w-16 text-right px-2 py-1 rounded text-xs hover:bg-slate-800 transition-colors font-mono text-slate-300"
    >
      {value}
    </button>
  );
}
