'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { GmnBooking, GmnBookingKind, GmnCopyItem, GmnCreative, GmnCreativeLocation, GmnLocationDetail, GmnMetricRow, GmnOfferDetail, GmnReportMonth, GmnReportPayload } from '@/lib/gmnReport';
import { groupReport, groupsWithData } from '@/lib/gmnReportGroups';
import { fmtInt, fmtPct, fmtUsd, adsManagerAdUrl } from '@/app/(marketer)/marketer/_components/format';
import EnhancedView, { BRAND_FONT_STACK, BRAND_LOGOS, CopyText, type BrandKey, type CopyKind } from './EnhancedView';

interface Props {
  clientName: string;
  months: GmnReportMonth[];
  selectedMonth: string | null;
  report: GmnReportPayload | null;
}

// Alloy deck palette: charcoal background, yellow accents.
const ACCENT = 'text-[#E1E000]';

// Deployed-build label, same as the main dashboard's (NEXT_PUBLIC_VERSION / NEXT_PUBLIC_BUILD_SHA are set at build time).
function versionLabel(): string {
  const version = process.env.NEXT_PUBLIC_VERSION;
  const sha = process.env.NEXT_PUBLIC_BUILD_SHA || 'dev';
  if (!version || version === sha) return `v.${sha}`;
  return `${version} (${sha})`;
}

