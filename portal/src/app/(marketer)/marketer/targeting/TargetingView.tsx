'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TargetingReport } from '@/lib/marketer/targeting';
import TargetingMap from './TargetingMap';
import OverlapTable from './OverlapTable';
import NeighboursPanel from './NeighboursPanel';
import { buildPinProposal, buildProposals, miToKm, PIN_DEFAULT_MI, type PinState } from './focusSim';

// Holds the state shared between the map and the right-hand panel: the
// highlighted pair (overview mode) or neighbour (focus mode), the radii
// being simulated, and the dropped pin. Everything else derives from the
// report prop; the simulation itself is pure (focusSim.ts).
export default function TargetingView({ report, includeSameCampaign }: { report: TargetingReport; includeSameCampaign: boolean }) {
  const focus = report.focus;
  const [selectedPairKey, setSelectedPairKey] = useState<string | null>(null);
  const [selectedCircleId, setSelectedCircleId] = useState<string | null>(null);
  const [proposedKm, setProposedKm] = useState<Record<string, number>>({});
  const [pin, setPin] = useState<PinState | null>(null);
  const [dropPinMode, setDropPinMode] = useState(false);

  // A new focus client means new circles — stale slider values would point
  // at circleIds that no longer exist.
  useEffect(() => {
    setProposedKm({});
    setSelectedCircleId(null);
    setPin(null);
    setDropPinMode(false);
  }, [focus?.clientId]);

  const proposals = useMemo(() => (focus ? buildProposals(focus, proposedKm, includeSameCampaign) : []), [focus, proposedKm, includeSameCampaign]);
  const pinProposal = useMemo(() => (focus ? buildPinProposal(focus, pin, includeSameCampaign) : null), [focus, pin, includeSameCampaign]);

  const onMapClick = useCallback((lat: number, lng: number) => {
    setPin(prev => ({ lat, lng, radiusKm: prev?.radiusKm ?? miToKm(PIN_DEFAULT_MI) }));
  }, []);
  const onPinDrag = useCallback((lat: number, lng: number) => {
    setPin(prev => (prev ? { ...prev, lat, lng } : { lat, lng, radiusKm: miToKm(PIN_DEFAULT_MI) }));
  }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      <div className="lg:col-span-3">
        <TargetingMap
          clubs={report.clubs}
          circles={report.adsets}
          pairs={report.pairs}
          selectedPairKey={focus ? null : selectedPairKey}
          focus={focus ? { clientId: focus.clientId, center: focus.center, ringKm: focus.ringKm } : null}
          proposals={proposals}
          pin={pinProposal}
          selectedCircleId={focus ? selectedCircleId : null}
          dropPinMode={dropPinMode}
          onToggleDropPin={focus ? () => setDropPinMode(v => !v) : undefined}
          onMapClick={onMapClick}
          onPinDrag={onPinDrag}
        />
      </div>
      <div className="lg:col-span-2 min-w-0">
        {focus ? (
          <NeighboursPanel
            focus={focus}
            proposals={proposals}
            pin={pinProposal}
            includeSameCampaign={includeSameCampaign}
            onProposeKm={(circleId, km) => setProposedKm(prev => ({ ...prev, [circleId]: km }))}
            onProposeAllKm={km => setProposedKm(Object.fromEntries(focus.focusCircles.map(c => [c.circleId, km])))}
            onReset={() => setProposedKm({})}
            onPinRadius={km => setPin(prev => (prev ? { ...prev, radiusKm: km } : prev))}
            onRemovePin={() => { setPin(null); setDropPinMode(false); }}
            selectedCircleId={selectedCircleId}
            onSelectCircle={id => setSelectedCircleId(prev => (prev === id ? null : id))}
          />
        ) : (
          <OverlapTable
            pairs={report.pairs}
            offClub={report.offClub}
            broad={report.broad}
            selectedPairKey={selectedPairKey}
            onSelectPair={key => setSelectedPairKey(prev => (prev === key ? null : key))}
          />
        )}
      </div>
    </div>
  );
}
