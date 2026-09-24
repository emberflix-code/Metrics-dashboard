import type { AlertKind, AlertSeverity } from '@/lib/marketer/alerts';

// Human labels for alert kinds. Kept in a plain module (no 'use client')
// so both server pages and client components can import it without the
// value turning into a client reference.
export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  zero_lead_spend: 'Zero-lead spend',
  cpl_spike: 'CPL spike',
  overlap_high: 'Radius overlap',
  off_club: 'Off-club targeting',
  broad_targeting: 'Broad targeting',
  copy_offer_mismatch: 'Copy/offer mismatch',
  greeting_city_mismatch: 'Greeting/city mismatch',
  unattributed_campaign: 'Unattributed campaign',
  stale_sync: 'Stale sync',
  creative_fatigue: 'Creative fatigue',
  club_not_geocoded: 'Club not geocoded',
};

// Display order for chips/filters: performance first, then targeting,
// then copy, then data-quality — the order a marketer triages in.
export const ALERT_KINDS_ORDERED: AlertKind[] = [
  'zero_lead_spend', 'cpl_spike', 'creative_fatigue',
  'overlap_high', 'off_club', 'broad_targeting',
  'copy_offer_mismatch', 'greeting_city_mismatch',
  'unattributed_campaign', 'stale_sync', 'club_not_geocoded',
];

export function isAlertKind(s: string): s is AlertKind {
  return Object.prototype.hasOwnProperty.call(ALERT_KIND_LABELS, s);
}

export const SEVERITY_PILL_CLS: Record<AlertSeverity, string> = {
  high: 'text-red-300 border-red-500/30 bg-red-500/10',
  medium: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
  low: 'text-slate-300 border-slate-700 bg-slate-800',
};