export default function GmnReportClient({ clientName, months, selectedMonth, report: fullReport }: Props) {
  // Location groups (e.g. Presale) get their own tab; "All locations" is the report exactly as published.
  const groups = useMemo(() => (fullReport ? groupsWithData(fullReport) : []), [fullReport]);
  const [groupKey, setGroupKey] = useState<string | null>(null);
  useEffect(() => {
    try { const g = new URLSearchParams(window.location.search).get('group'); if (g) setGroupKey(g); } catch { /* no URL access */ }
  }, []);
  const activeGroup = groups.find(g => g.key === groupKey);
  const report = useMemo(() => (fullReport && activeGroup ? groupReport(fullReport, activeGroup) : fullReport), [fullReport, activeGroup]);
  const pickGroup = (key: string | null) => {
    setGroupKey(key);
    setOpenLocation(null); setOpenOffer(null); setOpenCreative(null); setOpenCopy(null); setOpenBookings(null);
    try {
      const u = new URL(window.location.href);
      if (key) u.searchParams.set('group', key); else u.searchParams.delete('group');
      window.history.replaceState(null, '', u.toString());
    } catch { /* no URL access */ }
  };
  const [openLocation, setOpenLocation] = useState<string | null>(null);
  const [openOffer, setOpenOffer] = useState<string | null>(null);
  // Bookings / SPS click-through: the entries behind a location's number (fetched on open, never in the page data).
  const [openBookings, setOpenBookings] = useState<{ label: string; kind: GmnBookingKind; paidOnly: boolean } | null>(null);
  const bookingLabels = useMemo(() => new Set(fullReport?.bookingDetailLocations ?? []), [fullReport]);
  const spsLabels = useMemo(() => new Set(fullReport?.spsDetailLocations ?? []), [fullReport]);
  const showBookings = bookingLabels.size ? (label: string, paidOnly = false) => { if (bookingLabels.has(label)) setOpenBookings({ label, kind: 'bookings', paidOnly }); } : undefined;
  const showSps = spsLabels.size ? (label: string, paidOnly = false) => { if (spsLabels.has(label)) setOpenBookings({ label, kind: 'sps', paidOnly }); } : undefined;
  const details = report?.locationDetails;
  const offerDetails = report?.offerDetails;
  const openDetail = openLocation && details ? details[openLocation] : undefined;
  const openOfferDetail = openOffer && offerDetails ? offerDetails[openOffer] : undefined;
  const showLocation = details ? (label: string) => { if (details[label]) { setOpenOffer(null); setOpenLocation(label); } } : undefined;
  const showOffer = offerDetails ? (label: string) => { if (offerDetails[label]) { setOpenLocation(null); setOpenOffer(label); } } : undefined;
  // Classic (default) vs Enhanced (beta) view — remembered per browser; Classic stays exactly as before.
  const [view, setView] = useState<'classic' | 'enhanced'>('classic');
  useEffect(() => {
    try { if (localStorage.getItem('gmn-report-view') === 'enhanced') setView('enhanced'); } catch { /* storage blocked */ }
  }, []);
  const pickView = (v: 'classic' | 'enhanced') => {
    setView(v);
    try { localStorage.setItem('gmn-report-view', v); } catch { /* storage blocked */ }
  };
  const brand: BrandKey | undefined = /^alloy/i.test(clientName) ? 'alloy' : undefined;
  // modals take the brand look only in the Enhanced view; Classic modals keep their original look
  const panelBrand = view === 'enhanced' ? brand : undefined;
  const [openCreative, setOpenCreative] = useState<GmnCreative | null>(null);
  const [openCopy, setOpenCopy] = useState<{ item: GmnCopyItem; kind: CopyKind } | null>(null);
  const showCreative = (c: GmnCreative) => { setOpenLocation(null); setOpenOffer(null); setOpenCopy(null); setOpenCreative(c); };
  const showCopy = (item: GmnCopyItem, kind: CopyKind) => { setOpenLocation(null); setOpenOffer(null); setOpenCreative(null); setOpenCopy({ item, kind }); };
  const openLocationFromCreative = showLocation ? (label: string) => { setOpenCreative(null); setOpenCopy(null); showLocation(label); } : undefined;
  return (
    <div className="min-h-screen bg-[#2C2A29] text-slate-100">
      <header className="border-b border-white/10 bg-black/20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <a href="/dashboard" className="text-xs text-slate-400 hover:text-white">← Back to dashboard</a>
            <h1 className="text-xl sm:text-2xl font-semibold mt-1">GMN Marketing Report</h1>
            <p className="text-sm text-slate-400">{clientName}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
          {report && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">View</span>
              <div className="flex bg-black/30 border border-white/15 rounded-lg p-0.5" role="tablist" aria-label="Report view">
                {(['classic', 'enhanced'] as const).map(v => (
                  <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => pickView(v)}
                    className={`text-xs px-3 py-1.5 rounded-md transition-colors ${view === v ? 'bg-[#E1E000] text-black font-semibold' : 'text-slate-300 hover:text-white'}`}>
                    {v === 'classic' ? 'Classic' : 'Enhanced (beta)'}
                  </button>
                ))}
              </div>
            </div>
          )}
          {months.length > 0 && (
            <label className="text-sm text-slate-300 flex items-center gap-2">
              Month
              <select
                value={selectedMonth ?? ''}
                onChange={e => { window.location.href = `/dashboard/gmn-report?month=${encodeURIComponent(e.target.value)}${activeGroup ? `&group=${encodeURIComponent(activeGroup.key)}` : ''}`; }}
                className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white"
              >
                {months.map(m => <option key={m.month} value={m.month}>{m.label}</option>)}
              </select>
            </label>
          )}
          </div>
        </div>
      </header>

      {report && groups.length > 0 && (
        <nav className="border-b border-white/10 bg-black/10" aria-label="Report sections">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 flex gap-1 overflow-x-auto" role="tablist">
            {[{ key: null as string | null, label: 'All locations' }, ...groups.map(g => ({ key: g.key as string | null, label: g.label }))].map(t => {
              const on = (activeGroup?.key ?? null) === t.key;
              return (
                <button key={t.key ?? 'all'} type="button" role="tab" aria-selected={on} onClick={() => pickGroup(t.key)}
                  className={`px-4 py-3 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${on ? 'border-[#E1E000] text-white font-semibold' : 'border-transparent text-slate-400 hover:text-white'}`}>
                  {t.label}
                </button>
              );
            })}
          </div>
        </nav>
      )}

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-12">
        {!report ? (
          <div className="text-center py-24">
            <h2 className="text-lg font-semibold">No report published yet</h2>
            <p className="text-sm text-slate-400 mt-2">Your monthly marketing report will appear here once it is published.</p>
          </div>
        ) : view === 'enhanced' ? (
          <EnhancedView
            report={report}
            brand={brand}
            onOpenLocation={showLocation}
            onOpenOffer={showOffer}
            onOpenCopy={showCopy}
            renderCreatives={cs => <CreativeGroups creatives={cs} onShowLocations={showCreative} cols="grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" />}
          />
        ) : (
          <>
            <section>
              <p className={`text-sm font-semibold uppercase tracking-wider ${ACCENT}`}>{report.monthLabel}</p>
              <h2 className="text-2xl sm:text-3xl font-light mt-1">{report.title}</h2>
            </section>
            <Overview report={report} />
            <MetricTable
              title="Meta Campaign Breakdown"
              subtitle={[
                details ? 'Click a location to see its own offer breakdown and top creatives.' : '',
                showBookings ? `Click a Bookings${showSps ? ' or SPS' : ''} number to see who booked.` : showSps ? 'Click an SPS number to see who booked.' : '',
                report.locations.some(r => r.bookingsPaid !== undefined)
                  ? 'Bookings and SPS (Starting Point Sessions) count each person once per date (booked again on another date = counted again; staff entries left out). Paid = from our paid ads, Total = paid + organic. CPB – Paid ads = spend ÷ Bookings – Paid.'
                  : '',
                report.locations.some(r => r.spsTotal === null) ? 'SPS N/A = the location records no SPS in GoHighLevel that month.' : '',
              ].filter(Boolean).join(' ') || undefined}
              firstCol="Location"
              rows={report.locations}
              total={report.locationsTotal}
              onRowClick={showLocation}
              bookingLabels={bookingLabels}
              onBookingsClick={showBookings}
              spsLabels={spsLabels}
              onSpsClick={showSps}
            />
            <MetricTable
              title="Marketing Offer Breakdown"
              subtitle={offerDetails ? 'Click an offer to see which locations ran it.' : undefined}
              firstCol="Offer"
              rows={report.offers}
              total={report.offersTotal}
              onRowClick={offerDetails ? label => { if (offerDetails[label]) setOpenOffer(label); } : undefined}
            />
            <TopCreatives creatives={report.topCreatives} note={report.creativesNote} onShowLocations={showCreative} />
            {report.notes && report.notes.length > 0 && (
              <section className="text-xs text-slate-400 space-y-1 border-t border-white/10 pt-6">
                {report.notes.map((n, i) => <p key={i}>{n}</p>)}
              </section>
            )}
          </>
        )}
      </main>
      <footer className="max-w-7xl mx-auto px-4 sm:px-6 py-4 text-center text-[11px] text-slate-500 border-t border-white/10">
        GMN Marketing Report
        <span className="ml-2 font-mono opacity-70" title="Deployed build">{versionLabel()}</span>
      </footer>
      {/* always-visible build badge, same as the main dashboard (z-30: below the pop-ups, which sit at z-50) */}
      <div className="fixed bottom-3 right-3 z-30 font-mono text-[10px] text-slate-400 bg-black/60 border border-white/10 rounded px-2 py-1 backdrop-blur-sm pointer-events-none select-none" title="Deployed build">
        {versionLabel()}
      </div>
      {openLocation && openDetail && report && (
        <LocationPanel
          name={openLocation}
          monthLabel={report.monthLabel}
          detail={openDetail}
          note={report.locationCreativesNote}
          brand={panelBrand}
          onClose={() => setOpenLocation(null)}
        />
      )}
      {openOffer && openOfferDetail && report && (
        <OfferPanel
          name={openOffer}
          monthLabel={report.monthLabel}
          detail={openOfferDetail}
          brand={panelBrand}
          onClose={() => setOpenOffer(null)}
          onLocation={showLocation}
        />
      )}
      {openCopy && report && (
        <CopyPanel
          item={openCopy.item}
          kind={openCopy.kind}
          monthLabel={report.monthLabel}
          brand={panelBrand}
          onClose={() => setOpenCopy(null)}
          onLocation={openLocationFromCreative}
        />
      )}
      {openBookings && report && (
        <BookingsPanel
          key={`${openBookings.label}|${openBookings.kind}|${openBookings.paidOnly}`}
          location={openBookings.label}
          kind={openBookings.kind}
          paidOnly={openBookings.paidOnly}
          month={report.month}
          monthLabel={report.monthLabel}
          row={report.locations.find(r => r.label === openBookings.label)}
          brand={panelBrand}
          onClose={() => setOpenBookings(null)}
        />
      )}
      {openCreative && report && (
        <CreativePanel
          c={openCreative}
          monthLabel={report.monthLabel}
          brand={panelBrand}
          onClose={() => setOpenCreative(null)}
          onLocation={openLocationFromCreative}
        />
      )}
    </div>
  );
}

