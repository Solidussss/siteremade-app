// Explicit request router — replaces the http.createServer monkeypatch chain.
//
// Historically, every new backend feature added its own vNN-*.js file that
// did `const prev = http.createServer.bind(http); http.createServer =
// listener => prev((req,res) => { ...intercept some routes...; return
// listener(req,res); })`. Whichever file required *earliest* got first look
// at every request, which produced real, hard-to-see bugs (see
// PHASE3-ROUTE-MAP.md): some routes were silently shadowed by an
// earlier-loaded file defining the same method+path, and reading "what
// happens for POST /api/app/whatever" required tracing the whole require
// order.
//
// This module is a single, explicit route table instead: method + path
// pattern + auth requirement + handler, matched in registration order (no
// import-order-dependent shadowing — if two routes collide it's a visible
// bug in this file, not a side effect of require() order). It reuses
// lib/context.js for session/workspace resolution exactly like server.js's
// existing api() dispatcher does, so a migrated route behaves identically
// to its vNN original.
//
// Migration is incremental on purpose (see the Phase 3 brief): server.js's
// top-level handler tries the router first, and falls through to whatever
// legacy dispatcher(s) still exist for anything not yet migrated. A vNN
// file is only deleted once every route it owned has a route module here
// and has been tested.

const { getAuthUser, getContext } = require('./context');

function compilePattern(pattern) {
  const paramNames = [];
  const regexStr = pattern
    .split('/')
    .map(seg => {
      if (seg.startsWith(':')) { paramNames.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

class Router {
  constructor() {
    this.routes = [];
  }

  // opts: { auth: 'none'|'user'|'owner' } — default 'none'. 'user' resolves
  // full workspace context (getContext) and 401s if missing. 'owner' does
  // the same and additionally 403s if the resolved context isn't an owner.
  // A route that only needs the signed-in user/profile without workspace
  // resolution (rare — most of this app is workspace-scoped) can pass
  // { auth: 'session' } to get getAuthUser() instead of getContext().
  add(method, pattern, opts, handler) {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const { regex, paramNames } = compilePattern(pattern);
    this.routes.push({ method: method.toUpperCase(), pattern, regex, paramNames, auth: opts.auth || 'none', handler });
    return this;
  }
  get(pattern, opts, handler) { return this.add('GET', pattern, opts, handler); }
  post(pattern, opts, handler) { return this.add('POST', pattern, opts, handler); }
  patch(pattern, opts, handler) { return this.add('PATCH', pattern, opts, handler); }
  put(pattern, opts, handler) { return this.add('PUT', pattern, opts, handler); }
  delete(pattern, opts, handler) { return this.add('DELETE', pattern, opts, handler); }

  // Merge another Router's routes into this one (used to compose route
  // modules — each routes/*.js file builds its own small Router and
  // exports it; server.js merges them all into one top-level router).
  use(otherRouter) {
    this.routes.push(...otherRouter.routes);
    return this;
  }

  find(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (m) {
        const params = {};
        route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
        return { route, params };
      }
    }
    return null;
  }

  // Returns true if a route matched and was handled (including auth
  // failures — those are still "handled", just with a 401/403 response).
  // Returns false only when no route pattern matched at all, so the caller
  // can fall through to a legacy dispatcher for anything not yet migrated.
  async dispatch(req, res, u, json) {
    const found = this.find(req.method, u.pathname);
    if (!found) return false;
    const { route, params } = found;
    let context = null;
    if (route.auth === 'session') {
      context = await getAuthUser(req, res);
      if (!context) { json(res, 401, { ok: false, message: 'Authentication required.' }); return true; }
    } else if (route.auth === 'user' || route.auth === 'owner') {
      context = await getContext(req, res, u);
      if (!context) { json(res, 401, { ok: false, message: 'Authentication required.' }); return true; }
      if (route.auth === 'owner' && !context.owner) { json(res, 403, { ok: false, message: 'Owner access required.' }); return true; }
    }
    try {
      await route.handler(req, res, { params, c: context, u, json });
    } catch (e) {
      console.error(`[router] ${route.method} ${route.pattern}:`, e);
      // Several migrated handlers throw Error objects with a custom
      // `.status` (e.g. a Google Ads API 409/429 passed through) and expect
      // that exact status back, not a blanket 500 — matches what their
      // original http.createServer wrappers did with `send(res, e.status ||
      // 500, ...)`.
      if (!res.headersSent) json(res, e.status || 500, { ok: false, message: e.message || 'Server error' });
    }
    return true;
  }
}

module.exports = { Router };
