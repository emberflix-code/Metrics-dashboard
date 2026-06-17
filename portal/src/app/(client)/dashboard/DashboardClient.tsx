/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useEffect, useState } from 'react';
import Script from 'next/script';
import { signOut } from 'next-auth/react';
import { ChangePasswordButton } from '@/components/ChangePasswordButton';

declare const Chart: any;
declare const lucide: { createIcons: () => void };

interface Props {
  accountIds: string[]; // plain IDs without act_ prefix
  clientName: string;
  campaignFilter: string; // case-insensitive substring to filter campaign names
  showAccount: boolean;  // admin toggle: show ad account column
  platform?: 'meta' | 'google'; // data source — defaults to meta
  hasGoogleAds?: boolean;       // is the Google Ads view available for this client?
  metaUrl?: string;             // link target for "View Meta" switch (on /dashboard/google)
  googleUrl?: string;           // link target for "View Google Ads" switch (on /dashboard)
}

// ── Module-level mutable state (client-only, one instance per browser tab) ──
const _campaigns: any[] = [];
let _currentLevel = 'campaign';
const _selectedRows = new Set<string>();
let _sortCol: string | null = null;
let _sortDir = 'asc';
let _drilldownParentIds = new Set<string>();
let _drilldownParentLevel: string | null = null;
let _currentView = 'table';
let _trendData: any[] = [];
let _comparisonTrendData: any[] = [];
let _comparisonTotals: any = null;
let _comparisonRange: { since: string; until: string } | null = null;
let _comparisonPeriod = 'none';
let _searchMode = 'all';
const _searchChips: string[] = [];
let _isInitialized = false;
let _hasLoadedOnce = false;
let _showAccount = false;
let _platform: 'meta' | 'google' = 'meta';

const _charts: Record<string, any> = {};
const _chartSort = { spend: 'desc', results: 'desc', cplEff: 'asc' };

const CHART_DEFAULTS = {
  color: '#94a3b8',
  grid: 'rgba(148,163,184,0.08)',
  font: { family: 'Space Mono, monospace', size: 10 },
};

// ── Date Picker state ────────────────────────────────────────────────────────
// Today is excluded everywhere — both Meta and Google Ads data are treated as
// complete only after the day rolls over, so today-anchored ranges are blocked.
const DP_PRESETS = [
  { label: 'Yesterday', key: 'yesterday' },
  { label: 'Last 7 days', key: 'last_7d' },
  { label: 'Last 14 days', key: 'last_14d' },
  { label: 'Last 28 days', key: 'last_28d' },
  { label: 'Last 30 days', key: 'last_30d' },
  { label: 'This week', key: 'this_week' },
  { label: 'Last week', key: 'last_week' },
  { label: 'This month', key: 'this_month' },
  { label: 'Last month', key: 'last_month' },
  { label: 'Maximum', key: 'maximum' },
];
const DP_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DP_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

let _dpSince: string | null = null;
let _dpUntil: string | null = null;
let _dpSelecting = false;
let _dpHover: string | null = null;
let _dpLY = 0;
let _dpLM = 0;
let _dpActivePreset = 'last_30d';
let _dpRecentlyUsed: string[] = [];

