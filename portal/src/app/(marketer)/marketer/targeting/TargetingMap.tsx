'use client';

import { useEffect, useRef, useState } from 'react';
import { haversineKm, pairKey, type AdsetCircle, type OverlapPair, type Severity } from '@/lib/geoOverlap';
import type { TargetingClub } from '@/lib/marketer/targeting';
import { groupColorFor } from '@/lib/groupColors';
import { adsManagerAdsetUrl, fmtInt, fmtKm, fmtMi, fmtUsd } from '../_components/format';
import type { FocusProposal, PinProposal } from './focusSim';

// Leaflet is loaded from the CDN at runtime rather than bundled: it is the
// only page that needs a map, Leaflet's CSS wants a real <link>, and it
// keeps `npm install` untouched. `L` is reached through window so there is
// no compile-time dependency on @types/leaflet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Leaflet = any;

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_IMAGES = 'https://unpkg.com/leaflet@1.9.4/dist/images/';

const COLOR_DEFAULT = '#3b82f6';
const COLOR_HIGH = '#ef4444';
const COLOR_MEDIUM = '#f59e0b';
const COLOR_FOCUS = '#34d399';
const COLOR_PIN = '#f472b6';
const COLOR_RING = '#94a3b8';
const DIM_OUTSIDE_RING = 0.25;

export interface MapFocus {
  clientId: string;
  center: { lat: number; lng: number } | null;
  ringKm: number;
}

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

