// GMN Marketing Report: the shape of a published monthly snapshot
// (client_monthly_reports.payload) and the loader the /dashboard/gmn-report
// page uses. Payloads are built offline by the monthly report scripts
// (portal/_build_alloy_month_xlsx.py + portal/_alloy_month_top_creatives.ts)
// with the same numbers as the client's slide deck, then published with
// portal/_publish_monthly_report.ts — nothing here computes metrics.
import { query } from './db';

/** One row of a Lead Generation-style table (a location, an offer, or a total). */
export interface GmnMetricRow {
  label: string;
  spend: number;
  reach: number;
  impressions: number;
  linkClicks: number;
  ctr: number | null;        // percent, e.g. 1.26
  leads: number | null;
  cpl: number | null;
  bookings: number | null;   // calendar count (deck "Bookings")
  cpb: number | null;        // spend / calendar count (deck "CPB")
}

export interface GmnCreativeLocation {
  location: string;
  spend: number;
  impressions: number;
  linkClicks: number;
  ctr: number | null;
  leads: number;
  cpl: number | null;
}

export interface GmnCreative {
  rank: number;
  type: 'image' | 'video';
  accountId: string;          // canonical asset's ad account (thumbnail/video lookups)
  assetKey: string;           // e.g. "image:<hash>" or "video:<id>"
  videoId: string | null;
  sampleAdId: string | null;  // an ad that ran it, for the Ads Manager fallback link
  title: string | null;
  body: string | null;
  variants: number;           // assets merged into this creative (overlay/copy variants, re-uploads)
  spend: number;
  impressions: number;
  linkClicks: number;
  ctr: number | null;
  leads: number;              // Meta leads
  cpl: number | null;
  locations: GmnCreativeLocation[];
}

export interface GmnReportPayload {
  version: 1;
  title: string;              // e.g. "Alloy Personal Training Local Marketing Monthly Report"
  month: string;              // "YYYY-MM"
  monthLabel: string;         // e.g. "September 2026"
  generatedAt: string;
  overview: {
    totalLocations: number;
    spend: number;
    leads: number;
    cpl: number | null;
    bookings: number | null;
    cpb: number | null;
    avgLocationSpend: number | null;
  };
  locations: GmnMetricRow[];
  locationsTotal: GmnMetricRow;
  offers: GmnMetricRow[];
  offersTotal: GmnMetricRow;
  topCreatives: GmnCreative[];
  creativesNote?: string;
  // Click-through per location (keyed by the location row's label): its row, its own offer breakdown and its top
  // creatives (ranked by that location's CPL). Optional — older snapshots don't have it and the rows stay plain.
  locationDetails?: Record<string, GmnLocationDetail>;
  locationCreativesNote?: string;
  // Click-through per offer (keyed by the offer row's label): the locations that ran it, each with its numbers for
  // that offer. Optional — older snapshots don't have it and the offer rows stay plain.
  offerDetails?: Record<string, GmnOfferDetail>;
  // Top headlines and ad copy (Meta's title_asset / body_asset breakdowns), ranked like the creatives. Ad copy is grouped by
  // template: each location's city name is swapped for "{City}" so the same copy run at many locations is one row.
  // Optional — older snapshots don't have them and the Enhanced view just skips the section.
  topHeadlines?: GmnCopyItem[];
  topAdCopy?: GmnCopyItem[];
  copyNote?: string;
  notes?: string[];
}

export interface GmnCopyItem {
  rank: number;
  text: string;               // the headline, or the ad copy template with "{City}" in place of the location's city
  variants: number;           // distinct texts merged into this row (one per city for ad copy)
  spend: number;
  impressions: number;
  linkClicks: number;
  ctr: number | null;
  leads: number;              // Meta leads
  cpl: number | null;
  locations: GmnCreativeLocation[];
}

export interface GmnOfferDetail {
  row: GmnMetricRow;
  locations: GmnMetricRow[];  // label = location name
}

export interface GmnLocationDetail {
  row: GmnMetricRow;
  offers: GmnMetricRow[];
  topCreatives: GmnCreative[];
}

export interface GmnReportMonth { month: string; label: string }

/** Published months for a client, newest first. Tolerates the table not existing yet. */
export async function listPublishedMonths(clientId: string): Promise<GmnReportMonth[]> {
  const rows = await query<{ month: string; label: string | null }>(
    `SELECT to_char(month, 'YYYY-MM') AS month, payload->>'monthLabel' AS label
     FROM client_monthly_reports
     WHERE client_id = $1 AND published_at IS NOT NULL
     ORDER BY month DESC`,
    [clientId]
  ).catch(() => []);
  return rows.map(r => ({ month: r.month, label: r.label || r.month }));
}

/** The published payload for one month ("YYYY-MM"), or null. */
export async function loadPublishedReport(clientId: string, month: string): Promise<GmnReportPayload | null> {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [row] = await query<{ payload: GmnReportPayload }>(
    `SELECT payload FROM client_monthly_reports
     WHERE client_id = $1 AND month = $2::date AND published_at IS NOT NULL`,
    [clientId, `${month}-01`]
  ).catch(() => []);
  if (!row?.payload) return null;
  // The page doesn't show ad copy or headlines; blank them so they never reach the browser either.
  const strip = (cs: GmnCreative[] | undefined) => (cs ?? []).map(c => ({ ...c, title: null, body: null }));
  const p = row.payload;
  return {
    ...p,
    topCreatives: strip(p.topCreatives),
    locationDetails: p.locationDetails
      ? Object.fromEntries(Object.entries(p.locationDetails).map(([k, d]) => [k, { ...d, topCreatives: strip(d.topCreatives) }]))
      : p.locationDetails,
  };
}
