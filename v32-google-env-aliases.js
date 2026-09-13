// Normalize Google OAuth variable names for the mailbox code.
// Railway currently stores the Gmail OAuth credentials as
// GOOGLE_GMAIL_CLIENT_ID / GOOGLE_GMAIL_CLIENT_SECRET.
const googleClientId = process.env.GOOGLE_GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const googleClientSecret = process.env.GOOGLE_GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';

if (googleClientId) {
  process.env.GOOGLE_GMAIL_CLIENT_ID = googleClientId;
  process.env.GOOGLE_CLIENT_ID = googleClientId;
  process.env.GOOGLE_OAUTH_CLIENT_ID = googleClientId;
}
if (googleClientSecret) {
  process.env.GOOGLE_GMAIL_CLIENT_SECRET = googleClientSecret;
  process.env.GOOGLE_CLIENT_SECRET = googleClientSecret;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = googleClientSecret;
}

require('./v40-twilio-subaccounts');
require('./v35-loader');
