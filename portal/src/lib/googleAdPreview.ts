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

// One combination: pinned texts keep their slot, the free slots take the
// unpinned texts starting at `offset` (so each phone shows a different mix,
// like Google's preview page does).
function comboAt(items: GoogleAdText[], prefix: 'HEADLINE' | 'DESCRIPTION', slots: number, offset: number): string[] {
  const out: (string | null)[] = Array(slots).fill(null);
  for (const it of items) {
    const m = new RegExp(`^${prefix}_(\\d)$`).exec(it.pinned || '');
    const pos = m ? Number(m[1]) - 1 : -1;
    if (pos >= 0 && pos < slots && out[pos] === null) out[pos] = it.text;
  }
  const free = items.filter(it => !it.pinned).map(it => it.text);
  let k = 0;
  for (let s = 0; s < slots && free.length; s++) {
    if (out[s] !== null) continue;
    let tries = 0, cand = free[(offset + k) % free.length];
    while (out.includes(cand) && tries++ < free.length) { k++; cand = free[(offset + k) % free.length]; }
    if (!out.includes(cand)) out[s] = cand;
    k++;
  }
  return out.filter((x): x is string => !!x);
}

/** Mobile display URL as Google shows it: host (with www) + /path1/path2. */
function mobileDisplayUrl(finalUrl: string, path1: string, path2: string): string {
  let host = '';
  try { host = new URL(finalUrl).hostname; } catch { host = finalUrl; }
  return [host, path1, path2].filter(Boolean).join('/');
}

const G_LOGO = '<span style="font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:500;letter-spacing:-1px">'
  + [['G', '#4285F4'], ['o', '#EA4335'], ['o', '#FBBC05'], ['g', '#4285F4'], ['l', '#34A853'], ['e', '#EA4335']].map(([c, col]) => `<span style="color:${col}">${c}</span>`).join('') + '</span>';
const bar = (w: string, h = 10, mt = 0) => `<div style="width:${w};height:${h}px;background:#eceff1;border-radius:2px;margin-top:${mt}px"></div>`;
const skeletonResult = `<div style="padding:14px 14px;border-top:8px solid #f1f3f4">
  <div style="display:flex;gap:10px;align-items:center"><div style="width:26px;height:26px;border-radius:50%;background:#eceff1"></div><div style="flex:1">${bar('45%', 8)}${bar('70%', 8, 6)}</div></div>
  ${bar('60%', 14, 12)}${bar('100%', 10, 10)}${bar('50%', 10, 8)}</div>`;

