'use client';

import { useState, useEffect, useRef } from 'react';

// Client-side instant filter over rows already rendered by the server.
// Each filterable <tr> carries data-search="name marketing_type offer"
// (lowercased, space-joined); group header rows carry data-group-header
// and are hidden when every row in their group is hidden by the filter.
export default function SearchBox() {
  const [term, setTerm] = useState('');
  const tableRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    tableRef.current = document.querySelector('[data-overview-table]');
  }, []);

  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const needle = term.trim().toLowerCase();
    const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr[data-search]'));
    const groupHeaders = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr[data-group-header]'));

    for (const row of rows) {
      const haystack = row.dataset.search || '';
      row.style.display = needle && !haystack.includes(needle) ? 'none' : '';
    }

    for (const header of groupHeaders) {
      const groupKey = header.dataset.groupHeader || '';
      const memberRows = rows.filter(r => r.dataset.group === groupKey);
      const anyVisible = memberRows.some(r => r.style.display !== 'none');
      header.style.display = needle && !anyVisible ? 'none' : '';
    }
  }, [term]);

  return (
    <input
      type="text"
      value={term}
      onChange={e => setTerm(e.target.value)}
      placeholder="Search clients…"
      className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 w-48"
    />
  );
}
