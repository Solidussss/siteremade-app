'use strict';
// An in-memory stand-in for the Supabase query builder -- only the calls lib/website-links.js and routes/
// website-bridge.js make (select / eq / not-is-null / order / limit / maybeSingle / single / insert / update / delete), with the
// one constraint that matters here: website_project_links.generator_project_id is UNIQUE (V52/V54), so a second link
// for the same project fails exactly like Postgres ("duplicate key value violates unique constraint"). Every write is
// recorded, so a test can prove what was (and wasn't) inserted or updated. Nothing reaches a real database.
const UNIQUE = { website_project_links: ['generator_project_id'] };

function createFakeSupabase(seed) {
  const tables = {}; const writes = [];
  for (const [t, rows] of Object.entries(seed || {})) tables[t] = rows.map(r => ({ ...r }));
  const rowsOf = t => (tables[t] = tables[t] || []);
  let nextId = 1;
  function query(table) {
    const q = { table, filters: [], orderBy: null, max: null, op: 'select', payload: null, returning: false };
    const run = () => {
      const all = rowsOf(table);
      const match = r => q.filters.every(f => f(r));
      if (q.op === 'insert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        for (const row of list) for (const col of UNIQUE[table] || []) if (all.some(r => r[col] === row[col])) return { data: null, error: { message: `duplicate key value violates unique constraint "${table}_${col}_key"` } };
        const made = list.map(row => ({ id: nextId++, ...row }));
        all.push(...made); writes.push({ op: 'insert', table, rows: made.map(r => ({ ...r })) });
        return { data: made.map(r => ({ ...r })), error: null };
      }
      if (q.op === 'delete') {
        const hit = all.filter(match); tables[table] = all.filter(r => !match(r));
        writes.push({ op: 'delete', table, count: hit.length, rows: hit.map(r => ({ ...r })) });
        return { data: hit.map(r => ({ ...r })), error: null };
      }
      if (q.op === 'update') {
        const hit = all.filter(match); hit.forEach(r => Object.assign(r, q.payload));
        writes.push({ op: 'update', table, count: hit.length, patch: { ...q.payload } });
        return { data: hit.map(r => ({ ...r })), error: null };
      }
      let out = all.filter(match).map(r => ({ ...r }));
      if (q.orderBy) { const { col, asc } = q.orderBy; out.sort((a, b) => (String(a[col]).localeCompare(String(b[col]))) * (asc ? 1 : -1)); }
      if (q.max != null) out = out.slice(0, q.max);
      return { data: out, error: null };
    };
    const api = {
      select() { if (q.op !== 'select') q.returning = true; return api; },
      eq(col, v) { q.filters.push(r => r[col] === v); return api; },
      not(col, op, v) { if (op === 'is' && v === null) q.filters.push(r => r[col] != null); return api; },
      order(col, o) { q.orderBy = { col, asc: !(o && o.ascending === false) }; return api; },
      limit(n) { q.max = n; return api; },
      insert(payload) { q.op = 'insert'; q.payload = payload; return api; },
      update(patch) { q.op = 'update'; q.payload = patch; return api; },
      delete() { q.op = 'delete'; return api; },
      async maybeSingle() { const r = run(); if (r.error) return r; if (r.data.length > 1) return { data: null, error: { message: 'multiple rows' } }; return { data: r.data[0] || null, error: null }; },
      async single() { const r = run(); if (r.error) return r; if (r.data.length !== 1) return { data: null, error: { message: 'not exactly one row' } }; return { data: r.data[0], error: null }; },
      then(resolve, reject) { try { resolve(run()); } catch (e) { reject(e); } },
    };
    return api;
  }
  return { from: query, tables, writes, rows: t => rowsOf(t).map(r => ({ ...r })) };
}

module.exports = { createFakeSupabase };
