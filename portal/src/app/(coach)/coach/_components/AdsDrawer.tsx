'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { googleAdCardHtml } from '@/lib/googleAdPreview';
import type { GoogleAdRow, GoogleCampaignPreviewAssets } from '@/lib/googleAds';
import type { ActiveCreative, ActiveCreativesResult } from '@/lib/coach/activeCreatives';
import { resolveBoardRange, formatRangeLabel } from '@/lib/coach/dateRange';

// Side drawer: the client's running Meta ads (by creative) and Google ads
// (full search-ad previews with numbers for the board's date range).

type Tab = 'meta' | 'google';
type GoogleResp = { ads: GoogleAdRow[]; assets: Record<string, GoogleCampaignPreviewAssets>; source: string; error?: string };
type MetaResp = ActiveCreativesResult & { noMeta?: boolean; error?: string };

export default function AdsDrawer({ client, range, onClose }: {
  client: { id: string; name: string; hasMeta: boolean; hasGoogle: boolean; googleSource: 'api' | 'sheet' | null };
  range: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(client.hasMeta ? 'meta' : 'google');
  const [meta, setMeta] = useState<MetaResp | null>(null);
  const [google, setGoogle] = useState<GoogleResp | null>(null);
  const [googleRange, setGoogleRange] = useState('');
  const [runningOnly, setRunningOnly] = useState(true);
  const r = resolveBoardRange(range) || resolveBoardRange('last_7d')!;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (tab !== 'meta' || meta) return;
    fetch(`/api/coach/clients/${client.id}/active-creatives`).then(x => x.json()).then(setMeta)
      .catch(e => setMeta({ creatives: [], activeAds: 0, adsWithoutCopy: 0, creativesWithoutThumbnail: 0, copySyncedAt: null, error: String(e) }));
  }, [tab, meta, client.id]);

  useEffect(() => {
    if (tab !== 'google' || googleRange === range) return;
    setGoogle(null); setGoogleRange(range);
    fetch(`/api/coach/clients/${client.id}/google-ads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ range }) })
      .then(x => x.json()).then(setGoogle)
      .catch(e => setGoogle({ ads: [], assets: {}, source: 'api', error: String(e) }));
  }, [tab, range, googleRange, client.id]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[250] flex justify-end bg-black/50" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <aside role="dialog" aria-label={`Ads — ${client.name}`} className="h-full w-full max-w-[900px] bg-slate-950 border-l border-slate-800 shadow-2xl flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white truncate">{client.name}</h2>
            <p className="text-xs text-slate-500">Ads — {tab === 'google' ? `numbers for ${r.preset === 'custom' ? '' : r.label + ', '}${formatRangeLabel(r.since, r.until)}` : 'running now'}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none" aria-label="Close">×</button>
        </div>
        <div className="px-5 pt-3 flex items-center gap-3 flex-wrap">
          <div className="flex items-center bg-slate-800/60 rounded-lg p-0.5 border border-slate-700">
            {(['meta', 'google'] as Tab[]).map(t => {
              const enabled = t === 'meta' ? client.hasMeta : client.hasGoogle;
              return (
                <button key={t} type="button" disabled={!enabled} onClick={() => setTab(t)}
                  title={enabled ? undefined : t === 'meta' ? 'No Meta ads set up' : 'No Google Ads set up'}
                  className={`text-xs px-3 py-1 rounded ${tab === t ? 'bg-blue-600 text-white' : enabled ? 'text-slate-300 hover:text-white' : 'text-slate-600 cursor-not-allowed'}`}>
                  {t === 'meta' ? 'Meta' : 'Google'}
                </button>
              );
            })}
          </div>
          {tab === 'google' && (
            <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
              <input type="checkbox" checked={runningOnly} onChange={e => setRunningOnly(e.target.checked)} className="accent-blue-500" /> Running now only
            </label>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 coach-scroll">
          {tab === 'meta' ? <MetaPanel data={meta} /> : <GooglePanel data={google} runningOnly={runningOnly} />}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function Loading({ what }: { what: string }) {
  return <div className="py-10 text-center text-sm text-slate-500"><span className="inline-block h-3 w-3 rounded-full bg-blue-500 animate-pulse mr-2 align-middle" />Loading {what}…</div>;
}

function GooglePanel({ data, runningOnly }: { data: GoogleResp | null; runningOnly: boolean }) {
  const ads = useMemo(() => (data?.ads || []).filter(a => !runningOnly || (a.status === 'ENABLED' && a.adGroupStatus === 'ENABLED' && a.campaignStatus === 'ENABLED')), [data, runningOnly]);
  if (!data) return <Loading what="Google ads" />;
  if (data.error) return <p className="text-sm text-rose-300">Could not load Google ads: {data.error}</p>;
  if (data.source === 'sheet') return <p className="text-sm text-slate-400">This client&apos;s Google numbers come from a Google Sheet tab, so individual ads aren&apos;t available. Switching the client to the Google Ads API in Client settings shows them here.</p>;
  if (data.source === 'none') return <p className="text-sm text-slate-400">No Google Ads set up for this client.</p>;
  if (ads.length === 0) return <p className="text-sm text-slate-400">{runningOnly ? 'No ads running right now.' : 'No ads with numbers in these dates, and none running now.'}</p>;
  const running = (data.ads || []).filter(a => a.status === 'ENABLED' && a.adGroupStatus === 'ENABLED' && a.campaignStatus === 'ENABLED').length;
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-slate-500">{data.ads.length} ads, {running} running now. Highest spend first. Previews are drawn from the ad&apos;s text, so they never expire.</p>
      {ads.map(a => <div key={a.adId} dangerouslySetInnerHTML={{ __html: googleAdCardHtml(a, data.assets[a.campaign]) }} />)}
    </div>
  );
}

function MetaPanel({ data }: { data: MetaResp | null }) {
  if (!data) return <Loading what="running Meta ads" />;
  if (data.error) return <p className="text-sm text-rose-300">Could not load Meta ads: {data.error}</p>;
  if (data.noMeta) return <p className="text-sm text-slate-400">No Meta ad accounts set up for this client.</p>;
  if (data.creatives.length === 0) return <p className="text-sm text-slate-400">No Meta ads running right now.</p>;
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-slate-500">
        {data.activeAds} running ad{data.activeAds === 1 ? '' : 's'} using {data.creatives.length} creative{data.creatives.length === 1 ? '' : 's'} (those delivered in the last 14 days), highest spend first.
        {data.copySyncedAt && <> Ad text last synced {new Date(data.copySyncedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.</>}
      </p>
      {(data.adsWithoutCopy > 0 || data.creativesWithoutThumbnail > 0) && (
        <p className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          {data.adsWithoutCopy > 0 && <>{data.adsWithoutCopy} ad{data.adsWithoutCopy === 1 ? ' has' : 's have'} no text synced yet. </>}
          {data.creativesWithoutThumbnail > 0 && <>{data.creativesWithoutThumbnail} creative{data.creativesWithoutThumbnail === 1 ? ' has' : 's have'} no stored image yet.</>}
          {' '}They fill in on the next nightly sync.
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {data.creatives.map(c => <MetaCreativeCard key={`${c.accountId}|${c.key}`} c={c} />)}
      </div>
    </div>
  );
}

function MetaCreativeCard({ c }: { c: ActiveCreative }) {
  const [more, setMore] = useState(false);
  const thumb = c.hasThumbnail ? `/api/meta/db/asset-thumbnail/${c.accountId}/${encodeURIComponent(c.key)}` : '';
  const body = c.bodies[0] || '';
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden flex flex-col">
      <div className="relative bg-slate-900 aspect-[4/3] flex items-center justify-center">
        {thumb
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={thumb} alt="" className="w-full h-full object-contain" loading="lazy" />
          : <span className="text-xs text-slate-600">{c.type === 'unknown' ? 'No creative linked yet' : 'Image not stored yet'}</span>}
        <div className="absolute top-2 left-2 flex gap-1">
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-black/60 text-slate-200">{c.type === 'video' ? 'Video' : c.type === 'image' ? 'Image' : 'Ad'}</span>
          {c.isDco && <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-500/70 text-white" title="Dynamic creative — Meta mixes several texts and media in this ad">DCO</span>}
        </div>
        <span className="absolute top-2 right-2 flex gap-1">
          {c.spend14 !== null && <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-slate-100" title="Spend on this creative in the last 14 days">${c.spend14.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · 14d</span>}
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/80 text-white">{c.adCount} ad{c.adCount === 1 ? '' : 's'}</span>
        </span>
      </div>
      <div className="p-3 space-y-2 text-xs">
        {c.titles[0] && <p className="text-sm font-semibold text-white">{c.titles[0]}{c.titles.length > 1 && <span className="ml-1 text-[10px] font-normal text-slate-500">+{c.titles.length - 1} more</span>}</p>}
        {body
          ? <p className={`text-slate-300 whitespace-pre-line ${more ? '' : 'line-clamp-4'}`}>{body}</p>
          : <p className="text-slate-600">No ad text synced yet.</p>}
        {(body.length > 220 || c.bodies.length > 1 || c.titles.length > 1 || c.descriptions.length > 0) && (
          <button type="button" onClick={() => setMore(m => !m)} className="text-blue-400 hover:text-blue-300">{more ? 'Show less' : `Show all text${c.bodies.length > 1 ? ` (${c.bodies.length} variations)` : ''}`}</button>
        )}
        {more && (
          <div className="space-y-2 border-t border-slate-800 pt-2">
            {c.bodies.slice(1).map((b, i) => <p key={i} className="text-slate-400 whitespace-pre-line border-l-2 border-slate-700 pl-2">{b}</p>)}
            {c.titles.length > 1 && <p className="text-slate-400"><span className="text-slate-500">Headlines:</span> {c.titles.join(' · ')}</p>}
            {c.descriptions.length > 0 && <p className="text-slate-400"><span className="text-slate-500">Descriptions:</span> {c.descriptions.join(' · ')}</p>}
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500 pt-1">
          {c.ctas[0] && <span className="capitalize">Button: <span className="text-slate-300">{c.ctas[0]}</span></span>}
          {c.links[0] && <a href={c.links[0]} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 truncate max-w-full">{c.links[0].replace(/^https?:\/\//, '').slice(0, 60)}</a>}
        </div>
        <p className="text-[11px] text-slate-500" title={c.campaigns.join('\n')}>{c.campaigns.length === 1 ? c.campaigns[0] : `${c.campaigns.length} campaigns`}</p>
      </div>
    </div>
  );
}