// Modal shell shared by the location, offer and creative click-throughs (Esc / backdrop / Close button close it).
// With a brand (Enhanced view only) the header turns black with the brand logo and a yellow accent rule.
function Panel({ kicker, title, onClose, brand, children }: { kicker: string; title: string; onClose: () => void; brand?: BrandKey; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 overflow-y-auto" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-w-6xl mx-auto my-6 sm:my-10 px-4" onClick={e => e.stopPropagation()}>
        <div className={`bg-[#2C2A29] border rounded-2xl shadow-2xl overflow-hidden ${brand ? 'border-[#E1E000]/40 gmn-enhanced' : 'border-white/15'}`}>
          {brand ? (
            <div className="relative bg-black">
              <div aria-hidden className="absolute -right-16 -top-16 w-48 h-48 rotate-45 bg-[#E1E000]/10" />
              <div className="relative flex items-center justify-between gap-4 px-5 sm:px-6 py-4">
                <div className="flex items-center gap-4 min-w-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={BRAND_LOGOS[brand]} alt="" className="h-10 w-auto shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#E1E000]" style={{ fontFamily: BRAND_FONT_STACK }}>{kicker}</p>
                    <h2 className="text-xl sm:text-3xl font-bold uppercase leading-tight truncate" style={{ fontFamily: BRAND_FONT_STACK }}>{title}</h2>
                  </div>
                </div>
                <button type="button" onClick={onClose} className="shrink-0 text-black bg-[#E1E000] hover:bg-[#f0f04d] text-sm font-semibold rounded-lg px-3 py-1.5">
                  Close
                </button>
              </div>
              <div aria-hidden className="h-1 bg-gradient-to-r from-[#E1E000] via-[#E1E000]/50 to-transparent" />
            </div>
          ) : (
            <div className="flex items-start justify-between gap-4 px-5 sm:px-6 py-4 border-b border-white/10">
              <div>
                <p className={`text-xs font-semibold uppercase tracking-wider ${ACCENT}`}>{kicker}</p>
                <h2 className="text-xl sm:text-2xl font-light mt-0.5">{title}</h2>
              </div>
              <button type="button" onClick={onClose} className="text-slate-300 hover:text-white text-sm border border-white/20 rounded-lg px-3 py-1.5">
                Close
              </button>
            </div>
          )}
          <div className="px-5 sm:px-6 py-6 space-y-10">{children}</div>
        </div>
      </div>
    </div>
  );
}

function RowTiles({ r }: { r: GmnMetricRow }) {
  const tiles: [string, string][] = [
    ['Spend', fmtUsd(r.spend)], ['Leads', fmtInt(r.leads)], ['CPL', fmtUsd(r.cpl)],
    ...(r.bookingsPaid !== undefined
      ? [['Bookings – Paid', fmtInt(r.bookingsPaid ?? null)], ['Bookings – Total', fmtInt(r.bookings)], ['CPB – Paid ads', fmtUsd(r.cpb)]] as [string, string][]
      : [['Bookings', fmtInt(r.bookings)], ['CPB', fmtUsd(r.cpb)]] as [string, string][]),
    ['CTR', fmtPct(r.ctr)],
    ...(r.spsTotal !== undefined ? [['SPS – Paid', fmtSps(r.spsPaid)], ['SPS – Total', fmtSps(r.spsTotal)]] as [string, string][] : []),
  ];
  return (
    <div className={`grid grid-cols-3 ${tiles.length > 7 ? 'lg:grid-cols-9' : 'lg:grid-cols-6'} gap-3`}>
      {tiles.map(([l, v]) => (
        <div key={l} className="bg-black/25 border border-white/10 rounded-xl px-4 py-3">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">{l}</p>
          <p className="text-lg font-semibold mt-0.5 tabular-nums">{v}</p>
        </div>
      ))}
    </div>
  );
}

