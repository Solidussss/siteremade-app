# SiteRemade V16 — live customer workflow

## What changed
- Live 5-second dashboard sync: new website leads/messages update badges without a manual refresh.
- Leads, Inbox and top notifications show actionable counts.
- Website form inquiries now always create an Inbox conversation tied to the lead.
- Customer website-chat messages increment unread counts.
- Human takeover is respected: AI no longer keeps replying after the business takes over.
- Business replies clear unread state and automatically move New leads to Contacted.
- Inbox shows the customer phone/email plus which delivery channels are actually live.
- Business replies always return to website chat and also fan out to Resend email / Twilio SMS when configured.
- Send result is visible in the Inbox so it no longer feels like messaging into a wall.
- In-app toasts surface new leads and new customer messages while the owner is signed in.

## No SQL migration required
This release uses the existing leads, conversations and messages tables.

## Required integrations for off-site delivery
- RESEND_API_KEY (+ RESEND_FROM recommended) for automatic email delivery.
- TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM for automatic SMS delivery.
Website chat works without those providers.
