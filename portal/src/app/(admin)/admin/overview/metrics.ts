// Plain (non-client) module so the server component (page.tsx) can import
// parseMetricsParam directly — a 'use client' module's non-component named
// exports aren't reliably reachable from a server component across the RSC
// boundary in Next.js's App Router bundling, only the default export is.
export const OPTIONAL_METRICS = [
  { key: 'impressions', label: 'Impressions' },
  { key: 'reach', label: 'Reach' },
  { key: 'link_clicks', label: 'Link Clicks' },
  { key: 'ctr', label: 'CTR' },
] as const;

export type OptionalMetricKey = typeof OPTIONAL_METRICS[number]['key'];

export function parseMetricsParam(value: string | undefined): Set<OptionalMetricKey> {
  if (!value) return new Set();
  const valid = new Set(OPTIONAL_METRICS.map(m => m.key));
  return new Set(value.split(',').filter((v): v is OptionalMetricKey => valid.has(v as OptionalMetricKey)));
}
