import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';

// Public page (not in the middleware matcher) — linked from the Google OAuth consent screen branding.
export const metadata: Metadata = {
  title: 'Terms of Service — GMN Ads Portal',
  description: 'Terms for using the GMN Ads Portal operated by Gym Members Now.',
};

const CONTACT_EMAIL = 'support@gym-members-now.com';
const EFFECTIVE_DATE = 'October 31, 2026';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-slate-300">{children}</div>
    </section>
  );
}

export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen bg-slate-950 px-4 py-12">
      <div className="mx-auto max-w-3xl space-y-10">
        <header className="flex items-center gap-4">
          <div className="relative h-12 w-12 shrink-0">
            <Image src="/gmn.png" alt="GMN Logo" fill className="object-contain" priority />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Terms of Service</h1>
            <p className="text-sm text-slate-400">GMN Ads Portal · Effective {EFFECTIVE_DATE}</p>
          </div>
        </header>

        <Section title="About the portal">
          <p>
            The GMN Ads Portal at gym-members-now.info (the &ldquo;Portal&rdquo;) is operated by Gym Members Now
            (&ldquo;GMN&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;). It gives GMN staff and GMN&rsquo;s clients
            reporting on the advertising campaigns GMN manages. By signing in or using the Portal you agree to these
            terms. Your marketing services agreement with GMN, if you have one, governs the services themselves; these
            terms cover use of the Portal.
          </p>
        </Section>

        <Section title="Accounts">
          <ul className="list-disc space-y-2 pl-5">
            <li>Accounts are created by GMN for its staff and clients. Access is personal to the person it was issued to.</li>
            <li>
              Keep your password and any auto-login link private. You are responsible for activity under your account
              and should tell us promptly at {CONTACT_EMAIL} if you think it has been misused.
            </li>
            <li>We may suspend or remove access, for example when a client relationship ends or to protect the Portal.</li>
          </ul>
        </Section>

        <Section title="Acceptable use">
          <p>You agree not to:</p>
          <ul className="list-disc space-y-2 pl-5">
            <li>access dashboards or data that belong to another client, or try to get around access controls;</li>
            <li>interfere with, overload, scan or reverse-engineer the Portal;</li>
            <li>use the Portal or its data for anything unlawful.</li>
          </ul>
        </Section>

        <Section title="Connected accounts and data">
          <p>
            The Portal reads data from advertising and business platforms such as Meta, Google Ads, Google Sheets and
            client CRMs, using access that GMN or the client has authorized. Each platform&rsquo;s own terms continue to
            apply to those accounts. How we handle this data is described in our{' '}
            <Link href="/privacy" className="text-indigo-400 underline hover:text-indigo-300">
              Privacy Policy
            </Link>
            .
          </p>
          <p>
            Clients keep ownership of their business and advertising data. GMN keeps ownership of the Portal itself,
            including its software, design and report formats.
          </p>
        </Section>

        <Section title="Reporting accuracy">
          <p>
            Figures in the Portal come from third-party platforms and connected spreadsheets, which can be delayed,
            revised or reported differently by each platform. We work to keep the Portal accurate, but it is provided
            &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, and the source platform&rsquo;s own figures (for
            example for billing) take precedence over what the Portal shows.
          </p>
        </Section>

        <Section title="Liability">
          <p>
            To the extent the law allows, GMN is not liable for indirect or consequential losses arising from use of
            the Portal, or for interruptions or errors caused by third-party platforms. Nothing in these terms limits
            liability that cannot be limited by law.
          </p>
        </Section>

        <Section title="Changes and contact">
          <p>
            We may update these terms; the effective date above shows when they last changed, and continued use of the
            Portal means you accept the update. Questions:{' '}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-400 underline hover:text-indigo-300">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Section>

        <footer className="flex gap-4 border-t border-slate-800 pt-6 text-xs text-slate-500">
          <Link href="/privacy" className="hover:text-slate-300">
            Privacy Policy
          </Link>
          <Link href="/login" className="hover:text-slate-300">
            GMN Ads Portal sign in
          </Link>
        </footer>
      </div>
    </div>
  );
}
