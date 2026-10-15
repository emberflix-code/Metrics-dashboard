import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { notFound, redirect } from 'next/navigation';
import { query } from '@/lib/db';
import ImpersonationBanner from '@/components/ImpersonationBanner';
import { listPublishedMonths, loadPublishedReport } from '@/lib/gmnReport';
import GmnReportClient from './GmnReportClient';

export const dynamic = 'force-dynamic';

interface ClientRow {
  id: string;
  name: string;
  show_gmn_report: boolean;
}

// GMN Marketing Report: the client's published monthly report snapshots
// (client_monthly_reports). Only exists for clients an admin has switched on
// (clients.show_gmn_report) — everyone else gets a 404, and their dashboard
// never shows the button.
export default async function GmnReportPage({ searchParams }: { searchParams: { month?: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'client') redirect('/login');

  const [client] = await query<ClientRow>(
    `SELECT c.id, c.name, c.show_gmn_report
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  ).catch(() => [] as ClientRow[]);
  if (!client?.show_gmn_report) notFound();

  const months = await listPublishedMonths(client.id);
  const requested = searchParams.month && months.some(m => m.month === searchParams.month) ? searchParams.month : months[0]?.month;
  const report = requested ? await loadPublishedReport(client.id, requested) : null;
  const impersonatedBy = session.user.impersonatedBy;

  return (
    <>
      {impersonatedBy && (
        <ImpersonationBanner adminEmail={impersonatedBy.email} clientName={client.name} />
      )}
      <GmnReportClient clientName={client.name} months={months} selectedMonth={requested ?? null} report={report} />
    </>
  );
}
