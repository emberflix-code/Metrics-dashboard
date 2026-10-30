import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';

// Public page (not in the middleware matcher) — linked from the Google OAuth consent screen branding.
export const metadata: Metadata = {
  title: 'Privacy Policy — GMN Ads Portal',
  description: 'How Gym Members Now collects, uses and protects data in the GMN Ads Portal.',
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

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-slate-950 px-4 py-12">
      <div className="mx-auto max-w-3xl space-y-10">
        <header className="flex items-center gap-4">
          <div className="relative h-12 w-12 shrink-0">
            <Image src="/gmn.png" alt="GMN Logo" fill className="object-contain" priority />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Privacy Policy</h1>
            <p className="text-sm text-slate-400">GMN Ads Portal · Effective {EFFECTIVE_DATE}</p>
          </div>
        </header>

        <Section title="Who we are">
          <p>
            The GMN Ads Portal at gym-members-now.info is operated by Gym Members Now (&ldquo;GMN&rdquo;,
            &ldquo;we&rdquo;, &ldquo;us&rdquo;), a marketing agency for gyms and fitness businesses. The portal
            gives our team and our clients reporting on the advertising campaigns we manage for them. It is not a
            public consumer service; accounts are created by GMN for its staff and clients.
          </p>
        </Section>

        <Section title="Information we collect">
          <p>We collect only what is needed to run the portal and report on our clients&rsquo; campaigns:</p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="text-white">Account information</span> — the name, email address and password (stored
              only as a secure hash) of each portal user.
            </li>
            <li>
              <span className="text-white">Advertising data</span> — campaign, ad set, ad group, ad, keyword, budget,
              targeting and performance data (such as spend, impressions, clicks and leads) for ad accounts our clients
              have authorized us to manage, retrieved from Meta (Facebook/Instagram) and Google Ads.
            </li>
            <li>
              <span className="text-white">Lead and booking data</span> — lead counts and, where a client has asked for
              it, lead names and contact details from lead forms, connected spreadsheets and the client&rsquo;s CRM,
              used to report results back to that client.
            </li>
            <li>
              <span className="text-white">Technical data</span> — session cookies needed to keep you signed in, and
              standard server logs.
            </li>
          </ul>
        </Section>

        <Section title="Google user data">
          <p>
            When a GMN team member connects a Google account, the portal requests access to the Google Ads API
            (scope <code className="rounded bg-slate-800 px-1 py-0.5 text-xs">https://www.googleapis.com/auth/adwords</code>)
            to read the setup and performance of the Google Ads accounts GMN manages for its clients. We use this data
            only to show reporting in the portal and to review campaign setup for those clients.
          </p>
          <p>
            GMN&rsquo;s use and transfer of information received from Google APIs adheres to the{' '}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              className="text-indigo-400 underline hover:text-indigo-300"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements. In particular, we do not sell Google user data, do not use it for
            advertising to anyone, do not use it to train generalized AI or machine-learning models, and do not allow
            humans to read it except to operate and support the service, for security purposes, to comply with the
            law, or with the user&rsquo;s consent.
          </p>
        </Section>

        <Section title="How we use information">
          <ul className="list-disc space-y-2 pl-5">
            <li>To sign users in and show each client only the dashboards for their own business.</li>
            <li>To report advertising results, leads and costs to the client the data belongs to.</li>
            <li>To audit and improve the campaigns GMN manages on a client&rsquo;s behalf.</li>
            <li>To keep the portal secure and working properly.</li>
          </ul>
          <p>We do not sell personal information, and we do not use client data for anyone else&rsquo;s advertising.</p>
        </Section>

        <Section title="Sharing">
          <p>
            Data is shown only to GMN staff and to the client it belongs to. We use service providers to host and run
            the portal (for example our cloud hosting and database provider), who process data only on our
            instructions. We may disclose information if required by law.
          </p>
        </Section>

        <Section title="Storage, security and retention">
          <p>
            Data is stored on secured cloud infrastructure. Access tokens for connected Meta, Google and CRM accounts
            are encrypted at rest, connections use HTTPS, and passwords are stored only as hashes. We keep reporting
            data for as long as we manage a client&rsquo;s advertising and as needed for their historical reporting,
            and delete it when it is no longer needed or on request.
          </p>
        </Section>

        <Section title="Your choices">
          <p>
            You can ask us to access, correct or delete your information by emailing us. You can revoke the
            portal&rsquo;s access to a Google account at any time from your{' '}
            <a
              href="https://myaccount.google.com/permissions"
              className="text-indigo-400 underline hover:text-indigo-300"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google Account permissions
            </a>{' '}
            page, and to a Meta account from your Facebook Business Integrations settings.
          </p>
        </Section>

        <Section title="Changes and contact">
          <p>
            We may update this policy; the effective date above shows when it last changed. Questions or requests:{' '}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-400 underline hover:text-indigo-300">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Section>

        <footer className="border-t border-slate-800 pt-6 text-xs text-slate-500">
          <Link href="/login" className="hover:text-slate-300">
            GMN Ads Portal sign in
          </Link>
        </footer>
      </div>
    </div>
  );
}
