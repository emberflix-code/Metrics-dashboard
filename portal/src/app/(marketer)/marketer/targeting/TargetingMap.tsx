'use client';

import { useEffect, useRef, useState } from 'react';
import { pairKey, type AdsetCircle, type OverlapPair, type Severity } from '@/lib/geoOverlap';
import type { TargetingClub } from '@/lib/marketer/targeting';
import { groupColorFor } from '@/lib/groupColors';
import { adsManagerAdsetUrl, fmtInt, fmtKm, fmtMi, fmtUsd } from '../_components/format';

// Leaflet is loaded from the CDN at runtime rather than bundled: it is the
// only page that needs a map, Leaflet's CSS wants a real <link>, and it
// keeps `npm install` untouched. `L` is reached through window so there is
// no compile-time dependency on @types/leaflet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Leaflet = any;

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';

const COLOR_DEFAULT = '#3b82f6';
const COLOR_HIGH = '#ef4444';
const COLOR_MEDIUM = '#f59e0b';

function loadLeaflet(): Promise<Leaflet> {
  const w = window as unknown as { L?: Leaflet; __leafletPromise?: Promise<Leaflet> };
  if (w.L) return Promise.resolve(w.L);
  if (!w.__leafletPromise) {
    w.__leafletPromise = new Promise<Leaflet>((resolve, reject) => {
      if (!document.querySelector('link[data-leaflet]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = LEAFLET_CSS;
        link.setAttribute('data-leaflet', '1');
        document.head.appendChild(link);
      }
      const script = document.createElement('script');
      script.src = LEAFLET_JS;
      script.async = true;
      script.onload = () => (w.L ? resolve(w.L) : reject(new Error('Leaflet loaded without window.L')));
      script.onerror = () => reject(new Error('Leaflet failed to load from CDN'));
      document.head.appendChild(script);
    });
  }
  return w.__leafletPromise;
}

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

function clubPopup(c: TargetingClub): string {
  return `
    <div style="min-width:200px">
      <div style="font-weight:600;color:#fff;margin-bottom:2px">${esc(c.name)}</div>
      <div style="color:#94a3b8">${esc(c.brand)}${c.offer ? ` · ${esc(c.offer)}` : ''}</div>
      ${c.address ? `<div style="color:#94a3b8;margin-top:4px">${esc(c.address)}</div>` : ''}
      <div style="margin-top:6px;display:grid;grid-template-columns:auto auto;gap:2px 12px">
        <span style="color:#64748b">Ad sets</span><span>${fmtInt(c.adsetCount)}</span>
        <span style="color:#64748b">Spend</span><span>${fmtUsd(c.spend, 0)}</span>
        <span style="color:#64748b">Results</span><span>${fmtInt(c.results)}</span>
      </div>
    </div>`;
}

function circlePopup(c: AdsetCircle, sev: Severity | null): string {
  const sevLabel = sev === 'high' ? '<span style="color:#f87171">High overlap</span>' : sev === 'medium' ? '<span style="color:#fbbf24">Medium overlap</span>' : '';
  return `
    <div style="min-width:220px;max-width:300px">
      <div style="font-weight:600;color:#fff;margin-bottom:2px;word-break:break-word">${esc(c.adsetName)}</div>
      <div style="color:#94a3b8;word-break:break-word">${esc(c.campaignName)}</div>
      <div style="color:#cbd5e1;margin-top:4px">${esc(c.clientName ?? 'Unattributed')} · ${esc(c.offer)}</div>
      ${sevLabel ? `<div style="margin-top:4px">${sevLabel}</div>` : ''}
      <div style="margin-top:6px;display:grid;grid-template-columns:auto auto;gap:2px 12px">
        <span style="color:#64748b">Radius</span><span>${fmtMi(c.radiusKm)} (${fmtKm(c.radiusKm)})${c.approx ? ' <span style="color:#94a3b8">approx.</span>' : ''}</span>
        <span style="color:#64748b">Spend</span><span>${fmtUsd(c.spend)}</span>
        <span style="color:#64748b">Results</span><span>${fmtInt(c.results)}</span>
        <span style="color:#64748b">CPL</span><span>${fmtUsd(c.cpl)}</span>
        <span style="color:#64748b">Status</span><span>${esc(c.status)}</span>
        ${c.dailyBudget !== null ? `<span style="color:#64748b">Daily budget</span><span>${fmtUsd(c.dailyBudget, 0)}</span>` : ''}
      </div>
      <a href="${esc(adsManagerAdsetUrl(c.accountId, c.adsetId))}" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px;color:#93c5fd">Open in Ads Manager ↗</a>
    </div>`;
}

const MAP_CSS = `
.tmap .leaflet-container { background: #0f172a; font-family: inherit; }
.tmap .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9); }
.tmap .leaflet-popup-content-wrapper, .tmap .leaflet-popup-tip { background: #0f172a; color: #e2e8f0; box-shadow: 0 4px 16px rgba(0,0,0,.5); }
.tmap .leaflet-popup-content-wrapper { border: 1px solid #334155; border-radius: 10px; }
.tmap .leaflet-popup-content { margin: 10px 12px; font-size: 12px; line-height: 1.45; }
.tmap .leaflet-popup-close-button { color: #94a3b8 !important; }
.tmap .leaflet-control-attribution { background: rgba(15,23,42,.8); color: #94a3b8; font-size: 10px; }
.tmap .leaflet-control-attribution a { color: #93c5fd; }
.tmap .leaflet-bar a { background: #1e293b; color: #e2e8f0; border-bottom-color: #334155; }
.tmap .leaflet-bar a:hover { background: #334155; }
`;

export default function TargetingMap({ clubs, circles, pairs, selectedPairKey }: {
  clubs: TargetingClub[];
  circles: AdsetCircle[];
  pairs: OverlapPair[];
  selectedPairKey: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet | null>(null);
  const dataLayerRef = useRef<Leaflet | null>(null);
  const highlightLayerRef = useRef<Leaflet | null>(null);
  const circleLayersRef = useRef<Map<string, Leaflet>>(new Map());
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then(() => { if (!cancelled) setReady(true); }).catch(err => { if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  // Map instance lives for the component's lifetime; data is redrawn into
  // a layer group so filter changes don't rebuild the map.
  useEffect(() => {
    if (!ready || !containerRef.current || mapRef.current) return;
    const L = (window as unknown as { L: Leaflet }).L;
    const map = L.map(containerRef.current, { preferCanvas: true, zoomControl: true, worldCopyJump: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map);
    map.setView([39.5, -96], 4);
    dataLayerRef.current = L.layerGroup().addTo(map);
    highlightLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    setTimeout(() => map.invalidateSize(), 0);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.invalidateSize()) : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    const circleLayers = circleLayersRef.current;

    return () => {
      ro?.disconnect();
      map.remove();
      mapRef.current = null;
      dataLayerRef.current = null;
      highlightLayerRef.current = null;
      circleLayers.clear();
    };
  }, [ready]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = dataLayerRef.current;
    if (!ready || !map || !layer) return;
    const L = (window as unknown as { L: Leaflet }).L;

    layer.clearLayers();
    highlightLayerRef.current?.clearLayers();
    circleLayersRef.current.clear();

    // Worst severity each circle participates in decides its colour.
    const sevByCircle = new Map<string, Severity>();
    const rank = (s: Severity) => (s === 'high' ? 3 : s === 'medium' ? 2 : 1);
    for (const p of pairs) {
      for (const c of [p.a, p.b]) {
        const prev = sevByCircle.get(c.circleId);
        if (!prev || rank(p.severity) > rank(prev)) sevByCircle.set(c.circleId, p.severity);
      }
    }

    const bounds: [number, number][] = [];
    // Big circles first so small ones stay clickable on top.
    const sortedCircles = circles.slice().sort((a, b) => b.radiusKm - a.radiusKm);
    for (const c of sortedCircles) {
      const sev = sevByCircle.get(c.circleId) ?? null;
      const color = sev === 'high' ? COLOR_HIGH : sev === 'medium' ? COLOR_MEDIUM : COLOR_DEFAULT;
      const circle = L.circle([c.lat, c.lng], {
        radius: c.radiusKm * 1000,
        color,
        weight: 1.5,
        fillColor: color,
        fillOpacity: sev === 'high' ? 0.12 : sev === 'medium' ? 0.1 : 0.08,
        dashArray: c.approx ? '6 6' : undefined,
      });
      circle.bindPopup(circlePopup(c, sev), { maxWidth: 320 });
      circle.addTo(layer);
      circleLayersRef.current.set(c.circleId, circle);
      bounds.push([c.lat, c.lng]);
    }

    for (const club of clubs) {
      const pin = L.circleMarker([club.lat, club.lng], {
        radius: 7,
        color: '#ffffff',
        weight: 1.5,
        fillColor: groupColorFor(club.brand).bar,
        fillOpacity: 1,
      });
      pin.bindPopup(clubPopup(club), { maxWidth: 300 });
      pin.bindTooltip(club.name, { direction: 'top', offset: [0, -8], opacity: 0.9 });
      pin.addTo(layer);
      bounds.push([club.lat, club.lng]);
    }

    if (bounds.length > 0) {
      map.fitBounds(L.latLngBounds(bounds), { padding: [24, 24], maxZoom: 12 });
    }
  }, [ready, clubs, circles, pairs]);

  useEffect(() => {
    const map = mapRef.current;
    const hl = highlightLayerRef.current;
    if (!ready || !map || !hl) return;
    const L = (window as unknown as { L: Leaflet }).L;
    hl.clearLayers();

    // Restore any previously thickened circles.
    circleLayersRef.current.forEach(layer => {
      if (layer.__hl) { layer.setStyle({ weight: 1.5 }); layer.__hl = false; }
    });
    if (!selectedPairKey) return;

    const pair = pairs.find(p => pairKey(p) === selectedPairKey);
    if (!pair) return;
    const la = circleLayersRef.current.get(pair.a.circleId);
    const lb = circleLayersRef.current.get(pair.b.circleId);
    if (!la || !lb) return;

    L.polyline([[pair.a.lat, pair.a.lng], [pair.b.lat, pair.b.lng]], { color: '#ffffff', weight: 2, dashArray: '4 6', opacity: 0.9 }).addTo(hl);
    for (const layer of [la, lb]) {
      layer.setStyle({ weight: 3 });
      layer.__hl = true;
      layer.bringToFront();
    }
    map.fitBounds(la.getBounds().extend(lb.getBounds()), { padding: [40, 40], maxZoom: 13 });
  }, [ready, selectedPairKey, pairs]);

  return (
    <div className="tmap bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
      <style>{MAP_CSS}</style>
      <div ref={containerRef} style={{ height: 560 }} className="w-full">
        {(!ready || loadError) && (
          <div className="h-full w-full flex items-center justify-center text-sm text-slate-500">
            {loadError ? `Map unavailable: ${loadError}` : 'Loading map…'}
          </div>
        )}
      </div>
      <div className="px-4 py-2 border-t border-slate-800 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: COLOR_DEFAULT, background: 'rgba(59,130,246,0.15)' }} />Ad set radius</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: COLOR_HIGH, background: 'rgba(239,68,68,0.2)' }} />In a high-overlap pair</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: COLOR_MEDIUM, background: 'rgba(245,158,11,0.2)' }} />Medium</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border-2 border-dashed border-slate-400" />Assumed radius (city/zip)</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full bg-amber-400 border border-white" />Club (colour = brand)</span>
        <span className="ml-auto">{circles.length} circles · {clubs.length} clubs</span>
      </div>
    </div>
  );
}
