import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

// Signed-in users go straight to their area; everyone else gets a public page explaining the
// portal (required by Google's OAuth branding review — the home page can't be just a login form).
export default async function RootPage() {
  const session = await getServerSession(authOptions);

  if (session?.user.role === 'admin') redirect('/admin');
  if (session?.user.role === 'marketer') redirect('/marketer');
  if (session) redirect('/dashboard');

  return <PublicHome />;
}

const FEATURES = [
  {
    title: 'Campaign reporting',
    body: 'Each gym client gets a private dashboard with spend, impressions, clicks, leads and cost per lead for the ads GMN runs on their behalf.',
  },
  {
    title: 'Meta and Google Ads in one place',
    body: 'Results are read from the Meta (Facebook/Instagram) and Google Ads accounts GMN manages, alongside the lead sheets and CRM bookings clients already use.',
  },
  {
    title: 'Campaign setup reviews',
    body: 'The GMN team uses the portal to review how campaigns are set up — budgets, targeting, ads and lead forms — and to keep them performing.',
  },
];

function PublicHome() {
  return (
    <div className="min-h-screen bg-slate-950 px-4 py-12">
      <div className="mx-auto max-w-3xl space-y-12">
        <header className="flex items-center justify-between gap-4">
          <div className="rounded-xl bg-white px-3 py-2">
            <Image src="/gmn-logo-full.png" alt="GMN — Gym Members Now" width={658} height={258} className="h-12 w-auto sm:h-14" priority />
          </div>
          <Link
            href="/login"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Sign in
          </Link>
        </header>

        <section className="space-y-4">
          <h1 className="text-3xl font-bold text-white">Ad reporting for the gyms we market</h1>
          <p className="text-base leading-relaxed text-slate-300">
            The GMN Ads Portal is the client reporting tool of Gym Members Now, a marketing agency for gyms and fitness
            studios. It shows each client how the advertising campaigns we run for them are performing, and gives our
            team one place to review and manage those campaigns.
          </p>
          <p className="text-sm leading-relaxed text-slate-400">
            Access is by invitation: accounts are created by GMN for its staff and clients. There is no public sign-up.
          </p>
        </section>

        <section className="grid gap-4 sm:grid-cols-3">
          {FEATURES.map(f => (
            <div key={f.title} className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/50 p-5">
              <h2 className="text-sm font-semibold text-white">{f.title}</h2>
              <p className="text-sm leading-relaxed text-slate-400">{f.body}</p>
            </div>
          ))}
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-white">How the portal uses Google data</h2>
          <p className="text-sm leading-relaxed text-slate-300">
            When a GMN team member connects Google, the portal asks for access to Google Ads so it can read the
            setup and performance of the Google Ads accounts GMN manages for its clients. That data is used only to
            report results to the client it belongs to and to review those campaigns. It is never sold or used for
            advertising. See our{' '}
            <Link href="/privacy" className="text-indigo-400 underline hover:text-indigo-300">
              Privacy Policy
            </Link>{' '}
            for details.
          </p>
        </section>

        <footer className="flex flex-wrap gap-4 border-t border-slate-800 pt-6 text-xs text-slate-500">
          <span>© Gym Members Now</span>
          <Link href="/privacy" className="hover:text-slate-300">
            Privacy Policy
          </Link>
          <Link href="/terms" className="hover:text-slate-300">
            Terms of Service
          </Link>
          <a href="mailto:support@gym-members-now.com" className="hover:text-slate-300">
            support@gym-members-now.com
          </a>
        </footer>
      </div>
    </div>
  );
}
