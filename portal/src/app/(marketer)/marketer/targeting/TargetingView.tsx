'use client';

import { useState } from 'react';
import type { TargetingReport } from '@/lib/marketer/targeting';
import TargetingMap from './TargetingMap';
import OverlapTable from './OverlapTable';

// Holds the one piece of shared state between the map and the table: which
// pair is highlighted. Everything else is derived from the report prop.
export default function TargetingView({ report }: { report: TargetingReport }) {
  const [selectedPairKey, setSelectedPairKey] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      <div className="lg:col-span-3">
        <TargetingMap
          clubs={report.clubs}
          circles={report.adsets}
          pairs={report.pairs}
          selectedPairKey={selectedPairKey}
        />
      </div>
      <div className="lg:col-span-2 min-w-0">
        <OverlapTable
          pairs={report.pairs}
          offClub={report.offClub}
          broad={report.broad}
          selectedPairKey={selectedPairKey}
          onSelectPair={key => setSelectedPairKey(prev => (prev === key ? null : key))}
        />
      </div>
    </div>
  );
}
