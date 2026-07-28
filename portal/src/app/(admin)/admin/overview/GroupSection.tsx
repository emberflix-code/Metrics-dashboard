'use client';

import { useState, ReactNode } from 'react';

interface Props {
  groupKey: string;
  count: number;
  barColor: string;
  tintColor: string;
  summaryText: string;
  children: ReactNode;
  colSpan: number;
}

// Monday.com-style collapsible group: a colored left accent bar on the
// header AND every row in the group, a tinted header background, and a
// chevron that rotates on collapse.
export default function GroupSection({ groupKey, count, barColor, tintColor, summaryText, children, colSpan }: Props) {
  const [open, setOpen] = useState(true);

  return (
    <>
      <tr
        className="cursor-pointer select-none"
        style={{ backgroundColor: tintColor }}
        onClick={() => setOpen(o => !o)}
        data-group-header={groupKey}
      >
        <td colSpan={colSpan} className="p-0">
          <div className="flex items-stretch">
            <div className="w-1.5 shrink-0" style={{ backgroundColor: barColor }} />
            <div className="flex items-center gap-2 px-3 py-2.5 flex-1">
              <svg
                className={`w-3.5 h-3.5 text-slate-400 transition-transform shrink-0 ${open ? 'rotate-90' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
              <span className="font-semibold text-white text-sm">{groupKey}</span>
              <span
                className="text-xs font-semibold px-1.5 py-0.5 rounded-full text-slate-900"
                style={{ backgroundColor: barColor }}
              >
                {count}
              </span>
              <div className="flex-1" />
              <span className="text-xs text-slate-400 font-mono pr-2">{summaryText}</span>
            </div>
          </div>
        </td>
      </tr>
      {open && children}
    </>
  );
}
