'use strict';
// THE WEBSITE ADMIN -- the one SiteRemade account allowed to delete websites (any account's, any business's, drafts and
// purchased). The owner's decision: exactly this account, by its email, and no one else. No role grants it: not a
// business's owner or admin (workspace_members.role), not a member, and not SiteRemade staff (profiles.role 'owner' --
// lib/context.js `c.owner`, which sees every workspace). The email is the signed-in user's own, as Supabase verified it
// for their session (lib/context.js getAuthUser), and it must be CONFIRMED. The builder (siteremade lib/website-admin.js)
// holds the same list and checks it again on its own.
const WEBSITE_ADMIN_EMAILS = Object.freeze(['jaydenflynn9@gmail.com']);

// c: the request context (lib/context.js getContext) -> true only for the website admin
function isWebsiteAdmin(c) {
  const u = c && c.user;
  if (!u || !(u.email_confirmed_at || u.confirmed_at)) return false;
  return WEBSITE_ADMIN_EMAILS.includes(String(u.email || '').trim().toLowerCase());
}

module.exports = { WEBSITE_ADMIN_EMAILS, isWebsiteAdmin };