// ── Helpers ──────────────────────────────────────────────────────────────────
function _dpFmt(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function _dpDisplay(s: string) {
  if (!s) return '';
  const [y,m,d] = s.split('-');
  return new Date(+y,+m-1,+d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
function _dpPresetRange(key: string): { since: string; until: string } | null {
  const t = new Date();
  // Yesterday-anchored end date: today is always excluded.
  const tEnd = new Date(t); tEnd.setDate(tEnd.getDate()-1);
  const sow = (d: Date) => { const c=new Date(d); c.setDate(c.getDate()-c.getDay()); return c; };
  switch(key){
    case 'yesterday': return {since:_dpFmt(tEnd),until:_dpFmt(tEnd)};
    case 'last_7d':  { const s=new Date(tEnd); s.setDate(s.getDate()-6);  return {since:_dpFmt(s),until:_dpFmt(tEnd)}; }
    case 'last_14d': { const s=new Date(tEnd); s.setDate(s.getDate()-13); return {since:_dpFmt(s),until:_dpFmt(tEnd)}; }
    case 'last_28d': { const s=new Date(tEnd); s.setDate(s.getDate()-27); return {since:_dpFmt(s),until:_dpFmt(tEnd)}; }
    case 'last_30d': { const s=new Date(tEnd); s.setDate(s.getDate()-29); return {since:_dpFmt(s),until:_dpFmt(tEnd)}; }
    // Clamp to start-of-range when 'today' would invert the range (e.g. Sunday for this_week, 1st for this_month).
    case 'this_week': { const s=sow(t); const u=tEnd<s?s:tEnd; return {since:_dpFmt(s),until:_dpFmt(u)}; }
    case 'last_week': { const sw=sow(t); sw.setDate(sw.getDate()-7); const ew=new Date(sw); ew.setDate(ew.getDate()+6); return {since:_dpFmt(sw),until:_dpFmt(ew)}; }
    case 'this_month': { const s=new Date(t.getFullYear(),t.getMonth(),1); const u=tEnd<s?s:tEnd; return {since:_dpFmt(s),until:_dpFmt(u)}; }
    case 'last_month': { const s=new Date(t.getFullYear(),t.getMonth()-1,1); const e=new Date(t.getFullYear(),t.getMonth(),0); return {since:_dpFmt(s),until:_dpFmt(e)}; }
    case 'maximum': { const s=new Date(t); s.setMonth(s.getMonth()-37); return {since:_dpFmt(s),until:_dpFmt(tEnd)}; }
    default: return null;
  }
}
function _dpRY() { return _dpLM===11 ? _dpLY+1 : _dpLY; }
function _dpRM() { return _dpLM===11 ? 0 : _dpLM+1; }

function fmt(n: number) { return n.toLocaleString('en-US'); }
function fmtUsd(n: number) { return '$' + n.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtPct(n: number) { return n.toFixed(2) + '%'; }
function shortName(name: string, max = 22) { return name.length > max ? name.slice(0, max-1) + '…' : name; }

function getDateRange(): { since: string; until: string } {
  if (_dpSince && _dpUntil) return { since: _dpSince, until: _dpUntil };
  const preset = localStorage.getItem('meta_date_preset') || 'last_30d';
  return _dpPresetRange(preset) || _dpPresetRange('last_30d')!;
}

function formatDateLabel(since: string, until: string) {
  if (!since || !until) return '';
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [sy,sm,sd] = since.split('-').map(Number);
  const [ey,em,ed] = until.split('-').map(Number);
  if (since === until) return `${M[sm-1]} ${sd}, ${sy}`;
  const s = `${M[sm-1]} ${sd}`;
  const e = `${M[em-1]} ${ed}`;
  return sy === ey ? `${s} – ${e}, ${ey}` : `${s}, ${sy} – ${e}, ${ey}`;
}

function getComparisonDateRange(since: string, until: string, mode: string) {
  const parse = (s: string) => { const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); };
  const fmt2 = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const s = parse(since), e = parse(until);
  const days = Math.round((e.getTime()-s.getTime())/86400000);
  let cs: Date, ce: Date;
  if (mode==='prev_period') { ce=new Date(s); ce.setDate(ce.getDate()-1); cs=new Date(ce); cs.setDate(cs.getDate()-days); }
  else if (mode==='DoD') { cs=new Date(s); cs.setDate(cs.getDate()-1); ce=new Date(e); ce.setDate(ce.getDate()-1); }
  else if (mode==='WoW') { cs=new Date(s); cs.setDate(cs.getDate()-7); ce=new Date(e); ce.setDate(ce.getDate()-7); }
  else if (mode==='MoM') {
    const sl=new Date(s.getFullYear(),s.getMonth(),0).getDate();
    cs=new Date(s.getFullYear(),s.getMonth()-1,Math.min(s.getDate(),sl));
    const el=new Date(e.getFullYear(),e.getMonth(),0).getDate();
    ce=new Date(e.getFullYear(),e.getMonth()-1,Math.min(e.getDate(),el));
  } else if (mode==='YoY') {
    const sl=new Date(s.getFullYear()-1,s.getMonth()+1,0).getDate();
    cs=new Date(s.getFullYear()-1,s.getMonth(),Math.min(s.getDate(),sl));
    const el=new Date(e.getFullYear()-1,e.getMonth()+1,0).getDate();
    ce=new Date(e.getFullYear()-1,e.getMonth(),Math.min(e.getDate(),el));
  } else return null;
  return { since:fmt2(cs!), until:fmt2(ce!) };
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function showNotification(msg: string, type: 'success'|'error') {
  const el = document.createElement('div');
  const bg = type==='success' ? 'bg-emerald-500' : 'bg-red-500';
  const icon = type==='success' ? 'check-circle' : 'alert-circle';
  el.className = `fixed top-4 right-4 ${bg} text-white px-4 py-3 rounded-lg flex items-center gap-2 text-sm font-semibold shadow-lg z-50`;
  el.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4"></i> ${msg}`;
  document.body.appendChild(el);
  lucide.createIcons();
  setTimeout(() => { el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, 3000);
}

function showLoadingBar() {
  document.getElementById('loading-bar')?.classList.add('active');
  // Centered overlay only on the very first load — subsequent refreshes
  // (date change, level switch) keep the thin top bar but don't blank the screen.
  if (!_hasLoadedOnce) document.getElementById('loading-overlay')?.classList.remove('hidden');
}
function hideLoadingBar() {
  const bar = document.getElementById('loading-bar');
  document.getElementById('loading-overlay')?.classList.add('hidden');
  _hasLoadedOnce = true;
  if (!bar) return;
  bar.classList.remove('active');
  bar.style.opacity='1';
  bar.style.background='linear-gradient(90deg,#3b82f6,#818cf8)';
  setTimeout(()=>{ bar.style.opacity='0'; bar.style.transition='opacity .3s'; setTimeout(()=>{ bar.style.background=''; bar.style.transition=''; bar.style.opacity=''; },300); },120);
}

function showTableSkeleton() {
  const body = document.getElementById('table-body');
  const foot = document.getElementById('table-foot');
  if (foot) foot.innerHTML='';
  const widths=['w-4','w-40','w-16','w-14','w-16','w-12','w-12','w-16','w-10','w-14','w-10'];
  if (body) body.innerHTML=Array.from({length:8},()=>`<tr class="border-b border-slate-800/50">${Array.from({length:11},(_,i)=>`<td class="px-3 py-3.5"><div class="skeleton h-3.5 mx-auto ${widths[i]||'w-12'}"></div></td>`).join('')}</tr>`).join('');
}

function destroyChart(id: string) {
  if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
}

// ── Delivery badge ────────────────────────────────────────────────────────────
const DELIVERY_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  ACTIVE:      { dot:'bg-emerald-400', text:'text-emerald-400', label:'Active' },
  PAUSED:      { dot:'bg-slate-400',   text:'text-slate-400',   label:'Paused' },
  IN_PROCESS:  { dot:'bg-blue-400 animate-pulse', text:'text-blue-400', label:'In Process' },
  WITH_ISSUES: { dot:'bg-amber-400',   text:'text-amber-400',   label:'With Issues' },
  ARCHIVED:    { dot:'bg-slate-600',   text:'text-slate-500',   label:'Archived' },
};
function deliveryBadge(status: string) {
  const s = DELIVERY_STYLES[status] || { dot:'bg-slate-500', text:'text-slate-400', label:status||'—' };
  return `<span class="inline-flex items-center gap-1.5 ${s.text} text-xs font-medium whitespace-nowrap"><span class="w-2 h-2 rounded-full ${s.dot} flex-shrink-0"></span>${s.label}</span>`;
}

function calcMetrics(c: any) {
  const cpm = c.impressions>0 ? (c.spent/c.impressions)*1000 : 0;
  const ctr = c.impressions>0 ? (c.linkClicks/c.impressions)*100 : 0;
  const cpc = c.linkClicks>0 ? c.spent/c.linkClicks : 0;
  const cpl = c.results>0 ? c.spent/c.results : 0;
  return {...c, cpm, ctr, cpc, cpl};
}

// ── Search ────────────────────────────────────────────────────────────────────
function _matchesSearch(name: string) {
  const input = (document.getElementById('search-input') as HTMLInputElement)?.value?.toLowerCase()?.trim() || '';
  const allTokens = [..._searchChips, ...(input ? [input] : [])];
  if (!allTokens.length) return true;
  const n = name.toLowerCase();
  if (_searchMode==='all')  return allTokens.every(t=>n.includes(t));
  if (_searchMode==='any')  return allTokens.some(t=>n.includes(t));
  if (_searchMode==='none') return !allTokens.some(t=>n.includes(t));
  return true;
}

function getFiltered() {
  const acct = (document.getElementById('ad-account') as HTMLSelectElement)?.value || 'all';
  const delivery = (document.getElementById('delivery-filter') as HTMLSelectElement)?.value || 'all';
  return _campaigns.filter(c => {
    if (acct !== 'all' && c.account !== acct) return false;
    if (!_matchesSearch(c.name)) return false;
    if (delivery !== 'all' && c.status !== delivery) return false;
    if (_drilldownParentIds.size > 0) {
      if (_currentLevel==='adset' && !_drilldownParentIds.has(c.campaignId)) return false;
      if (_currentLevel==='ad'    && !_drilldownParentIds.has(c.adsetId))   return false;
    }
    return true;
  });
}

function getSelectedTotals(data: any[]) {
  const src = _selectedRows.size>0 ? data.filter(c=>_selectedRows.has(c.id||c.name)) : data;
  return src.reduce((a,c)=>({
    reach:a.reach+c.reach, impressions:a.impressions+c.impressions,
    results:a.results+c.results, spent:a.spent+c.spent, linkClicks:a.linkClicks+c.linkClicks
  }),{reach:0,impressions:0,results:0,spent:0,linkClicks:0});
}

// ── renderCards ───────────────────────────────────────────────────────────────
function renderCards(t: any, selCount=0) {
  const ctr  = t.impressions>0 ? (t.linkClicks/t.impressions)*100 : 0;
  const cpl  = t.results>0     ? t.spent/t.results : 0;
  let compCtr=0, compCpl=0;
  if (_comparisonTotals) {
    compCtr = _comparisonTotals.impressions>0 ? (_comparisonTotals.linkClicks/_comparisonTotals.impressions)*100 : 0;
    compCpl = _comparisonTotals.results>0 ? _comparisonTotals.spent/_comparisonTotals.results : 0;
  }
  function makeDelta(curr: number, comp: number|undefined, lowerIsBetter=false) {
    if (!_comparisonTotals||!comp) return '';
    const pct=((curr-comp)/Math.abs(comp))*100;
    if (Math.abs(pct)<0.05) return '<span class="delta-neutral font-mono">—</span>';
    const up=pct>0; const good=lowerIsBetter?!up:up;
    const cls=good?(up?'delta-up-good':'delta-down-good'):(up?'delta-up-bad':'delta-down-bad');
    return `<span class="${cls} font-mono">${up?'↑':'↓'}${Math.abs(pct).toFixed(1)}%</span>`;
  }
  const cards=[
    {label:'Link Clicks', value:fmt(t.linkClicks),  icon:'mouse-pointer-click', color:'blue',    delta:makeDelta(t.linkClicks,_comparisonTotals?.linkClicks)},
    {label:'Impressions', value:fmt(t.impressions), icon:'eye',                 color:'indigo',  delta:makeDelta(t.impressions,_comparisonTotals?.impressions)},
    {label:'Amount Spent',value:fmtUsd(t.spent),   icon:'dollar-sign',          color:'emerald', delta:makeDelta(t.spent,_comparisonTotals?.spent)},
    {label:'Results',     value:fmt(t.results),     icon:'target',              color:'amber',   delta:makeDelta(t.results,_comparisonTotals?.results)},
    {label:'CTR',         value:fmtPct(ctr),        icon:'mouse-pointer-click', color:'rose',    delta:makeDelta(ctr,compCtr)},
    {label:'CPL',         value:fmtUsd(cpl),        icon:'receipt',             color:'violet',  delta:makeDelta(cpl,compCpl,true)},
  ];
  const colors: Record<string,string> = {blue:'from-blue-500/20 to-blue-500/5 border-blue-500/20',indigo:'from-indigo-500/20 to-indigo-500/5 border-indigo-500/20',emerald:'from-emerald-500/20 to-emerald-500/5 border-emerald-500/20',amber:'from-amber-500/20 to-amber-500/5 border-amber-500/20',rose:'from-rose-500/20 to-rose-500/5 border-rose-500/20',violet:'from-violet-500/20 to-violet-500/5 border-violet-500/20'};
  const iconColors: Record<string,string> = {blue:'text-blue-400',indigo:'text-indigo-400',emerald:'text-emerald-400',amber:'text-amber-400',rose:'text-rose-400',violet:'text-violet-400'};
  const selBadge = selCount>0 ? `<span class="text-[10px] text-blue-400 font-normal normal-case">${selCount} selected</span>` : '';
  const grid = document.getElementById('cards-grid');
  if (grid) grid.innerHTML = cards.map((c,i)=>`
    <div class="bg-gradient-to-br ${colors[c.color]} border rounded-xl px-4 py-3 fade-up fade-up-${i+1}">
      <div class="flex items-center justify-between mb-2">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">${c.label}${i===0?selBadge:''}</span>
        <i data-lucide="${c.icon}" class="w-4 h-4 ${iconColors[c.color]}"></i>
      </div>
      <div class="text-xl font-bold text-white font-mono">${c.value}</div>
      ${c.delta?`<div class="mt-1 h-4">${c.delta}</div>`:'<div class="mt-1 h-4"></div>'}
    </div>`).join('');
  lucide.createIcons();
  const summary = document.getElementById('selection-summary');
  if (summary) { if (selCount>0){summary.textContent=`${selCount} row${selCount>1?'s':''} selected`;summary.classList.remove('hidden');}else summary.classList.add('hidden'); }
}

// ── renderTable ───────────────────────────────────────────────────────────────
function renderTable() {
  const rawData = getFiltered().map(calcMetrics);
  if (_sortCol) rawData.sort((a,b)=>{const va=a[_sortCol!],vb=b[_sortCol!]; const cmp=typeof va==='string'?va.localeCompare(vb):(va-vb); return _sortDir==='asc'?cmp:-cmp;});
  const data = rawData;
  const tbody = document.getElementById('table-body');
  const tfoot = document.getElementById('table-foot');
  const noRes = document.getElementById('no-results');
  if (!tbody||!tfoot||!noRes) return;

  // Drilldown banner
  const banner = document.getElementById('drilldown-banner');
  if (banner) {
    if (_drilldownParentIds.size>0&&_drilldownParentLevel) {
      const pl={campaign:'campaign',adset:'ad set'}[_drilldownParentLevel]||_drilldownParentLevel;
      banner.innerHTML=`<i data-lucide="filter" class="w-3.5 h-3.5 flex-shrink-0"></i><span>Showing ${_currentLevel==='adset'?'ad sets':'ads'} for <strong>${_drilldownParentIds.size} selected ${pl}${_drilldownParentIds.size>1?'s':''}</strong></span><button onclick="window._clearDrilldown()" class="ml-2 text-blue-400 hover:text-white underline">Clear filter</button>`;
      banner.classList.remove('hidden'); banner.classList.add('flex'); lucide.createIcons();
    } else { banner.classList.add('hidden'); banner.classList.remove('flex'); }
  }

  // Header
  const ll={campaign:'Campaign',adset:'Ad Set',ad:'Ad'};
  const arrow=(col: string)=>_sortCol===col?(_sortDir==='asc'?' ▲':' ▼'):' ⇅';
  const thB='text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap sort-th';
  const headRow = document.getElementById('table-head-row');
  if (headRow) headRow.innerHTML=`
    <th class="w-8 px-3 py-3 sticky left-0 bg-slate-900/90 backdrop-blur-sm"><input type="checkbox" id="select-all" onchange="window._handleSelectAll(this.checked)" class="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 accent-blue-500 cursor-pointer"></th>
    <th class="text-left px-4 py-3 sticky left-8 bg-slate-900/90 backdrop-blur-sm min-w-[200px] ${thB}" onclick="window._setSortCol('name')">${(ll as any)[_currentLevel]||'Campaign'}${arrow('name')}</th>
    ${_showAccount ? `<th class="text-left px-4 py-3 ${thB}">Ad Account</th>` : ''}
    <th class="text-left px-4 py-3 ${thB}" onclick="window._setSortCol('status')">Delivery${arrow('status')}</th>
    <th class="text-right px-4 py-3 ${thB}" onclick="window._setSortCol('reach')">Reach${arrow('reach')}</th>
    <th class="text-right px-4 py-3 ${thB}" onclick="window._setSortCol('impressions')">Impressions${arrow('impressions')}</th>
    <th class="text-right px-4 py-3 ${thB}" onclick="window._setSortCol('cpm')">CPM${arrow('cpm')}</th>
    <th class="text-right px-4 py-3 ${thB}" onclick="window._setSortCol('results')">Results${arrow('results')}</th>
    <th class="text-right px-4 py-3 ${thB}" onclick="window._setSortCol('spent')">Spent (USD)${arrow('spent')}</th>
    <th class="text-right px-4 py-3 ${thB}" onclick="window._setSortCol('ctr')">CTR${arrow('ctr')}</th>
    <th class="text-right px-4 py-3 ${thB}" onclick="window._setSortCol('linkClicks')">Link Clicks${arrow('linkClicks')}</th>
    <th class="text-right px-4 py-3 ${thB}" onclick="window._setSortCol('cpc')">CPC${arrow('cpc')}</th>
    <th class="text-right px-4 py-3 ${thB}" onclick="window._setSortCol('cpl')">CPL${arrow('cpl')}</th>`;

  if (data.length===0) { tbody.innerHTML=''; tfoot.innerHTML=''; noRes.classList.remove('hidden'); renderCards({reach:0,impressions:0,spent:0,linkClicks:0,results:0}); return; }
  noRes.classList.add('hidden');

  const totals = data.reduce((a:any,c:any)=>({reach:a.reach+c.reach,impressions:a.impressions+c.impressions,results:a.results+c.results,spent:a.spent+c.spent,linkClicks:a.linkClicks+c.linkClicks}),{reach:0,impressions:0,results:0,spent:0,linkClicks:0});
  const tCpm=totals.impressions>0?(totals.spent/totals.impressions)*1000:0;
  const tCtr=totals.impressions>0?(totals.linkClicks/totals.impressions)*100:0;
  const tCpc=totals.linkClicks>0?totals.spent/totals.linkClicks:0;
  const tCpl=totals.results>0?totals.spent/totals.results:0;
  const lu={campaign:'campaign',adset:'ad set',ad:'ad'};

  tbody.innerHTML = data.map((c:any,i:number)=>{
    const rowKey=c.id||c.name; const checked=_selectedRows.has(rowKey);
    const subLabel = _currentLevel==='ad'?`<div class="text-[10px] text-slate-500 mt-0.5 truncate max-w-xs">${c.campaignName||''} › ${c.adsetName||''}</div>`:_currentLevel==='adset'?`<div class="text-[10px] text-slate-500 mt-0.5 truncate max-w-xs">${c.campaignName||''}</div>`:'';
    return `<tr class="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors fade-up ${checked?'bg-blue-500/5':''}" style="animation-delay:${i*30}ms">
      <td class="w-8 px-3 py-3 sticky left-0 bg-inherit"><input type="checkbox" data-key="${rowKey}" onchange="window._handleCheckbox('${rowKey}')" ${checked?'checked':''} class="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 accent-blue-500 cursor-pointer"></td>
      <td class="px-4 py-3 sticky left-8 bg-inherit"><div class="font-medium text-white leading-tight">${c.name}</div>${subLabel}</td>
      ${_showAccount ? `<td class="px-4 py-3 text-xs text-slate-400 font-mono">${c.account||''}</td>` : ''}
      <td class="px-4 py-3">${deliveryBadge(c.status)}</td>
      <td class="text-right px-4 py-3 font-mono text-xs">${fmt(c.reach)}</td>
      <td class="text-right px-4 py-3 font-mono text-xs">${fmt(c.impressions)}</td>
      <td class="text-right px-4 py-3 font-mono text-xs">${fmtUsd(c.cpm)}</td>
      <td class="text-right px-4 py-3 font-mono text-xs">${fmt(c.results)}</td>
      <td class="text-right px-4 py-3 font-mono text-xs text-emerald-400">${fmtUsd(c.spent)}</td>
      <td class="text-right px-4 py-3 font-mono text-xs">${fmtPct(c.ctr)}</td>
      <td class="text-right px-4 py-3 font-mono text-xs">${fmt(c.linkClicks)}</td>
      <td class="text-right px-4 py-3 font-mono text-xs">${fmtUsd(c.cpc)}</td>
      <td class="text-right px-4 py-3 font-mono text-xs">${fmtUsd(c.cpl)}</td>
    </tr>`;
  }).join('');

  const selectAll = document.getElementById('select-all') as HTMLInputElement;
  if (selectAll) selectAll.checked = data.length>0 && data.every((c:any)=>_selectedRows.has(c.id||c.name));

  tfoot.innerHTML=`<tr class="bg-slate-800/40 border-t-2 border-blue-500/30 font-semibold">
    <td class="px-3 py-3 sticky left-0 bg-slate-900/90"></td>
    <td class="px-4 py-3 sticky left-8 bg-slate-900/90 backdrop-blur-sm text-blue-400 text-xs uppercase tracking-wider">Subtotal (${data.length} ${(lu as any)[_currentLevel]||'campaign'}s)</td>
    ${_showAccount ? '<td class="px-4 py-3"></td>' : ''}
    <td class="px-4 py-3"></td>
    <td class="text-right px-4 py-3 font-mono text-xs text-white">${fmt(totals.reach)}</td>
    <td class="text-right px-4 py-3 font-mono text-xs text-white">${fmt(totals.impressions)}</td>
    <td class="text-right px-4 py-3 font-mono text-xs text-white">${fmtUsd(tCpm)}</td>
    <td class="text-right px-4 py-3 font-mono text-xs text-white">${fmt(totals.results)}</td>
    <td class="text-right px-4 py-3 font-mono text-xs text-emerald-400">${fmtUsd(totals.spent)}</td>
    <td class="text-right px-4 py-3 font-mono text-xs text-white">${fmtPct(tCtr)}</td>
    <td class="text-right px-4 py-3 font-mono text-xs text-white">${fmt(totals.linkClicks)}</td>
    <td class="text-right px-4 py-3 font-mono text-xs text-white">${fmtUsd(tCpc)}</td>
    <td class="text-right px-4 py-3 font-mono text-xs text-white">${fmtUsd(tCpl)}</td>
  </tr>`;

  renderCards(getSelectedTotals(data), _selectedRows.size);
  if (_currentView==='analytics') renderAnalytics();
  lucide.createIcons();
}

// ── renderAnalytics ───────────────────────────────────────────────────────────
function renderAnalytics() {
  const data = getFiltered().map(calcMetrics);
  const CD = CHART_DEFAULTS;
  function toggle(wrapId: string, emptyId: string, show: boolean) {
    document.getElementById(wrapId)?.classList.toggle('hidden', !show);
    document.getElementById(emptyId)?.classList.toggle('hidden', show);
  }

  const {since} = getDateRange();
  const _compByDate: Record<string, any> = {};
  for (const c of _comparisonTrendData) _compByDate[c.date] = c;
  const _addDays = (dateStr: string, n: number) => { const d=new Date(dateStr+'T00:00:00'); d.setDate(d.getDate()+n); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  const compTrendAligned = _trendData.map(d => {
    if (!_comparisonRange) return null;
    const offset = Math.round((new Date(d.date+'T00:00:00').getTime()-new Date(since+'T00:00:00').getTime())/86400000);
    return _compByDate[_addDays(_comparisonRange.since, offset)] || null;
  });
  const _fmtDay = (s: string) => { if(!s)return''; const [,m,d]=s.split('-'); const ms=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return `${ms[+m-1]} ${+d}`; };

  // 1. Daily Spend & Results
  destroyChart('trend');
  const hasTrend = _trendData.length>=2;
  toggle('chart-trend-wrap','chart-trend-empty',hasTrend);
  if (hasTrend) {
    const hasComp = compTrendAligned.some(c=>c!==null);
    const rangeStr = formatDateLabel(_trendData[0].date,_trendData[_trendData.length-1].date);
    const compStr = (hasComp&&_comparisonRange)?` vs ${formatDateLabel(_comparisonRange.since,_comparisonRange.until)}`:'';
    const el = document.getElementById('chart-trend-range'); if (el) el.textContent=rangeStr+compStr;
    const ds: any[] = [
      {label:'Spend ($)',data:_trendData.map(d=>d.spend),borderColor:'#34d399',backgroundColor:'rgba(52,211,153,0.10)',yAxisID:'ySpend',tension:0.35,pointRadius:3,fill:true},
      {label:'Results',data:_trendData.map(d=>d.results),borderColor:'#f59e0b',backgroundColor:'rgba(245,158,11,0.10)',yAxisID:'yResults',tension:0.35,pointRadius:3,fill:true},
    ];
    if (hasComp) {
      ds.push({label:'Spend (prev)',data:compTrendAligned.map(c=>c?.spend??null),borderColor:'rgba(52,211,153,0.35)',backgroundColor:'transparent',yAxisID:'ySpend',tension:0.35,pointRadius:2,fill:false,borderDash:[5,4],spanGaps:true});
      ds.push({label:'Results (prev)',data:compTrendAligned.map(c=>c?.results??null),borderColor:'rgba(245,158,11,0.35)',backgroundColor:'transparent',yAxisID:'yResults',tension:0.35,pointRadius:2,fill:false,borderDash:[5,4],spanGaps:true});
    }
    _charts.trend = new Chart((document.getElementById('chart-trend') as HTMLCanvasElement)?.getContext('2d'),{type:'line',data:{labels:_trendData.map(d=>d.date.slice(5)),datasets:ds},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{labels:{color:CD.color,font:CD.font,boxWidth:10}},tooltip:{callbacks:{title:(items:any[])=>{const idx=items[0].dataIndex;const main=_trendData[idx]?.date;const comp=compTrendAligned[idx]?.date;return main?(_fmtDay(main)+(comp?'  ·  prev: '+_fmtDay(comp):'')):items[0].label;}}}},scales:{x:{ticks:{color:(ctx: any)=>{const d=_trendData[ctx.index]?.date;if(!d)return CD.color;const wd=new Date(d+'T12:00:00').getDay();return(wd===0||wd===6)?'#f87171':CD.color;},font:CD.font},grid:{color:(ctx: any)=>{const d=_trendData[ctx.index]?.date;if(!d)return CD.grid;const wd=new Date(d+'T12:00:00').getDay();return(wd===0||wd===6)?'rgba(248,113,113,0.18)':CD.grid;}}},ySpend:{position:'left',title:{display:true,text:'Daily Spend',color:'#34d399',font:{size:10}},ticks:{color:'#34d399',font:CD.font,callback:(v:number)=>'$'+v.toLocaleString()},grid:{color:CD.grid}},yResults:{position:'right',title:{display:true,text:'Daily Results',color:'#f59e0b',font:{size:10}},ticks:{color:'#f59e0b',font:CD.font},grid:{drawOnChartArea:false}}}}});
  }

  // 2. Daily CPL Trend
  destroyChart('cplTrend');
  const cplDays = _trendData.map(d=>({date:d.date,cpl:d.results>0?parseFloat((d.spend/d.results).toFixed(2)):null}));
  const hasCplTrend = cplDays.some(d=>d.cpl!==null)&&cplDays.length>=2;
  toggle('chart-cpl-trend-wrap','chart-cpl-trend-empty',hasCplTrend);
  if (hasCplTrend) {
    const compCpl = compTrendAligned.map(c=>(!c||c.results===0)?null:parseFloat((c.spend/c.results).toFixed(2)));
    const hasCompCpl = compCpl.some(v=>v!==null);
    const re = document.getElementById('chart-cpl-trend-range'); if (re) re.textContent=formatDateLabel(_trendData[0].date,_trendData[_trendData.length-1].date);
    const ds: any[] = [{label:'CPL ($)',data:cplDays.map(d=>d.cpl),borderColor:'#a78bfa',backgroundColor:'rgba(167,139,250,0.10)',tension:0.35,pointRadius:3,fill:true,spanGaps:true}];
    if (hasCompCpl) ds.push({label:'CPL (prev)',data:compCpl,borderColor:'rgba(167,139,250,0.35)',backgroundColor:'transparent',tension:0.35,pointRadius:2,fill:false,borderDash:[5,4],spanGaps:true});
    _charts.cplTrend = new Chart((document.getElementById('chart-cpl-trend') as HTMLCanvasElement)?.getContext('2d'),{type:'line',data:{labels:_trendData.map(d=>d.date.slice(5)),datasets:ds},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{labels:{color:CD.color,font:CD.font,boxWidth:10}},tooltip:{callbacks:{title:(items:any[])=>{const idx=items[0].dataIndex;const main=_trendData[idx]?.date;const comp=compTrendAligned[idx]?.date;return main?(_fmtDay(main)+(comp?'  ·  prev: '+_fmtDay(comp):'')):items[0].label;}}}},scales:{x:{ticks:{color:(ctx: any)=>{const d=_trendData[ctx.index]?.date;if(!d)return CD.color;const wd=new Date(d+'T12:00:00').getDay();return(wd===0||wd===6)?'#f87171':CD.color;},font:CD.font},grid:{color:(ctx: any)=>{const d=_trendData[ctx.index]?.date;if(!d)return CD.grid;const wd=new Date(d+'T12:00:00').getDay();return(wd===0||wd===6)?'rgba(248,113,113,0.18)':CD.grid;}}},y:{ticks:{color:'#a78bfa',font:CD.font,callback:(v:number)=>'$'+v.toFixed(2)},grid:{color:CD.grid}}}}});
  }

  // 3. Top 8 by Spend
  destroyChart('spend');
  const spendSorted=[...data].sort((a,b)=>_chartSort.spend==='desc'?b.spent-a.spent:a.spent-b.spent).slice(0,8);
  toggle('chart-spend-wrap','chart-spend-empty',spendSorted.length>0);
  if (spendSorted.length) _charts.spend=new Chart((document.getElementById('chart-spend') as HTMLCanvasElement)?.getContext('2d'),{type:'bar',data:{labels:spendSorted.map((c:any)=>shortName(c.name)),datasets:[{label:'Spend ($)',data:spendSorted.map((c:any)=>c.spent),backgroundColor:'rgba(52,211,153,0.7)',borderRadius:4}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:CD.color,font:CD.font,callback:(v:number)=>'$'+v.toLocaleString()},grid:{color:CD.grid}},y:{ticks:{color:CD.color,font:CD.font},grid:{color:CD.grid}}}}});

  // 4. Top 8 by Results
  destroyChart('results');
  const resultsSorted=[...data].sort((a,b)=>_chartSort.results==='desc'?b.results-a.results:a.results-b.results).slice(0,8);
  toggle('chart-results-wrap','chart-results-empty',resultsSorted.length>0);
  if (resultsSorted.length) _charts.results=new Chart((document.getElementById('chart-results') as HTMLCanvasElement)?.getContext('2d'),{type:'bar',data:{labels:resultsSorted.map((c:any)=>shortName(c.name)),datasets:[{label:'Results',data:resultsSorted.map((c:any)=>c.results),backgroundColor:'rgba(245,158,11,0.7)',borderRadius:4}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:CD.color,font:CD.font},grid:{color:CD.grid}},y:{ticks:{color:CD.color,font:CD.font},grid:{color:CD.grid}}}}});

  // 5. CPL by Campaign
  destroyChart('cpl');
  const withLeads=[...data].filter((c:any)=>c.results>0&&c.cpl>0).sort((a,b)=>_chartSort.cplEff==='asc'?a.cpl-b.cpl:b.cpl-a.cpl).slice(0,8);
  toggle('chart-cpl-wrap','chart-cpl-empty',withLeads.length>0);
  if (withLeads.length) _charts.cpl=new Chart((document.getElementById('chart-cpl') as HTMLCanvasElement)?.getContext('2d'),{type:'bar',data:{labels:withLeads.map((c:any)=>shortName(c.name)),datasets:[{label:'CPL ($)',data:withLeads.map((c:any)=>parseFloat(c.cpl.toFixed(2))),backgroundColor:withLeads.map((_:any,i:number)=>`rgba(167,139,250,${_chartSort.cplEff==='asc'?0.9-i*0.09:0.3+i*0.09})`),borderRadius:4}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:CD.color,font:CD.font,callback:(v:number)=>'$'+v.toFixed(2)},grid:{color:CD.grid}},y:{ticks:{color:CD.color,font:CD.font},grid:{color:CD.grid}}}}});

  // 6. Bubble scatter
  destroyChart('scatter');
  const scatterData=data.filter((c:any)=>c.results>0&&c.cpl>0);
  toggle('chart-scatter-wrap','chart-scatter-empty',scatterData.length>0);
  if (scatterData.length) { const mx=Math.max(...scatterData.map((c:any)=>c.spent)); _charts.scatter=new Chart((document.getElementById('chart-scatter') as HTMLCanvasElement)?.getContext('2d'),{type:'bubble',data:{datasets:[{label:'Campaigns',data:scatterData.map((c:any)=>({x:c.results,y:parseFloat(c.cpl.toFixed(2)),r:Math.max(4,Math.round((c.spent/mx)*20)),name:c.name})),backgroundColor:'rgba(167,139,250,0.55)',borderColor:'rgba(167,139,250,0.9)',borderWidth:1}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:(ctx:any)=>{const p=ctx.raw;return[`${shortName(p.name,30)}`,`Results: ${p.x}`,`CPL: $${p.y.toFixed(2)}`];}}}},scales:{x:{title:{display:true,text:'Results',color:CD.color,font:CD.font},ticks:{color:CD.color,font:CD.font},grid:{color:CD.grid}},y:{title:{display:true,text:'CPL ($)',color:CD.color,font:CD.font},ticks:{color:CD.color,font:CD.font,callback:(v:number)=>'$'+v.toFixed(2)},grid:{color:CD.grid}}}}}); }

  // 7. Delivery mix
  destroyChart('delivery');
  const dc: Record<string,number>={};
  data.forEach((c:any)=>{dc[c.status]=(dc[c.status]||0)+1;});
  const dKeys=Object.keys(dc);
  const DC={ACTIVE:'#34d399',PAUSED:'#94a3b8',IN_PROCESS:'#60a5fa',WITH_ISSUES:'#fbbf24',ARCHIVED:'#475569',UNKNOWN:'#334155'};
  toggle('chart-delivery-wrap','chart-delivery-empty',dKeys.length>0);
  if (dKeys.length) _charts.delivery=new Chart((document.getElementById('chart-delivery') as HTMLCanvasElement)?.getContext('2d'),{type:'doughnut',data:{labels:dKeys.map(k=>k.charAt(0)+k.slice(1).toLowerCase().replace(/_/g,' ')),datasets:[{data:dKeys.map(k=>dc[k]),backgroundColor:dKeys.map(k=>(DC as any)[k]||'#475569'),borderColor:'#0f172a',borderWidth:3,hoverOffset:6}]},options:{responsive:true,maintainAspectRatio:false,cutout:'68%',plugins:{legend:{position:'right',labels:{color:CD.color,font:CD.font,boxWidth:10,padding:12}}}}});

  lucide.createIcons();
}

