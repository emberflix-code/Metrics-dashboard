'use client';

import { useState } from 'react';

interface Props {
  clientId: string;
  field: 'marketing_type' | 'offer';
  value: string;
  placeholder: string;
}

export default function InlineTextField({ clientId, field, value, placeholder }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await fetch(`/api/admin/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: draft }),
      });
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <input
        type="text"
        autoFocus
        value={draft}
        disabled={saving}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.currentTarget.blur(); }
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
        }}
        className="w-full bg-slate-800 border border-blue-500 rounded px-2 py-1 text-xs text-white focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="w-full text-left px-2 py-1 rounded text-xs hover:bg-slate-800 transition-colors"
    >
      {value ? <span className="text-slate-200">{value}</span> : <span className="text-slate-600">{placeholder}</span>}
    </button>
  );
}
