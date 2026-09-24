// Browser-side "what if" state for focus mode: the radii the marketer is
// dragging and the pin they dropped, resolved against the neighbours the
// server found. Pure — shared by the panel (sliders, result strips) and
// the map (dashed proposal circles, collision lines) so both always agree.
import { proposalHits, safeCeilingMi, MILE_KM, type AdsetCircle, type ProposalHit } from '@/lib/geoOverlap';
import type { FocusReport } from '@/lib/marketer/targeting';

export const SLIDER_MIN_MI = 0.5;
export const SLIDER_MAX_MI = 50;
export const SLIDER_STEP_MI = 0.5;
export const PIN_DEFAULT_MI = 5;

export interface FocusProposal {
  circle: AdsetCircle;
  currentKm: number;
  proposedKm: number;
  changed: boolean;
  hits: ProposalHit[];
  safeCeilingMi: number | null;
}

export interface PinState { lat: number; lng: number; radiusKm: number }

export interface PinProposal extends PinState {
  hits: ProposalHit[];
  safeCeilingMi: number | null;
}

export const kmToMi = (km: number): number => km / MILE_KM;
export const miToKm = (mi: number): number => mi * MILE_KM;
export const snapMi = (mi: number): number =>
  Math.min(SLIDER_MAX_MI, Math.max(SLIDER_MIN_MI, Math.round(mi / SLIDER_STEP_MI) * SLIDER_STEP_MI));

/** Everything a focus circle can collide with: neighbours plus the client's own other circles. */
export function focusTargets(focus: FocusReport): AdsetCircle[] {
  return [...focus.neighbours.map(n => n.circle), ...focus.focusCircles];
}

export function buildProposals(focus: FocusReport, proposedKm: Record<string, number>, includeSameCampaign: boolean): FocusProposal[] {
  const targets = focusTargets(focus);
  return focus.focusCircles.map(c => {
    const km = proposedKm[c.circleId] ?? c.radiusKm;
    const source = { id: c.circleId, lat: c.lat, lng: c.lng, radiusKm: km, accountId: c.accountId, adsetId: c.adsetId, campaignId: c.campaignId || null };
    return {
      circle: c,
      currentKm: c.radiusKm,
      proposedKm: km,
      changed: Math.abs(km - c.radiusKm) > 1e-6,
      hits: proposalHits(source, targets, { includeSameCampaign }),
      safeCeilingMi: safeCeilingMi(source, targets, { includeSameCampaign, maxMi: SLIDER_MAX_MI, stepMi: SLIDER_STEP_MI }),
    };
  });
}

export function buildPinProposal(focus: FocusReport, pin: PinState | null, includeSameCampaign: boolean): PinProposal | null {
  if (!pin) return null;
  const targets = focusTargets(focus);
  const source = { id: 'pin', lat: pin.lat, lng: pin.lng, radiusKm: pin.radiusKm, accountId: null, adsetId: null, campaignId: null };
  return {
    ...pin,
    hits: proposalHits(source, targets, { includeSameCampaign }),
    safeCeilingMi: safeCeilingMi(source, targets, { includeSameCampaign, maxMi: SLIDER_MAX_MI, stepMi: SLIDER_STEP_MI }),
  };
}
