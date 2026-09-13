// Normalize the Google OAuth variable names used by the existing mailbox code.
if (!process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_CLIENT_ID) {
  process.env.GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
}
if (!process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_CLIENT_SECRET) {
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
}

// v17-server already loads this file immediately before v29-mail-server.
// Load the Gmail compatibility layer immediately after v29 so it can override
// only the Gmail status/connect/callback routes while leaving the rest of the
// mailbox implementation untouched.
const Module = require('module');
const originalLoad = Module._load;
let gmailFixLoaded = false;
Module._load = function patchedLoad(request, parent, isMain) {
  if (!gmailFixLoaded && request === './v29-mail-server') {
    const result = originalLoad.apply(this, arguments);
    gmailFixLoaded = true;
    originalLoad.call(this, './v33-gmail-oauth-fix', parent, false);
    Module._load = originalLoad;
    return result;
  }
  return originalLoad.apply(this, arguments);
};