// ── fetchMetaCampaigns ────────────────────────────────────────────────────────
async function fetchMetaCampaigns() {
  showLoadingBar();
  showTableSkeleton();
  const cards = document.getElementById('cards-grid');
  if (cards) { cards.style.opacity='0.4'; cards.style.transition='opacity 0.2s'; }

  try {
    const selectedAccount = (document.getElementById('ad-account') as HTMLSelectElement)?.value || 'all';
    const {since,until} = getDateRange();
    const timeRange = JSON.stringify({since,until});

    if (_platform === 'google') {
      await loadGoogleSheetData(since, until);
      return;
    }

    const select = document.getElementById('ad-account') as HTMLSelectElement;
    const accountIds = selectedAccount==='all'
      ? Array.from(select.options).filter(o=>o.value!=='all').map(o=>o.value.replace(/^act_/i,''))
      : [selectedAccount.replace(/^act_/i,'')];

    const levelConfig: Record<string,any> = {
      campaign:{endpoint:'campaigns',idField:'campaign_id',nameField:'campaign_name',insightFields:'campaign_id,campaign_name,reach,impressions,spend,inline_link_clicks,actions'},
      adset:   {endpoint:'adsets',   idField:'adset_id',   nameField:'adset_name',   insightFields:'adset_id,adset_name,campaign_name,reach,impressions,spend,inline_link_clicks,actions'},
      ad:      {endpoint:'ads',      idField:'ad_id',      nameField:'ad_name',       insightFields:'ad_id,ad_name,adset_name,campaign_name,reach,impressions,spend,inline_link_clicks,actions'},
    };
    const lvl = levelConfig[_currentLevel];
    let allMapped: any[] = [];

    const fetchOneAccount = async (accountId: string): Promise<any[]> => {
      const statusRes = await fetch(`/api/meta/${lvl.endpoint}?account_id=${encodeURIComponent(accountId)}`);
      const statusJson = await statusRes.json();
      if (statusJson.error) { const e=statusJson.error; throw new Error([e.message,e.type&&`(${e.type})`,e.code&&`Code ${e.code}`].filter(Boolean).join(' ')); }
      const statusMap: Record<string,string>={};
      for (const c of (statusJson.data||[])) statusMap[c.id]=c.effective_status;

      const rows: any[] = [];
      let url: string|null = `/api/meta/insights?account_id=${encodeURIComponent(accountId)}&fields=${encodeURIComponent(lvl.insightFields)}&level=${_currentLevel}&time_range=${encodeURIComponent(timeRange)}&limit=100&action_attribution_windows=${encodeURIComponent('["7d_click","1d_view","1d_ev"]')}`;
      let isFirstPage = true;
      while (url) {
        const fetchUrl: string = isFirstPage ? url : `/api/meta/next-page?url=${encodeURIComponent(url)}`;
        const response = await fetch(fetchUrl);
        const json = await response.json();
        if (json.error) { const e=json.error; throw new Error([e.message,e.type&&`(${e.type})`,e.code&&`Code ${e.code}`].filter(Boolean).join(' ')||'Meta API error'); }
        const mapped = (json.data||[]).map((item: any)=>{
          const am: Record<string,number>={};
          for (const a of (item.actions||[])) am[a.action_type]=parseInt(a.value||0);
          const pL=am['offsite_conversion.fb_pixel_lead']||0;
          const fL=am['onsite_conversion.lead_grouped']||0;
          const results=pL>0?pL:fL>0?fL:(am['lead']||0);
          const entityId=item[lvl.idField];
          return {id:entityId,name:item[lvl.nameField]||item.campaign_name,campaignId:item.campaign_id||'',adsetId:item.adset_id||'',campaignName:item.campaign_name||'',adsetName:item.adset_name||'',adName:item.ad_name||'',account:`act_${accountId}`,status:statusMap[entityId]||'UNKNOWN',reach:parseInt(item.reach||0),impressions:parseInt(item.impressions||0),spent:Math.round(parseFloat(item.spend||0)*100)/100,linkClicks:parseInt(item.inline_link_clicks||0),results};
        });
        rows.push(...mapped);
        url = (json.paging&&json.paging.next)||null;
        isFirstPage = false;
      }
      return rows;
    }

    const results = await Promise.all(accountIds.map(fetchOneAccount));
    allMapped = results.flat();

    if (allMapped.length===0) { _campaigns.splice(0,_campaigns.length); renderTable(); showNotification('No campaign data found for this date range','success'); return; }
    _campaigns.splice(0,_campaigns.length,...allMapped);

    localStorage.setItem('meta_delivery',(document.getElementById('delivery-filter') as HTMLSelectElement)?.value||'all');
    localStorage.setItem('meta_level',_currentLevel);

    // Trend data
    const _trendDelivery = (document.getElementById('delivery-filter') as HTMLSelectElement)?.value||'all';
    const _filteredForTrend = allMapped.filter(c=>{ if(!_matchesSearch(c.name))return false; if(_trendDelivery!=='all'&&c.status!==_trendDelivery)return false; return true; });
    const filteredCampaignIds = new Set(_filteredForTrend.map(c=>_currentLevel==='campaign'?c.id:c.campaignId).filter(Boolean));

    _trendData = [];
    try {
      if (since!==until) {
        const trendAcc = accountIds[0];
        let tUrl: string|null = `/api/meta/insights?account_id=${encodeURIComponent(trendAcc)}&fields=${encodeURIComponent('campaign_id,spend,actions')}&level=campaign&time_range=${encodeURIComponent(JSON.stringify({since,until}))}&time_increment=1&limit=500&action_attribution_windows=${encodeURIComponent('["7d_click","1d_view","1d_ev"]')}`;
        const byDate: Record<string,any>={};
        let tFirst=true;
        while (tUrl) {
          const tFetch: string=tFirst?tUrl:`/api/meta/next-page?url=${encodeURIComponent(tUrl)}`; tFirst=false;
          const tRes=await fetch(tFetch); const tJson=await tRes.json();
          if (tJson.error||!tJson.data) break;
          for (const d of tJson.data) {
            if (filteredCampaignIds.size>0&&!filteredCampaignIds.has(d.campaign_id)) continue;
            const am: Record<string,number>={};
            for (const a of (d.actions||[])) am[a.action_type]=parseInt(a.value||0);
            const pL=am['offsite_conversion.fb_pixel_lead']||0; const fL=am['onsite_conversion.lead_grouped']||0;
            const results=pL>0?pL:fL>0?fL:(am['lead']||0);
            const spend=Math.round(parseFloat(d.spend||0)*100)/100;
            const dt=d.date_start;
            if (!byDate[dt]) byDate[dt]={date:dt,spend:0,results:0};
            byDate[dt].spend=Math.round((byDate[dt].spend+spend)*100)/100;
            byDate[dt].results+=results;
          }
          tUrl=tJson.paging?.next||null;
        }
        _trendData=Object.values(byDate).sort((a:any,b:any)=>a.date.localeCompare(b.date));
      }
    } catch {}

    // Comparison
    _comparisonTotals=null; _comparisonTrendData=[]; _comparisonRange=null;
    if (_comparisonPeriod!=='none') {
      const cr=getComparisonDateRange(since,until,_comparisonPeriod);
      if (cr) {
        _comparisonRange=cr;
        try {
          const compAcc=accountIds[0];
          const ctotUrl=`/api/meta/insights?account_id=${encodeURIComponent(compAcc)}&fields=${encodeURIComponent('spend,reach,impressions,inline_link_clicks,actions')}&level=account&time_range=${encodeURIComponent(JSON.stringify({since:cr.since,until:cr.until}))}&limit=10&action_attribution_windows=${encodeURIComponent('["7d_click","1d_view","1d_ev"]')}`;
          const ctotRes=await fetch(ctotUrl); const ctotJson=await ctotRes.json();
          if (!ctotJson.error&&ctotJson.data?.length>0) {
            const d=ctotJson.data[0]; const am: Record<string,number>={};
            for (const a of (d.actions||[])) am[a.action_type]=parseInt(a.value||0);
            const pL=am['offsite_conversion.fb_pixel_lead']||0; const fL=am['onsite_conversion.lead_grouped']||0;
            _comparisonTotals={reach:parseInt(d.reach||0),impressions:parseInt(d.impressions||0),spent:Math.round(parseFloat(d.spend||0)*100)/100,linkClicks:parseInt(d.inline_link_clicks||0),results:pL>0?pL:fL>0?fL:(am['lead']||0)};
          }
          if (cr.since!==cr.until) {
            let ctUrl: string|null=`/api/meta/insights?account_id=${encodeURIComponent(compAcc)}&fields=${encodeURIComponent('campaign_id,spend,actions')}&level=campaign&time_range=${encodeURIComponent(JSON.stringify({since:cr.since,until:cr.until}))}&time_increment=1&limit=500&action_attribution_windows=${encodeURIComponent('["7d_click","1d_view","1d_ev"]')}`;
            const cByDate: Record<string,any>={};
            let ctFirst=true;
            while (ctUrl) {
              const ctFetch: string=ctFirst?ctUrl:`/api/meta/next-page?url=${encodeURIComponent(ctUrl)}`; ctFirst=false;
              const ctRes=await fetch(ctFetch); const ctJson=await ctRes.json();
              if (ctJson.error||!ctJson.data) break;
              for (const d of ctJson.data) {
                if (filteredCampaignIds.size>0&&!filteredCampaignIds.has(d.campaign_id)) continue;
                const am: Record<string,number>={};
                for (const a of (d.actions||[])) am[a.action_type]=parseInt(a.value||0);
                const pL=am['offsite_conversion.fb_pixel_lead']||0; const fL=am['onsite_conversion.lead_grouped']||0;
                const spend=Math.round(parseFloat(d.spend||0)*100)/100; const dt=d.date_start;
                if (!cByDate[dt]) cByDate[dt]={date:dt,spend:0,results:0};
                cByDate[dt].spend=Math.round((cByDate[dt].spend+spend)*100)/100;
                cByDate[dt].results+=(pL>0?pL:fL>0?fL:(am['lead']||0));
              }
              ctUrl=ctJson.paging?.next||null;
            }
            _comparisonTrendData=Object.values(cByDate).sort((a:any,b:any)=>a.date.localeCompare(b.date));
          }
        } catch {}
      }
    }

    renderTable();
    if (_currentView==='analytics') renderAnalytics();
    showNotification(`Loaded ${allMapped.length} campaign${allMapped.length!==1?'s':''}`, 'success');
    const statusEl = document.getElementById('data-status');
    if (statusEl) {
      const now = new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
      statusEl.textContent = `Updated ${now}`;
      statusEl.className = 'text-xs text-slate-400';
    }
  } catch(err: any) {
    showNotification(err.message||'Failed to fetch data', 'error');
    const statusEl = document.getElementById('data-status');
    if (statusEl) { statusEl.textContent='Failed to load — try again'; statusEl.className='text-xs text-red-400'; }
  } finally {
    hideLoadingBar();
    const cards = document.getElementById('cards-grid');
    if (cards) { cards.style.opacity=''; cards.style.transition=''; }
  }
}

