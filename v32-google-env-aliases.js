// Normalize Google OAuth variable names for the mailbox code.
if (!process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_CLIENT_ID) {
  process.env.GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
}
if (!process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_CLIENT_SECRET) {
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
}