function circlePopup(c: AdsetCircle, sev: Severity | null, isFocus: boolean): string {
  const sevLabel = isFocus ? '<span style="color:#6ee7b7">Focused client</span>' : sev === 'high' ? '<span style="color:#f87171">High overlap</span>' : sev === 'medium' ? '<span style="color:#fbbf24">Medium overlap</span>' : '';
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
.tmap.tmap-drop .leaflet-container { cursor: crosshair; }
.tmap .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9); }
.tmap .leaflet-popup-content-wrapper, .tmap .leaflet-popup-tip { background: #0f172a; color: #e2e8f0; box-shadow: 0 4px 16px rgba(0,0,0,.5); }
.tmap .leaflet-popup-content-wrapper { border: 1px solid #334155; border-radius: 10px; }
.tmap .leaflet-popup-content { margin: 10px 12px; font-size: 12px; line-height: 1.45; }
.tmap .leaflet-popup-close-button { color: #94a3b8 !important; }
.tmap .leaflet-control-attribution { background: rgba(15,23,42,.8); color: #94a3b8; font-size: 10px; }
.tmap .leaflet-control-attribution a { color: #93c5fd; }
.tmap .leaflet-bar a { background: #1e293b; color: #e2e8f0; border-bottom-color: #334155; }
.tmap .leaflet-bar a:hover { background: #334155; }
.tmap .leaflet-tooltip { background: #0f172a; color: #e2e8f0; border-color: #334155; }
`;

export default function TargetingMap({
  clubs, circles, pairs, selectedPairKey,
  focus = null, proposals = [], pin = null, selectedCircleId = null,
  dropPinMode = false, onToggleDropPin, onMapClick, onPinDrag,
}: {
  clubs: TargetingClub[];
  circles: AdsetCircle[];
  pairs: OverlapPair[];
  selectedPairKey: string | null;
  focus?: MapFocus | null;
  proposals?: FocusProposal[];
  pin?: PinProposal | null;
  selectedCircleId?: string | null;
  dropPinMode?: boolean;
  onToggleDropPin?: () => void;
  onMapClick?: (lat: number, lng: number) => void;
  onPinDrag?: (lat: number, lng: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet | null>(null);
  const dataLayerRef = useRef<Leaflet | null>(null);
  const proposalLayerRef = useRef<Leaflet | null>(null);
  const highlightLayerRef = useRef<Leaflet | null>(null);
  const pinMarkerRef = useRef<Leaflet | null>(null);
  const circleLayersRef = useRef<Map<string, Leaflet>>(new Map());
  // Callbacks and mode live in refs so the map's click handler is bound once.
  const clickRef = useRef<{ dropPinMode: boolean; onMapClick?: (lat: number, lng: number) => void; onPinDrag?: (lat: number, lng: number) => void }>({ dropPinMode });
  clickRef.current = { dropPinMode, onMapClick, onPinDrag };
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then(() => { if (!cancelled) setReady(true); }).catch(err => { if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  // Map instance lives for the component's lifetime; data is redrawn into
  // layer groups so filter changes don't rebuild the map.
  useEffect(() => {
    if (!ready || !containerRef.current || mapRef.current) return;
    const L = (window as unknown as { L: Leaflet }).L;
    L.Icon.Default.imagePath = LEAFLET_IMAGES;
    const map = L.map(containerRef.current, { preferCanvas: true, zoomControl: true, worldCopyJump: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map);
    map.setView([39.5, -96], 4);
    dataLayerRef.current = L.layerGroup().addTo(map);
    proposalLayerRef.current = L.layerGroup().addTo(map);
    highlightLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    map.on('click', (e: { latlng: { lat: number; lng: number } }) => {
      const { dropPinMode: on, onMapClick: cb } = clickRef.current;
      if (on && cb) cb(e.latlng.lat, e.latlng.lng);
    });

    setTimeout(() => map.invalidateSize(), 0);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.invalidateSize()) : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    const circleLayers = circleLayersRef.current;

    return () => {
      ro?.disconnect();
      map.remove();
      mapRef.current = null;
      dataLayerRef.current = null;
      proposalLayerRef.current = null;
      highlightLayerRef.current = null;
      pinMarkerRef.current = null;
      circleLayers.clear();
    };
  }, [ready]);

  const focusClientId = focus?.clientId ?? null;
  const focusLat = focus?.center?.lat ?? null;
  const focusLng = focus?.center?.lng ?? null;
  const ringKm = focus?.ringKm ?? null;

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

    const center = focusLat !== null && focusLng !== null ? { lat: focusLat, lng: focusLng } : null;
    const inRing = (c: { lat: number; lng: number }) => !center || ringKm === null || haversineKm(center, c) <= ringKm;

    const bounds: [number, number][] = [];
    // Big circles first so small ones stay clickable on top.
    const sortedCircles = circles.slice().sort((a, b) => b.radiusKm - a.radiusKm);
    for (const c of sortedCircles) {
      const isFocus = focusClientId !== null && c.clientId === focusClientId;
      const sev = sevByCircle.get(c.circleId) ?? null;
      const color = isFocus ? COLOR_FOCUS : sev === 'high' ? COLOR_HIGH : sev === 'medium' ? COLOR_MEDIUM : COLOR_DEFAULT;
      const dim = focusClientId !== null && !isFocus && !inRing(c) ? DIM_OUTSIDE_RING : 1;
      const baseFill = isFocus ? 0.14 : sev === 'high' ? 0.12 : sev === 'medium' ? 0.1 : 0.08;
      const circle = L.circle([c.lat, c.lng], {
        radius: c.radiusKm * 1000,
        color,
        weight: isFocus ? 2 : 1.5,
        opacity: dim,
        fillColor: color,
        fillOpacity: baseFill * dim,
        dashArray: c.approx ? '6 6' : undefined,
      });
      circle.__baseWeight = isFocus ? 2 : 1.5;
      circle.bindPopup(circlePopup(c, sev, isFocus), { maxWidth: 320 });
      circle.addTo(layer);
      circleLayersRef.current.set(c.circleId, circle);
      bounds.push([c.lat, c.lng]);
    }

    for (const club of clubs) {
      const isFocus = focusClientId !== null && club.clientId === focusClientId;
      const dim = focusClientId !== null && !isFocus && !inRing(club) ? 0.5 : 1;
      const pinMarker = L.circleMarker([club.lat, club.lng], {
        radius: isFocus ? 9 : 7,
        color: '#ffffff',
        weight: isFocus ? 2.5 : 1.5,
        opacity: dim,
        fillColor: groupColorFor(club.brand).bar,
        fillOpacity: dim,
      });
      pinMarker.bindPopup(clubPopup(club), { maxWidth: 300 });
      pinMarker.bindTooltip(club.name, { direction: 'top', offset: [0, -8], opacity: 0.9 });
      pinMarker.addTo(layer);
      bounds.push([club.lat, club.lng]);
    }

    if (center && ringKm !== null) {
      const ring = L.circle([center.lat, center.lng], {
        radius: ringKm * 1000, color: COLOR_RING, weight: 1, opacity: 0.8, dashArray: '4 8', fill: false, interactive: false,
      });
      ring.addTo(layer);
      map.fitBounds(ring.getBounds(), { padding: [16, 16] });
    } else if (bounds.length > 0) {
      map.fitBounds(L.latLngBounds(bounds), { padding: [24, 24], maxZoom: 12 });
    }
  }, [ready, clubs, circles, pairs, focusClientId, focusLat, focusLng, ringKm]);

  // Simulation layer: dashed proposal circles + lines to whatever they would
  // collide with. Separate from the data layer so slider drags are cheap.
  useEffect(() => {
    const map = mapRef.current;
    const layer = proposalLayerRef.current;
    if (!ready || !map || !layer) return;
    const L = (window as unknown as { L: Leaflet }).L;
    layer.clearLayers();
    pinMarkerRef.current = null;

    const drawHits = (from: { lat: number; lng: number }, hits: FocusProposal['hits']) => {
      for (const h of hits) {
        const color = h.score >= 0.5 ? COLOR_HIGH : COLOR_MEDIUM;
        L.polyline([[from.lat, from.lng], [h.target.lat, h.target.lng]], {
          color, weight: h.counted ? 2 : 1, opacity: h.counted ? 0.9 : 0.4, dashArray: h.counted ? undefined : '2 6', interactive: false,
        }).addTo(layer);
      }
    };

    for (const p of proposals) {
      if (!p.changed) continue;
      L.circle([p.circle.lat, p.circle.lng], {
        radius: p.proposedKm * 1000, color: COLOR_FOCUS, weight: 2, dashArray: '2 6', fillColor: COLOR_FOCUS, fillOpacity: 0.04, interactive: false,
      }).addTo(layer);
      drawHits(p.circle, p.hits);
    }

    if (pin) {
      L.circle([pin.lat, pin.lng], {
        radius: pin.radiusKm * 1000, color: COLOR_PIN, weight: 2, dashArray: '2 6', fillColor: COLOR_PIN, fillOpacity: 0.06, interactive: false,
      }).addTo(layer);
      drawHits(pin, pin.hits);
      const marker = L.marker([pin.lat, pin.lng], { draggable: true, title: 'Planned location — drag to move' });
      marker.on('dragend', () => {
        const ll = marker.getLatLng();
        clickRef.current.onPinDrag?.(ll.lat, ll.lng);
      });
      marker.bindTooltip(`Planned · ${fmtMi(pin.radiusKm)}`, { direction: 'top', offset: [-15, -10], permanent: false });
      marker.addTo(layer);
      pinMarkerRef.current = marker;
    }
  }, [ready, proposals, pin]);

  useEffect(() => {
    const map = mapRef.current;
    const hl = highlightLayerRef.current;
    if (!ready || !map || !hl) return;
    const L = (window as unknown as { L: Leaflet }).L;
    hl.clearLayers();

    // Restore any previously thickened circles.
    circleLayersRef.current.forEach(layer => {
      if (layer.__hl) { layer.setStyle({ weight: layer.__baseWeight ?? 1.5 }); layer.__hl = false; }
    });

    if (selectedCircleId) {
      const target = circleLayersRef.current.get(selectedCircleId);
      if (!target) return;
      target.setStyle({ weight: 3 });
      target.__hl = true;
      target.bringToFront();
      const center = focusLat !== null && focusLng !== null ? { lat: focusLat, lng: focusLng } : null;
      let bounds = target.getBounds();
      if (center) {
        const t = target.getLatLng();
        L.polyline([[center.lat, center.lng], [t.lat, t.lng]], { color: '#ffffff', weight: 2, dashArray: '4 6', opacity: 0.9, interactive: false }).addTo(hl);
        bounds = bounds.extend([center.lat, center.lng]);
      }
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
      return;
    }

    if (!selectedPairKey) return;
    const pair = pairs.find(p => pairKey(p) === selectedPairKey);
    if (!pair) return;
    const la = circleLayersRef.current.get(pair.a.circleId);
    const lb = circleLayersRef.current.get(pair.b.circleId);
    if (!la || !lb) return;

    L.polyline([[pair.a.lat, pair.a.lng], [pair.b.lat, pair.b.lng]], { color: '#ffffff', weight: 2, dashArray: '4 6', opacity: 0.9, interactive: false }).addTo(hl);
    for (const layer of [la, lb]) {
      layer.setStyle({ weight: 3 });
      layer.__hl = true;
      layer.bringToFront();
    }
    map.fitBounds(la.getBounds().extend(lb.getBounds()), { padding: [40, 40], maxZoom: 13 });
  }, [ready, selectedPairKey, selectedCircleId, pairs, focusLat, focusLng]);

  return (
    <div className={`tmap ${dropPinMode ? 'tmap-drop' : ''} bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden`}>
      <style>{MAP_CSS}</style>
      <div className="relative">
        <div ref={containerRef} style={{ height: 560 }} className="w-full">
          {(!ready || loadError) && (
            <div className="h-full w-full flex items-center justify-center text-sm text-slate-500">
              {loadError ? `Map unavailable: ${loadError}` : 'Loading map…'}
            </div>
          )}
        </div>
        {onToggleDropPin && ready && (
          <div className="absolute top-3 right-3 z-[1000] flex items-center gap-2">
            {dropPinMode && <span className="text-[11px] text-pink-200 bg-slate-900/90 border border-pink-500/40 rounded-lg px-2 py-1">Click the map to place the planned location</span>}
            <button
              type="button"
              onClick={onToggleDropPin}
              className={`text-xs font-medium rounded-lg px-3 py-1.5 border transition-colors ${dropPinMode ? 'bg-pink-500/20 text-pink-200 border-pink-500/50' : 'bg-slate-900/90 text-slate-200 border-slate-700 hover:border-slate-500'}`}
            >
              {dropPinMode ? 'Done placing' : pin ? 'Move pin' : 'Drop pin'}
            </button>
          </div>
        )}
      </div>
      <div className="px-4 py-2 border-t border-slate-800 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
        {focus ? (
          <>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: COLOR_FOCUS, background: 'rgba(52,211,153,0.2)' }} />Focused client</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border-2 border-dashed" style={{ borderColor: COLOR_FOCUS }} />Proposed radius</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border-2 border-dashed" style={{ borderColor: COLOR_PIN }} />Planned location</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: COLOR_DEFAULT, background: 'rgba(59,130,246,0.15)' }} />Neighbour (dimmed = outside ring)</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: COLOR_HIGH }} />Would overlap ≥50%</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: COLOR_MEDIUM }} />Would overlap &lt;50%</span>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: COLOR_DEFAULT, background: 'rgba(59,130,246,0.15)' }} />Ad set radius</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: COLOR_HIGH, background: 'rgba(239,68,68,0.2)' }} />In a high-overlap pair</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: COLOR_MEDIUM, background: 'rgba(245,158,11,0.2)' }} />Medium</span>
          </>
        )}
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border-2 border-dashed border-slate-400" />Assumed radius (city/zip)</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full bg-amber-400 border border-white" />Club (colour = brand)</span>
        <span className="ml-auto">{circles.length} circles · {clubs.length} clubs</span>
      </div>
    </div>
  );
}
