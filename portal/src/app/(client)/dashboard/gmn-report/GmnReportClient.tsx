'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { GmnCreative, GmnLocationDetail, GmnMetricRow, GmnOfferDetail, GmnReportMonth, GmnReportPayload } from '@/lib/gmnReport';
import { fmtInt, fmtPct, fmtUsd, adsManagerAdUrl } from '@/app/(marketer)/marketer/_components/format';
import EnhancedView, { type BrandKey } from './EnhancedView';

interface Props {
  clientName: string;
  months: GmnReportMonth[];
  selectedMonth: string | null;
  report: GmnReportPayload | null;
}

// Alloy deck palette: charcoal background, yellow accents.
const ACCENT = 'text-[#E1E000]';

export default function GmnReportClient({ clientName, months, selectedMonth, report }: Props) {
  const [openLocation, setOpenLocation] = useState<string | null>(null);
  const [openOffer, setOpenOffer] = useState<string | null>(null);
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
                onChange={e => { window.location.href = `/dashboard/gmn-report?month=${encodeURIComponent(e.target.value)}`; }}
                className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white"
              >
                {months.map(m => <option key={m.month} value={m.month}>{m.label}</option>)}
              </select>
            </label>
          )}
          </div>
        </div>
      </header>

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
            renderCreative={c => <CreativeCard c={c} />}
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
              subtitle={details ? 'Click a location to see its own offer breakdown and top creatives.' : undefined}
              firstCol="Location"
              rows={report.locations}
              total={report.locationsTotal}
              onRowClick={showLocation}
            />
            <MetricTable
              title="Marketing Offer Breakdown"
              subtitle={offerDetails ? 'Click an offer to see which locations ran it.' : undefined}
              firstCol="Offer"
              rows={report.offers}
              total={report.offersTotal}
              onRowClick={offerDetails ? label => { if (offerDetails[label]) setOpenOffer(label); } : undefined}
            />
            <TopCreatives creatives={report.topCreatives} note={report.creativesNote} />
            {report.notes && report.notes.length > 0 && (
              <section className="text-xs text-slate-400 space-y-1 border-t border-white/10 pt-6">
                {report.notes.map((n, i) => <p key={i}>{n}</p>)}
              </section>
            )}
          </>
        )}
      </main>
      {openLocation && openDetail && report && (
        <LocationPanel
          name={openLocation}
          monthLabel={report.monthLabel}
          detail={openDetail}
          note={report.locationCreativesNote}
          onClose={() => setOpenLocation(null)}
        />
      )}
      {openOffer && openOfferDetail && report && (
        <OfferPanel
          name={openOffer}
          monthLabel={report.monthLabel}
          detail={openOfferDetail}
          onClose={() => setOpenOffer(null)}
          onLocation={showLocation}
        />
      )}
    </div>
  );
}

// Modal shell shared by the location and offer click-throughs (Esc / backdrop / Close button close it).
function Panel({ kicker, title, onClose, children }: { kicker: string; title: string; onClose: () => void; children: ReactNode }) {
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
        <div className="bg-[#2C2A29] border border-white/15 rounded-2xl shadow-2xl">
          <div className="flex items-start justify-between gap-4 px-5 sm:px-6 py-4 border-b border-white/10">
            <div>
              <p className={`text-xs font-semibold uppercase tracking-wider ${ACCENT}`}>{kicker}</p>
              <h2 className="text-xl sm:text-2xl font-light mt-0.5">{title}</h2>
            </div>
            <button type="button" onClick={onClose} className="text-slate-300 hover:text-white text-sm border border-white/20 rounded-lg px-3 py-1.5">
              Close
            </button>
          </div>
          <div className="px-5 sm:px-6 py-6 space-y-10">{children}</div>
        </div>
      </div>
    </div>
  );
}

