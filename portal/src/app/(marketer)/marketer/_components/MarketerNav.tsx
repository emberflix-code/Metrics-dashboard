'use client';

import { usePathname } from 'next/navigation';

const ITEMS: { href: string; label: string; exact?: boolean }[] = [
  { href: '/marketer', label: 'Overview', exact: true },
  { href: '/marketer/alerts', label: 'Alerts' },
  { href: '/marketer/targeting', label: 'Targeting' },
  { href: '/marketer/assets', label: 'Assets' },
  { href: '/marketer/fatigue', label: 'Fatigue' },
  { href: '/marketer/offers', label: 'Offers' },
];

export default function MarketerNav() {
  const pathname = usePathname() || '';
  return (
    <nav className="flex items-center gap-1">
      {ITEMS.map(it => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
        return (
          <a
            key={it.href}
            href={it.href}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${active ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-900'}`}
          >
            {it.label}
          </a>
        );
      })}
    </nav>
  );
}
