// Offer x Location CPL matrix: which offer each club should run next.
// Rows are location clients (or brands when collapsed), columns are offer
// tokens, cells are spend/leads/CPL for the range; footer = agency median
// CPL per offer across clients that clear the minimum sample.
import { loadMarketerScope } from '@/lib/marketerScope';
import { loadCampaignStats, median, emptyTotals, addTotals, cplOf, type Totals } from './campaignStats';
import { MIN_PEER_SPEND, MIN_PEER_RESULTS } from './scorecard';

export interface MatrixCell { spend: number; results: number; cpl: number | null; campaigns: number; judged: boolean }
export interface MatrixRow { key: string; label: string; brand: string; clientId: string | null; cells: Record<string, MatrixCell>; total: MatrixCell }
export interface OfferMatrix {
  range: { since: string; until: string };
  offers: { token: string; spend: number; results: number; cpl: number | null; medianCpl: number | null; clients: number }[];
  rows: MatrixRow[];
  groupBy: 'client' | 'brand';
}

export async function buildOfferMatrix(f: { since: string; until: string; brand?: string; groupBy?: 'client' | 'brand'; minSpend?: number }): Promise<OfferMatrix> {
  const scope = await loadMarketerScope();
  const stats = await loadCampaignStats(scope.accountIds, f.since, f.until);
  const groupBy = f.groupBy ?? 'client';
  const minSpend = f.minSpend ?? 0;

  type Acc = Totals & { campaigns: number };
  const cellAcc = new Map<string, Map<string, Acc>>(); // rowKey -> offer -> acc
  const rowMeta = new Map<string, { label: string; brand: string; clientId: string | null }>();
  const clientCellForMedian = new Map<string, Map<string, Acc>>(); // always per client, for the footer medians

  for (const s of stats) {
    if (!s.clientId) continue;
    const c = scope.clientById.get(s.clientId);
    if (!c || c.isRollup) continue;
    if (f.brand && c.brand !== f.brand) continue;
    const rowKey = groupBy === 'brand' ? `brand:${c.brand}` : c.id;
    if (!rowMeta.has(rowKey)) rowMeta.set(rowKey, { label: groupBy === 'brand' ? c.brand : c.name, brand: c.brand, clientId: groupBy === 'brand' ? null : c.id });
    for (const [map, key] of [[cellAcc, rowKey], [clientCellForMedian, c.id]] as const) {
      let byOffer = map.get(key);
      if (!byOffer) { byOffer = new Map(); map.set(key, byOffer); }
      let acc = byOffer.get(s.offer);
      if (!acc) { acc = { ...emptyTotals(), campaigns: 0 }; byOffer.set(s.offer, acc); }
      addTotals(acc, s);
      acc.campaigns++;
    }
  }

  const toCell = (a: Acc | undefined): MatrixCell => {
    if (!a) return { spend: 0, results: 0, cpl: null, campaigns: 0, judged: false };
    return { spend: a.spend, results: a.results, cpl: cplOf(a.spend, a.results), campaigns: a.campaigns, judged: a.spend >= MIN_PEER_SPEND && a.results >= MIN_PEER_RESULTS };
  };

  // Offer columns ordered by total spend.
  const offerTotals = new Map<string, Acc & { clients: Set<string>; cpls: number[] }>();
  for (const [clientId, byOffer] of Array.from(clientCellForMedian.entries())) {
    for (const [offer, acc] of Array.from(byOffer.entries())) {
      let o = offerTotals.get(offer);
      if (!o) { o = { ...emptyTotals(), campaigns: 0, clients: new Set(), cpls: [] }; offerTotals.set(offer, o); }
      addTotals(o, acc); o.campaigns += acc.campaigns; o.clients.add(clientId);
      const cell = toCell(acc);
      if (cell.judged && cell.cpl !== null) o.cpls.push(cell.cpl);
    }
  }
  const offers = Array.from(offerTotals.entries())
    .sort((a, b) => b[1].spend - a[1].spend)
    .map(([token, o]) => ({ token, spend: o.spend, results: o.results, cpl: cplOf(o.spend, o.results), medianCpl: median(o.cpls), clients: o.clients.size }));

  const rows: MatrixRow[] = Array.from(cellAcc.entries()).map(([key, byOffer]) => {
    const meta = rowMeta.get(key)!;
    const cells: Record<string, MatrixCell> = {};
    const total: Acc = { ...emptyTotals(), campaigns: 0 };
    for (const [offer, acc] of Array.from(byOffer.entries())) { cells[offer] = toCell(acc); addTotals(total, acc); total.campaigns += acc.campaigns; }
    return { key, label: meta.label, brand: meta.brand, clientId: meta.clientId, cells, total: toCell(total) };
  }).filter(r => r.total.spend >= minSpend)
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.label.localeCompare(b.label));

  return { range: { since: f.since, until: f.until }, offers, rows, groupBy };
}
