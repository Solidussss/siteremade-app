// Normalize Google OAuth variable names so the existing mailbox/auth code works
// with the Railway variables already configured for SiteRemade.
if (!process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_CLIENT_ID) {
  process.env.GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
}
if (!process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_CLIENT_SECRET) {
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
}