// One location's own view: its numbers, its top creatives ranked by its own CPL, then its offer breakdown (bookings
// split across its offers by lead share, same as the all-locations table).
function LocationPanel({ name, monthLabel, detail, note, brand, onClose }: {
  name: string; monthLabel: string; detail: GmnLocationDetail; note?: string; brand?: BrandKey; onClose: () => void;
}) {
  return (
    <Panel kicker={monthLabel} title={name} onClose={onClose} brand={brand}>
      <RowTiles r={detail.row} />
      <TopCreatives creatives={detail.topCreatives} note={note} cols="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" emptyText="No creative at this location reached $100 spend with at least one lead this month." />
      <MetricTable title="Marketing Offer Breakdown" firstCol="Offer" rows={detail.offers} total={{ ...detail.row, label: 'Total' }} />
    </Panel>
  );
}

// One offer's view: the locations that ran it, each with its numbers for this offer (bookings = that location's
// calendar count split by its lead share). Location names jump to that location's own panel.
function OfferPanel({ name, monthLabel, detail, brand, onClose, onLocation }: {
  name: string; monthLabel: string; detail: GmnOfferDetail; brand?: BrandKey; onClose: () => void; onLocation?: (label: string) => void;
}) {
  return (
    <Panel kicker={`${monthLabel} · Offer`} title={name} onClose={onClose} brand={brand}>
      <RowTiles r={detail.row} />
      <MetricTable
        title={`Locations that ran this offer (${detail.locations.length})`}
        subtitle={onLocation ? 'Click a location to open its own report.' : undefined}
        firstCol="Location"
        rows={detail.locations}
        total={{ ...detail.row, label: 'Total' }}
        onRowClick={onLocation}
      />
    </Panel>
  );
}

const STATUS_LABEL: Record<string, string> = { confirmed: 'Confirmed', showed: 'Showed', noshow: 'No-show', cancelled: 'Cancelled', booked: 'Booked' };

