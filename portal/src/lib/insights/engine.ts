// Rule-based written analysis of a period (the client dashboard's Insights
// tab, and the coach board's insights pop-up). Pure: everything it reads comes
// in through InsightInput, and every number/name is formatted with the
// caller's InsightFormat so the dashboard and the server render identically.
// Moved out of DashboardClient.tsx unchanged (text and thresholds); see the
// parity check in the commit that introduced this file.

export interface InsightFinding { tone: 'good' | 'bad' | 'warn' | 'info'; text: string }
export interface InsightSection { key: string; title: string; icon: string; iconColor: string; findings: InsightFinding[]; table?: string; empty?: string }
export interface InsightTile { label: string; value: string; delta?: number | null; lowerIsBetter?: boolean; sub?: string }
export interface InsightReport { rangeLabel: string; days: number; tiles: InsightTile[]; sections: InsightSection[]; recommendations: string[]; basis: string[] }

/** One table row (campaign / ad set / ad) — the fields of the dashboard's calcMetrics() it uses. */
export interface InsightRow { id?: string; name: string; status?: string; spent: number; results: number; impressions: number; linkClicks: number; cpl: number; ctr: number }
type TrendDay = { date: string; spend: number; results: number };
export interface InsightThemeRow { key?: string; label: string; spend: number; leads: number; cpl: number | null }
export interface InsightThemes { byTheme: InsightThemeRow[]; byUgc: InsightThemeRow[] }

export interface InsightFormat {
  fmtUsd: (n: number) => string;
  fmt: (n: number) => string;
  fmtPct: (n: number) => string;
  shortName: (name: string, max: number) => string;
  formatDateLabel: (since: string, until: string) => string;
  esc: (s: string) => string;
  deliveryBadge: (status: string | undefined) => string;
}

export interface InsightInput {
  since: string;
  until: string;
  level: string;                  // 'campaign' | 'adset' | 'ad'
  rows: InsightRow[];
  kpi: { spend: number | null; leads: number | null; impressions: number | null };
  comparison: { since: string; until: string; totals: { spent: number; results: number; impressions: number; linkClicks: number } } | null;
  trend: { date: string; spend: number; results: number }[];
  showThemes: boolean;
  themes: InsightThemes | null;
  leadsSource: string;
  filtersOn: string[];
  format: InsightFormat;
}

function _pctChange(curr: number, prev: number): number | null {
  if (!prev || !Number.isFinite(prev) || !Number.isFinite(curr)) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}