// Google Ads data source — entire dashboard reads from a single sheet tab.
async function loadGoogleSheetData(since: string, until: string) {
  const res = await fetch('/api/sheets/google');
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  const allRows: { campaign: string; day: string; spend: number; leads: number; impressions: number; linkClicks: number }[] = json.rows || [];

  // 1. Build per-campaign aggregates for the table + KPI cards.
  const inRange = allRows.filter(r => r.day >= since && r.day <= until);
  const byCampaign: Record<string, any> = {};
  for (const r of inRange) {
    if (!byCampaign[r.campaign]) {
      byCampaign[r.campaign] = {
        id: r.campaign, name: r.campaign, campaignId: r.campaign,
        campaignName: r.campaign, adsetName: '', adName: '',
        adsetId: '', account: 'google', status: 'ACTIVE',
        reach: 0, impressions: 0, spent: 0, linkClicks: 0, results: 0,
      };
    }
    const c = byCampaign[r.campaign];
    c.spent = Math.round((c.spent + r.spend) * 100) / 100;
    c.results += r.leads;
    c.impressions += r.impressions;
    c.linkClicks += r.linkClicks;
  }
  const allMapped = Object.values(byCampaign);

  _campaigns.splice(0, _campaigns.length, ...allMapped);

  // 2. Build daily trend across all campaigns in range, seeded with zeros for missing days.
  const byDay: Record<string, any> = {};
  for (const r of inRange) {
    if (!byDay[r.day]) byDay[r.day] = { date: r.day, spend: 0, results: 0, impressions: 0, linkClicks: 0 };
    const d = byDay[r.day];
    d.spend = Math.round((d.spend + r.spend) * 100) / 100;
    d.results += r.leads;
    d.impressions += r.impressions;
    d.linkClicks += r.linkClicks;
  }
  const cur = new Date(since + 'T00:00:00'); const end = new Date(until + 'T00:00:00');
  while (cur <= end) {
    const dt = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
    if (!byDay[dt]) byDay[dt] = { date: dt, spend: 0, results: 0, impressions: 0, linkClicks: 0 };
    cur.setDate(cur.getDate() + 1);
  }
  _trendData = Object.values(byDay).sort((a:any, b:any) => a.date.localeCompare(b.date));

  // 3. Comparison period (if any) — same shape, just on the prior date range.
  _comparisonTotals = null; _comparisonTrendData = []; _comparisonRange = null;
  if (_comparisonPeriod !== 'none') {
    const cr = getComparisonDateRange(since, until, _comparisonPeriod);
    if (cr) {
      _comparisonRange = cr;
      const compRows = allRows.filter(r => r.day >= cr.since && r.day <= cr.until);
      const cTot = { reach: 0, impressions: 0, spent: 0, linkClicks: 0, results: 0 };
      const cByDay: Record<string, any> = {};
      for (const r of compRows) {
        cTot.impressions += r.impressions;
        cTot.spent = Math.round((cTot.spent + r.spend) * 100) / 100;
        cTot.linkClicks += r.linkClicks;
        cTot.results += r.leads;
        if (!cByDay[r.day]) cByDay[r.day] = { date: r.day, spend: 0, results: 0, impressions: 0, linkClicks: 0 };
        const d = cByDay[r.day];
        d.spend = Math.round((d.spend + r.spend) * 100) / 100;
        d.results += r.leads;
        d.impressions += r.impressions;
        d.linkClicks += r.linkClicks;
      }
      _comparisonTotals = cTot;
      const cCur = new Date(cr.since + 'T00:00:00'); const cEnd = new Date(cr.until + 'T00:00:00');
      while (cCur <= cEnd) {
        const dt = `${cCur.getFullYear()}-${String(cCur.getMonth()+1).padStart(2,'0')}-${String(cCur.getDate()).padStart(2,'0')}`;
        if (!cByDay[dt]) cByDay[dt] = { date: dt, spend: 0, results: 0, impressions: 0, linkClicks: 0 };
        cCur.setDate(cCur.getDate() + 1);
      }
      _comparisonTrendData = Object.values(cByDay).sort((a:any, b:any) => a.date.localeCompare(b.date));
    }
  }

  renderTable();
  if (_currentView === 'analytics') renderAnalytics();
  showNotification(`Loaded ${allMapped.length} campaign${allMapped.length!==1?'s':''}`, 'success');
  const statusEl = document.getElementById('data-status');
  if (statusEl) {
    const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    statusEl.textContent = `Updated ${now}`;
    statusEl.className = 'text-xs text-slate-400';
  }
}

