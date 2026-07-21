'use client';

import { useRef, useState } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  delimiter?: string;
}

// Same tag-pill UX as CampaignFilterForm, but for values that legitimately
// contain commas (sheet tab names like "Alloy Middleton, WI") — so tags are
// split/merged on `|` instead, matching fetchSheetRows' own split('|') in
// lib/sheets.ts. Keep both in sync if the delimiter ever changes.
function parseTags(raw: string, delimiter: string): string[] {
  return raw.split(delimiter).map(s => s.trim()).filter(Boolean);
}

export default function PillTagInput({ value, onChange, placeholder, delimiter = '|' }: Props) {
  const [tags, setTags] = useState<string[]>(() => parseTags(value, delimiter));
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function commit(nextTags: string[]) {
    setTags(nextTags);
    onChange(nextTags.join(delimiter));
  }

  function commitDraft() {
    const val = draft.trim();
    setDraft('');
    if (!val || tags.includes(val)) return;
    commit([...tags, val]);
  }

  function removeTag(tag: string) {
    commit(tags.filter(t => t !== tag));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === delimiter) {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      commit(tags.slice(0, -1));
    }
  }

  return (
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
        placeholder={tags.length === 0 ? placeholder : 'Add another…'}
        className="flex-1 min-w-[120px] bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none py-0.5"
      />
    </div>
  );
}
