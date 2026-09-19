// Aggregates every migrated route module onto one Router instance. See
// lib/router.js for why this replaces the http.createServer monkeypatch
// chain, and PHASE3-ROUTE-MAP.md for the full inventory of what has and
// hasn't moved here yet. server.js merges this router's routes in front of
// its own legacy api() dispatcher, so anything not yet listed below still
// falls through to whichever file currently owns it.
const { Router } = require('../lib/router');

const registerers = [
  require('./integrations'),
  require('./twilio-provisioning'),
  require('./google-ads'),
  require('./ad-intelligence'),
  require('./twilio-existing-number')
];

function buildRouter() {
  const router = new Router();
  for (const register of registerers) register(router);
  return router;
}

module.exports = { buildRouter };