// Who is behind a location's Bookings (or SPS) numbers: each calendar entry with its date, calendar, status and the paid
// ad (our Meta campaign) the lead came from. Loaded on open from /api/gmn-report/bookings.
function BookingsPanel({ location, kind, paidOnly = false, month, monthLabel, row, brand, onClose }: {
  location: string; kind: GmnBookingKind; paidOnly?: boolean; month: string; monthLabel: string; row?: GmnMetricRow; brand?: BrandKey; onClose: () => void;
}) {
  const sps = kind === 'sps';
  const [rows, setRows] = useState<GmnBooking[] | null>(null);
  const [error, setError] = useState(false);
  // opened from a Paid number: start with only the paid-ad leads (the checkbox still shows everyone when unticked)
  const [onlyAds, setOnlyAds] = useState(paidOnly);
  useEffect(() => {
    let live = true;
    setRows(null); setError(false);
    fetch(`/api/gmn-report/bookings?month=${encodeURIComponent(month)}&location=${encodeURIComponent(location)}${sps ? '&kind=sps' : ''}`)
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j: { rows: GmnBooking[] }) => { if (live) setRows(j.rows); })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [month, location, sps]);
  const isOurs = (r: GmnBooking) => !!(r.campaign || r.adLead || r.via === 'our_form');
  const fromAds = rows?.filter(isOurs).length ?? 0;
  // With the paid split, a person counts once per date: a second entry for the same person on the same date is a
  // repeat (on another date it counts again). Older snapshots count every entry, so any later entry is a repeat.
  const perDate = sps || row?.bookingsPaid !== undefined;
  const repeatOf = useMemo(() => {
    const personKey = (r: GmnBooking) => r.name.trim().toLowerCase().replace(/\s+/g, ' ') + (perDate ? `|${r.date}` : '');
    const seen = new Map<string, number>();
    return (rows ?? []).map((r, i) => {
      const k = personKey(r);
      const first = seen.get(k);
      if (first == null) { seen.set(k, i); return null; }
      return first;
    });
  }, [rows, perDate]);
  const uniquePeople = repeatOf.filter(x => x == null).length;
  const shown = rows ? rows.map((r, i) => ({ r, i })).filter(({ r }) => !onlyAds || isOurs(r)) : [];
  const calendars = rows ? Array.from(new Set(rows.map(r => r.calendar))) : [];
  return (
    <Panel kicker={`${monthLabel} · ${sps ? 'SPS (Starting Point Sessions)' : 'Bookings'}`} title={location} onClose={onClose} brand={brand}>
      {error && <p className="text-sm text-red-300">Couldn&apos;t load the {sps ? 'SPS bookings' : 'bookings'} for this location.</p>}
      {!rows && !error && <p className="text-sm text-slate-400">Loading…</p>}
      {rows && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {(sps ? [
              ['SPS – Paid', fmtInt(row?.spsPaid ?? null)],
              ['SPS – Total', fmtInt(row?.spsTotal ?? null)],
              ['SPS entries', fmtInt(rows.length)],
              ['Same-day repeats / staff', fmtInt(rows.length - (row?.spsTotal ?? uniquePeople))],
            ] : perDate ? [
              ['Bookings – Paid', fmtInt(row?.bookingsPaid ?? null)],
              ['Bookings – Total', fmtInt(row?.bookings ?? null)],
              ['Calendar entries', fmtInt(rows.length)],
              ['Same-day repeats / staff', fmtInt(rows.length - (row?.bookings ?? uniquePeople))],
            ] : [
              ['Bookings', fmtInt(row?.bookings ?? rows.length)],
              ['Unique people', fmtInt(uniquePeople)],
              ['From our paid ads', fmtInt(fromAds)],
              ['Other entries', fmtInt(rows.length - fromAds)],
            ] as [string, string][]).map(([l, v]) => (
              <div key={l} className="bg-black/25 border border-white/10 rounded-xl px-4 py-3">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">{l}</p>
                <p className="text-lg font-semibold mt-0.5 tabular-nums">{v}</p>
              </div>
            ))}
          </div>
          <section>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <p className="text-xs text-slate-400">
                Calendar{calendars.length === 1 ? '' : 's'}: {calendars.join(' · ')}. &quot;From our paid ads&quot; = the lead carries the
                location&apos;s ad-lead tag or submitted one of our ad forms; the campaign shows when GoHighLevel recorded it.{' '}
                {perDate
                  ? `Every ${sps ? 'SPS appointment' : 'calendar entry'} this month is listed. The numbers count each person once per date (booked again on another date = counted again); a second entry on the same date is marked "Repeat", and staff / internal entries are left out.`
                  : 'Bookings counts every calendar entry, so a person who booked more than once is listed again and marked "Repeat".'}
              </p>
              <label className="text-xs text-slate-300 flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={onlyAds} onChange={e => setOnlyAds(e.target.checked)} className="accent-[#E1E000]" />
                Only paid-ad leads
              </label>
            </div>
            <div className="overflow-auto max-h-[60vh] rounded-xl border border-white/15">
              <table className="w-full text-sm border-collapse min-w-[760px]">
                <thead className="sticky top-0 bg-[#1F1E1D] z-10">
                  <tr>
                    <th className="px-3 py-2 text-right font-semibold w-10">#</th>
                    <th className="px-3 py-2 text-left font-semibold">Lead</th>
                    <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Date</th>
                    <th className="px-3 py-2 text-left font-semibold">Calendar</th>
                    <th className="px-3 py-2 text-left font-semibold">Status</th>
                    <th className="px-3 py-2 text-left font-semibold">Paid ad</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(({ r, i }) => (
                    <tr key={i} className={`border-t border-white/5 hover:bg-white/5 align-top ${repeatOf[i] != null ? 'opacity-60' : ''}`}>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{i + 1}</td>
                      <td className="px-3 py-1.5">
                        {r.name}
                        {repeatOf[i] != null && (
                          <span className="ml-2 text-[10px] uppercase tracking-wider font-semibold text-[#E1E000] border border-[#E1E000]/40 rounded px-1.5 py-0.5">
                            Repeat of #{(repeatOf[i] as number) + 1}
                          </span>
                        )}
                        {r.note && <span className="block text-xs text-slate-500">{r.note}</span>}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap tabular-nums">{r.date}</td>
                      <td className="px-3 py-1.5 text-slate-300">{r.calendar}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{STATUS_LABEL[r.status] ?? r.status}</td>
                      <td className="px-3 py-1.5">
                        {r.campaign ? (
                          <>
                            <span>{r.campaign}</span>
                            {r.ad && <span className="block text-xs text-slate-400">Ad: {r.ad}</span>}
                            {!r.adLead && r.via === 'our_form' && <span className="block text-xs text-slate-400">Came through our ad form; ad-lead tag missing in GoHighLevel</span>}
                          </>
                        ) : r.adLead ? (
                          <span className="text-slate-300">Paid ad lead <span className="text-xs text-slate-500">(campaign not recorded in GoHighLevel)</span></span>
                        ) : r.via === 'our_form' ? (
                          <span className="text-slate-300">Paid ad lead <span className="text-xs text-slate-500">(came through our ad form; ad-lead tag missing in GoHighLevel)</span></span>
                        ) : (
                          <span className="text-slate-500">
                            Not from our ads
                            {(r.viaNote || r.via) && (
                              <span className="block text-xs">
                                {r.viaNote ?? (r.via === 'other_form' ? 'Only another form (club website, other ads)' : 'No form submitted')}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </Panel>
  );
}

function Overview({ report }: { report: GmnReportPayload }) {
  const o = report.overview;
  const tiles: [string, string][] = [
    ['Total Locations', fmtInt(o.totalLocations)],
    ['CPL', fmtUsd(o.cpl)],
    [report.locationsTotal.bookingsPaid !== undefined ? 'CPB – Paid ads' : 'CPB', fmtUsd(o.cpb)],
    ['Avg. location spend', fmtUsd(o.avgLocationSpend)],
  ];
  return (
    <section>
      <h3 className="text-xl font-light mb-4">Performance Overview</h3>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="bg-black/25 border border-white/10 rounded-xl px-5 py-4">
            <p className="text-xs uppercase tracking-wider text-slate-400">{label}</p>
            <p className="text-2xl font-semibold mt-1">{value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const COLS: { key: keyof GmnMetricRow; label: string; fmt: (r: GmnMetricRow) => string }[] = [
  { key: 'spend', label: 'Spend', fmt: r => fmtUsd(r.spend) },
  { key: 'reach', label: 'Reach', fmt: r => fmtInt(r.reach) },
  { key: 'impressions', label: 'Impr.', fmt: r => fmtInt(r.impressions) },
  { key: 'linkClicks', label: 'Link clicks', fmt: r => fmtInt(r.linkClicks) },
  { key: 'ctr', label: 'CTR', fmt: r => fmtPct(r.ctr) },
  { key: 'leads', label: 'Leads', fmt: r => fmtInt(r.leads) },
  { key: 'cpl', label: 'CPL', fmt: r => fmtUsd(r.cpl) },
  { key: 'bookings', label: 'Bookings', fmt: r => fmtInt(r.bookings) },
  { key: 'cpb', label: 'CPB', fmt: r => fmtUsd(r.cpb) },
];
// SPS columns, only for snapshots that have them. null = the location records no SPS in GoHighLevel that month.
const fmtSps = (n: number | null | undefined) => (n === null ? 'N/A' : fmtInt(n ?? null));
const PAID_COL: (typeof COLS)[number] = { key: 'bookingsPaid', label: 'Bookings – Paid', fmt: r => fmtInt(r.bookingsPaid ?? null) };
const SPS_COLS: typeof COLS = [
  { key: 'spsPaid', label: 'SPS – Paid', fmt: r => fmtSps(r.spsPaid) },
  { key: 'spsTotal', label: 'SPS – Total', fmt: r => fmtSps(r.spsTotal) },
];

function MetricTable({ title, subtitle, firstCol, rows, total, onRowClick, bookingLabels, onBookingsClick, spsLabels, onSpsClick }: {
  title: string; subtitle?: string; firstCol: string; rows: GmnMetricRow[]; total: GmnMetricRow; onRowClick?: (label: string) => void;
  bookingLabels?: Set<string>; onBookingsClick?: (label: string, paidOnly?: boolean) => void;
  spsLabels?: Set<string>; onSpsClick?: (label: string, paidOnly?: boolean) => void;
}) {
  // paid split: Bookings → "Bookings – Paid" + "Bookings – Total", CPB → "CPB – Paid ads"
  const base = rows.some(r => r.bookingsPaid !== undefined)
    ? COLS.flatMap(c => c.key === 'bookings' ? [PAID_COL, { ...c, label: 'Bookings – Total' }] : c.key === 'cpb' ? [{ ...c, label: 'CPB – Paid ads' }] : [c])
    : COLS;
  const cols = rows.some(r => r.spsTotal !== undefined) ? [...base, ...SPS_COLS] : base;
  const linkCell = (text: string, onClick: () => void, hint: string) => (
    <button type="button" onClick={onClick} title={hint}
      className="underline decoration-white/30 underline-offset-2 hover:text-[#E1E000] hover:decoration-[#E1E000] tabular-nums">
      {text}
    </button>
  );
  const cell = (c: (typeof COLS)[number], r: GmnMetricRow) => {
    // a Paid number opens the list showing only the paid-ad leads; a Total number opens everyone
    const paidOnly = c.key === 'bookingsPaid' || c.key === 'spsPaid';
    if ((c.key === 'bookings' || c.key === 'bookingsPaid') && onBookingsClick && bookingLabels?.has(r.label))
      return linkCell(c.fmt(r), () => onBookingsClick(r.label, paidOnly), paidOnly ? 'See who booked from our paid ads' : 'See who booked');
    if ((c.key === 'spsPaid' || c.key === 'spsTotal') && onSpsClick && spsLabels?.has(r.label) && r[c.key] != null)
      return linkCell(c.fmt(r), () => onSpsClick(r.label, paidOnly), paidOnly ? 'See who booked an SPS from our paid ads' : 'See who booked an SPS');
    return c.fmt(r);
  };
  return (
    <section>
      <h3 className={`text-xl font-light ${subtitle ? 'mb-1' : 'mb-4'}`}>{title}</h3>
      {subtitle && <p className="text-xs text-slate-400 mb-4">{subtitle}</p>}
      <div className="overflow-x-auto rounded-lg border border-white/40">
        <table className="w-full text-sm border-collapse min-w-[900px]">
          <thead>
            <tr><th colSpan={cols.length + 1} className={`bg-[#1F1E1D] py-2 text-center font-semibold ${ACCENT}`}>Lead Generation</th></tr>
            <tr className="bg-[#1F1E1D]">
              <th className="text-left px-3 py-2 font-semibold border border-white/40">{firstCol}</th>
              {cols.map(c => <th key={c.key} className="px-3 py-2 font-semibold text-right border border-white/40 whitespace-nowrap">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.label + i} className={i % 2 ? 'bg-[#4F5124]/60' : 'bg-black/10'}>
                <td className="px-3 py-2 border border-white/15">
                  {onRowClick ? (
                    <button type="button" onClick={() => onRowClick(r.label)} className="text-left underline decoration-white/30 underline-offset-2 hover:text-[#E1E000] hover:decoration-[#E1E000]">
                      {r.label}
                    </button>
                  ) : r.label}
                </td>
                {cols.map(c => <td key={c.key} className="px-3 py-2 text-right tabular-nums border border-white/15 whitespace-nowrap">{cell(c, r)}</td>)}
              </tr>
            ))}
            <tr className="bg-[#1F1E1D] font-semibold">
              <td className={`px-3 py-2 border border-white/40 ${ACCENT}`}>Total</td>
              {cols.map(c => <td key={c.key} className="px-3 py-2 text-right tabular-nums border border-white/40 whitespace-nowrap">{c.fmt(total)}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TopCreatives({ creatives, note, emptyText, onShowLocations, cols = 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4' }: {
  creatives: GmnCreative[]; note?: string; emptyText?: string; onShowLocations?: (c: GmnCreative) => void; cols?: string;
}) {
  if (!creatives.length && !emptyText) return null;
  return (
    <section>
      <h3 className="text-xl font-light mb-1">Top 10 Creatives</h3>
      {note && <p className="text-xs text-slate-400 mb-4">{note}</p>}
      {!creatives.length && <p className="text-sm text-slate-400">{emptyText}</p>}
      <CreativeGroups creatives={creatives} onShowLocations={onShowLocations} cols={cols} />
    </section>
  );
}

// Image, or a playable video (fresh Meta source via /api/gmn-report/video) with the poster frame as fallback.
// Always fills its parent frame (absolute inset-0) so image and video cards are exactly the same size.
function CreativeMedia({ c, eager = false }: { c: GmnCreative; eager?: boolean }) {
  const [videoFailed, setVideoFailed] = useState(false);
  const poster = `/api/meta/db/asset-thumbnail/${encodeURIComponent(c.accountId)}/${encodeURIComponent(c.assetKey)}`;
  return (
    <div className="absolute inset-0 bg-black">
      {c.type === 'video' && c.videoId && !videoFailed ? (
        <video
          className="absolute inset-0 w-full h-full object-contain"
          controls
          preload={eager ? 'metadata' : 'none'}
          poster={poster}
          src={`/api/gmn-report/video/${encodeURIComponent(c.accountId)}/${encodeURIComponent(c.videoId)}`}
          onError={() => setVideoFailed(true)}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster} alt={`Creative ${c.rank}`} className="absolute inset-0 w-full h-full object-contain" loading={eager ? 'eager' : 'lazy'} />
      )}
      {c.type === 'video' && videoFailed && (
        <div className="absolute bottom-0 inset-x-0 bg-black/75 text-xs text-slate-300 px-3 py-2">
          Video can&apos;t play here.{' '}
          {c.sampleAdId && <a className="underline" target="_blank" rel="noreferrer" href={adsManagerAdUrl(c.accountId, c.sampleAdId)}>Open in Ads Manager</a>}
        </div>
      )}
    </div>
  );
}

function CreativeCard({ c, onShowLocations }: { c: GmnCreative; onShowLocations?: (c: GmnCreative) => void }) {
  const stats: [string, string][] = [
    ['Spend', fmtUsd(c.spend)], ['Impr.', fmtInt(c.impressions)], ['Link clicks', fmtInt(c.linkClicks)],
    ['CTR', fmtPct(c.ctr)], ['Leads', fmtInt(c.leads)], ['CPL', fmtUsd(c.cpl)],
  ];
  return (
    <article className="bg-black/25 border border-white/10 rounded-xl overflow-hidden flex flex-col h-full">
      <div className="relative bg-black aspect-square overflow-hidden">
        <CreativeMedia c={c} />
        <span className={`absolute top-2 left-2 z-10 bg-black/70 rounded-full w-8 h-8 flex items-center justify-center font-semibold pointer-events-none ${ACCENT}`}>{c.rank}</span>
      </div>
      <div className="p-4 flex-1 flex flex-col gap-3">
        <div>
          <p className="text-xs text-slate-400 uppercase tracking-wider">
            {c.type === 'video' ? 'Video' : 'Image'}
            {c.locations.length > 0 && ` · ${c.locations.length} location${c.locations.length === 1 ? '' : 's'}`}
            {c.variants > 1 ? ` · ${c.variants} variants` : ''}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {stats.map(([l, v]) => (
            <div key={l} className="bg-black/20 rounded-lg px-2 py-1.5">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">{l}</p>
              <p className="text-sm font-semibold tabular-nums">{v}</p>
            </div>
          ))}
        </div>
        {c.locations.length > 0 && onShowLocations && (
          <button type="button" onClick={() => onShowLocations(c)}
            className="mt-auto text-xs font-semibold text-black bg-[#E1E000] hover:bg-[#f0f04d] rounded-lg px-3 py-2 transition-colors">
            Show locations ({c.locations.length})
          </button>
        )}
      </div>
    </article>
  );
}

// Creatives grouped by type (Images, then Videos), each keeping its overall rank, in equal-size cards.
function CreativeGroups({ creatives, onShowLocations, cols = 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4' }: {
  creatives: GmnCreative[]; onShowLocations?: (c: GmnCreative) => void; cols?: string;
}) {
  const groups: [string, GmnCreative[]][] = [
    ['Images', creatives.filter(c => c.type !== 'video')],
    ['Videos', creatives.filter(c => c.type === 'video')],
  ];
  return (
    <div className="space-y-8">
      {groups.filter(([, cs]) => cs.length).map(([label, cs]) => (
        <div key={label}>
          <p className={`text-xs font-semibold uppercase tracking-[0.2em] mb-3 ${ACCENT}`}>{label} ({cs.length})</p>
          <div className={`grid ${cols} gap-5 items-stretch`}>
            {cs.map(c => <CreativeCard key={c.rank} c={c} onShowLocations={onShowLocations} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

type CreativeSortKey = 'location' | 'spend' | 'impressions' | 'linkClicks' | 'ctr' | 'leads' | 'cpl';

// The locations that ran a creative / headline / ad copy: sortable, with a spend-share bar and each location's CPL shaded
// against the item's own CPL (blue = better, red = worse). Locations open their report.
function LocationsBreakdown({ rows: input, refCpl, what, onLocation }: {
  rows: GmnCreativeLocation[]; refCpl: number | null; what: string; onLocation?: (label: string) => void;
}) {
  const [sort, setSort] = useState<{ key: CreativeSortKey; dir: 1 | -1 }>({ key: 'spend', dir: -1 });
  const rows = [...input].sort((a, b) => {
    if (sort.key === 'location') return sort.dir * a.location.localeCompare(b.location);
    return sort.dir * (((a[sort.key] as number | null) ?? Infinity) - ((b[sort.key] as number | null) ?? Infinity));
  });
  const maxSpend = Math.max(...input.map(l => l.spend), 1);
  const cplShade = (v: number | null) => {
    if (v == null || refCpl == null) return undefined;
    const ratio = v / refCpl;
    const t = Math.min(1, Math.abs(Math.log2(ratio)));
    return `rgba(${ratio <= 1 ? '57,135,229' : '230,103,103'},${(0.12 + 0.45 * t).toFixed(2)})`;
  };
  const th = (key: CreativeSortKey, label: string, right = true) => (
    <th className={`px-3 py-2 font-semibold whitespace-nowrap cursor-pointer select-none ${right ? 'text-right' : 'text-left'}`}
      onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'location' || key === 'cpl' ? 1 : -1 }))}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );
  return (
    <section>
      <h3 className="text-xl font-light mb-1">Locations that ran this {what} ({input.length})</h3>
      <p className="text-xs text-slate-400 mb-4">
        Sort by any column. The bar shows each location&apos;s share of this {what}&apos;s spend; CPL is shaded against the
        {' '}{what}&apos;s own CPL ({fmtUsd(refCpl)}): blue = better, red = worse.{onLocation ? ' Click a location to open its report.' : ''}
      </p>
      <div className="overflow-auto max-h-[480px] rounded-xl border border-white/15">
        <table className="w-full text-sm border-collapse min-w-[760px]">
          <thead className="sticky top-0 bg-[#1F1E1D] z-10">
            <tr>{th('location', 'Location', false)}{th('spend', 'Spend')}{th('impressions', 'Impr.')}{th('linkClicks', 'Clicks')}{th('ctr', 'CTR')}{th('leads', 'Leads')}{th('cpl', 'CPL')}</tr>
          </thead>
          <tbody>
            {rows.map(l => (
              <tr key={l.location} className="border-t border-white/5 hover:bg-white/5">
                <td className="px-3 py-1.5">
                  {onLocation ? <button type="button" onClick={() => onLocation(l.location)} className="text-left hover:text-[#E1E000] underline decoration-white/20 underline-offset-2">{l.location}</button> : l.location}
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-20 h-2 bg-black/30 rounded hidden sm:block"><div className="h-2 rounded-r bg-[#3987e5]" style={{ width: `${(l.spend / maxSpend) * 100}%` }} /></div>
                    <span className="tabular-nums w-20 text-right">{fmtUsd(l.spend)}</span>
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtInt(l.impressions)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtInt(l.linkClicks)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtPct(l.ctr)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtInt(l.leads)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums" style={{ background: cplShade(l.cpl) }}>{fmtUsd(l.cpl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MetricTiles({ m }: { m: { spend: number; leads: number; cpl: number | null; impressions: number; linkClicks: number; ctr: number | null } }) {
  const tiles: [string, string][] = [
    ['Spend', fmtUsd(m.spend)], ['Leads', fmtInt(m.leads)], ['CPL', fmtUsd(m.cpl)],
    ['Impr.', fmtInt(m.impressions)], ['Link clicks', fmtInt(m.linkClicks)], ['CTR', fmtPct(m.ctr)],
  ];
  return (
    <div className="grid grid-cols-3 gap-3">
      {tiles.map(([l, v]) => (
        <div key={l} className="bg-black/25 border border-white/10 rounded-xl px-4 py-3">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">{l}</p>
          <p className="text-lg font-semibold mt-0.5 tabular-nums">{v}</p>
        </div>
      ))}
    </div>
  );
}

// One creative's modal: the creative large, its numbers, and every location that ran it.
function CreativePanel({ c, monthLabel, brand, onClose, onLocation }: {
  c: GmnCreative; monthLabel: string; brand?: BrandKey; onClose: () => void; onLocation?: (label: string) => void;
}) {
  return (
    <Panel kicker={`${monthLabel} · Creative #${c.rank} · ${c.type === 'video' ? 'Video' : 'Image'}`} title={`Creative #${c.rank}`} onClose={onClose} brand={brand}>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-2 relative bg-black rounded-xl overflow-hidden aspect-square border border-white/10">
          <CreativeMedia c={c} eager />
        </div>
        <div className="lg:col-span-3 flex flex-col gap-4">
          <MetricTiles m={c} />
          <p className="text-xs text-slate-400">
            Ran at {c.locations.length} location{c.locations.length === 1 ? '' : 's'}
            {c.variants > 1 ? ` in ${c.variants} versions (same image or video with a different city or offer headline)` : ''}.
          </p>
        </div>
      </div>
      <LocationsBreakdown rows={c.locations} refCpl={c.cpl} what="creative" onLocation={onLocation} />
    </Panel>
  );
}

// One headline's / ad copy template's modal: the full text, its numbers, and every location that ran it.
function CopyPanel({ item, kind, monthLabel, brand, onClose, onLocation }: {
  item: GmnCopyItem; kind: CopyKind; monthLabel: string; brand?: BrandKey; onClose: () => void; onLocation?: (label: string) => void;
}) {
  const what = kind === 'headline' ? 'headline' : 'ad copy';
  return (
    <Panel kicker={`${monthLabel} · ${kind === 'headline' ? 'Headline' : 'Ad copy'} #${item.rank}`} title={kind === 'headline' ? item.text : `Ad copy #${item.rank}`} onClose={onClose} brand={brand}>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3 bg-black/25 border border-white/10 rounded-xl p-5 text-sm text-slate-200 whitespace-pre-line leading-relaxed max-h-[420px] overflow-y-auto">
          <CopyText text={item.text} />
        </div>
        <div className="lg:col-span-2 flex flex-col gap-4">
          <MetricTiles m={item} />
          <p className="text-xs text-slate-400">
            Ran at {item.locations.length} location{item.locations.length === 1 ? '' : 's'}
            {kind === 'adcopy' && item.variants > 1 ? ` as ${item.variants} versions (City and Coach = each location's own city and coach name)` : ''}.
          </p>
        </div>
      </div>
      <LocationsBreakdown rows={item.locations} refCpl={item.cpl} what={what} onLocation={onLocation} />
    </Panel>
  );
}
