# Project Charter
## Meta Ads Client Reporting Portal

**Version:** 1.0  
**Date:** April 9, 2026  
**Status:** Draft

---

## 1. Project Overview

A white-label Meta Ads reporting portal that allows an agency to give each client a private login to view their own ad performance dashboard. The agency maintains an admin view to manage all client accounts, assign Meta ad accounts, and control access.

Modeled after the reporting experience of tools like GoHighLevel (GHL) but purpose-built for Meta Ads — using a custom dashboard already developed and in active use.

---

## 2. Problem Statement

Currently, sharing Meta Ads performance data with clients requires:
- Manual exports (CSV, screenshots)
- Granting clients direct access to Meta Business Manager
- Third-party tools (e.g. Looker Studio, AgencyAnalytics) that are generic and expensive

This project replaces that workflow with a branded, always-live portal that clients log into on demand — showing only their data, in a clean dashboard the agency controls.

---

## 3. Goals & Objectives

| # | Goal | Measure of Success |
|---|---|---|
| 1 | Clients can log in and view their own Meta Ads data | Login works, data is scoped to their accounts only |
| 2 | Agency admin can manage all clients from one view | Admin can add/remove clients, assign accounts, manage tokens |
| 3 | No manual reporting effort per client | Zero CSV exports or manual updates needed |
| 4 | Dashboard reflects live Meta API data | Data refreshes on demand via Meta Marketing API |
| 5 | Deployed and stable on hosting | Uptime >99%, no data leakage between clients |

---

## 4. Scope

### In Scope
- User authentication (email + password login)
- Role system: `admin` and `client`
- Admin panel: create clients, assign Meta ad account IDs, store access tokens
- Client portal: existing Meta Ads dashboard scoped to their accounts
- Multi-tenancy: strict data isolation per client
- Email: client invite, password reset
- Meta long-lived token storage per client
- Deployment to Railway with custom domain

### Out of Scope (Phase 1)
- Meta OAuth login flow for clients (admin manages tokens manually first)
- Mobile app
- Slack / email alerts for ad performance drops
- Billing / subscription management for clients
- White-label custom domain per client
- Google Ads or TikTok Ads integration

---

## 5. Stakeholders

| Role | Responsibility |
|---|---|
| Agency Owner (Project Sponsor) | Final decisions, client relationships, defines requirements |
| Developer | Architecture, build, deployment, maintenance |
| Clients | End users of the portal — view their own dashboard |

---

## 6. Technical Stack

| Layer | Technology | Reason |
|---|---|---|
| Framework | Next.js 14 (App Router) | Unified frontend + API, easy migration from current stack |
| Database | PostgreSQL via Railway | Relational, supports row-level security, co-located with app |
| Auth | NextAuth.js | Free, handles sessions, role-based routing |
| Email | Resend | Simple API, free up to 3K emails/mo |
| Hosting | Railway | $5/mo flat, no cold starts, Postgres included |
| CDN / SSL | Cloudflare | Free, automatic HTTPS, DDoS protection |
| Meta API | Meta Marketing API v22.0 | Existing integration — unchanged |
| Current Dashboard | Vanilla HTML + Chart.js + Tailwind | Migrated as Next.js page component |

---

## 7. Database Schema (High Level)

```
users
  id, email, password_hash, role (admin | client), created_at

clients
  id, name, created_by (admin user id), created_at

client_users
  client_id, user_id

meta_connections
  id, client_id, access_token (encrypted), ad_account_ids[], token_expires_at, updated_at
```

Row-level access control enforced at the API route layer — client users can only query their own `meta_connections` row.

---

## 8. Phases & Timeline

### Phase 1 — Foundation (Week 1–2)
- [ ] Scaffold Next.js project
- [ ] Set up Railway (app + Postgres)
- [ ] Configure Cloudflare + custom domain
- [ ] Implement auth: login, session, role-based redirect
- [ ] Admin route protection middleware
- [ ] Client route protection middleware

### Phase 2 — Admin Panel (Week 3)
- [ ] Admin dashboard: list all clients
- [ ] Create client account (name, email, temp password)
- [ ] Send invite email via Resend
- [ ] Assign Meta ad account IDs to client
- [ ] Store Meta long-lived access token per client (encrypted)
- [ ] Edit / deactivate client

### Phase 3 — Client Portal (Week 4)
- [ ] Migrate existing `Meta.html` dashboard into Next.js page
- [ ] Replace hardcoded token/account with session-scoped values from DB
- [ ] All API routes inject correct `access_token` and `account_id` from client record
- [ ] Client sees only their accounts — no cross-client data possible
- [ ] Test with real Meta API data end-to-end

### Phase 4 — Polish & Launch (Week 5–6)
- [ ] Branding: agency logo, portal name
- [ ] Error states: expired token warning to admin
- [ ] Loading states, empty states
- [ ] Password reset flow
- [ ] Security audit: no token exposure in client-side JS
- [ ] Load test with multiple concurrent client sessions
- [ ] Go live

---

## 9. Budget

### Infrastructure (Monthly)

| Item | Cost |
|---|---|
| Railway (app + Postgres) | $5/mo |
| Cloudflare | Free |
| Resend | Free (under 3K emails/mo) |
| Domain | ~$1/mo |
| **Total** | **~$6/mo** |

### Scaling Triggers

| Event | Action | New Cost |
|---|---|---|
| >10GB database | Upgrade Railway Postgres | +$10–20/mo |
| >100K req/mo | Still within Railway Hobby | No change |
| Need staging environment | Add Railway service | +$5/mo |

### One-Time Costs
- Domain registration: ~$12/year
- Developer time: internal (not billed to infrastructure)

---

## 10. Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Meta access token expires (60-day limit) | High | High | Admin gets notified when token is within 7 days of expiry. Phase 2 adds OAuth refresh. |
| Client sees another client's data | Low | Critical | Row-level checks on every API route. Pentest before launch. |
| Railway downtime | Low | High | Cloudflare caches static assets. Meta data is read-only so no data loss. |
| Meta API rate limits | Medium | Medium | Responses cached per client per date range for 15 minutes |
| Admin loses access | Low | High | At least 2 admin accounts created at launch |

---

## 11. Success Metrics (3 Months Post-Launch)

- [ ] At least 3 active client logins per month per client account
- [ ] Zero support requests for "can you send me the report"
- [ ] Zero data isolation incidents
- [ ] Dashboard load time under 3 seconds on first visit
- [ ] Agency owner can onboard a new client in under 10 minutes

---

## 12. Future Phases (Backlog)

- **Meta OAuth flow** — clients connect their own accounts without admin handling tokens
- **Alerts** — email/Slack when spend spikes or CPL exceeds threshold
- **Scheduled reports** — weekly PDF summary emailed to client automatically
- **Custom domain per client** — `reports.theirclinic.com` instead of `agency.com/client`
- **Billing integration** — Stripe, charge clients monthly via the portal
- **Multi-platform** — Google Ads, TikTok Ads tabs alongside Meta
- **White-label** — agency can resell the portal under their own brand to other agencies

---

## 13. Approvals

| Role | Name | Date | Signature |
|---|---|---|---|
| Project Sponsor | | | |
| Developer | | | |

---

*This document should be reviewed at the start of each phase and updated to reflect any scope or timeline changes.*
