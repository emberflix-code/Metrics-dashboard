import { requireCoachSession } from '@/lib/coachAuth';
import { loadCoachClients, listCoachNames } from '@/lib/coach/scope';
import { loadBoardPrefs } from '@/lib/coach/prefs';
import { isGoogleOnlyClient } from '@/lib/meta';
import CoachBoard, { type BoardClient } from './_components/CoachBoard';

export const dynamic = 'force-dynamic';

// Board shell only: the coach's clients and settings. No metric queries here —
// the numbers load after the page renders (/api/coach/board-metrics), only
// for the columns the coach has switched on.
export default async function CoachPage() {
  const ctx = await requireCoachSession();
  const prefs = await loadBoardPrefs(ctx.session.user.id, ctx.isAdmin);
  // Admins load everyone once and filter by coach in the browser.
  const [clients, coachNames] = await Promise.all([loadCoachClients(ctx), ctx.isAdmin ? listCoachNames() : Promise.resolve([])]);

  const rows: BoardClient[] = clients.map(c => ({
    id: c.id,
    name: c.name,
    isRollup: c.isRollup,
    marketingType: c.marketingType,
    offer: c.offer,
    offerDetails: c.offerDetails,
    coachName: c.coachName,
    contactName: c.contactName,
    locationAddress: c.locationAddress,
    leadsSource: c.leadsSource,
    hasMeta: !isGoogleOnlyClient({ ad_account_ids: c.adAccountIds, google_data_source: c.googleDataSource }) && (c.adAccountIds.length > 0 || c.isRollup),
    hasGoogle: c.googleDataSource === 'api' ? c.googleCustomerIds.length > 0 : !!c.googleSheetTab,
    googleSource: c.googleDataSource === 'api' ? 'api' : c.googleSheetTab ? 'sheet' : null,
    hasGhl: c.hasGhlToken,
    dataSource: c.dataSource,
    showCreativesV3: c.showCreativesV3,
    showBookings: c.showBookings,
    cpaEnabled: c.cpaEnabled,
    ltvEnabled: c.ltvEnabled,
  }));

  if (!ctx.isAdmin && !ctx.coachName) {
    return (
      <div className="max-w-xl mx-auto mt-16 text-center text-slate-400 text-sm">
        Your coach login isn&apos;t linked to a coach name yet, so there are no clients to show. Ask an admin to set your name in Admin → Settings → Coaches.
      </div>
    );
  }

  return <CoachBoard clients={rows} prefs={prefs} isAdmin={ctx.isAdmin} coachNames={coachNames} />;
}
