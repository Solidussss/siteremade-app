require('dotenv').config();
const http = require('http');
const fs = require('fs');
const previousCreateServer = http.createServer.bind(http);
const previousReadFileSync = fs.readFileSync.bind(fs);
const { db, sendJson: send, readJsonBody, getContext: context } = require('./lib/context');

const clean = (v, n = 12000) => String(v ?? '').trim().slice(0, n);
async function readBody(req) {
  return readJsonBody(req, 1_500_000);
}

function extractJson(text) {
  const raw = clean(text, 50000);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw Error('AI did not return a structured website brief.');
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeBrief(input = {}) {
  const style = input.styleDirection || input.style_direction || {};
  const content = input.content || {};
  const builderPrompt = clean(input.builderPrompt || input.builder_prompt, 30000);
  return {
    summary: clean(input.summary, 2000),
    businessPositioning: clean(input.businessPositioning || input.business_positioning, 3000),
    styleDirection: {
      style: clean(style.style, 300),
      visualTone: clean(style.visualTone || style.visual_tone, 500),
      colors: Array.isArray(style.colors) ? style.colors.slice(0, 8).map(x => clean(x, 120)) : [],
      typography: clean(style.typography, 800),
      layout: clean(style.layout, 1500),
      motion: clean(style.motion, 1200)
    },
    content: {
      hero: content.hero && typeof content.hero === 'object' ? content.hero : {},
      services: Array.isArray(content.services) ? content.services.slice(0, 12) : [],
      trust: Array.isArray(content.trust) ? content.trust.slice(0, 12) : [],
      about: clean(content.about, 3000),
      faq: Array.isArray(content.faq) ? content.faq.slice(0, 12) : [],
      quoteForm: content.quoteForm || content.quote_form || {}
    },
    buildRules: Array.isArray(input.buildRules || input.build_rules) ? (input.buildRules || input.build_rules).slice(0, 30).map(x => clean(x, 1000)) : [],
    avoid: Array.isArray(input.avoid) ? input.avoid.slice(0, 30).map(x => clean(x, 1000)) : [],
    builderPrompt
  };
}

function promptForWebsite({ workspace, lead, intakeText, existingBrief, revision }) {
  const source = {
    workspace: {
      businessName: workspace?.business_name || '',
      services: workspace?.ai_services || '',
      serviceArea: workspace?.ai_service_area || '',
      tone: workspace?.ai_tone || ''
    },
    lead: lead ? {
      name: lead.name || '',
      email: lead.email || '',
      phone: lead.phone || '',
      service: lead.service || '',
      message: lead.message || '',
      source: lead.source || ''
    } : null,
    intake: clean(intakeText, 18000),
    existingBrief: existingBrief || null,
    revision: clean(revision, 8000)
  };
  return `You are SiteRemade's senior website strategist, conversion copywriter and design director.

Your job is to turn the supplied client/lead information into a production-ready website brief that another coding agent can build without guessing.

Important rules:
- Treat the chosen website style, colours, layout, sections, business details and client notes in the intake as constraints, not suggestions.
- Preserve the client's actual business identity. Do not invent awards, years in business, certifications, reviews, prices, team members, project counts, warranties, service areas or claims that were not supplied.
- Make the site feel custom to this specific business rather than like a generic contractor/SaaS template.
- Write useful real copy where the source supports it. If information is missing, use clearly marked neutral placeholders or instruct the builder to omit the claim.
- The finished site should feel expensive, editorial and intentional: strong hierarchy, excellent spacing, restrained motion, sharp mobile behaviour, and no random gradients/glass cards unless the selected direction explicitly calls for them.
- Use the client's requested SiteRemade style as the visual foundation, but interpret it intelligently for the industry.
- The builder prompt must be self-contained. A coding agent should be able to build the site from that prompt without needing this conversation.
- If a revision is supplied, update the existing brief rather than starting over.
- Return JSON only. No markdown.

Return exactly this shape:
{
  "summary": "short project summary",
  "businessPositioning": "how this business should be positioned",
  "styleDirection": {
    "style": "selected/derived style",
    "visualTone": "specific visual feel",
    "colors": ["specific supplied/derived colours"],
    "typography": "font personality and hierarchy guidance",
    "layout": "specific layout/composition guidance",
    "motion": "restrained interaction and motion guidance"
  },
  "content": {
    "hero": {
      "kicker": "",
      "headline": "",
      "subhead": "",
      "primaryCta": "",
      "secondaryCta": ""
    },
    "services": [{"name":"","description":""}],
    "trust": ["only supported trust points"],
    "about": "",
    "faq": [{"question":"","answer":""}],
    "quoteForm": {"fields":[],"intro":""}
  },
  "buildRules": ["specific implementation rules"],
  "avoid": ["specific things that would make this site feel cheap or generic"],
  "builderPrompt": "complete production prompt for the website coding agent"
}

SOURCE DATA:
${JSON.stringify(source)}`;
}

async function callAnthropic(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!key || !model) return null;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 7000,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data?.error?.message || 'Claude could not generate the website brief.');
  const text = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  return { provider: 'anthropic', model, brief: normalizeBrief(extractJson(text)) };
}