// ── Date Picker ───────────────────────────────────────────────────────────────
function dpPresetRow(key: string, active: boolean) {
  const p=DP_PRESETS.find(x=>x.key===key); if (!p) return '';
  return `<button class="dp-preset-btn${active?' dp-preset-active':''}" onclick="window._dpSelectPreset('${key}')"><span class="dp-radio${active?' dp-radio-on':''}"></span>${p.label}</button>`;
}
function dpPopulatePresets() {
  const ru=_dpRecentlyUsed.slice(0,3).filter(k=>DP_PRESETS.find(p=>p.key===k));
  const ruEl=document.getElementById('dp-recently-used'); if (ruEl) ruEl.innerHTML=ru.map(k=>dpPresetRow(k,k===_dpActivePreset)).join('');
  const pEl=document.getElementById('dp-presets'); if (pEl) pEl.innerHTML=DP_PRESETS.map(p=>dpPresetRow(p.key,p.key===_dpActivePreset)).join('');
}
function dpPopulateSelects() {
  const curYear=new Date().getFullYear();
  const years=Array.from({length:18},(_,i)=>curYear-14+i);
  [['l',_dpLY,_dpLM],['r',_dpRY(),_dpRM()]].forEach(([s,yr,mo])=>{
    const mEl=document.getElementById(`dp-month-${s}`); if (mEl) mEl.innerHTML=DP_MONTHS.map((m,i)=>`<option value="${i}"${i===mo?' selected':''}>${m}</option>`).join('');
    const yEl=document.getElementById(`dp-year-${s}`);  if (yEl) yEl.innerHTML=years.map(y=>`<option value="${y}"${y===yr?' selected':''}>${y}</option>`).join('');
  });
}
function dpRenderBothCals() {
  dpRenderCal('dp-hdr-l','dp-cal-l',_dpLY,_dpLM);
  dpRenderCal('dp-hdr-r','dp-cal-r',_dpRY(),_dpRM());
}
function dpRenderCal(hdrId: string, calId: string, year: number, month: number) {
  const hEl=document.getElementById(hdrId); if (hEl) hEl.innerHTML=DP_DAYS.map(d=>`<div class="dp-hdr-cell">${d}</div>`).join('');
  const today=_dpFmt(new Date());
  const firstDay=new Date(year,month,1).getDay();
  const dim=new Date(year,month+1,0).getDate();
  const effEnd=(_dpSelecting&&_dpHover)?(_dpHover>=_dpSince!?_dpHover:_dpSince!):_dpUntil!;
  const effStart=(_dpSelecting&&_dpHover&&_dpHover<_dpSince!)?_dpHover:_dpSince!;
  let html='<div class="dp-day dp-empty"></div>'.repeat(firstDay);
  for (let d=1;d<=dim;d++) {
    const ds=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isStart=ds===effStart&&effStart;
    const isEnd=ds===effEnd&&effEnd&&!_dpSelecting;
    const inRange=effStart&&effEnd&&ds>effStart&&ds<effEnd&&!_dpSelecting;
    const col=(firstDay+d-1)%7;
    let classes='dp-day';
    if (isStart&&isEnd) classes+=' dp-start dp-end';
    else if (isStart) classes+=' dp-start';
    else if (isEnd) classes+=' dp-end';
    else if (inRange) {
      classes+=' dp-in-range';
      if (col===0||d===1) classes+=' dp-range-start-cap';
      if (col===6||d===dim) classes+=' dp-range-end-cap';
    }
    if (ds===today&&!isStart&&!isEnd) classes+=' dp-today';
    // Block today: omit data-ds so the click handler's `if(ds){...}` early-exits.
    const disabled = ds===today;
    if (disabled) classes+=' dp-disabled';
    html+=`<div class="${classes}"${disabled?'':` data-ds="${ds}"`}>${d}</div>`;
  }
  const cEl=document.getElementById(calId); if (cEl) cEl.innerHTML=html;
}
function updateDateLabel() {
  try {
    const {since,until}=getDateRange();
    const lbl=document.getElementById('date-range-label'); if (lbl) lbl.textContent=formatDateLabel(since,until);
    const clbl=document.getElementById('compare-range-label');
    if (clbl&&_comparisonPeriod!=='none') { const cr=getComparisonDateRange(since,until,_comparisonPeriod); clbl.textContent=cr?`vs ${formatDateLabel(cr.since,cr.until)}`:''; }
    else if (clbl) clbl.textContent='';
  } catch {}
}
function dpRenderCompareRange() {
  if (!_dpSince||!_dpUntil) return;
  const mode=(document.getElementById('dp-compare-select') as HTMLSelectElement)?.value||'prev_period';
  const cr=getComparisonDateRange(_dpSince,_dpUntil,mode);
  const cs=document.getElementById('dp-comp-start') as HTMLInputElement; if (cs) cs.value=cr?_dpDisplay(cr.since):'';
  const ce=document.getElementById('dp-comp-end') as HTMLInputElement; if (ce) ce.value=cr?_dpDisplay(cr.until):'';
}

// ── Export ────────────────────────────────────────────────────────────────────
function downloadFile(content: string, filename: string, type: string) {
  const blob=new Blob([content],{type}); const url=URL.createObjectURL(blob);
  const link=document.createElement('a'); link.href=url; link.download=filename;
  document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url);
}