function RowTiles({ r }: { r: GmnMetricRow }) {
  const tiles: [string, string][] = [
    ['Spend', fmtUsd(r.spend)], ['Leads', fmtInt(r.leads)], ['CPL', fmtUsd(r.cpl)],
    ['Bookings', fmtInt(r.bookings)], ['CPB', fmtUsd(r.cpb)], ['CTR', fmtPct(r.ctr)],
  ];
  return (
    <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
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
function LocationPanel({ name, monthLabel, detail, note, onClose }: {
  name: string; monthLabel: string; detail: GmnLocationDetail; note?: string; onClose: () => void;
}) {
  return (
    <Panel kicker={monthLabel} title={name} onClose={onClose}>
      <RowTiles r={detail.row} />
      <TopCreatives creatives={detail.topCreatives} note={note} emptyText="No creative at this location reached $100 spend with at least one lead this month." />
      <MetricTable title="Marketing Offer Breakdown" firstCol="Offer" rows={detail.offers} total={{ ...detail.row, label: 'Total' }} />
    </Panel>
  );
}

// One offer's view: the locations that ran it, each with its numbers for this offer (bookings = that location's
// calendar count split by its lead share). Location names jump to that location's own panel.
function OfferPanel({ name, monthLabel, detail, onClose, onLocation }: {
  name: string; monthLabel: string; detail: GmnOfferDetail; onClose: () => void; onLocation?: (label: string) => void;
}) {
  return (
    <Panel kicker={`${monthLabel} · Offer`} title={name} onClose={onClose}>
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

function Overview({ report }: { report: GmnReportPayload }) {
  const o = report.overview;
  const tiles: [string, string][] = [
    ['Total Locations', fmtInt(o.totalLocations)],
    ['CPL', fmtUsd(o.cpl)],
    ['CPB', fmtUsd(o.cpb)],
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

function MetricTable({ title, subtitle, firstCol, rows, total, onRowClick }: {
  title: string; subtitle?: string; firstCol: string; rows: GmnMetricRow[]; total: GmnMetricRow; onRowClick?: (label: string) => void;
}) {
  return (
    <section>
      <h3 className={`text-xl font-light ${subtitle ? 'mb-1' : 'mb-4'}`}>{title}</h3>
      {subtitle && <p className="text-xs text-slate-400 mb-4">{subtitle}</p>}
      <div className="overflow-x-auto rounded-lg border border-white/40">
        <table className="w-full text-sm border-collapse min-w-[900px]">
          <thead>
            <tr><th colSpan={COLS.length + 1} className={`bg-[#1F1E1D] py-2 text-center font-semibold ${ACCENT}`}>Lead Generation</th></tr>
            <tr className="bg-[#1F1E1D]">
              <th className="text-left px-3 py-2 font-semibold border border-white/40">{firstCol}</th>
              {COLS.map(c => <th key={c.key} className="px-3 py-2 font-semibold text-right border border-white/40 whitespace-nowrap">{c.label}</th>)}
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
                {COLS.map(c => <td key={c.key} className="px-3 py-2 text-right tabular-nums border border-white/15 whitespace-nowrap">{c.fmt(r)}</td>)}
              </tr>
            ))}
            <tr className="bg-[#1F1E1D] font-semibold">
              <td className={`px-3 py-2 border border-white/40 ${ACCENT}`}>Total</td>
              {COLS.map(c => <td key={c.key} className="px-3 py-2 text-right tabular-nums border border-white/40 whitespace-nowrap">{c.fmt(total)}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TopCreatives({ creatives, note, emptyText }: { creatives: GmnCreative[]; note?: string; emptyText?: string }) {
  if (!creatives.length && !emptyText) return null;
  return (
    <section>
      <h3 className="text-xl font-light mb-1">Top 10 Creatives</h3>
      {note && <p className="text-xs text-slate-400 mb-4">{note}</p>}
      {!creatives.length && <p className="text-sm text-slate-400">{emptyText}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {creatives.map(c => <CreativeCard key={c.rank} c={c} />)}
      </div>
    </section>
  );
}

function CreativeCard({ c }: { c: GmnCreative }) {
  const [open, setOpen] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const poster = `/api/meta/db/asset-thumbnail/${encodeURIComponent(c.accountId)}/${encodeURIComponent(c.assetKey)}`;
  const stats: [string, string][] = [
    ['Spend', fmtUsd(c.spend)], ['Impr.', fmtInt(c.impressions)], ['Link clicks', fmtInt(c.linkClicks)],
    ['CTR', fmtPct(c.ctr)], ['Leads', fmtInt(c.leads)], ['CPL', fmtUsd(c.cpl)],
  ];
  return (
    <article className="bg-black/25 border border-white/10 rounded-xl overflow-hidden flex flex-col">
      <div className="relative bg-black aspect-square flex items-center justify-center">
        <span className={`absolute top-2 left-2 z-10 bg-black/70 rounded-full w-8 h-8 flex items-center justify-center font-semibold ${ACCENT}`}>{c.rank}</span>
        {c.type === 'video' && c.videoId && !videoFailed ? (
          <video
            className="w-full h-full object-contain"
            controls
            preload="none"
            poster={poster}
            src={`/api/gmn-report/video/${encodeURIComponent(c.accountId)}/${encodeURIComponent(c.videoId)}`}
            onError={() => setVideoFailed(true)}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt={c.title || `Creative ${c.rank}`} className="w-full h-full object-contain" loading="lazy" />
        )}
        {c.type === 'video' && videoFailed && (
          <div className="absolute bottom-0 inset-x-0 bg-black/75 text-xs text-slate-300 px-3 py-2">
            Video can&apos;t play here.{' '}
            {c.sampleAdId && <a className="underline" target="_blank" rel="noreferrer" href={adsManagerAdUrl(c.accountId, c.sampleAdId)}>Open in Ads Manager</a>}
          </div>
        )}
      </div>
      <div className="p-4 flex-1 flex flex-col gap-3">
        <div>
          <p className="text-xs text-slate-400 uppercase tracking-wider">
            {c.type === 'video' ? 'Video' : 'Image'}
            {c.locations.length > 0 && ` · ${c.locations.length} location${c.locations.length === 1 ? '' : 's'}`}
            {c.variants > 1 ? ` · ${c.variants} variants` : ''}
          </p>
          {c.title && <p className="text-sm font-semibold mt-1">{c.title}</p>}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {stats.map(([l, v]) => (
            <div key={l} className="bg-black/20 rounded-lg px-2 py-1.5">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">{l}</p>
              <p className="text-sm font-semibold tabular-nums">{v}</p>
            </div>
          ))}
        </div>
        {c.locations.length > 0 && (
          <button type="button" onClick={() => setOpen(o => !o)} className={`text-xs text-left ${ACCENT} hover:underline`}>
            {open ? 'Hide' : 'Show'} locations ({c.locations.length})
          </button>
        )}
        {open && c.locations.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400">
                  <th className="text-left py-1 pr-2 font-medium">Location</th>
                  <th className="text-right py-1 px-1 font-medium">Spend</th>
                  <th className="text-right py-1 px-1 font-medium">Impr.</th>
                  <th className="text-right py-1 px-1 font-medium">Clicks</th>
                  <th className="text-right py-1 px-1 font-medium">CTR</th>
                  <th className="text-right py-1 px-1 font-medium">Leads</th>
                  <th className="text-right py-1 pl-1 font-medium">CPL</th>
                </tr>
              </thead>
              <tbody>
                {c.locations.map(l => (
                  <tr key={l.location} className="border-t border-white/10">
                    <td className="py-1 pr-2">{l.location}</td>
                    <td className="text-right py-1 px-1 tabular-nums">{fmtUsd(l.spend)}</td>
                    <td className="text-right py-1 px-1 tabular-nums">{fmtInt(l.impressions)}</td>
                    <td className="text-right py-1 px-1 tabular-nums">{fmtInt(l.linkClicks)}</td>
                    <td className="text-right py-1 px-1 tabular-nums">{fmtPct(l.ctr)}</td>
                    <td className="text-right py-1 px-1 tabular-nums">{fmtInt(l.leads)}</td>
                    <td className="text-right py-1 pl-1 tabular-nums">{fmtUsd(l.cpl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </article>
  );
}
