require('dotenv').config();

const http = require('http');
const { URL } = require('url');

const originalCreateServer = http.createServer.bind(http);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const { db, anon } = require('./lib/context');

function json(res, status, obj, cookies = []) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' };
  if (cookies.length) headers['Set-Cookie'] = cookies;
  res.writeHead(status, headers);
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 200000) { reject(new Error('Payload too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function publicOrigin(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}
function sessionCookies(session) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return [
    `sr_access=${encodeURIComponent(session.access_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(60, Number(session.expires_in) || 3600)}${secure}`,
    `sr_refresh=${encodeURIComponent(session.refresh_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`
  ];
}
async function ensureProfileAndWorkspace(user) {
  if (!db) throw new Error('Supabase is not configured.');
  const existing = await db.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return;
  const email = String(user.email || '').trim().toLowerCase();
  const meta = user.user_metadata || {};
  const name = String(meta.full_name || meta.name || email.split('@')[0] || 'SiteRemade User').trim().slice(0, 120);
  const p = await db.from('profiles').upsert({ id: user.id, name, role: 'client' });
  if (p.error) throw p.error;
  const workspace = await db.from('workspaces').insert({ business_name: `${name}'s Business`.slice(0, 160), email, timezone: 'America/Edmonton', currency: 'CAD', plan: 'Growth', ai_enabled: true, ai_services: '', ai_service_area: '', ai_tone: 'Helpful, concise, professional' }).select('*').single();
  if (workspace.error) throw workspace.error;
  const member = await db.from('workspace_members').insert({ workspace_id: workspace.data.id, user_id: user.id, role: 'admin' });
  if (member.error) throw member.error;
}
async function startGoogle(req, res) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    res.writeHead(302, { Location: '/?auth_error=' + encodeURIComponent('Supabase auth is not configured.'), 'Cache-Control': 'no-store' });
    return res.end();
  }
  const redirectTo = `${publicOrigin(req)}/?google_oauth=1`;
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/authorize`);
  url.searchParams.set('provider', 'google');
  url.searchParams.set('redirect_to', redirectTo);
  res.writeHead(302, { Location: url.toString(), 'Cache-Control': 'no-store' });
  res.end();
}
async function finishGoogle(req, res) {
  if (!anon || !db) return json(res, 503, { ok: false, message: 'Supabase auth is not configured.' });
  const body = await readJson(req);
  const accessToken = String(body.access_token || '').trim();
  const refreshToken = String(body.refresh_token || '').trim();
  if (!accessToken || !refreshToken) return json(res, 400, { ok: false, message: 'Google did not return a complete session.' });
  const verified = await anon.auth.getUser(accessToken);
  const user = verified.data?.user;
  if (verified.error || !user) return json(res, 401, { ok: false, message: 'Google session could not be verified.' });
  await ensureProfileAndWorkspace(user);
  return json(res, 200, { ok: true }, sessionCookies({ access_token: accessToken, refresh_token: refreshToken, expires_in: Number(body.expires_in) || 3600 }));
}
function injectGoogleAuth(html) {
  if (html.includes('google-auth-button')) return html;
  const button = `<a class="google-auth-button" href="/auth/google"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.41Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.36l-3.24-2.54c-.9.6-2.05.96-3.38.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.39 13.93A6.02 6.02 0 0 1 6.08 12c0-.67.11-1.32.31-1.93V7.45H3.04A10 10 0 0 0 2 12c0 1.61.39 3.14 1.04 4.55l3.35-2.62Z"/><path fill="#EA4335" d="M12 5.94c1.47 0 2.78.5 3.82 1.5l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.96 5.45l3.35 2.62C7.18 7.7 9.39 5.94 12 5.94Z"/></svg><span>Continue with Google</span></a><div class="auth-divider"><span>or</span></div>`;
  html = html.replace('<label>Email<input name="email" type="email"', `${button}<label>Email<input name="email" type="email"`);
  const css = `<style id="google-auth-style">.google-auth-button{height:46px;border:1px solid #d9dde5;border-radius:999px;background:#fff;color:#17191d;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:10px;font-size:12px;font-weight:750;margin:18px 0 12px;transition:.15s ease}.google-auth-button:hover{background:#f7f8fa;border-color:#c8cdd6}.google-auth-button svg{width:18px;height:18px;flex:none}.auth-divider{display:flex;align-items:center;gap:10px;color:#9aa0aa;font-size:9px;margin:0 0 12px}.auth-divider:before,.auth-divider:after{content:"";height:1px;background:#e5e7eb;flex:1}.auth-divider span{text-transform:uppercase;letter-spacing:.12em}</style>`;
  html = html.replace('</head>', `${css}</head>`);
  const script = `<script>(async function(){var q=new URLSearchParams(location.search),err=q.get('auth_error');if(err){var s=document.getElementById('loginStatus');if(s){s.textContent=err;s.style.color='#c54747'}history.replaceState({},'',location.pathname);return}if(q.get('google_oauth')!=='1')return;var h=new URLSearchParams(location.hash.replace(/^#/,'')),a=h.get('access_token'),r=h.get('refresh_token'),x=h.get('expires_in');if(!a||!r){var e=document.getElementById('loginStatus');if(e)e.textContent='Google sign-in did not return a session.';return}try{var resp=await fetch('/api/auth/oauth-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_token:a,refresh_token:r,expires_in:Number(x)||3600})}),data=await resp.json();if(!resp.ok||data.ok===false)throw new Error(data.message||'Google sign-in failed.');history.replaceState({},'',location.pathname);location.reload()}catch(ex){var s2=document.getElementById('loginStatus');if(s2){s2.textContent=ex.message;s2.style.color='#c54747'}}})();</script>`;
  html = html.replace('</body>', `${script}</body>`);
  return html;
}

http.createServer = function patchedGoogleCreateServer(listener) {
  return originalCreateServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && u.pathname === '/auth/google') return await startGoogle(req, res);
      if (req.method === 'POST' && u.pathname === '/api/auth/oauth-session') return await finishGoogle(req, res);
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
        const originalEnd = res.end.bind(res);
        res.end = (chunk, ...args) => {
          try {
            const type = String(res.getHeader('Content-Type') || '');
            if (chunk && type.includes('text/html')) {
              const input = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
              const output = injectGoogleAuth(input);
              res.removeHeader('Content-Length');
              return originalEnd(output, ...args);
            }
          } catch (error) {
            console.error('Google auth HTML injection:', error);
          }
          return originalEnd(chunk, ...args);
        };
      }
      return listener(req, res);
    } catch (error) {
      console.error('Google auth middleware:', error);
      if (!res.headersSent) return json(res, 500, { ok: false, message: error?.message || 'Google sign-in failed.' });
      res.end();
    }
  });
};