// ── Initialization ────────────────────────────────────────────────────────────
function initDashboard(accountIds: string[], campaignFilter: string, showAccount: boolean) {
  if (_isInitialized) return;
  _isInitialized = true;
  void campaignFilter; // filter is now applied server-side via Meta API
  _showAccount = showAccount;

  // Populate account dropdown from server-provided IDs
  const select = document.getElementById('ad-account') as HTMLSelectElement;
  if (select) {
    select.innerHTML = '<option value="all">All Accounts</option>' +
      accountIds.map(id => `<option value="act_${id}">act_${id}</option>`).join('');
    const saved = localStorage.getItem('meta_ad_account');
    if (saved && Array.from(select.options).some(o => o.value === saved)) select.value = saved;
  }

  // Restore UI state
  const savedDelivery = localStorage.getItem('meta_delivery');
  if (savedDelivery) { const el=document.getElementById('delivery-filter') as HTMLSelectElement; if (el) el.value=savedDelivery; }
  const savedLevel = localStorage.getItem('meta_level');
  if (savedLevel && ['campaign','adset','ad'].includes(savedLevel)) {
    _currentLevel = savedLevel;
    ['campaign','adset','ad'].forEach(l => { const t=document.getElementById(`tab-${l}`); if(t) t.classList.toggle('active-tab',l===savedLevel); });
  }
  const savedView = localStorage.getItem('meta_view');
  if (savedView && ['table','analytics'].includes(savedView)) {
    _currentView = savedView;
    document.getElementById('table-view')?.classList.toggle('hidden',savedView!=='table');
    document.getElementById('analytics-view')?.classList.toggle('hidden',savedView!=='analytics');
    document.getElementById('view-btn-table')?.classList.toggle('active-view-btn',savedView==='table');
    document.getElementById('view-btn-analytics')?.classList.toggle('active-view-btn',savedView==='analytics');
  }
  const savedCompare = localStorage.getItem('meta_compare');
  if (savedCompare) _comparisonPeriod = savedCompare;

  // Init date picker
  _dpRecentlyUsed = JSON.parse(localStorage.getItem('dp_recently_used')||'[]');
  let savedPreset = localStorage.getItem('meta_date_preset')||'last_30d';
  // Migrate stale presets that referenced today (since we no longer expose them).
  if (savedPreset === 'today' || savedPreset === 'today_and_yesterday') savedPreset = 'last_30d';
  _dpActivePreset = savedPreset;
  const r = _dpPresetRange(savedPreset);
  if (r) { _dpSince=r.since; _dpUntil=r.until; }
  const preset = DP_PRESETS.find(p=>p.key===savedPreset);
  if (preset) { const lbl=document.getElementById('date-picker-label'); if(lbl) lbl.textContent=preset.label; }

  updateDateLabel();
  lucide.createIcons();

  // Auto-fetch live data
  fetchMetaCampaigns().catch(err => showNotification(err.message, 'error'));

  // Click outside handlers
  document.addEventListener('click', (e: MouseEvent) => {
    const menu = document.getElementById('export-menu');
    const btn = (e.target as Element)?.closest?.('[data-export-toggle]');
    if (!btn && menu && !menu.classList.contains('hidden') && !menu.contains(e.target as Node)) menu.classList.add('hidden');
    const smenu = document.getElementById('search-mode-menu');
    if (smenu && !(e.target as Element)?.closest?.('[data-search-mode-toggle]')) smenu.classList.add('hidden');
  });
}

// Attach window-level handlers for inline event attributes in rendered HTML
if (typeof window !== 'undefined') {
  (window as any)._setSortCol = (col: string) => { if (_sortCol===col) _sortDir=_sortDir==='asc'?'desc':'asc'; else { _sortCol=col; _sortDir='asc'; } renderTable(); };
  (window as any)._handleCheckbox = (key: string) => { if (_selectedRows.has(key)) _selectedRows.delete(key); else _selectedRows.add(key); const data=getFiltered().map(calcMetrics); renderCards(getSelectedTotals(data),_selectedRows.size); const sa=document.getElementById('select-all') as HTMLInputElement; if (sa) sa.checked=data.length>0&&data.every((c:any)=>_selectedRows.has(c.id||c.name)); };
  (window as any)._handleSelectAll = (checked: boolean) => { const data=getFiltered(); if (checked) data.forEach(c=>_selectedRows.add(c.id||c.name)); else _selectedRows.clear(); renderTable(); };
  (window as any)._clearDrilldown = () => { _drilldownParentIds.clear(); _drilldownParentLevel=null; _selectedRows.clear(); renderTable(); };
  (window as any)._dpSelectPreset = (key: string) => { _dpActivePreset=key; const r=_dpPresetRange(key); if (r){_dpSince=r.since;_dpUntil=r.until;} _dpSelecting=false;_dpHover=null; const base=new Date(_dpSince!+'T00:00:00');_dpLY=base.getFullYear();_dpLM=base.getMonth(); dpPopulatePresets();dpPopulateSelects();dpRenderBothCals();dpRenderCompareRange(); };
}

