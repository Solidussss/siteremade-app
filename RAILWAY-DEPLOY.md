# SiteRemade — Railway deployment notes

This is the current V14 SiteRemade project prepared for its first hosted deployment.

## Preserved
- Current V14 app and Market Finder
- Supabase Auth/database and workspace isolation
- Leads, inbox, calendar, invoices, analytics, automations and Website Updates
- Subscription gate and owner bypass
- Existing Stripe scaffolding (not configured yet)
- Existing Google Places/OpenAI hooks
- Current customizer/public assets and exact logo/favicon

## Production cleanup applied
1. Normalized uploaded filenames to the names the Node server serves.
2. Updated the PWA service-worker registration/cache from V12/V13 references to V14.
3. The Stripe webhook now returns 503 until `STRIPE_WEBHOOK_SECRET` exists, so an unsigned public request cannot mutate payment/subscription state before Stripe is configured.
4. Added `.gitignore`; secrets, `node_modules`, legacy local `data/`, logs and macOS files stay out of GitHub.
5. Added `.env.example` with variable names only.
6. Excluded `node_modules/` and `data/store.json`. Railway installs dependencies from package files and the current app is Supabase-backed.

## First deployment order
1. Push this folder to a private GitHub repo.
2. Create a Railway service from the repo.
3. Add the Supabase variables and the integration variables already in use.
4. Set `NODE_ENV=production`.
5. Test using Railway's generated HTTPS domain first.
6. Verify `/api/system/status`, owner/client login, workspace switching, Market Finder, Website Updates, invoice creation/deletion, AI/Places features you have configured, and mobile layout.
7. Attach `app.siteremade.com` only after the generated domain passes those tests.
8. Set `PUBLIC_BASE_URL=https://app.siteremade.com` after the custom domain is active.
9. Then begin Stripe in test mode.

## Do not
- Commit `.env` or any real keys.
- Commit `node_modules/`.
- Re-run the full Supabase schema merely because the app moved to Railway.
- Put the Supabase secret/service-role key into browser JavaScript.
- Enable live Stripe before test checkout/webhook/Connect flows pass.
