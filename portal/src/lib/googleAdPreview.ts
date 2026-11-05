// Google search-ad preview cards (HTML strings) shared by the client Google
// dashboard (Ads tab, rendered with innerHTML) and the coach board's ad drawer.
// Every value from Google is escaped. The preview is drawn by us from the
// synced ad text, so it never expires (Google's own "Ad preview" links last
// 14 days). Google mixes headlines/descriptions per search; we show one valid
// combination: pinned positions first, then the remaining ones in order.
import type { GoogleAdRow, GoogleCampaignPreviewAssets, GoogleAdText } from './googleAds';

export function escHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function pickPositions(items: GoogleAdText[], prefix: 'HEADLINE' | 'DESCRIPTION', slots: number): string[] {
  const out: (string | null)[] = Array(slots).fill(null);
  const used = new Set<number>();
  items.forEach((t, i) => {
    const m = new RegExp(`^${prefix}_(\\d)$`).exec(t.pinned || '');
    const pos = m ? Number(m[1]) - 1 : -1;
    if (pos >= 0 && pos < slots && out[pos] === null) { out[pos] = t.text; used.add(i); }
  });
  let next = 0;
  for (let s = 0; s < slots; s++) {
    if (out[s] !== null) continue;
    while (next < items.length && (used.has(next) || items[next].pinned)) next++;
    if (next < items.length) { out[s] = items[next].text; used.add(next); next++; }
  }
  return out.filter((x): x is string => !!x);
}

export function displayUrl(finalUrl: string, path1: string, path2: string): string {
  let host = '';
  try { host = new URL(finalUrl).hostname.replace(/^www\./, ''); } catch { host = finalUrl; }
  return [host, path1, path2].filter(Boolean).join(' › ');
}

const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const conv = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STATUS_STYLE: Record<string, string> = {
  ENABLED: 'background:rgba(16,185,129,.15);color:#6ee7b7',
  PAUSED: 'background:rgba(245,158,11,.15);color:#fcd34d',
  REMOVED: 'background:rgba(100,116,139,.2);color:#94a3b8',
};
const TYPE_LABEL: Record<string, string> = {
  RESPONSIVE_SEARCH_AD: 'Search ad', RESPONSIVE_DISPLAY_AD: 'Display ad', DEMAND_GEN_VIDEO_RESPONSIVE_AD: 'Video ad',
};