// ── React component ───────────────────────────────────────────────────────────
export default function DashboardClient({ accountIds, clientName, campaignFilter, showAccount, platform = 'meta', hasGoogleAds = false, metaUrl, googleUrl }: Props) {
  const [ready, setReady] = useState(0);
  _platform = platform;

  useEffect(() => {
    if (ready >= 2) initDashboard(accountIds, campaignFilter, showAccount);
  }, [ready, accountIds, campaignFilter, showAccount]);

  const incReady = () => setReady(r => r + 1);

  return (
    <>
      <Script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js" strategy="afterInteractive" onLoad={incReady} />
      <Script src="https://cdn.jsdelivr.net/npm/lucide@0.263.0/dist/umd/lucide.min.js" strategy="afterInteractive" onLoad={incReady} />

      <div id="loading-bar"></div>
      <div id="loading-overlay" className="hidden">
        <div className="loading-overlay-inner">
          <div className="loading-spinner"></div>
          <div className="loading-text">Loading dashboard data…</div>
          <div className="loading-subtext">Meta sometimes takes a moment.</div>
        </div>
      </div>
      <div id="app" className="w-full min-h-screen flex flex-col font-sans" style={{fontFamily:'DM Sans, sans-serif'}}>

        {/* Header */}
        <header className="bg-slate-900/80 backdrop-blur-md border-b border-slate-800 sticky top-0 z-30">
          <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <img src="/gmnlogo.png" alt="Logo" className="w-9 h-9 rounded-lg object-contain" />
              <h1 className="text-lg font-bold text-white tracking-tight">Meta Ads Dashboard</h1>
              <span className="text-[10px] font-mono bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full uppercase tracking-wider">{clientName}</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <i data-lucide="info" className="w-3.5 h-3.5"></i>
                <span id="data-status">Connecting to Meta API...</span>
              </div>
              <div className="flex items-center gap-2">
                {/* Platform switch — shown when this client has both Meta and Google Ads. */}
                {hasGoogleAds && (
                  <div className="flex items-center bg-slate-800/60 rounded-lg p-0.5 border border-slate-700">
                    <a
                      href={metaUrl || '/dashboard'}
                      className={`text-xs px-3 py-1 rounded transition-colors ${platform === 'meta' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}
                    >
                      Meta
                    </a>
                    <a
                      href={googleUrl || '/dashboard/google'}
                      className={`text-xs px-3 py-1 rounded transition-colors ${platform === 'google' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}
                    >
                      Google Ads
                    </a>
                  </div>
                )}
                {/* Export */}
                <div className="relative">
                  <button data-export-toggle onClick={() => document.getElementById('export-menu')?.classList.toggle('hidden')} className="text-xs bg-slate-800/50 hover:bg-slate-800 text-slate-300 border border-slate-600 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2">
                    <i data-lucide="download" className="w-3 h-3"></i><span>Export</span>
                  </button>
                  <div id="export-menu" className="hidden absolute right-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-40 min-w-[168px] py-1">
                    <button onClick={() => { const data=getFiltered().map(calcMetrics); if(!data.length){showNotification('No data','error');return;} const h=['Campaign','Account','Delivery','Reach','Impressions','CPM','Results','Spent','CTR','Link Clicks','CPC','CPL']; const rows=data.map((c:any)=>[c.name,c.account,c.status||'—',c.reach,c.impressions,c.cpm.toFixed(2),c.results,c.spent.toFixed(2),c.ctr.toFixed(2),c.linkClicks,c.cpc.toFixed(2),c.cpl.toFixed(2)]); downloadFile([h,...rows].map(r=>r.map((v:any)=>`"${v}"`).join(',')).join('\n'),'meta-ads-'+new Date().toISOString().split('T')[0]+'.csv','text/csv'); showNotification('Downloaded CSV','success'); document.getElementById('export-menu')?.classList.add('hidden'); }} className="w-full text-left px-4 py-2 text-xs text-slate-300 hover:bg-slate-700 flex items-center gap-2"><i data-lucide="file-text" className="w-3.5 h-3.5"></i> Download CSV</button>
                    <button onClick={() => { const data=getFiltered().map(calcMetrics); if(!data.length){showNotification('No data','error');return;} downloadFile(JSON.stringify(data,null,2),'meta-ads-'+new Date().toISOString().split('T')[0]+'.json','application/json'); showNotification('Downloaded JSON','success'); document.getElementById('export-menu')?.classList.add('hidden'); }} className="w-full text-left px-4 py-2 text-xs text-slate-300 hover:bg-slate-700 flex items-center gap-2"><i data-lucide="file-code" className="w-3.5 h-3.5"></i> Download JSON</button>
                  </div>
                </div>
                <ChangePasswordButton className="text-xs bg-slate-800/50 hover:bg-slate-800 text-slate-300 border border-slate-600 px-3 py-1.5 rounded-lg transition-colors" />
                <button onClick={() => signOut({ callbackUrl: '/login' })} className="text-xs bg-slate-800/50 hover:bg-slate-800 text-slate-300 border border-slate-600 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2">
                  <i data-lucide="log-out" className="w-3 h-3"></i><span>Sign out</span>
                </button>
              </div>
            </div>
          </div>
        </header>

        {/* Controls */}
        <div className="max-w-[1600px] mx-auto w-full px-4 sm:px-6 pt-5 pb-3">
          <div className="flex flex-wrap gap-3 items-end">
            {/* Account (Meta only — Google Ads pulls a single sheet tab, no account selector) */}
            {platform === 'meta' && (
              <div className="flex flex-col gap-1.5 min-w-[200px]">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Ad Account</label>
                <div className="flex flex-col gap-0.5">
                  <div className="relative">
                    <select id="ad-account" onChange={() => { localStorage.setItem('meta_ad_account',(document.getElementById('ad-account') as HTMLSelectElement).value); renderTable(); }} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 pr-8 text-sm text-white appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500/50 cursor-pointer">
                      <option value="all">All Accounts</option>
                    </select>
                    <i data-lucide="chevron-down" className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none"></i>
                  </div>
                  <span className="h-4 block"></span>
                </div>
              </div>
            )}
            {/* Date Range */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Date Range</label>
              <div className="flex flex-col gap-0.5">
                <button id="date-picker-btn" onClick={() => {
                  const base=_dpSince?new Date(_dpSince+'T00:00:00'):new Date();
                  _dpLY=base.getFullYear();_dpLM=base.getMonth();_dpSelecting=false;_dpHover=null;
                  const stored=localStorage.getItem('meta_compare')||'none';
                  const cc=document.getElementById('dp-compare-check') as HTMLInputElement; if(cc) cc.checked=stored!=='none';
                  const cs=document.getElementById('dp-compare-select') as HTMLSelectElement; if(cs) cs.value=stored!=='none'?stored:'prev_period';
                  const cr=document.getElementById('dp-compare-row') as HTMLElement; if(cr) cr.style.display=(stored!=='none')?'flex':'none';
                  dpPopulatePresets();dpPopulateSelects();dpRenderBothCals();dpRenderCompareRange();
                  document.getElementById('date-picker-modal')?.classList.remove('hidden');
                }} className="flex items-center gap-2 bg-slate-900 border border-slate-700 hover:border-slate-500 rounded-lg px-3 py-2 text-sm text-white transition-colors whitespace-nowrap">
                  <i data-lucide="calendar" className="w-4 h-4 text-slate-400"></i>
                  <span id="date-picker-label">Last 30 days</span>
                  <i data-lucide="chevron-down" className="w-3.5 h-3.5 text-slate-400 ml-1"></i>
                </button>
                <span id="date-range-label" className="text-[10px] text-slate-400 font-mono px-1 h-4 whitespace-nowrap"></span>
              </div>
            </div>
            <span id="compare-range-label" className="hidden"></span>
            {/* Delivery (Meta only — the Google Ads sheet has no delivery status) */}
            {platform === 'meta' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Delivery</label>
              <div className="flex flex-col gap-0.5">
                <div className="relative">
                  <select id="delivery-filter" onChange={() => renderTable()} className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 pr-8 text-sm text-white appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500/50 cursor-pointer min-w-[150px]">
                    <option value="all">All Delivery</option>
                    <option value="ACTIVE">Active</option>
                    <option value="PAUSED">Paused</option>
                    <option value="IN_PROCESS">In Process</option>
                    <option value="WITH_ISSUES">With Issues</option>
                    <option value="ARCHIVED">Archived</option>
                  </select>
                  <i data-lucide="chevron-down" className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none"></i>
                </div>
                <span className="h-4 block"></span>
              </div>
            </div>
            )}
            {/* Search */}
            <div className="flex flex-col gap-1.5 flex-1 min-w-[280px]">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Search Campaigns</label>
              <div className="flex flex-col gap-0.5">
                <div className="flex items-stretch gap-0">
                  <div className="relative">
                    <button data-search-mode-toggle onClick={(e) => { e.stopPropagation(); document.getElementById('search-mode-menu')?.classList.toggle('hidden'); }} className="h-full bg-slate-900 border border-slate-700 border-r-0 rounded-l-lg px-3 py-2 text-sm text-slate-300 flex items-center gap-1.5 whitespace-nowrap hover:bg-slate-800 transition-colors">
                      <span id="search-mode-label">contains all of</span>
                      <i data-lucide="chevron-down" className="w-3 h-3 text-slate-400"></i>
                    </button>
                    <div id="search-mode-menu" className="hidden absolute left-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-50 min-w-[200px] py-1">
                      {(['all','any','none'] as const).map(m => (
                        <button key={m} onClick={() => {
                          _searchMode=m;
                          const labels={all:'contains all of',any:'contains any of',none:"doesn't contain any of"};
                          const lbl=document.getElementById('search-mode-label'); if(lbl) lbl.textContent=labels[m];
                          (['all','any','none'] as const).forEach(x=>{ const dot=document.getElementById(`mode-dot-${x}`); if(dot){dot.classList.toggle('border-blue-500',x===m);dot.classList.toggle('bg-blue-500',x===m);dot.classList.toggle('border-slate-500',x!==m);} });
                          document.getElementById('search-mode-menu')?.classList.add('hidden');
                          renderTable();
                        }} className="w-full text-left px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 flex items-center gap-2">
                          <span className="w-3 h-3 rounded-full border-2 border-slate-500 flex-shrink-0" id={`mode-dot-${m}`}></span>
                          {m==='all'?'contains all of':m==='any'?'contains any of':"doesn't contain any of"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div id="search-chip-area" onClick={() => document.getElementById('search-input')?.focus()} className="flex-1 flex flex-wrap items-center gap-1 bg-slate-900 border border-slate-700 rounded-r-lg px-2 py-1.5 cursor-text min-h-[38px]">
                    <div id="search-chips" className="flex flex-wrap gap-1"></div>
                    <input type="text" id="search-input" placeholder="Enter a name or keyword..." onKeyDown={(e) => {
                      const input=e.currentTarget; const val=input.value.trim();
                      if ((e.key==='Enter'||e.key===',')&&val) { e.preventDefault(); if(!_searchChips.includes(val.toLowerCase())){_searchChips.push(val.toLowerCase()); const c=document.getElementById('search-chips'); if(c) c.innerHTML=_searchChips.map((chip,i)=>`<span class="inline-flex items-center gap-1 bg-blue-600/30 border border-blue-500/40 text-blue-300 text-xs rounded px-2 py-0.5 font-mono">${chip}<button onclick="window._removeChip(${i})" class="ml-0.5 text-blue-400 hover:text-white leading-none">&times;</button></span>`).join('');} input.value=''; renderTable(); }
                      else if (e.key==='Backspace'&&!val&&_searchChips.length>0) { _searchChips.pop(); const c=document.getElementById('search-chips'); if(c) c.innerHTML=_searchChips.map((chip,i)=>`<span class="inline-flex items-center gap-1 bg-blue-600/30 border border-blue-500/40 text-blue-300 text-xs rounded px-2 py-0.5 font-mono">${chip}<button onclick="window._removeChip(${i})" class="ml-0.5 text-blue-400 hover:text-white leading-none">&times;</button></span>`).join(''); renderTable(); }
                    }} onInput={() => renderTable()} className="flex-1 min-w-[120px] bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none py-0.5" />
                  </div>
                </div>
                <span className="h-4 block" id="search-hint"></span>
              </div>
            </div>
            <button onClick={() => fetchMetaCampaigns().catch(err=>showNotification(err.message,'error'))} className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors flex items-center gap-2 self-end mb-[20px]">
              <i data-lucide="refresh-cw" className="w-4 h-4"></i> Apply
            </button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="max-w-[1600px] mx-auto w-full px-4 sm:px-6 py-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" id="cards-grid"></div>
        </div>

        {/* Table */}
        <div className="max-w-[1600px] mx-auto w-full px-4 sm:px-6 pb-6 flex-1">
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
            {/* Level tabs + view toggle */}
            <div className="flex items-center gap-1 px-4 pt-3 pb-0 border-b border-slate-800">
              {platform === 'meta' && (['campaign','adset','ad'] as const).map(l => (
                <button key={l} id={`tab-${l}`} onClick={() => {
                  if (l===_currentLevel) return;
                  const lo=['campaign','adset','ad']; const pi=lo.indexOf(_currentLevel); const ni=lo.indexOf(l);
                  if (ni>pi&&_selectedRows.size>0){_drilldownParentIds=new Set(_selectedRows);_drilldownParentLevel=_currentLevel;}
                  else {_drilldownParentIds.clear();_drilldownParentLevel=null;}
                  _currentLevel=l; _selectedRows.clear(); _sortCol=null;
                  localStorage.setItem('meta_level',l);
                  lo.forEach(x=>{const t=document.getElementById(`tab-${x}`);if(t)t.classList.toggle('active-tab',x===l);});
                  fetchMetaCampaigns().catch(err=>showNotification(err.message,'error'));
                }} className={`level-tab px-4 py-2 text-xs font-semibold rounded-t-lg transition-colors${l==='campaign'?' active-tab':''}`}>
                  {l.charAt(0).toUpperCase()+l.slice(1)}{l==='adset'?' Sets':l==='ad'?'s':'s'}
                </button>
              ))}
              {platform === 'google' && (
                <div className="px-4 py-2 text-xs font-semibold text-slate-300">
                  <i data-lucide="bar-chart-2" className="w-3.5 h-3.5 inline mr-1.5 align-text-bottom text-blue-400"></i>
                  Google Ads
                </div>
              )}
              <div className="ml-auto flex items-center gap-2 pb-2">
                <span id="selection-summary" className="text-xs text-slate-500 hidden"></span>
                <div className="flex items-center gap-0.5 bg-slate-800/60 rounded-lg p-0.5">
                  <button id="view-btn-table" onClick={() => { _currentView='table'; localStorage.setItem('meta_view','table'); document.getElementById('table-view')?.classList.remove('hidden'); document.getElementById('analytics-view')?.classList.add('hidden'); document.getElementById('view-btn-table')?.classList.add('active-view-btn'); document.getElementById('view-btn-analytics')?.classList.remove('active-view-btn'); }} className="view-btn active-view-btn flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold"><i data-lucide="table-2" className="w-3 h-3"></i> Table</button>
                  <button id="view-btn-analytics" onClick={() => { _currentView='analytics'; localStorage.setItem('meta_view','analytics'); document.getElementById('table-view')?.classList.add('hidden'); document.getElementById('analytics-view')?.classList.remove('hidden'); document.getElementById('view-btn-table')?.classList.remove('active-view-btn'); document.getElementById('view-btn-analytics')?.classList.add('active-view-btn'); renderAnalytics(); }} className="view-btn flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold"><i data-lucide="bar-chart-2" className="w-3 h-3"></i> Analytics</button>
                </div>
              </div>
            </div>

            {/* Table view */}
            <div id="table-view">
              <div id="drilldown-banner" className="hidden items-center gap-2 px-4 py-2 bg-blue-500/10 border-b border-blue-500/20 text-xs text-blue-300"></div>
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-slate-800" id="table-head-row">
                    <th className="w-8 px-3 py-3 sticky left-0 bg-slate-900/90 backdrop-blur-sm"><input type="checkbox" id="select-all" onChange={(e)=>(window as any)._handleSelectAll(e.target.checked)} className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 accent-blue-500 cursor-pointer" /></th>
                    <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 sticky left-8 bg-slate-900/90 backdrop-blur-sm min-w-[200px]">Campaign</th>
                    <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap">Delivery</th>
                    <th className="text-right px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap">Reach</th>
                    <th className="text-right px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap">Impressions</th>
                    <th className="text-right px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap">CPM</th>
                    <th className="text-right px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap">Results</th>
                    <th className="text-right px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap">Spent (USD)</th>
                    <th className="text-right px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap">CTR</th>
                    <th className="text-right px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap">Link Clicks</th>
                    <th className="text-right px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap">CPC</th>
                    <th className="text-right px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap">CPL</th>
                  </tr></thead>
                  <tbody id="table-body"></tbody>
                  <tfoot id="table-foot"></tfoot>
                </table>
              </div>
              <div id="no-results" className="hidden px-6 py-12 text-center text-slate-500">
                <i data-lucide="search-x" className="w-10 h-10 mx-auto mb-3 opacity-40"></i>
                <p className="font-medium">No campaigns found</p>
                <p className="text-xs mt-1">Try adjusting your search or filters</p>
              </div>
            </div>

            {/* Analytics view */}
            <div id="analytics-view" className="hidden p-5 space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2"><i data-lucide="trending-up" className="w-3.5 h-3.5 text-emerald-400"></i> Daily Spend &amp; Results</h3>
                    <span id="chart-trend-range" className="text-[10px] font-mono text-slate-500"></span>
                  </div>
                  <div id="chart-trend-wrap" style={{position:'relative',height:180}}><canvas id="chart-trend"></canvas></div>
                  <div id="chart-trend-empty" className="hidden text-center text-slate-500 py-8 text-xs">Select a multi-day date range to see daily trends</div>
                </div>
                <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2"><i data-lucide="target" className="w-3.5 h-3.5 text-amber-400"></i> Top by Results</h3>
                    <div className="flex gap-1">
                      <button className="sort-btn active-sort-btn" onClick={() => { _chartSort.results='desc'; document.querySelectorAll('[data-sort-results]').forEach((b,i)=>b.classList.toggle('active-sort-btn',i===0)); renderAnalytics(); }} data-sort-results="desc">High → Low</button>
                      <button className="sort-btn" onClick={() => { _chartSort.results='asc'; document.querySelectorAll('[data-sort-results]').forEach((b,i)=>b.classList.toggle('active-sort-btn',i===1)); renderAnalytics(); }} data-sort-results="asc">Low → High</button>
                    </div>
                  </div>
                  <div id="chart-results-wrap" style={{position:'relative',height:180}}><canvas id="chart-results"></canvas></div>
                  <div id="chart-results-empty" className="hidden text-center text-slate-500 py-8 text-xs">No data</div>
                </div>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2"><i data-lucide="dollar-sign" className="w-3.5 h-3.5 text-emerald-400"></i> Top by Spend</h3>
                    <div className="flex gap-1">
                      <button className="sort-btn active-sort-btn" onClick={() => { _chartSort.spend='desc'; renderAnalytics(); }}>High → Low</button>
                      <button className="sort-btn" onClick={() => { _chartSort.spend='asc'; renderAnalytics(); }}>Low → High</button>
                    </div>
                  </div>
                  <div id="chart-spend-wrap" style={{position:'relative',height:240}}><canvas id="chart-spend"></canvas></div>
                  <div id="chart-spend-empty" className="hidden text-center text-slate-500 py-8 text-xs">No data</div>
                </div>
                <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2"><i data-lucide="receipt" className="w-3.5 h-3.5 text-violet-400"></i> Daily CPL Trend</h3>
                    <span id="chart-cpl-trend-range" className="text-[10px] font-mono text-slate-500"></span>
                  </div>
                  <div id="chart-cpl-trend-wrap" style={{position:'relative',height:240}}><canvas id="chart-cpl-trend"></canvas></div>
                  <div id="chart-cpl-trend-empty" className="hidden text-center text-slate-500 py-8 text-xs">Select a multi-day date range to see CPL trend</div>
                </div>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2"><i data-lucide="receipt" className="w-3.5 h-3.5 text-violet-400"></i> CPL by Campaign</h3>
                    <div className="flex gap-1">
                      <button className="sort-btn active-sort-btn" onClick={() => { _chartSort.cplEff='asc'; renderAnalytics(); }}>Best First</button>
                      <button className="sort-btn" onClick={() => { _chartSort.cplEff='desc'; renderAnalytics(); }}>Worst First</button>
                    </div>
                  </div>
                  <div id="chart-cpl-wrap" style={{position:'relative',height:240}}><canvas id="chart-cpl"></canvas></div>
                  <div id="chart-cpl-empty" className="hidden text-center text-slate-500 py-8 text-xs">No lead data</div>
                </div>
                <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2"><i data-lucide="scatter-chart" className="w-3.5 h-3.5 text-blue-400"></i> CPL vs Results (bubble = spend)</h3>
                  </div>
                  <div id="chart-scatter-wrap" style={{position:'relative',height:240}}><canvas id="chart-scatter"></canvas></div>
                  <div id="chart-scatter-empty" className="hidden text-center text-slate-500 py-8 text-xs">No lead data</div>
                </div>
              </div>
              <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2 mb-3"><i data-lucide="pie-chart" className="w-3.5 h-3.5 text-blue-400"></i> Delivery Mix</h3>
                <div id="chart-delivery-wrap" style={{position:'relative',height:180}}><canvas id="chart-delivery"></canvas></div>
                <div id="chart-delivery-empty" className="hidden text-center text-slate-500 py-8 text-xs">No data</div>
              </div>
            </div>
          </div>
        </div>

        <footer className="max-w-[1600px] mx-auto w-full px-4 sm:px-6 py-4 text-center text-[11px] text-slate-600 border-t border-slate-800/50">
          Live data from Meta Marketing API. All times in account timezone.
        </footer>
      </div>

      {/* Date Picker Modal */}
      <div id="date-picker-modal" className="hidden fixed inset-0 z-[200]" style={{background:'rgba(0,0,0,.6)'}} onClick={(e)=>{ if(e.target===e.currentTarget) document.getElementById('date-picker-modal')?.classList.add('hidden'); }}>
        <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',background:'#0f172a',border:'1px solid #1e293b',borderRadius:12,boxShadow:'0 24px 64px rgba(0,0,0,.6)',display:'flex',overflow:'hidden',minWidth:760,maxWidth:'95vw'}} onClick={e=>e.stopPropagation()}>
          <div style={{width:210,borderRight:'1px solid #1e293b',overflowY:'auto',padding:'10px 0',flexShrink:0,maxHeight:540}}>
            <div style={{padding:'8px 16px 4px',fontSize:10,fontWeight:700,color:'#475569',textTransform:'uppercase',letterSpacing:'.08em'}}>Recently used</div>
            <div id="dp-recently-used"></div>
            <div style={{borderTop:'1px solid #1e293b',margin:'6px 0'}}></div>
            <div id="dp-presets"></div>
          </div>
          <div style={{display:'flex',flexDirection:'column',padding:'20px 22px 16px',gap:14,flex:1,minWidth:0}}>
            <div style={{display:'flex',alignItems:'flex-start'}}>
              <button className="dp-nav-btn" onClick={()=>{_dpLM--;if(_dpLM<0){_dpLM=11;_dpLY--;}dpPopulateSelects();dpRenderBothCals();}}>&#8249;</button>
              <div style={{flex:1,padding:'0 6px'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:2,marginBottom:8}}>
                  <select id="dp-month-l" onChange={()=>{_dpLM=+(document.getElementById('dp-month-l') as HTMLSelectElement).value;_dpLY=+(document.getElementById('dp-year-l') as HTMLSelectElement).value;dpPopulateSelects();dpRenderBothCals();}} className="dp-cal-select"></select>
                  <select id="dp-year-l"  onChange={()=>{_dpLM=+(document.getElementById('dp-month-l') as HTMLSelectElement).value;_dpLY=+(document.getElementById('dp-year-l') as HTMLSelectElement).value;dpPopulateSelects();dpRenderBothCals();}} className="dp-cal-select"></select>
                </div>
                <div className="dp-hdr" id="dp-hdr-l"></div>
                <div className="dp-grid" id="dp-cal-l" onClick={(e)=>{const el=(e.target as Element).closest('.dp-day');const ds=(el as HTMLElement)?.dataset?.ds;if(ds){if(!_dpSelecting||!_dpSince){_dpSince=ds;_dpUntil=ds;_dpSelecting=true;_dpActivePreset='custom';}else{if(ds<_dpSince){_dpUntil=_dpSince;_dpSince=ds;}else _dpUntil=ds;_dpSelecting=false;_dpHover=null;dpPopulatePresets();}dpRenderBothCals();dpRenderCompareRange();}}} onMouseOver={(e)=>{if(!_dpSelecting)return;const el=(e.target as Element).closest('.dp-day');const ds=(el as HTMLElement)?.dataset?.ds;if(ds&&ds!==_dpHover){_dpHover=ds;dpRenderBothCals();}}}></div>
              </div>
              <div style={{width:1,background:'#1e293b',alignSelf:'stretch',margin:'0 4px'}}></div>
              <div style={{flex:1,padding:'0 6px'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:2,marginBottom:8}}>
                  <select id="dp-month-r" onChange={()=>{const rm=+(document.getElementById('dp-month-r') as HTMLSelectElement).value,ry=+(document.getElementById('dp-year-r') as HTMLSelectElement).value;_dpLM=rm===0?11:rm-1;_dpLY=rm===0?ry-1:ry;dpPopulateSelects();dpRenderBothCals();}} className="dp-cal-select"></select>
                  <select id="dp-year-r"  onChange={()=>{const rm=+(document.getElementById('dp-month-r') as HTMLSelectElement).value,ry=+(document.getElementById('dp-year-r') as HTMLSelectElement).value;_dpLM=rm===0?11:rm-1;_dpLY=rm===0?ry-1:ry;dpPopulateSelects();dpRenderBothCals();}} className="dp-cal-select"></select>
                </div>
                <div className="dp-hdr" id="dp-hdr-r"></div>
                <div className="dp-grid" id="dp-cal-r" onClick={(e)=>{const el=(e.target as Element).closest('.dp-day');const ds=(el as HTMLElement)?.dataset?.ds;if(ds){if(!_dpSelecting||!_dpSince){_dpSince=ds;_dpUntil=ds;_dpSelecting=true;_dpActivePreset='custom';}else{if(ds<_dpSince){_dpUntil=_dpSince;_dpSince=ds;}else _dpUntil=ds;_dpSelecting=false;_dpHover=null;dpPopulatePresets();}dpRenderBothCals();dpRenderCompareRange();}}} onMouseOver={(e)=>{if(!_dpSelecting)return;const el=(e.target as Element).closest('.dp-day');const ds=(el as HTMLElement)?.dataset?.ds;if(ds&&ds!==_dpHover){_dpHover=ds;dpRenderBothCals();}}}></div>
              </div>
              <button className="dp-nav-btn" onClick={()=>{_dpLM++;if(_dpLM>11){_dpLM=0;_dpLY++;}dpPopulateSelects();dpRenderBothCals();}}>&#8250;</button>
            </div>
            <div style={{borderTop:'1px solid #1e293b',paddingTop:12,display:'flex',flexDirection:'column',gap:10}}>
              <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13,color:'#cbd5e1',fontWeight:500,userSelect:'none'}}>
                <input type="checkbox" id="dp-compare-check" onChange={()=>{const on=(document.getElementById('dp-compare-check') as HTMLInputElement).checked;const row=document.getElementById('dp-compare-row') as HTMLElement;if(row)row.style.display=on?'flex':'none';if(on)dpRenderCompareRange();}} style={{width:15,height:15,accentColor:'#3b82f6',cursor:'pointer'}} /> Compare
              </label>
              <div id="dp-compare-row" style={{display:'none',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                <select id="dp-compare-select" onChange={()=>dpRenderCompareRange()} style={{fontSize:12,border:'1px solid #334155',borderRadius:8,padding:'6px 10px',background:'#1e293b',color:'#e2e8f0',cursor:'pointer',outline:'none'}}>
                  <option value="prev_period">Previous period</option>
                  <option value="DoD">Day over day</option>
                  <option value="WoW">Week over week</option>
                  <option value="MoM">Month over month</option>
                  <option value="YoY">Year over year</option>
                </select>
                <input id="dp-comp-start" type="text" readOnly style={{width:108,fontSize:12,border:'1px solid #334155',borderRadius:8,padding:'6px 10px',color:'#94a3b8',background:'#1e293b',fontFamily:'monospace'}} />
                <span style={{color:'#475569',fontSize:13}}>–</span>
                <input id="dp-comp-end" type="text" readOnly style={{width:108,fontSize:12,border:'1px solid #334155',borderRadius:8,padding:'6px 10px',color:'#94a3b8',background:'#1e293b',fontFamily:'monospace'}} />
              </div>
            </div>
            <div style={{fontSize:11,color:'#475569'}}>Dates are shown in account timezone</div>
            <div style={{display:'flex',alignItems:'center',justifyContent:'flex-end',gap:10,borderTop:'1px solid #1e293b',paddingTop:14}}>
              <button onClick={()=>document.getElementById('date-picker-modal')?.classList.add('hidden')} style={{padding:'7px 18px',borderRadius:8,border:'1px solid #334155',background:'transparent',fontSize:13,fontWeight:600,color:'#cbd5e1',cursor:'pointer'}}>Cancel</button>
              <button onClick={()=>{
                if(!_dpSince||!_dpUntil){document.getElementById('date-picker-modal')?.classList.add('hidden');return;}
                const compareOn=(document.getElementById('dp-compare-check') as HTMLInputElement)?.checked;
                const compareMode=(document.getElementById('dp-compare-select') as HTMLSelectElement)?.value||'prev_period';
                const preset=DP_PRESETS.find(p=>p.key===_dpActivePreset);
                const label=preset?preset.label:`${_dpDisplay(_dpSince)} – ${_dpDisplay(_dpUntil)}`;
                const lbl=document.getElementById('date-picker-label'); if(lbl) lbl.textContent=label;
                if(_dpActivePreset&&_dpActivePreset!=='custom'){_dpRecentlyUsed=[_dpActivePreset,..._dpRecentlyUsed.filter(x=>x!==_dpActivePreset)].slice(0,3);localStorage.setItem('dp_recently_used',JSON.stringify(_dpRecentlyUsed));}
                _comparisonPeriod=compareOn?compareMode:'none';
                localStorage.setItem('meta_date_preset',_dpActivePreset);
                localStorage.setItem('meta_compare',_comparisonPeriod);
                document.getElementById('date-picker-modal')?.classList.add('hidden');
                updateDateLabel();
                fetchMetaCampaigns().catch(err=>showNotification(err.message,'error'));
              }} style={{padding:'7px 18px',borderRadius:8,border:'none',background:'#3b82f6',fontSize:13,fontWeight:600,color:'#fff',cursor:'pointer'}}>Update</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// Attach remaining window helpers
if (typeof window !== 'undefined') {
  (window as any)._removeChip = (idx: number) => {
    _searchChips.splice(idx,1);
    const c=document.getElementById('search-chips');
    if(c) c.innerHTML=_searchChips.map((chip,i)=>`<span class="inline-flex items-center gap-1 bg-blue-600/30 border border-blue-500/40 text-blue-300 text-xs rounded px-2 py-0.5 font-mono">${chip}<button onclick="window._removeChip(${i})" class="ml-0.5 text-blue-400 hover:text-white leading-none">&times;</button></span>`).join('');
    renderTable();
  };
}
