'use client';

import { useState, useEffect, useRef } from 'react';

// Client-side instant filter over rows already rendered by the server.
// Each filterable <tr> carries data-search="name marketing_type offer"
// (lowercased, space-joined); group header rows carry data-group-header
// and are hidden when every row in their group is hidden by the filter.
//
// Perf: querySelectorAll + a filter-per-group scan used to re-run on every
// single keystroke (O(n) DOM query + O(groups * n) group-visibility check),
// which got noticeably laggy once the client list grew past ~70 rows. Rows
// and the row->group index are now captured ONCE on mount (rows don't change
// without a full page reload anyway — sort/group/date changes always
// navigate), and filtering itself is debounced ~120ms so fast typing doesn't
// thrash layout on every keystroke.
const DEBOUNCE_MS = 120;

export default function SearchBox() {
  const [term, setTerm] = useState('');
  const rowsRef = useRef<HTMLTableRowElement[] | null>(null);
  const groupHeadersRef = useRef<HTMLTableRowElement[] | null>(null);
  const rowsByGroupRef = useRef<Map<string, HTMLTableRowElement[]> | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const table = document.querySelector('[data-overview-table]');
    if (!table) return;
    const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr[data-search]'));
    const groupHeaders = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr[data-group-header]'));
    const byGroup = new Map<string, HTMLTableRowElement[]>();
    for (const row of rows) {
      const key = row.dataset.group;
      if (!key) continue;
      const list = byGroup.get(key) || [];
      list.push(row);
      byGroup.set(key, list);
    }
    rowsRef.current = rows;
    groupHeadersRef.current = groupHeaders;
    rowsByGroupRef.current = byGroup;
  }, []);

  function applyFilter(needle: string) {
    const rows = rowsRef.current;
    const groupHeaders = groupHeadersRef.current;
    const byGroup = rowsByGroupRef.current;
    if (!rows || !groupHeaders || !byGroup) return;

    for (const row of rows) {
      const haystack = row.dataset.search || '';
      row.style.display = needle && !haystack.includes(needle) ? 'none' : '';
    }
    for (const header of groupHeaders) {
      const groupKey = header.dataset.groupHeader || '';
      const memberRows = byGroup.get(groupKey) || [];
      const anyVisible = memberRows.some(r => r.style.display !== 'none');
      header.style.display = needle && !anyVisible ? 'none' : '';
    }
  }

  function handleChange(value: string) {
    setTerm(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      applyFilter(value.trim().toLowerCase());
    }, DEBOUNCE_MS);
  }

  return (
    <div className="relative w-full">
      <svg
        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none"
        fill="none" stroke="currentColor" viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <input
        type="text"
        value={term}
        onChange={e => handleChange(e.target.value)}
        placeholder="Search clients…"
        className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
      />
    </div>
  );
}