/** One phone: Google header, search box, the ad (one headline/description combination), then placeholder results. */
function phoneHtml(ad: GoogleAdRow, a: GoogleCampaignPreviewAssets, heads: string[], descs: string[], image: string, sitelinks: GoogleCampaignPreviewAssets['sitelinks']): string {
  const url = mobileDisplayUrl(ad.finalUrl, ad.path1, ad.path2);
  return `
  <div style="flex:0 0 auto;width:300px;border:2px solid #dadce0;border-radius:34px;padding:10px;background:#fff">
    <div style="border:1px solid #e8eaed;border-radius:26px;overflow:hidden;background:#fff;font-family:Arial,Helvetica,sans-serif;color:#202124;height:600px;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 14px 8px">
        <div style="width:18px"><div style="height:2px;background:#5f6368;margin:3px 0"></div><div style="height:2px;background:#5f6368;margin:3px 0"></div><div style="height:2px;background:#5f6368;margin:3px 0"></div></div>
        ${G_LOGO}
        <div style="width:28px;height:28px;border-radius:50%;background:#e8eaed"></div>
      </div>
      <div style="margin:6px 12px 10px;height:40px;border-radius:20px;box-shadow:0 1px 4px rgba(32,33,36,.28);display:flex;align-items:center;padding:0 14px">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5f6368" stroke-width="2.4"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21" stroke-linecap="round"/></svg>
      </div>
      <div style="display:flex;gap:14px;padding:4px 14px 10px;border-bottom:1px solid #ebebeb">${bar('22px', 14)}${bar('46px', 14)}${bar('58px', 14)}${bar('42px', 14)}</div>
      <div style="padding:14px 14px 12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          ${a.logoUrl ? `<img src="${escHtml(a.logoUrl)}" alt="" referrerpolicy="no-referrer" style="width:26px;height:26px;border-radius:50%;object-fit:cover;border:1px solid #dadce0">`
            : '<div style="width:26px;height:26px;border-radius:50%;background:#f1f3f4;border:1px solid #dadce0"></div>'}
          <div style="line-height:1.25;min-width:0">
            <div style="font-size:13px">${escHtml(a.businessName || 'Anytime Fitness')}</div>
            <div style="font-size:11px;color:#4d5156;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px">${escHtml(url)}</div>
          </div>
        </div>
        <a href="${escHtml(ad.finalUrl)}" target="_blank" rel="noopener noreferrer" style="display:block;font-size:19px;line-height:1.3;color:#1a0dab;text-decoration:none;margin-bottom:6px">${heads.map(escHtml).join(' - ') || '<span style="color:#9aa0a6">(no headlines)</span>'}</a>
        <div style="display:flex;gap:10px;align-items:flex-start">
          <div style="flex:1;font-size:13px;line-height:1.5;color:#4d5156">${descs.map(escHtml).join(' ')}</div>
          ${image ? `<img src="${escHtml(image)}" alt="" referrerpolicy="no-referrer" style="width:92px;height:92px;border-radius:8px;object-fit:cover;flex:0 0 auto">` : ''}
        </div>
        ${sitelinks.length ? `<div style="display:flex;gap:8px;margin-top:12px;overflow:hidden">${sitelinks.map(sl =>
          `<a href="${escHtml(sl.finalUrl || ad.finalUrl)}" target="_blank" rel="noopener noreferrer" style="flex:0 0 auto;font-size:13px;color:#1a0dab;text-decoration:none;border:1px solid #dadce0;border-radius:18px;padding:6px 14px;white-space:nowrap">${escHtml(sl.text)}</a>`).join('')}</div>` : ''}
      </div>
      <div style="flex:1;overflow:hidden">${skeletonResult}${skeletonResult}</div>
    </div>
  </div>`;
}

/** Up to 4 phones, each a different headline / description / sitelink mix (the last one with an image when the campaign has one). */
function phonesHtml(ad: GoogleAdRow, a: GoogleCampaignPreviewAssets): string {
  const freeH = Math.max(1, ad.headlines.filter(h => !h.pinned).length);
  const freeD = Math.max(1, ad.descriptions.filter(d => !d.pinned).length);
  const seen = new Set<string>();
  const phones: string[] = [];
  for (let i = 0; i < 4; i++) {
    const heads = comboAt(ad.headlines, 'HEADLINE', 2, (i * 2) % freeH);
    const descs = comboAt(ad.descriptions, 'DESCRIPTION', 2, i % freeD);
    const key = heads.join('|') + '#' + descs.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const image = i === 3 && a.images.length ? a.images[0] : '';
    const n = a.sitelinks.length;
    const links = n ? Array.from({ length: Math.min(n, 3) }, (_, k) => a.sitelinks[(i + k) % n]) : [];
    phones.push(phoneHtml(ad, a, heads, descs, image, links));
  }
  return `<div style="display:flex;gap:16px;overflow-x:auto;padding:4px 2px 10px">${phones.join('')}</div>
    <p style="font-size:11px;color:#64748b;margin:2px 0 0">Mobile previews (examples). Google mixes the headlines and descriptions for each search, so these are some of the combinations people see.</p>`;
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
  const a = assets || { businessName: '', logoUrl: '', sitelinks: [], callouts: [], images: [] };
  const url = displayUrl(ad.finalUrl, ad.path1, ad.path2);

  const preview = isSearch ? phonesHtml(ad, a)
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
