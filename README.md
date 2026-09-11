# SiteRemade App V5 — Supabase

V5 replaces the local JSON/auth layer with Supabase Auth + Postgres while keeping the V4 UI and API shape.

## 1. Create the Supabase project

1. Create a Supabase project.
2. Open **SQL Editor**, paste the full contents of `supabase-schema.sql`, and run it once.
3. In **Project Settings → API**, copy:
   - Project URL
   - anon/public key
   - service-role key

Never put the service-role key in browser JavaScript or a client website. V5 uses it only on the Node server.

## 2. Configure SiteRemade

Duplicate `.env.example` as `.env` and fill in:

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
OWNER_EMAIL=your-real-email@example.com
OWNER_PASSWORD=use-a-strong-password
OWNER_NAME=Jayden Flynn
OWNER_WORKSPACE=SiteRemade Demo
```

Optional Stripe/OpenAI/Resend/Twilio keys can stay blank until those integrations are ready.

## 3. Install + create the first owner

```bash
npm install
npm run bootstrap-owner
npm start
```

Open `http://localhost:8080` and sign in using `OWNER_EMAIL` / `OWNER_PASSWORD`.

`bootstrap-owner` is safe to run again: it finds the existing owner instead of creating duplicates.

## What is cloud-backed now

- User/password authentication is handled by Supabase Auth.
- Passwords are not stored by SiteRemade.
- Sessions use HttpOnly access/refresh cookies.
- Workspaces and memberships are stored in Postgres.
- Leads, notes, conversations, messages, appointments, invoices, automations, activity, and audit logs are stored in Postgres.
- Each client user is granted membership only to assigned workspaces.
- The SiteRemade owner account can access all workspaces.
- Row Level Security is enabled in the schema as an additional boundary.
- Admin-created client accounts are real Supabase Auth users.
- Deleting a lead cascades its conversation/messages and keeps unrelated workspaces untouched.

## Public website lead capture

Every workspace has both an ID and a generated `publicKey`. Public endpoints require both so a bare workspace UUID is not enough to inject leads.

POST:

```text
/api/public/lead
```

Body:

```json
{
  "workspaceId": "WORKSPACE_UUID",
  "publicKey": "WORKSPACE_PUBLIC_KEY",
  "name": "Sarah Mitchell",
  "email": "sarah@example.com",
  "phone": "403-555-0191",
  "service": "Panel upgrade",
  "message": "Looking for a quote"
}
```

For the chat widget:

```html
<script
  src="https://app.siteremade.com/widget.js"
  data-workspace="WORKSPACE_UUID"
  data-public-key="WORKSPACE_PUBLIC_KEY"
></script>
```

The `publicKey` is intentionally public/embeddable; the Supabase service-role key is not.

## Production deployment

On Railway (or another Node host), add the same environment variables to the service instead of committing `.env`. Set:

```env
NODE_ENV=production
PUBLIC_BASE_URL=https://app.siteremade.com
```

Do not commit `.env`.

## Stripe webhook

When Stripe is enabled, point the webhook to:

```text
https://app.siteremade.com/api/webhooks/stripe
```

and add the signing secret as `STRIPE_WEBHOOK_SECRET`.

## Important next integrations

The database/auth foundation is production-oriented, but live AI, SMS, email, Stripe payouts, Google Calendar OAuth, and Google/Meta ads still require their real provider credentials/accounts. Their UI/hooks remain in the app.


## V6 additions

- AI Business Assistant on Home (reads the current workspace data).
- Lead Bot / Find Leads using Google Places when `GOOGLE_PLACES_API_KEY` is configured.
- Ad spend tracking inside Analytics with CPL and ROAS.
- Appointment reminder worker that checks enabled reminder automation and sends activity/email/SMS once per appointment.
- `New lead alert` now controls both the activity notification and website email/SMS alert.

Optional new environment variable:

```env
GOOGLE_PLACES_API_KEY=
```

Google/Meta live ad-account syncing still requires provider OAuth/API credentials. Until then, ad spend can be entered manually and the AI assistant can analyze it.

## V7 additions

