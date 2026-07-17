'use client';

import { useState, useRef } from 'react';

interface Props {
  clientId: string;
  currentFilter: string;
}

// Storage format is unchanged: a pipe-delimited string ("Acme|G1 MW|G2 MW"),
// same as matchesCampaignFilter (src/lib/meta.ts) already expects — this
// component only changes how an admin EDITS that string, not what's saved.
// Each tag is one OR'd substring keyword. Splitting/joining on '|' here is
// deliberately the only place that needs to agree with matchesCampaignFilter's
// own split('|') — keep both in sync if the delimiter ever changes.
function parseTags(filter: string): string[] {
  return filter.split('|').map(s => s.trim()).filter(Boolean);
}

export default function CampaignFilterForm({ clientId, currentFilter }: Props) {
  const [tags, setTags] = useState<string[]>(() => parseTags(currentFilter));
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // A comma is the exact typo that silently broke a real client's filter
  // (meant to be several separate tags, typed as one comma-joined blob) —
  // splitting on it here means that mistake can no longer happen: pasting
  // or typing "G1 MW, G2 MW" produces two tags instead of one broken one.
  function mergeTags(existing: string[], raw: string): string[] {
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    const next = [...existing];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    return next;
  }

  function commitDraft() {
    const value = draft.trim();
    setDraft('');
    if (!value) return;
    setTags(prev => mergeTags(prev, value));
  }

  function removeTag(tag: string) {
    setTags(prev => prev.filter(t => t !== tag));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      // Backspace on an empty input deletes the last tag — standard tag-input
      // convention, lets an admin correct a mistake without reaching for the mouse.
      setTags(prev => prev.slice(0, -1));
    }
  }

  async function handleSave() {
    // setState from commitDraft() wouldn't be visible on `tags` until the
    // next render, so compute the final list directly with the same merge
    // logic instead of calling commitDraft() and reading stale state.
    const finalTags = draft.trim() ? mergeTags(tags, draft.trim()) : tags;
    setStatus('saving');
    setErrorMsg('');
    try {
      const res = await fetch(`/api/admin/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaign_filter: finalTags.join('|') }),
      });
      const data = await res.json();
      if (!res.ok) { setErrorMsg(data.error || 'Failed to save'); setStatus('error'); return; }
      setTags(finalTags);
      setDraft('');
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch {
      setErrorMsg('Network error');
      setStatus('error');
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
          Campaign Name Keywords
        </label>
        <div
          className="w-full min-h-[42px] bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 flex flex-wrap items-center gap-1.5 focus-within:border-blue-500 cursor-text"
          onClick={() => inputRef.current?.focus()}
        >
          {tags.map(tag => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 bg-blue-600/20 border border-blue-500/40 text-blue-300 text-xs font-medium px-2 py-1 rounded-full"
            >
              {tag}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); removeTag(tag); }}
                className="text-blue-400 hover:text-white leading-none"
                aria-label={`Remove ${tag}`}
              >
                ×
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={commitDraft}
            placeholder={tags.length === 0 ? 'e.g. Acme, [GMN], FitLife' : 'Add another…'}
            className="flex-1 min-w-[120px] bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none py-0.5"
          />
        </div>
        <p className="text-xs text-slate-500 mt-1.5">
          A campaign matches if its name contains ANY of these keywords (case-insensitive, matches anywhere in the
          name). Press Enter, comma, or click away to add a keyword as its own tag — pasting a comma-separated list
          splits it into separate tags automatically.
        </p>
      </div>

      {errorMsg && (
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{errorMsg}</p>
      )}
      {status === 'saved' && (
        <p className="text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">Saved</p>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={status === 'saving'}
        className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
      >
        {status === 'saving' ? 'Saving...' : 'Save Filter'}
      </button>
    </div>
  );
}
