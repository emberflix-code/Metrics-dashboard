// Location groups for the GMN Marketing Report (e.g. "Presale"): a group is a subset of the month's locations shown on
// its own tab. The full report stays exactly as published; the group's view is derived here from the same snapshot:
// its locations' rows, totals recomputed from them, its offers summed from each location's own offer breakdown and
// its creatives merged from each location's own top creatives. Pure (no db) so the client page can import it.
import type { GmnCreative, GmnCreativeLocation, GmnLocationDetail, GmnMetricRow, GmnOfferDetail, GmnReportGroup, GmnReportPayload } from './gmnReport';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Sum rows and recompute the ratios from the sums (CPB only over rows that have booking data). */
export function sumRows(rows: GmnMetricRow[], label: string): GmnMetricRow {
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  const reach = rows.reduce((s, r) => s + r.reach, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const linkClicks = rows.reduce((s, r) => s + r.linkClicks, 0);
  const withLeads = rows.filter(r => r.leads != null);
  const leads = withLeads.length ? withLeads.reduce((s, r) => s + (r.leads ?? 0), 0) : null;
  const leadSpend = withLeads.reduce((s, r) => s + r.spend, 0);
  const withBookings = rows.filter(r => r.bookings != null);
  const bookings = withBookings.length ? withBookings.reduce((s, r) => s + (r.bookings ?? 0), 0) : null;
  const bookingSpend = withBookings.reduce((s, r) => s + r.spend, 0);
  return {
    label,
    spend: r2(spend),
    reach,
    impressions,
    linkClicks,
    ctr: impressions ? r2((linkClicks / impressions) * 100) : null,
    leads,
    cpl: leads ? r2(leadSpend / leads) : null,
    bookings,
    cpb: bookings ? r2(bookingSpend / bookings) : null,
  };
}

function sumCreativeLocations(locs: GmnCreativeLocation[]) {
  const spend = locs.reduce((s, l) => s + l.spend, 0);
  const impressions = locs.reduce((s, l) => s + l.impressions, 0);
  const linkClicks = locs.reduce((s, l) => s + l.linkClicks, 0);
  const leads = locs.reduce((s, l) => s + l.leads, 0);
  return {
    spend: r2(spend), impressions, linkClicks, leads,
    ctr: impressions ? r2((linkClicks / impressions) * 100) : null,
    cpl: leads ? r2(spend / leads) : null,
  };
}

/** Groups in this snapshot that have at least one location row this month. */
export function groupsWithData(report: GmnReportPayload): GmnReportGroup[] {
  const labels = new Set(report.locations.map(r => r.label));
  return (report.groups ?? []).filter(g => g.locations.some(l => labels.has(l)));
}

/** The report as it reads for one group of locations. */
export function groupReport(report: GmnReportPayload, group: GmnReportGroup): GmnReportPayload {
  const wanted = new Set(group.locations);
  const locations = report.locations.filter(r => wanted.has(r.label));
  const locationsTotal = sumRows(locations, 'Total');
  const details: Record<string, GmnLocationDetail> = {};
  for (const r of locations) { const d = report.locationDetails?.[r.label]; if (d) details[r.label] = d; }

  // Offers: each location's own offer rows (they already sum to the location row), added up per offer.
  const offerRows = new Map<string, GmnMetricRow[]>();
  const offerLocs = new Map<string, GmnMetricRow[]>();
  for (const [loc, d] of Object.entries(details)) {
    for (const o of d.offers) {
      (offerRows.get(o.label) ?? offerRows.set(o.label, []).get(o.label)!).push(o);
      (offerLocs.get(o.label) ?? offerLocs.set(o.label, []).get(o.label)!).push({ ...o, label: loc });
    }
  }
  const offers = Array.from(offerRows.entries()).map(([label, rows]) => sumRows(rows, label)).sort((a, b) => b.spend - a.spend);
  const offerDetails: Record<string, GmnOfferDetail> = {};
  for (const o of offers) offerDetails[o.label] = { row: o, locations: (offerLocs.get(o.label) ?? []).sort((a, b) => b.spend - a.spend) };

  // Creatives: each location's own top creatives (numbers are that location's), merged by asset and ranked by CPL.
  const merged = new Map<string, { base: GmnCreative; locs: GmnCreativeLocation[]; variants: number }>();
  for (const [loc, d] of Object.entries(details)) {
    for (const c of d.topCreatives) {
      const m = merged.get(c.assetKey) ?? merged.set(c.assetKey, { base: c, locs: [], variants: 0 }).get(c.assetKey)!;
      m.locs.push({ location: loc, spend: c.spend, impressions: c.impressions, linkClicks: c.linkClicks, ctr: c.ctr, leads: c.leads, cpl: c.cpl });
      m.variants = Math.max(m.variants, c.variants);
    }
  }
  const topCreatives: GmnCreative[] = Array.from(merged.values())
    .map(({ base, locs, variants }) => ({ ...base, ...sumCreativeLocations(locs), variants, locations: locs.sort((a, b) => b.spend - a.spend) }))
    .filter(c => c.leads > 0)
    .sort((a, b) => (a.cpl ?? Infinity) - (b.cpl ?? Infinity) || b.spend - a.spend)
    .slice(0, 10)
    .map((c, i) => ({ ...c, rank: i + 1 }));

  const missing = group.locations.filter(l => !locations.some(r => r.label === l));
  const notes = [
    `${group.label} locations: ${group.locations.map(shortName).join(', ')}. They are also included in the full report.`,
    ...(missing.length ? [`No ad spend this month: ${missing.map(shortName).join(', ')}.`] : []),
    ...(report.notes ?? []),
  ];
  return {
    ...report,
    title: `${report.title} – ${group.label}`,
    overview: {
      totalLocations: locations.length,
      spend: locationsTotal.spend,
      leads: locationsTotal.leads ?? 0,
      cpl: locationsTotal.cpl,
      bookings: locationsTotal.bookings,
      cpb: locationsTotal.cpb,
      avgLocationSpend: locations.length ? r2(locationsTotal.spend / locations.length) : null,
    },
    locations,
    locationsTotal,
    offers,
    offersTotal: sumRows(offers, 'Total'),
    topCreatives,
    creativesNote: `Top creatives across the ${group.label.toLowerCase()} locations, ranked by cost per lead: each location's own top creatives (at least $100 spend and one lead there), with the same image or video combined across locations.`,
    locationDetails: details,
    offerDetails,
    // Headline and ad copy rankings are account-wide (top 10 only), so they can't be narrowed to a group honestly.
    topHeadlines: undefined,
    topAdCopy: undefined,
    copyNote: undefined,
    notes,
  };
}

function shortName(label: string): string {
  return label.replace(/^Alloy (Personal Training )?(- )?/i, '');
}
