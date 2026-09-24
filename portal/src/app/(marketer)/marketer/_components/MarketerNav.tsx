'use client';

import { usePathname, useSearchParams } from 'next/navigation';

const ITEMS: { href: string; label: string; exact?: boolean }[] = [
  { href: '/marketer', label: 'Overview', exact: true },
  { href: '/marketer/alerts', label: 'Alerts' },
  { href: '/marketer/targeting', label: 'Targeting' },
  { href: '/marketer/assets', label: 'Assets' },
  { href: '/marketer/fatigue', label: 'Fatigue' },
  { href: '/marketer/offers', label: 'Offers' },
];

// The date range (and the live toggle) follow the marketer from tab to tab
// instead of every page resetting to the 30-day default. Page-specific
// filters (client, offer, sort…) are deliberately not carried over.
const CARRIED_PARAMS = ['preset', 'since', 'until', 'live'];

export default function MarketerNav() {
  const pathname = usePathname() || '';
  const searchParams = useSearchParams();
  const carried = new URLSearchParams();
  for (const k of CARRIED_PARAMS) {
    const v = searchParams.get(k);
    if (v) carried.set(k, v);
  }
  const qs = carried.toString();
  return (
    <nav className="flex items-center gap-1">
      {ITEMS.map(it => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
        return (
          <a
            key={it.href}
            href={qs ? `${it.href}?${qs}` : it.href}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${active ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-900'}`}
          >
            {it.label}
          </a>
        );
      })}
    </nav>
  );
}