async function callOpenAI(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return only valid JSON matching the requested schema.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data?.error?.message || 'Fallback AI could not generate the website brief.');
  const text = data.choices?.[0]?.message?.content || '';
  return { provider: 'openai', model, brief: normalizeBrief(extractJson(text)) };
}

async function generateWebsiteBrief(args) {
  const prompt = promptForWebsite(args);
  const anthropic = await callAnthropic(prompt);
  if (anthropic) return anthropic;
  const fallback = await callOpenAI(prompt);
  if (fallback) return fallback;
  throw Error('Website intelligence is not configured. Add ANTHROPIC_API_KEY and ANTHROPIC_MODEL in Railway.');
}

function mapProject(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    leadId: row.lead_id || '',
    businessName: row.business_name || '',
    source: row.source || 'SiteRemade',
    intakeText: row.intake_text || '',
    designDirection: row.design_direction || {},
    brief: row.brief || {},
    builderPrompt: row.builder_prompt || '',
    status: row.status || 'Intake',
    aiProvider: row.ai_provider || '',
    aiModel: row.ai_model || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

fs.readFileSync = function(file, ...args) {
  const out = previousReadFileSync(file, ...args);
  if (typeof out !== 'string') return out;
  const name = String(file || '');
  if (!name.endsWith('app.html') && !name.endsWith('index.html')) return out;
  if (out.includes('/v46-site-intelligence-client.js')) return out;
  return out.replace('</body>', '  <script src="/v46-site-intelligence-client.js?v=46"></script>\n</body>');
};

http.createServer = function(listener) {
  return previousCreateServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const p = u.pathname;
      if (!p.startsWith('/api/app/website-projects') && p !== '/api/app/website-intelligence/status') {
        return listener(req, res);
      }
      const c = await context(req, res);
      if (!c) return send(res, 401, { ok: false, message: 'Authentication required.' });

      if (req.method === 'GET' && p === '/api/app/website-intelligence/status') {
        return send(res, 200, {
          ok: true,
          configured: Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL),
          provider: process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL ? 'anthropic' : (process.env.OPENAI_API_KEY ? 'openai-fallback' : 'none'),
          model: process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL || ''
        });
      }

      if (req.method === 'GET' && p === '/api/app/website-projects') {
        const result = await db.from('website_projects').select('*').eq('workspace_id', c.wid).order('updated_at', { ascending: false }).limit(200);
        if (result.error) throw result.error;
        return send(res, 200, { ok: true, projects: (result.data || []).map(mapProject) });
      }

      if (req.method === 'POST' && p === '/api/app/website-projects/generate') {
        if (!c.owner) return send(res, 403, { ok: false, message: 'SiteRemade owner access required.' });
        const b = await readBody(req);
        const leadId = clean(b.leadId, 80);
        let lead = null;
        if (leadId) {
          const got = await db.from('leads').select('*').eq('id', leadId).eq('workspace_id', c.wid).maybeSingle();
          if (got.error) throw got.error;
          lead = got.data;
          if (!lead) return send(res, 404, { ok: false, message: 'Lead not found.' });
        }
        const intakeText = clean(b.intakeText, 18000);
        if (!lead && !intakeText) return send(res, 400, { ok: false, message: 'Choose a lead or paste the client design intake.' });

        let existing = null;
        const projectId = clean(b.projectId, 80);
        if (projectId) {
          const got = await db.from('website_projects').select('*').eq('id', projectId).eq('workspace_id', c.wid).maybeSingle();
          if (got.error) throw got.error;
          existing = got.data;
        }

        const ai = await generateWebsiteBrief({
          workspace: c.workspace,
          lead,
          intakeText: intakeText || existing?.intake_text || '',
          existingBrief: existing?.brief || null,
          revision: ''
        });

        const businessName = clean(b.businessName, 200) || lead?.name || c.workspace.business_name || 'Website project';
        const payload = {
          workspace_id: c.wid,
          lead_id: lead?.id || existing?.lead_id || null,
          business_name: businessName,
          source: lead?.source || existing?.source || 'SiteRemade',
          intake_text: intakeText || existing?.intake_text || '',
          design_direction: ai.brief.styleDirection || {},
          brief: ai.brief,
          builder_prompt: ai.brief.builderPrompt || '',
          status: 'Brief Ready',
          ai_provider: ai.provider,
          ai_model: ai.model,
          updated_at: new Date().toISOString()
        };
        let saved;
        if (existing) {
          const r = await db.from('website_projects').update(payload).eq('id', existing.id).eq('workspace_id', c.wid).select('*').single();
          if (r.error) throw r.error;
          saved = r.data;
        } else {
          const r = await db.from('website_projects').insert(payload).select('*').single();
          if (r.error) throw r.error;
          saved = r.data;
        }
        await db.from('activities').insert({
          workspace_id: c.wid,
          type: 'website',
          title: 'Website brief generated',
          detail: `${businessName} · ${ai.provider}`
        });
        return send(res, 201, { ok: true, project: mapProject(saved), provider: ai.provider, model: ai.model });
      }

      const revise = p.match(/^\/api\/app\/website-projects\/([^/]+)\/revise$/);
      if (req.method === 'POST' && revise) {
        if (!c.owner) return send(res, 403, { ok: false, message: 'SiteRemade owner access required.' });
        const got = await db.from('website_projects').select('*').eq('id', revise[1]).eq('workspace_id', c.wid).maybeSingle();
        if (got.error) throw got.error;
        if (!got.data) return send(res, 404, { ok: false, message: 'Website project not found.' });
        const b = await readBody(req);
        const revision = clean(b.revision, 8000);
        if (!revision) return send(res, 400, { ok: false, message: 'Describe the revision first.' });
        let lead = null;
        if (got.data.lead_id) {
          lead = (await db.from('leads').select('*').eq('id', got.data.lead_id).eq('workspace_id', c.wid).maybeSingle()).data || null;
        }
        const ai = await generateWebsiteBrief({
          workspace: c.workspace,
          lead,
          intakeText: got.data.intake_text,
          existingBrief: got.data.brief,
          revision
        });
        const update = {
          design_direction: ai.brief.styleDirection || {},
          brief: ai.brief,
          builder_prompt: ai.brief.builderPrompt || '',
          status: 'Brief Ready',
          ai_provider: ai.provider,
          ai_model: ai.model,
          updated_at: new Date().toISOString()
        };
        const saved = await db.from('website_projects').update(update).eq('id', got.data.id).eq('workspace_id', c.wid).select('*').single();
        if (saved.error) throw saved.error;
        await db.from('activities').insert({
          workspace_id: c.wid,
          type: 'website',
          title: 'Website brief revised',
          detail: `${got.data.business_name} · ${revision.slice(0, 120)}`
        });
        return send(res, 200, { ok: true, project: mapProject(saved.data), provider: ai.provider, model: ai.model });
      }

      const item = p.match(/^\/api\/app\/website-projects\/([^/]+)$/);
      if (item && req.method === 'PATCH') {
        if (!c.owner) return send(res, 403, { ok: false, message: 'SiteRemade owner access required.' });
        const b = await readBody(req);
        const patch = { updated_at: new Date().toISOString() };
        if (b.status !== undefined) {
          const status = clean(b.status, 40);
          if (!['Intake', 'Brief Ready', 'Building', 'Review', 'Delivered'].includes(status)) {
            return send(res, 400, { ok: false, message: 'Invalid website project status.' });
          }
          patch.status = status;
        }
        if (b.businessName !== undefined) patch.business_name = clean(b.businessName, 200);
        if (b.intakeText !== undefined) patch.intake_text = clean(b.intakeText, 18000);
        if (b.builderPrompt !== undefined) patch.builder_prompt = clean(b.builderPrompt, 30000);
        const saved = await db.from('website_projects').update(patch).eq('id', item[1]).eq('workspace_id', c.wid).select('*').maybeSingle();
        if (saved.error) throw saved.error;
        if (!saved.data) return send(res, 404, { ok: false, message: 'Website project not found.' });
        return send(res, 200, { ok: true, project: mapProject(saved.data) });
      }

      if (item && req.method === 'DELETE') {
        if (!c.owner) return send(res, 403, { ok: false, message: 'SiteRemade owner access required.' });
        const result = await db.from('website_projects').delete().eq('id', item[1]).eq('workspace_id', c.wid);
        if (result.error) throw result.error;
        return send(res, 200, { ok: true });
      }

      return listener(req, res);
    } catch (error) {
      console.error('Website intelligence:', error);
      if (!res.headersSent) return send(res, 500, { ok: false, message: error.message || 'Website intelligence failed.' });
      res.end();
    }
  });
};