function _fmtSignedPct(p: number | null, digits = 1): string {
  if (p === null || !Number.isFinite(p)) return '—';
  return `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(digits)}%`;
}
function _fmtDayLong(s: string): string {
  if (!s) return '';
  return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function _joinNames(shortName: InsightFormat['shortName'], names: string[], max = 3): string {
  const shown = names.slice(0, max).map(n => `**${shortName(n, 40)}**`);
  const rest = names.length - shown.length;
  return shown.join(', ') + (rest > 0 ? ` and ${rest} more` : '');
}

export function buildInsightReport(i: InsightInput): InsightReport {
  const { since, until } = i;
  const { fmtUsd, fmt, fmtPct, shortName, formatDateLabel, esc, deliveryBadge } = i.format;
  const _joinNamesF = (names: string[], max = 3) => _joinNames(shortName, names, max);
  const rangeLabel = formatDateLabel(since, until);
  const days = Math.max(1, Math.round((Date.parse(until + 'T00:00:00Z') - Date.parse(since + 'T00:00:00Z')) / 86400000) + 1);
  const lvl = i.level;
  const noun = lvl === 'adset' ? ['ad set', 'ad sets'] : lvl === 'ad' ? ['ad', 'ads'] : ['campaign', 'campaigns'];
  const Noun = noun[1].charAt(0).toUpperCase() + noun[1].slice(1);

  const rows = i.rows;
  const rowSpend = rows.reduce((s, c) => s + c.spent, 0);
  const rowLeads = rows.reduce((s, c) => s + c.results, 0);
  const rowImpr = rows.reduce((s, c) => s + c.impressions, 0);
  const rowClicks = rows.reduce((s, c) => s + c.linkClicks, 0);
  // Prefer the exact numbers the KPI cards show (they apply the leads-source
  // and KPI-sheet-filter overrides); fall back to the row sums.
  const spend = i.kpi.spend ?? rowSpend;
  const leads = i.kpi.leads ?? rowLeads;
  const impressions = i.kpi.impressions ?? rowImpr;
  const linkClicks = rowClicks;
  const cpl = leads > 0 ? spend / leads : 0;
  const ctr = impressions > 0 ? (linkClicks / impressions) * 100 : 0;
  // Per-row benchmarks use the row-level (Meta/sheet-attributed) totals so a
  // campaign is compared against the same attribution its own numbers use.
  const rowCpl = rowLeads > 0 ? rowSpend / rowLeads : 0;
  const rowCtr = rowImpr > 0 ? (rowClicks / rowImpr) * 100 : 0;

  const sections: InsightSection[] = [];
  const recommendations: string[] = [];

  // ── Tiles ──────────────────────────────────────────────────────────────
  const ct = i.comparison?.totals ?? null;
  const _comparisonRange = i.comparison && i.comparison.since ? { since: i.comparison.since, until: i.comparison.until } : null;
  const compCpl = ct && ct.results > 0 ? ct.spent / ct.results : 0;
  const compCtr = ct && ct.impressions > 0 ? (ct.linkClicks / ct.impressions) * 100 : 0;
  const tiles: InsightTile[] = [
    { label: 'Amount Spent', value: fmtUsd(spend), delta: ct ? _pctChange(spend, ct.spent) : null, sub: `${fmtUsd(spend / days)} / day` },
    { label: 'Leads', value: fmt(leads), delta: ct ? _pctChange(leads, ct.results) : null, sub: `${(leads / days).toFixed(1)} / day` },
    { label: 'CPL', value: leads > 0 ? fmtUsd(cpl) : '—', delta: ct && leads > 0 ? _pctChange(cpl, compCpl) : null, lowerIsBetter: true },
    { label: 'CTR', value: fmtPct(ctr), delta: ct ? _pctChange(ctr, compCtr) : null },
    { label: 'Impressions', value: fmt(impressions), delta: ct ? _pctChange(impressions, ct.impressions) : null, sub: impressions > 0 ? `${fmtUsd((spend / impressions) * 1000)} CPM` : undefined },
    { label: 'Link Clicks', value: fmt(linkClicks), delta: ct ? _pctChange(linkClicks, ct.linkClicks) : null, sub: linkClicks > 0 ? `${fmtUsd(spend / linkClicks)} CPC` : undefined },
  ];

  // ── 1. Versus comparison period ────────────────────────────────────────
  if (ct && _comparisonRange) {
    const f: InsightFinding[] = [];
    const dSpend = _pctChange(spend, ct.spent), dLeads = _pctChange(leads, ct.results), dCpl = leads > 0 && compCpl > 0 ? _pctChange(cpl, compCpl) : null;
    const dCtr = _pctChange(ctr, compCtr), dImpr = _pctChange(impressions, ct.impressions);
    const dir = (p: number | null, up = 'rose', down = 'fell') => p === null ? 'was flat' : Math.abs(p) < 0.5 ? 'was flat' : p > 0 ? up : down;
    f.push({
      tone: 'info',
      text: `Spend ${dir(dSpend)} ${_fmtSignedPct(dSpend)} (${fmtUsd(ct.spent)} → ${fmtUsd(spend)}) and leads ${dir(dLeads)} ${_fmtSignedPct(dLeads)} (${fmt(ct.results)} → ${fmt(leads)}) versus ${formatDateLabel(_comparisonRange.since, _comparisonRange.until)}.`,
    });
    if (dCpl !== null) {
      const better = dCpl < 0;
      f.push({
        tone: Math.abs(dCpl) < 3 ? 'info' : better ? 'good' : 'bad',
        text: `CPL ${better ? 'improved' : 'worsened'} ${_fmtSignedPct(dCpl)}: **${fmtUsd(compCpl)} → ${fmtUsd(cpl)}**${dSpend !== null && dLeads !== null ? (better && dSpend > 0 ? ' — leads grew faster than spend' : !better && dSpend > 0 ? ' — spend grew faster than leads' : '') : ''}.`,
      });
      if (Math.abs(dCpl) >= 15) recommendations.push(better
        ? `Efficiency is up ${_fmtSignedPct(-dCpl)} versus the comparison period — this is a good window to scale budgets while CPL holds.`
        : `CPL is ${_fmtSignedPct(dCpl)} versus the comparison period — check frequency, audience saturation and creative age before adding budget.`);
    } else if (leads === 0 && ct.results > 0) {
      f.push({ tone: 'bad', text: `No leads this period versus **${fmt(ct.results)}** in the comparison period.` });
    }
    if (dCtr !== null && Math.abs(dCtr) >= 5) {
      f.push({ tone: dCtr > 0 ? 'good' : 'warn', text: `CTR ${dCtr > 0 ? 'rose' : 'fell'} ${_fmtSignedPct(dCtr)} (${fmtPct(compCtr)} → ${fmtPct(ctr)})${dImpr !== null && dImpr > 10 && dCtr < 0 ? ' while impressions grew — the extra reach engaged less' : ''}.` });
    }
    sections.push({ key: 'compare', title: 'Versus comparison period', icon: 'git-compare', iconColor: 'text-sky-400', findings: f });
  }

  // ── 2. Trend within the period ─────────────────────────────────────────
  {
    const f: InsightFinding[] = [];
    const trend = i.trend.filter(d => d.date >= since && d.date <= until);
    if (trend.length >= 2) {
      const sum = (arr: TrendDay[]) => arr.reduce((a, d) => ({ spend: a.spend + d.spend, results: a.results + d.results }), { spend: 0, results: 0 });
      const cplOf = (t: { spend: number; results: number }) => t.results > 0 ? t.spend / t.results : null;
      // Momentum: last 7 vs prior 7 when there's room, else second half vs first half.
      let recent: TrendDay[] = [], prior: TrendDay[] = [], recentLabel = '', priorLabel = '';
      if (trend.length >= 14) { recent = trend.slice(-7); prior = trend.slice(-14, -7); recentLabel = 'the last 7 days'; priorLabel = 'the 7 days before'; }
      else if (trend.length >= 4) { const h = Math.floor(trend.length / 2); prior = trend.slice(0, h); recent = trend.slice(trend.length - h); recentLabel = `the second half (${_fmtDayLong(recent[0].date)} onward)`; priorLabel = 'the first half'; }
      if (recent.length) {
        const r = sum(recent), p = sum(prior), rc = cplOf(r), pc = cplOf(p);
        const dL = _pctChange(r.results, p.results), dS = _pctChange(r.spend, p.spend), dC = rc !== null && pc !== null ? _pctChange(rc, pc) : null;
        let txt = `Momentum: ${recentLabel} produced **${fmt(r.results)} leads on ${fmtUsd(r.spend)}** vs ${fmt(p.results)} on ${fmtUsd(p.spend)} in ${priorLabel}`;
        txt += dL !== null ? ` (leads ${_fmtSignedPct(dL)}, spend ${_fmtSignedPct(dS)})` : '';
        txt += dC !== null ? ` — CPL ${dC < 0 ? 'improved' : 'worsened'} from ${fmtUsd(pc!)} to **${fmtUsd(rc!)}** (${_fmtSignedPct(dC)}).` : rc !== null ? ` — CPL ${fmtUsd(rc)}.` : '.';
        f.push({ tone: dC === null ? 'info' : Math.abs(dC) < 5 ? 'info' : dC < 0 ? 'good' : 'bad', text: txt });
        if (dC !== null && dC >= 15) recommendations.push(`CPL is trending up inside the period (${_fmtSignedPct(dC)} in ${recentLabel}) — watch ad frequency and rotate in fresh creative before it compounds.`);
        else if (dC !== null && dC <= -15) recommendations.push(`CPL is trending down inside the period (${_fmtSignedPct(dC)} in ${recentLabel}) — the current setup is gaining efficiency; avoid unnecessary changes.`);
      }
      // Best / worst days, guarded so a $3 day can't be the "best" CPL.
      const avgSpend = sum(trend).spend / trend.length;
      const eligible = trend.filter(d => d.results > 0 && d.spend >= avgSpend * 0.5);
      if (eligible.length >= 2) {
        const byCpl = [...eligible].sort((a, b) => (a.spend / a.results) - (b.spend / b.results));
        const best = byCpl[0], worst = byCpl[byCpl.length - 1];
        f.push({ tone: 'good', text: `Best day: **${_fmtDayLong(best.date)}** — ${fmt(best.results)} leads on ${fmtUsd(best.spend)} (${fmtUsd(best.spend / best.results)} CPL).` });
        if (worst !== best) f.push({ tone: 'warn', text: `Weakest day: **${_fmtDayLong(worst.date)}** — ${fmt(worst.results)} leads on ${fmtUsd(worst.spend)} (${fmtUsd(worst.spend / worst.results)} CPL).` });
      }
      const peak = [...trend].sort((a, b) => b.results - a.results)[0];
      if (peak && peak.results > 0 && (!eligible.length || peak.date !== eligible.sort((a, b) => (a.spend / a.results) - (b.spend / b.results))[0]?.date)) {
        f.push({ tone: 'info', text: `Highest lead volume: **${_fmtDayLong(peak.date)}** with ${fmt(peak.results)} leads (${fmtUsd(peak.spend)} spend).` });
      }
      const zero = trend.filter(d => d.spend > 0 && d.results === 0);
      if (zero.length) {
        const zSpend = zero.reduce((s, d) => s + d.spend, 0);
        f.push({ tone: zero.length >= 2 ? 'bad' : 'warn', text: `**${zero.length} day${zero.length > 1 ? 's' : ''}** spent ${fmtUsd(zSpend)} with no leads: ${zero.slice(0, 4).map(d => _fmtDayLong(d.date)).join(', ')}${zero.length > 4 ? '…' : ''}.` });
        if (zero.length >= 2) recommendations.push(`Investigate the ${zero.length} zero-lead days (${zero.slice(0, 3).map(d => _fmtDayLong(d.date)).join(', ')}) — spend ran but nothing converted, which usually points to a form/pixel issue, a paused ad set, or a learning-phase reset.`);
      }
      // Weekday pattern needs at least two of each weekday to mean anything.
      if (trend.length >= 14) {
        const wd: Record<number, { spend: number; results: number; n: number }> = {};
        for (const d of trend) { const k = new Date(d.date + 'T12:00:00').getDay(); wd[k] = wd[k] || { spend: 0, results: 0, n: 0 }; wd[k].spend += d.spend; wd[k].results += d.results; wd[k].n++; }
        const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const list = Object.entries(wd).map(([k, v]) => ({ k: +k, ...v, cpl: v.results > 0 ? v.spend / v.results : null, perDay: v.results / v.n })).filter(x => x.cpl !== null);
        if (list.length >= 5) {
          const byCpl = [...list].sort((a, b) => a.cpl! - b.cpl!);
          const b = byCpl[0], w = byCpl[byCpl.length - 1];
          const gap = _pctChange(w.cpl!, b.cpl!);
          if (gap !== null && gap >= 20) {
            f.push({ tone: 'info', text: `Weekday pattern: **${names[b.k]}s** are the most efficient (${fmtUsd(b.cpl!)} CPL, ${b.perDay.toFixed(1)} leads/day) and **${names[w.k]}s** the least (${fmtUsd(w.cpl!)} CPL, ${w.perDay.toFixed(1)} leads/day).` });
          }
          const we = list.filter(x => x.k === 0 || x.k === 6), wk = list.filter(x => x.k >= 1 && x.k <= 5);
          const agg = (xs: typeof list) => { const s = xs.reduce((a, x) => a + x.spend, 0), r = xs.reduce((a, x) => a + x.results, 0); return r > 0 ? s / r : null; };
          const weC = agg(we), wkC = agg(wk);
          if (weC !== null && wkC !== null) {
            const d = _pctChange(weC, wkC);
            if (d !== null && Math.abs(d) >= 15) f.push({ tone: 'info', text: `Weekend CPL is ${fmtUsd(weC)} vs ${fmtUsd(wkC)} on weekdays (${_fmtSignedPct(d)}).` });
          }
        }
      }
      const maxDay = [...trend].sort((a, b) => b.spend - a.spend)[0];
      if (maxDay && avgSpend > 0 && maxDay.spend >= avgSpend * 2) {
        f.push({ tone: 'info', text: `Spend spiked on **${_fmtDayLong(maxDay.date)}** (${fmtUsd(maxDay.spend)}, ${(maxDay.spend / avgSpend).toFixed(1)}× the daily average of ${fmtUsd(avgSpend)}).` });
      }
    }
    sections.push({ key: 'trend', title: 'Trend within the period', icon: 'trending-up', iconColor: 'text-emerald-400', findings: f, empty: trend.length >= 2 ? 'Daily performance was steady — nothing stood out.' : 'Select a multi-day date range to see daily trend analysis.' });
  }

  // ── 3. Campaign / ad set / ad performance ──────────────────────────────
  {
    const f: InsightFinding[] = [];
    let table: string | undefined;
    const withSpend = rows.filter(c => c.spent > 0);
    if (withSpend.length > 0) {
      const byLeads = [...withSpend].sort((a, b) => b.results - a.results || b.spent - a.spent);
      const spenders = [...withSpend].sort((a, b) => b.spent - a.spent);
      if (rowLeads > 0) {
        let cum = 0, k = 0;
        for (const c of byLeads) { cum += c.results; k++; if (cum >= rowLeads * 0.8) break; }
        const top = byLeads[0];
        f.push({ tone: 'info', text: `**${k} of ${withSpend.length} ${withSpend.length === 1 ? noun[0] : noun[1]}** produced 80% of leads. ${shortName(top.name, 40)} led with **${fmt(top.results)} leads** (${((top.results / rowLeads) * 100).toFixed(0)}% of the total) at ${fmtUsd(top.cpl)} CPL on ${((top.spent / rowSpend) * 100).toFixed(0)}% of spend.` });
      } else {
        f.push({ tone: 'bad', text: `**No leads** were attributed to any ${noun[0]} in this period despite ${fmtUsd(rowSpend)} of spend.` });
      }
      const topSpender = spenders[0];
      if (topSpender && rowSpend > 0 && topSpender.spent / rowSpend >= 0.5 && withSpend.length > 1) {
        f.push({ tone: 'warn', text: `Budget is concentrated: **${shortName(topSpender.name, 40)}** took ${((topSpender.spent / rowSpend) * 100).toFixed(0)}% of all spend.` });
      }

      const minLeads = Math.max(5, Math.ceil(rowLeads * 0.02));
      const minSpend = Math.max(50, rowSpend * 0.02);
      const winners = rowCpl > 0 ? withSpend.filter(c => c.results >= minLeads && c.cpl > 0 && c.cpl <= rowCpl * 0.8).sort((a, b) => b.results - a.results) : [];
      if (winners.length) {
        f.push({ tone: 'good', text: `Efficient at volume: ${winners.slice(0, 3).map(c => `**${shortName(c.name, 40)}** (${fmtUsd(c.cpl)} CPL, ${fmt(c.results)} leads, ${_fmtSignedPct(_pctChange(c.cpl, rowCpl))} vs average)`).join('; ')}${winners.length > 3 ? ` and ${winners.length - 3} more` : ''}.` });
        recommendations.push(`Shift budget toward ${_joinNamesF(winners.map(c => c.name))} — ${winners.length > 1 ? 'they deliver' : 'it delivers'} leads at least 20% below your average CPL of ${fmtUsd(rowCpl)}.`);
      }
      const noLeads = withSpend.filter(c => c.results === 0 && c.spent >= minSpend).sort((a, b) => b.spent - a.spent);
      if (noLeads.length) {
        const s = noLeads.reduce((a, c) => a + c.spent, 0);
        f.push({ tone: 'bad', text: `${fmtUsd(s)} went to ${noLeads.length} ${noLeads.length === 1 ? noun[0] : noun[1]} with **zero leads**: ${noLeads.slice(0, 3).map(c => `${shortName(c.name, 40)} (${fmtUsd(c.spent)})`).join(', ')}${noLeads.length > 3 ? '…' : ''}.` });
        recommendations.push(`Pause or rework ${_joinNamesF(noLeads.map(c => c.name))}: ${fmtUsd(s)} spent in the period with no leads attributed.`);
      }
      const expensive = rowCpl > 0 ? withSpend.filter(c => c.results > 0 && c.spent >= minSpend && c.cpl >= rowCpl * 1.5).sort((a, b) => b.spent - a.spent) : [];
      if (expensive.length) {
        f.push({ tone: 'warn', text: `Above-average cost: ${expensive.slice(0, 3).map(c => `**${shortName(c.name, 40)}** (${fmtUsd(c.cpl)} CPL, ${_fmtSignedPct(_pctChange(c.cpl, rowCpl))}, ${fmtUsd(c.spent)} spend)`).join('; ')}${expensive.length > 3 ? ` and ${expensive.length - 3} more` : ''}.` });
        recommendations.push(`Audit targeting and creative on ${_joinNamesF(expensive.map(c => c.name))} — CPL is 50%+ above the ${fmtUsd(rowCpl)} average with meaningful spend behind it.`);
      }
      const lowCtr = rowCtr > 0 ? withSpend.filter(c => c.impressions >= 10000 && c.ctr < rowCtr * 0.5).sort((a, b) => b.impressions - a.impressions) : [];
      if (lowCtr.length) {
        f.push({ tone: 'warn', text: `Low engagement: ${lowCtr.slice(0, 3).map(c => `**${shortName(c.name, 40)}** (${fmtPct(c.ctr)} CTR on ${fmt(c.impressions)} impressions)`).join('; ')} vs ${fmtPct(rowCtr)} average — a typical sign of creative fatigue or a mismatched audience.` });
        recommendations.push(`Refresh creative on ${_joinNamesF(lowCtr.map(c => c.name))} — CTR is under half your ${fmtPct(rowCtr)} average.`);
      }
      const active = withSpend.filter(c => c.status === 'ACTIVE');
      const inactive = withSpend.filter(c => c.status && c.status !== 'ACTIVE');
      if (active.length && inactive.length) {
        const aS = active.reduce((s, c) => s + c.spent, 0), iS = inactive.reduce((s, c) => s + c.spent, 0);
        const aL = active.reduce((s, c) => s + c.results, 0), iL = inactive.reduce((s, c) => s + c.results, 0);
        f.push({ tone: 'info', text: `${active.length} currently active ${active.length === 1 ? noun[0] : noun[1]} account for ${((aS / rowSpend) * 100).toFixed(0)}% of spend${aL > 0 ? ` at ${fmtUsd(aS / aL)} CPL` : ''}; ${inactive.length} now paused/ended ${inactive.length === 1 ? noun[0] : noun[1]} spent ${fmtUsd(iS)}${iL > 0 ? ` at ${fmtUsd(iS / iL)} CPL` : ' with no leads'} during the period.` });
      }

      const top5 = byLeads.slice(0, 5);
      table = `
        <div class="mt-3 rounded-lg overflow-hidden border border-slate-800">
          <div class="bg-slate-950 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Top ${top5.length} ${noun[1]} by leads</div>
          <div class="overflow-x-auto scrollbar-thin"><table class="w-full">
            <thead><tr class="border-b border-slate-800 bg-slate-900/60">
              ${['Name', 'Delivery', 'Spend', 'Leads', 'Share', 'CPL', 'vs avg', 'CTR'].map((h, i) => `<th class="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap ${i < 2 ? 'text-left' : 'text-right'}">${h}</th>`).join('')}
            </tr></thead>
            <tbody>${top5.map(c => {
              const d = c.results > 0 && rowCpl > 0 ? _pctChange(c.cpl, rowCpl) : null;
              const dCls = d === null ? 'text-slate-500' : d <= -10 ? 'text-emerald-400' : d >= 10 ? 'text-red-400' : 'text-slate-300';
              return `<tr class="border-b border-slate-800/60">
                <td class="px-3 py-1.5 text-xs text-white max-w-[320px] truncate" title="${esc(c.name)}">${esc(shortName(c.name, 48))}</td>
                <td class="px-3 py-1.5 text-xs">${deliveryBadge(c.status)}</td>
                <td class="px-3 py-1.5 text-xs text-slate-300 text-right whitespace-nowrap">${fmtUsd(c.spent)}</td>
                <td class="px-3 py-1.5 text-xs text-slate-300 text-right">${fmt(c.results)}</td>
                <td class="px-3 py-1.5 text-xs text-slate-400 text-right">${rowLeads > 0 ? ((c.results / rowLeads) * 100).toFixed(0) + '%' : '—'}</td>
                <td class="px-3 py-1.5 text-xs text-slate-300 text-right whitespace-nowrap">${c.results > 0 ? fmtUsd(c.cpl) : '—'}</td>
                <td class="px-3 py-1.5 text-xs text-right font-mono ${dCls}">${_fmtSignedPct(d, 0)}</td>
                <td class="px-3 py-1.5 text-xs text-slate-300 text-right">${fmtPct(c.ctr)}</td>
              </tr>`;
            }).join('')}</tbody>
          </table></div>
        </div>`;
    }
    sections.push({ key: 'campaigns', title: `${Noun} performance`, icon: 'target', iconColor: 'text-violet-400', findings: f, table, empty: `No ${noun[1]} with spend in this period.` });
  }

  // ── 4. Creative themes (only when the Theme Breakdown tab is enabled) ──
  if (i.showThemes) {
    const f: InsightFinding[] = [];
    const tb = i.themes;
    if (tb && (tb.byTheme.length || tb.byUgc.length)) {
      const themes = tb.byTheme.filter(r => r.spend > 0);
      const tSpend = themes.reduce((s, r) => s + r.spend, 0), tLeads = themes.reduce((s, r) => s + r.leads, 0);
      const judged = themes.filter(r => r.leads >= 10 && r.cpl !== null);
      if (judged.length >= 2) {
        const byCpl = [...judged].sort((a, b) => a.cpl! - b.cpl!);
        const b = byCpl[0], w = byCpl[byCpl.length - 1];
        const gap = _pctChange(w.cpl!, b.cpl!);
        f.push({ tone: gap !== null && gap >= 20 ? 'good' : 'info', text: `**${b.label}** is the most efficient theme at ${fmtUsd(b.cpl!)} CPL (${fmt(b.leads)} leads on ${((b.spend / tSpend) * 100).toFixed(0)}% of tagged spend); **${w.label}** is the least at ${fmtUsd(w.cpl!)}${gap !== null ? ` (${_fmtSignedPct(gap)})` : ''}.` });
        if (gap !== null && gap >= 25 && (b.spend / tSpend) < 0.5) {
          recommendations.push(`Lean into ${b.label} creative — it converts ${_fmtSignedPct(-((w.cpl! - b.cpl!) / w.cpl!) * 100)} cheaper than ${w.label} but only gets ${((b.spend / tSpend) * 100).toFixed(0)}% of tagged spend.`);
        }
      }
      if (tLeads > 0 && tSpend > 0) {
        const gaps = themes.map(r => ({ r, gap: (r.spend / tSpend - r.leads / tLeads) * 100 })).filter(x => x.r.leads >= 10 || x.r.spend / tSpend >= 0.1);
        const over = [...gaps].sort((a, b) => b.gap - a.gap)[0];
        if (over && over.gap >= 5) f.push({ tone: 'warn', text: `**${over.r.label}** takes ${((over.r.spend / tSpend) * 100).toFixed(0)}% of tagged spend but returns ${((over.r.leads / tLeads) * 100).toFixed(0)}% of tagged leads.` });
        const under = [...gaps].sort((a, b) => a.gap - b.gap)[0];
        if (under && under.gap <= -5) f.push({ tone: 'good', text: `**${under.r.label}** returns ${((under.r.leads / tLeads) * 100).toFixed(0)}% of tagged leads from only ${((under.r.spend / tSpend) * 100).toFixed(0)}% of tagged spend.` });
      }
      const ugc = tb.byUgc.find(r => r.key === 'ugc'), non = tb.byUgc.find(r => r.key === 'non-ugc');
      if (ugc && non && ugc.leads >= 10 && non.leads >= 10 && ugc.cpl !== null && non.cpl !== null) {
        const d = _pctChange(ugc.cpl, non.cpl);
        const uShare = (ugc.spend / (ugc.spend + non.spend)) * 100;
        f.push({ tone: d !== null && Math.abs(d) >= 10 ? (d < 0 ? 'good' : 'warn') : 'info', text: `UGC creative converts at **${fmtUsd(ugc.cpl)}** vs ${fmtUsd(non.cpl)} for non-UGC (${_fmtSignedPct(d)} per lead), with UGC at ${uShare.toFixed(0)}% of tagged spend.` });
        if (d !== null && d <= -20 && uShare < 70) recommendations.push(`Increase the UGC share of creative — it is ${_fmtSignedPct(-d)} cheaper per lead than non-UGC and only carries ${uShare.toFixed(0)}% of tagged spend.`);
        if (d !== null && d >= 20 && uShare > 50) recommendations.push(`Test more polished (non-UGC) creative — UGC is ${_fmtSignedPct(d)} more expensive per lead here while carrying ${uShare.toFixed(0)}% of tagged spend.`);
      }
    }
    sections.push({ key: 'themes', title: 'Creative themes (tagged DCO creatives only)', icon: 'palette', iconColor: 'text-amber-400', findings: f, empty: tb ? 'Not enough tagged creative data in this period to compare themes.' : 'Theme data is still loading or unavailable.' });
  }

  if (!recommendations.length) {
    recommendations.push(rows.length ? 'No red flags in this period. Keep the current allocation and re-check after another week of data.' : 'Load a period with delivery to get recommendations.');
  }

  const filtersOn: string[] = i.filtersOn;
  const basis = [
    `${fmt(rows.length)} ${rows.length === 1 ? noun[0] : noun[1]} from the ${Noun} table for ${rangeLabel} (${days} day${days > 1 ? 's' : ''})${filtersOn.length ? `, filtered by ${filtersOn.join(', ')}` : ''}.`,
    `Leads source: ${i.leadsSource === 'sheet' ? 'client KPI sheet' : i.leadsSource === 'ghl' ? 'GoHighLevel leads' : 'Meta lead actions'}. Daily figures come from the same series as the Analytics charts.`,
  ];
  if (i.showThemes) basis.push('Theme findings cover only DCO creatives with an admin-set Theme/UGC tag, so their totals are smaller than the KPI cards.');

  return { rangeLabel, days, tiles, sections, recommendations, basis };
}