/** One ad: Google-style preview + numbers + every headline/description with pins. */
export function googleAdCardHtml(ad: GoogleAdRow, assets?: GoogleCampaignPreviewAssets, opts: { showCampaign?: boolean } = {}): string {
  const live = ad.status === 'ENABLED' && ad.adGroupStatus === 'ENABLED' && ad.campaignStatus === 'ENABLED';
  const statusLabel = live ? 'Running' : ad.status === 'ENABLED' ? 'Not running' : ad.status === 'PAUSED' ? 'Paused' : ad.status === 'REMOVED' ? 'Removed' : ad.status;
  const statusStyle = live ? STATUS_STYLE.ENABLED : STATUS_STYLE[ad.status] || STATUS_STYLE.REMOVED;
  const notRunningWhy = !live && ad.status === 'ENABLED' ? (ad.campaignStatus !== 'ENABLED' ? 'Campaign is paused or ended' : 'Ad group is paused') : '';
  const isSearch = ad.adType === 'RESPONSIVE_SEARCH_AD';
  const heads = pickPositions(ad.headlines, 'HEADLINE', 3);
  const descs = pickPositions(ad.descriptions, 'DESCRIPTION', 2);
  const a = assets || { businessName: '', logoUrl: '', sitelinks: [], callouts: [], images: [] };
  const url = displayUrl(ad.finalUrl, ad.path1, ad.path2);

  const preview = isSearch ? `
    <div style="background:#fff;border-radius:10px;padding:14px 16px;font-family:Arial,Helvetica,sans-serif;color:#202124;max-width:620px">
      <div style="font-size:12px;font-weight:700;margin-bottom:6px">Sponsored</div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        ${a.logoUrl ? `<img src="${escHtml(a.logoUrl)}" alt="" referrerpolicy="no-referrer" style="width:28px;height:28px;border-radius:50%;object-fit:cover;border:1px solid #dadce0">`
          : '<div style="width:28px;height:28px;border-radius:50%;background:#f1f3f4;border:1px solid #dadce0"></div>'}
        <div style="line-height:1.25;min-width:0">
          <div style="font-size:14px">${escHtml(a.businessName || 'Anytime Fitness')}</div>
          <div style="font-size:12px;color:#4d5156;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(url)}</div>
        </div>
      </div>
      <a href="${escHtml(ad.finalUrl)}" target="_blank" rel="noopener noreferrer" style="display:block;font-size:20px;line-height:1.3;color:#1a0dab;text-decoration:none;margin:2px 0 3px">${heads.map(escHtml).join(' | ') || '<span style="color:#9aa0a6">(no headlines)</span>'}</a>
      <div style="font-size:14px;line-height:1.58;color:#4d5156">${descs.map(escHtml).join(' ')}</div>
      ${a.callouts.length ? `<div style="font-size:14px;color:#4d5156;margin-top:2px">${a.callouts.slice(0, 4).map(escHtml).join(' · ')}</div>` : ''}
      ${a.sitelinks.length ? `<div style="display:flex;flex-wrap:wrap;gap:4px 18px;margin-top:8px">${a.sitelinks.slice(0, 4).map(s =>
        `<a href="${escHtml(s.finalUrl || ad.finalUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:14px;color:#1a0dab;text-decoration:none">${escHtml(s.text)}</a>`).join('')}</div>` : ''}
    </div>`
    : `<div style="background:#0f172a;border:1px dashed #334155;border-radius:10px;padding:12px 14px;color:#94a3b8;font-size:12px">
        ${escHtml(TYPE_LABEL[ad.adType] || ad.adType)} — preview not available. ${ad.finalUrl ? `Links to <a href="${escHtml(ad.finalUrl)}" target="_blank" rel="noopener noreferrer" style="color:#60a5fa">${escHtml(url)}</a>` : ''}
        ${heads.length ? `<div style="margin-top:6px;color:#e2e8f0">${heads.map(escHtml).join(' | ')}</div>` : ''}
      </div>`;

  const nums: [string, string][] = [
    ['Spend', money(ad.spend)], ['Impr.', ad.impressions.toLocaleString('en-US')], ['Clicks', ad.clicks.toLocaleString('en-US')],
    ['CTR', ad.impressions > 0 ? (ad.clicks / ad.impressions * 100).toFixed(2) + '%' : '—'],
    ['Leads', conv(ad.leads)], ['CPL', ad.leads > 0 ? money(ad.spend / ad.leads) : '—'],
    ['Bookings', conv(ad.bookings)], ['Joins', conv(ad.joins)],
  ];
  const pinTag = (p: string) => p ? ` <span style="font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(59,130,246,.15);color:#93c5fd" title="Always shown in this position">Pinned ${escHtml(p.split('_')[1] || '')}</span>` : '';
  const list = (title: string, items: GoogleAdText[]) => items.length ? `
      <div style="flex:1;min-width:220px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:4px">${title} (${items.length})</div>
        <ol style="margin:0;padding-left:18px;color:#cbd5e1;font-size:12px;line-height:1.6">${items.map(t => `<li>${escHtml(t.text)}${pinTag(t.pinned)}</li>`).join('')}</ol>
      </div>` : '';

  return `
  <div style="border:1px solid #1e293b;border-radius:12px;padding:14px;background:rgba(15,23,42,.5)">
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px;font-size:12px;color:#94a3b8">
      <span style="font-size:11px;padding:2px 8px;border-radius:999px;${statusStyle}" ${notRunningWhy ? `title="${escHtml(notRunningWhy)}"` : ''}>${escHtml(statusLabel)}</span>
      ${ad.approval && ad.approval !== 'APPROVED' && ad.approval !== 'UNKNOWN' ? `<span style="font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(244,63,94,.15);color:#fda4af">${escHtml(ad.approval.replace(/_/g, ' ').toLowerCase())}</span>` : ''}
      ${opts.showCampaign !== false ? `<span style="color:#e2e8f0">${escHtml(ad.campaign)}</span><span>·</span>` : ''}
      <span>${escHtml(ad.adGroup)}</span>
    </div>
    ${preview}
    <div style="display:flex;flex-wrap:wrap;gap:6px 18px;margin:10px 0 2px;font-size:12px">
      ${nums.map(([k, v]) => `<span style="color:#64748b">${k} <span style="color:#e2e8f0;font-family:ui-monospace,monospace">${v}</span></span>`).join('')}
    </div>
    ${isSearch && (ad.headlines.length || ad.descriptions.length) ? `
    <details style="margin-top:8px">
      <summary style="cursor:pointer;font-size:12px;color:#60a5fa">All headlines and descriptions</summary>
      <div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:8px">${list('Headlines', ad.headlines)}${list('Descriptions', ad.descriptions)}</div>
      <p style="font-size:11px;color:#64748b;margin-top:8px">Google picks up to 3 headlines and 2 descriptions for each search, so the preview above is one of the combinations people see.</p>
    </details>` : ''}
  </div>`;
}
