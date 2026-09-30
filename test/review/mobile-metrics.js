'use strict';
// The in-page measurement every mobile audit runs (builder: test/review/mobile-audit.js; the Client App keeps an
// identical copy in its own test/review/). Returns plain data about the page AS RENDERED at the current viewport:
//   overflowX     the page scrolls sideways (documentElement.scrollWidth > clientWidth)
//   wide          visible elements reaching past the viewport edge that no clipping/scrolling ancestor contains
//   clipped       buttons/inputs cut off by a clipping ancestor (partly outside it)
//   taps          interactive controls smaller than a comfortable tap (under 40px either way; inline text links exempt)
//   zoom          text inputs/selects/textareas under 16px (iOS zooms the page when they get focus)
//   tiny          text rendered under 12px (count + samples)
//   fixed         fixed/sticky elements and how much of the viewport they cover
// `scope` (a selector) limits every check except overflowX to one subtree.
module.exports = function metricsSource(scope) {
  return `(() => {
  const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document.body'};
  if (!root) return { error: 'scope not found' };
  const W = document.documentElement.clientWidth, H = innerHeight;
  // visible to a person: not hidden, not transparent, and not parked far off-screen on purpose (honeypot fields and
  // screen-reader-only text use left:-9999px or a 1px clip)
  const vis = el => { if (el.closest('[hidden], .hp-field, .visually-hidden, .sr-only')) return false; const rr = el.getBoundingClientRect(); if (rr.right < -500 || rr.left > W + 500) return false; const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const desc = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
  // A clipping ancestor INSIDE the page contains an element on purpose (a hero art frame, a scroller). html/body are
  // not counted: an overflow-x:hidden there only hides sideways overflow, it doesn't fix it -- so what they hide is
  // still reported (pageClipsX says whether the page hides it).
  const clipAncestors = el => { const list = []; for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) { const s = getComputedStyle(a); if (/(hidden|auto|scroll|clip)/.test(s.overflowX)) list.push(a); } return list; };
  const clipAncestor = el => clipAncestors(el)[0] || null;
  const pageClipsX = [document.documentElement, document.body].some(e => /(hidden|clip)/.test(getComputedStyle(e).overflowX));
  const all = [...root.querySelectorAll('*')].filter(vis).filter(el => !(el instanceof SVGElement && el.ownerSVGElement)); // an SVG is judged as a whole
  const wide = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.right <= W + 1 && r.left >= -1) continue;
    if (clipAncestors(el).some(c => { const cr = c.getBoundingClientRect(); return cr.right <= W + 1 && cr.left >= -1; })) continue;
    if (wide.some(w => w.node.contains(el))) continue; // only the outermost offender
    wide.push({ node: el, el: desc(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
  }
  const controls = [...root.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], summary')].filter(vis);
  const clipped = [];
  for (const el of controls) {
    const c = clipAncestor(el); if (!c) continue;
    const r = el.getBoundingClientRect(), cr = c.getBoundingClientRect();
    const s = getComputedStyle(c);
    if (/auto|scroll/.test(s.overflowX)) continue; // an intentional scroller: reachable by scrolling it
    if (r.right > cr.right + 1 || r.left < cr.left - 1) clipped.push({ el: desc(el), text: (el.textContent || el.value || '').trim().slice(0, 30), by: desc(c) });
  }
  const taps = [];
  for (const el of controls) {
    const cs = getComputedStyle(el);
    if (el.tagName === 'A' && cs.display === 'inline') continue; // a link inside a sentence
    if (el.type === 'checkbox' || el.type === 'radio') continue; // judged by their label
    const r = el.getBoundingClientRect();
    if (r.height < 40 || r.width < 40) taps.push({ el: desc(el), text: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 36), w: Math.round(r.width), h: Math.round(r.height) });
  }
  const zoom = [...root.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]), select, textarea')].filter(vis)
    .filter(el => parseFloat(getComputedStyle(el).fontSize) < 16).map(el => ({ el: desc(el), fontSize: getComputedStyle(el).fontSize }));
  let tiny = 0; const tinySamples = [];
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) {
    const t = tw.currentNode; if (!t.textContent.trim()) continue;
    const el = t.parentElement; if (!el || !vis(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 12) { tiny++; if (tinySamples.length < 80) tinySamples.push({ el: desc(el), fs, text: t.textContent.trim().slice(0, 30) }); }
  }
  const fixed = all.filter(el => ['fixed', 'sticky'].includes(getComputedStyle(el).position)).map(el => { const r = el.getBoundingClientRect(); return { el: desc(el), pos: getComputedStyle(el).position, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), coversPct: Math.round(100 * Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0)) / H) }; });
  return {
    innerWidth: innerWidth, clientWidth: W, innerHeight: H, scrollWidth: document.documentElement.scrollWidth, overflowX: document.documentElement.scrollWidth > W + 1, pageClipsX,
    wide: wide.slice(0, 20).map(({ node, ...w }) => w), clipped: clipped.slice(0, 20), taps: taps.slice(0, 60), tapCount: taps.length,
    zoom: zoom.slice(0, 20), tiny, tinySamples, fixed: fixed.slice(0, 12),
  };
})()`;
};