- Self-service client account creation from the sign-in screen.
- Signup creates a Supabase Auth user, client profile, isolated workspace, membership, and default automations, then signs the client in.
- AI receptionist test button in Settings.
- Website chat now collects name/email/phone and saves them onto the lead.
- AI receptionist uses the workspace services, service area, and tone to qualify inquiries without inventing prices or availability.
- Google Places and OpenAI connection status are shown in Settings.

No new SQL migration is required for these V7 changes if the V6 schema has already been applied.


## V8 additions — commercial layer

- SiteRemade monthly subscription checkout through the platform Stripe account.
- Stripe Billing Portal route for clients to manage their SiteRemade subscription/payment method.
- Client-funded advertising balance for Google / Meta / Both.
- Ad funds are paid to the SiteRemade platform account, while customer invoices still use each client's connected Stripe account.
- Payments screen separates SiteRemade billing, advertising funds, and the client's own customer invoices.
- Stripe webhook tracks subscription status and marks advertising funding as Funded after successful Checkout.
- Checkout return confirmation also verifies completed sessions, which makes localhost testing possible without relying only on a public webhook.

Run the V8 SQL addition at the bottom of `supabase-schema.sql` once.

Optional environment variable:
```env
SITEREMADE_MONTHLY_PRICE_CENTS=25000
```
The default is 25000 = $250/month in the workspace currency. Change this before production if your monthly price changes.

For production, configure `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `PUBLIC_BASE_URL`. The existing Stripe webhook URL remains `/api/webhooks/stripe`.


## V9 — managed growth workflow

- SiteRemade owner manages client growth from the owner account and can open any client workspace.
- Admin now shows lead count, advertising funded, advertising spent, and subscription status per workspace.
- Leads imported by the SiteRemade owner are marked `SiteRemade`; client self-prospecting remains optional and is marked `Lead Bot`.
- Clients can fund/approve Google + Meta advertising budgets, but only the SiteRemade owner can record campaign spend/performance.
- Client analytics are read-only for managed ad spend; owner sees the campaign reporting form.
- Customer invoices remain separate from SiteRemade subscription and advertising funds.
- No additional SQL migration is required beyond the V8 schema.


## V10 — subscription enforcement

- SiteRemade owner accounts always retain full access.
- Client workspaces require an active or trialing SiteRemade subscription.
- Unpaid, canceled, or past-due client accounts can sign in but are shown only the activation/billing screen.
- Locked client bootstrap responses contain no leads, conversations, appointments, invoices, automations, activity, ad spend, or ad-fund records.
- Billing checkout, billing portal, checkout confirmation, and logout remain available while locked.
- Client data is never deleted when access is locked; it becomes available again when billing returns to active/trialing.
- No new V10 SQL migration is required. V10 uses the subscription fields already added in V8.


## V11 — strict unpaid-client lock fix

V10 had the server-side lock inserted too late in the route file. That meant several business routes could still execute before the subscription check was reached. V11 moves the lock immediately after authentication/bootstrap/workspace selection so unpaid clients are rejected before all business feature routes.

V11 also cache-busts app.js/app.css and unregisters older service workers before registering the V11 worker, preventing an older cached SiteRemade UI from masking the new lock screen.

No new SQL is required.


## V12 — prospect history + website traffic framework

- Find Leads now remembers prospects that have been opened or imported. Viewed prospects return with a different card treatment and a `VIEWED` badge, even on later searches in the same workspace.
- Viewed state is isolated per workspace, so one client's research does not mark another client's prospects.
- Analytics now includes a Website Traffic panel available to paid clients and the SiteRemade owner.
- The business domain can be saved now. Real sessions/users/pageviews are intentionally not fabricated from a domain alone; those fields are ready for a Google Analytics connection/sync.
- Run `V12-MIGRATION.sql` once before starting V12.


## V13 additions

- Inbox badge now reflects the actual unread conversation count.
- New-lead percentage is calculated against the previous equal period (30 or 90 days) instead of being hard-coded.
- Customer invoices/transaction records can be deleted from SiteRemade. Deleting a record does not refund a Stripe payment.
- Google/Meta advertising UI is intentionally blocked as Coming Soon while preserving the underlying ad funding/spend code and database data.
- New Website Updates module for clients to send page/priority/change requests. SiteRemade owners can move requests through Requested → In Progress → Completed.
- Run `V13-MIGRATION.sql` once after V12 to create the website_updates table.
