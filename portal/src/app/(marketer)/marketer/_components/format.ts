// Formatting helpers shared by marketer pages (server + client safe).
export const fmtUsd = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const fmtInt = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US');

export const fmtPct = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`;

export const fmtKm = (km: number | null | undefined): string =>
  km === null || km === undefined || !Number.isFinite(km) ? '—' : km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;

export const fmtMi = (km: number | null | undefined): string =>
  km === null || km === undefined || !Number.isFinite(km) ? '—' : `${(km / 1.609344).toFixed(km / 1.609344 < 10 ? 1 : 0)} mi`;

export const fmtSignedPct = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(0)}%`;

export function pctChange(curr: number, prev: number): number | null {
  if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

export function adsManagerAdsetUrl(accountId: string, adsetId: string): string {
  return `https://adsmanager.facebook.com/adsmanager/manage/adsets?act=${encodeURIComponent(accountId)}&selected_adset_ids=${encodeURIComponent(adsetId)}`;
}
export function adsManagerCampaignUrl(accountId: string, campaignId: string): string {
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(accountId)}&selected_campaign_ids=${encodeURIComponent(campaignId)}`;
}
export function adsManagerAdUrl(accountId: string, adId: string): string {
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${encodeURIComponent(accountId)}&selected_ad_ids=${encodeURIComponent(adId)}`;
}
