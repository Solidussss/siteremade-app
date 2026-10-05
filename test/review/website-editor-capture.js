'use strict';
// Electron half of test/review/website-editor-review.js: drives the Website editor through real clicks and records what
// happened, at each width. electron website-editor-capture.js <job.json>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const job = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const out = { widths: {} };
  for (const width of job.widths) {
    const phone = width < 700; const w = new BrowserWindow({ width, height: phone ? 844 : 900, show: true, x: 0, y: 0, webPreferences: { backgroundThrottling: false } });
    const errors = []; w.webContents.on('console-message', (e) => { const m = e.message || ''; if ((e.level === 'error' || e.level === 3) && !/Security Warning/.test(m)) errors.push(m.slice(0, 200)); });
    const js = code => w.webContents.executeJavaScript(code);
    const shot = async name => { try { const img = await Promise.race([w.webContents.capturePage(), sleep(8000).then(() => null)]); if (img) fs.writeFileSync(path.join(job.outDir, `${width}-${name}.png`), img.toPNG()); } catch (e) { /* (a screenshot the compositor could not take is not a failed step) */ } };
    const until = async (cond, ms) => { for (let i = 0; i < (ms || 30000) / 250; i++) { if (await js(`!!(${cond})`)) return true; await sleep(250); } return false; };
    const overflow = () => js('document.documentElement.scrollWidth - window.innerWidth');
    const steps = [];
    try {
      await w.loadURL(job.baseUrl); await sleep(300); await js(`fetch('/__scenario?auth=1&saved=one').then(() => true)`); await w.loadURL(job.baseUrl);
      await until('typeof switchView === "function"'); await js('switchView("website"); true');
      steps.push(['editor shown for the Creative website', await until('document.querySelector("#creativeEditor") && !document.querySelector("#creativeEditor").hidden && document.querySelectorAll(".ce-scene").length > 1', 40000)]);
      steps.push(['Business update box hidden', await js('document.querySelector("#siteEditor").hidden')]);
      await js('document.querySelector("#creativeEditor").scrollIntoView({block:"start"}); true'); await sleep(600); await shot('1-editor');
      out.widths[width] = { overflowAtStart: await overflow() };
      // ---- BUG 1: what the owner is typing survives every redraw (real typing: the browser's own input events)
      const redrawAll = async () => {
        await js('CreativeEditor.render(canonicalWebsite.project); true'); await sleep(150);
        await js('CreativeEditor.reload().then(() => true)'); await sleep(150);
        await js('typeof loadCanonicalWebsite === "function" ? loadCanonicalWebsite(true).then(() => true) : true'); await sleep(250); // the parent refresh (summary, preview)
        await js('typeof renderWebsite === "function" && renderWebsite(); true'); await sleep(150);
        await js('typeof safeRender === "function" && typeof renderWorkspaceCredits === "function" && safeRender("workspace-credits", renderWorkspaceCredits); true'); await sleep(150);
        await js('CreativeEditor.render(canonicalWebsite.project); true'); await sleep(250);
      };
      const typed = async (sel, text, label) => {
        await js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: 'center' }); el.focus(); el.select(); return true; })()`);
        await w.webContents.insertText(text); await sleep(150);
        await redrawAll(); await redrawAll();
        const kept = await js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return { value: el.value, focused: document.activeElement === el }; })()`);
        // (and the owner goes on typing where they were)
        await w.webContents.insertText(' — still typing'); await sleep(150); await redrawAll();
        const more = await js(`document.querySelector(${JSON.stringify(sel)}).value`);
        steps.push([`${label}: the typed sentence survives every redraw`, kept.value === text]);
        steps.push([`${label}: still the field being typed in, and typing goes on`, kept.focused && more === text + ' — still typing']);
      };
      await js(`document.querySelector('.ce-scene[data-scene="${job.heroScene}"]').click(); true`); await sleep(300);
      await typed('#ceSceneAsk', 'Make the bottle feel colder, like the fridge door just opened', 'the scene helper');
      await typed('#ceSiteAsk', 'A bolder summer page with more red and less white space', 'the whole-page helper');
      await js('[...document.querySelectorAll(".ce-item")].find(b => /Headline/.test(b.textContent)).click(); true'); await sleep(250);
      await typed('#ceText', 'A headline I am still writing', 'the manual text box');
      await shot('1b-typing');
      await js('document.querySelector(\'[data-ce="close"]\').click(); true'); await sleep(200);
      // ---- BUG 2: the old website's broken opening title -- "Fix text layout" repairs it as a new draft
      const preview = async (source, vw) => { const pw = new BrowserWindow({ width: vw, height: vw < 700 ? 844 : 900, show: false, webPreferences: { backgroundThrottling: false } });
        try { await pw.loadURL(`${job.baseUrl}api/app/website/projects/${job.projectId}/preview${source === 'draft' ? '?source=draft' : ''}`); await sleep(400);
          return await pw.webContents.executeJavaScript(`(async () => { await document.fonts.ready; const h = document.querySelector('h1.sc-heading'); if (!h) return null; h.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 200));
            const rg = document.createRange(); const rows = []; const tw = document.createTreeWalker(h, NodeFilter.SHOW_TEXT); const vw = document.documentElement.clientWidth; let right = 0, left = 1e9;
            // (a page with the kinetic layer splits its headline into words (.kw) -- a 3D one into letters too: a word is its .kw)
            const kws = [...h.querySelectorAll('.kw')];
            for (const w of kws) { const r = w.getBoundingClientRect(); if (!r.width) continue; right = Math.max(right, r.right); left = Math.min(left, r.left); const row = rows.find(x => Math.abs(x.top - r.top) < 12); if (row) row.words.push(w.textContent.trim()); else rows.push({ top: r.top, words: [w.textContent.trim()] }); }
            if (!kws.length) for (let n; (n = tw.nextNode());) { if (n.parentElement.closest('[aria-hidden]')) continue; const re = /\\S+/g; let m; while ((m = re.exec(n.data))) { rg.setStart(n, m.index); rg.setEnd(n, m.index + m[0].length); const r = [...rg.getClientRects()].filter(x => x.width)[0]; if (!r) continue; right = Math.max(right, r.right); left = Math.min(left, r.left); const row = rows.find(x => Math.abs(x.top - r.top) < 8); if (row) row.words.push(m[0]); else rows.push({ top: r.top, words: [m[0]] }); } }
            const cs = getComputedStyle(h), he = document.documentElement; return { lines: rows.map(r => r.words.join(' ')), inside: right <= vw + 1 && left >= -1, why: { font: cs.fontSize, family: cs.fontFamily.slice(0, 50), spacing: cs.letterSpacing, lw: h.style.getPropertyValue('--lw'), fit: cs.getPropertyValue('--fit'), look: he.hasAttribute('data-look'), display: he.dataset.display, kase: he.dataset.case, typo: he.dataset.typo, hw: Math.round(h.getBoundingClientRect().width), pw: Math.round(h.parentElement.getBoundingClientRect().width), lnW: [...h.querySelectorAll('.ln')].map(x => Math.round(x.getBoundingClientRect().width)), maxw: cs.maxWidth, size: h.parentElement.dataset.size, width: h.parentElement.dataset.width } }; })()`);
        } finally { pw.destroy(); } };
      const before = await preview('draft', width);
      out.widths[width].titleBefore = before;
      await js(`document.querySelector('.ce-scene[data-scene="${job.heroScene}"]').click(); true`); await sleep(300);
      const src0 = await js('document.querySelector("#websiteFrame").getAttribute("src") || ""');
      await shot('1c-title-before');
      await js('document.querySelector(\'[data-op="text-layout"]\').click(); true');
      await until('/Fixed the text layout|already fits/i.test(document.querySelector("#ceFeedback").textContent)', 30000);
      const fb2 = await js('document.querySelector("#ceFeedback").textContent'); out.widths[width].titleFixFeedback = fb2.slice(0, 300);
      if (/Fixed/.test(fb2)) {
        steps.push(['old broken title: "Fix text layout" made a new draft, free', /Saved as a draft/.test(fb2) && /No credits were used/.test(fb2)]);
        steps.push(['the preview changes to the new draft', await until(`(document.querySelector("#websiteFrame").getAttribute("src") || "") !== ${JSON.stringify(src0)} && /source=draft/.test(document.querySelector("#websiteFrame").getAttribute("src"))`, 20000)]);
      } else steps.push(['already repaired (at the first width): "Text already fits", nothing saved', /already fits/i.test(fb2) && /Nothing was saved/.test(fb2)]);
      await sleep(1500); await shot('1d-title-after');
      // reload the whole app: the draft stays fixed; desktop and phone both render the balanced title inside the screen
      await w.loadURL(job.baseUrl); await until('typeof switchView === "function"'); await js('switchView("website"); true'); await until('document.querySelectorAll(".ce-scene").length > 1', 40000);
      const after = await preview('draft', width); const other = await preview('draft', width < 700 ? 1440 : 390); const live = await preview('published', width);
      out.widths[width].titleAfter = after; out.widths[width].titlePublished = live;
      steps.push(['after a reload the draft title is today\'s balanced fit', !!after && JSON.stringify(after.lines) === JSON.stringify(['THE WORLD RAISES', 'ONE GLASS']) && after.inside]);
      steps.push([`and at ${width < 700 ? 1440 : 390}px too`, !!other && JSON.stringify(other.lines) === JSON.stringify(['THE WORLD RAISES', 'ONE GLASS']) && other.inside]);
      steps.push(['the published site keeps its old render until Publish', !!live && JSON.stringify(live.lines) === JSON.stringify(['THE WORLD', 'RAISES ONE', 'GLASS'])]);
      if (before) steps.push(['before the fix the draft showed the broken split', width !== job.widths[0] || JSON.stringify(before.lines) === JSON.stringify(['THE WORLD', 'RAISES ONE', 'GLASS'])]);
      // ---- FONTS: the picker -- grouped, each name in its own face, scrolling inside the panel; a face and a pairing chosen
      const fontsAt = () => js('[...document.querySelectorAll("#ceWhole .ce-fontrow")].map(b => b.textContent.replace(/▾/, "").trim())');
      await js('document.querySelector("#ceWhole .ce-fonts").scrollIntoView({ block: "start" }); true'); await sleep(300);
      steps.push(['fonts: pairings and a row per role shown', await js('document.querySelectorAll("#ceWhole .ce-preset").length === 10 && document.querySelectorAll("#ceWhole .ce-fontrow").length === 3')]);
      await js('document.querySelector(\'[data-ce="font-open"][data-role="headline"]\').click(); true'); await sleep(700);
      await shot('6a-font-menu-open'); await sleep(300); // (a frame drawn: what is on screen is what the owner sees)
      const menu = await js(`(() => { const m = document.querySelector('#ceFontMenu'); const r = m.getBoundingClientRect(); const vw = document.documentElement.clientWidth;
        const opts = [...m.querySelectorAll('.ce-fontopt')]; const shown = opts.filter(o => { const q = o.getBoundingClientRect(); return q.bottom > r.top && q.top < r.bottom; });
        return { left: r.left, right: r.right, vw, scrolls: m.scrollHeight > m.clientHeight + 4, options: opts.length, groups: m.querySelectorAll('.ce-fontcat').length, small: opts.filter(o => o.getBoundingClientRect().height < 43.5).length,
          ownFace: shown.filter(o => { const s = o.querySelector('.ce-fontsample'); return s && s.dataset.ff && s.style.fontFamily; }).length, shown: shown.length,
          loaded: performance.getEntriesByType('resource').filter(e => /\\/api\\/app\\/website\\/fonts\\//.test(e.name)).length }; })()`);
      out.widths[width].fontMenu = menu;
      const centred = await js("(() => { const m = document.querySelector('#ceFontMenu'); const on = m.querySelector('.ce-fontopt.is-on'); if (!on) return false; const r = m.getBoundingClientRect(), q = on.getBoundingClientRect(); return q.top >= r.top - 1 && q.bottom <= r.bottom + 1; })()");
      steps.push(['fonts: the menu opens on the current choice', centred]);
      steps.push(['fonts: the menu is grouped by category and fits the screen', menu.groups === 10 && menu.left >= 0 && menu.right <= menu.vw + 0.5]);
      steps.push(['fonts: the menu scrolls inside itself with touch-sized options', menu.scrolls && menu.options >= 50 && menu.small === 0]);
      steps.push(['fonts: names on screen are set in their own face; faces off screen are not fetched', menu.ownFace >= Math.min(4, menu.shown - 1) && menu.loaded < 43]);
      await shot('6-font-menu');
      await js('document.querySelector(\'#ceFontMenu [data-font="space-grotesk"]\').scrollIntoView({ block: "center" }); document.querySelector(\'#ceFontMenu [data-font="space-grotesk"]\').click(); true');
      steps.push(['fonts: a headline face chosen, saved as a draft for free', await until('/Fonts: headlines in Space Grotesk/.test(document.querySelector("#ceFeedback").textContent) && /No credits were used/.test(document.querySelector("#ceFeedback").textContent)', 30000)]);
      await until('[...document.querySelectorAll("#ceWhole .ce-fontrow")].some(b => /Space Grotesk/.test(b.textContent))', 20000);
      const dp = await preview('draft', width); out.widths[width].fontPreview = dp && dp.why ? { family: dp.why.family, lines: dp.lines, inside: dp.inside } : dp;
      steps.push(['fonts: the draft preview sets its headlines in Space Grotesk, inside the screen', !!dp && /SR Space Grotesk/.test(dp.why.family) && dp.inside]);
      await js(`document.querySelector('[data-ce="font-preset"][data-preset="${width < 700 ? 'tech' : 'luxury'}"]').click(); true`);
      steps.push(['fonts: a pairing chosen, saved as a draft for free', await until(`/Fonts \\(${width < 700 ? 'Tech' : 'Luxury'}\\)/.test(document.querySelector("#ceFeedback").textContent)`, 30000)]);
      await w.loadURL(job.baseUrl); await until('typeof switchView === "function"'); await js('switchView("website"); true'); await until('document.querySelectorAll("#ceWhole .ce-fontrow").length === 3', 40000);
      const rows = await fontsAt(); out.widths[width].fontRows = rows;
      steps.push(['fonts: after a reload the pairing is still the page\'s', width < 700 ? /Space Grotesk/.test(rows[0]) && /Inter/.test(rows[1]) && /IBM Plex Mono/.test(rows[2]) : /Bodoni Moda/.test(rows[0]) && /Manrope/.test(rows[1]) && /Manrope/.test(rows[2])]);
      steps.push(['fonts: the chosen pairing is marked', await js(`!!document.querySelector('.ce-preset.is-on[data-preset="${width < 700 ? 'tech' : 'luxury'}"]')`)]);
      const dp2 = await preview('draft', width);
      steps.push(['fonts: the draft still renders the pairing after the reload', !!dp2 && (width < 700 ? /SR Space Grotesk/ : /SR Bodoni Moda/).test(dp2.why.family) && dp2.inside]);
      await shot('7-fonts-chosen');
      // a free text edit: choose the second scene, open its headline, type, save
      await js('document.querySelectorAll(".ce-scene")[1].click(); true'); await sleep(300);
      await js('[...document.querySelectorAll(".ce-item")].find(b => /Headline/.test(b.textContent)).click(); true'); await sleep(200);
      const text = `Edited at ${width}px`;
      await js(`const t = document.querySelector("#ceText"); t.value = ${JSON.stringify(text)}; document.querySelector('[data-ce="save-text"]').click(); true`);
      steps.push(['free text edit saved as a draft', await until('/Saved as a draft/.test(document.querySelector("#ceFeedback").textContent)', 30000)]);
      steps.push(['no credits for it', await js('/No credits were used/.test(document.querySelector("#ceFeedback").textContent)')]);
      steps.push(['the preview shows the draft', await until(`/source=draft/.test(document.querySelector("#websiteFrame").getAttribute("src") || "")`, 20000)]);
      steps.push(['the outline reads the new heading back', await until(`(document.querySelectorAll(".ce-scene")[1] || {}).textContent.includes(${JSON.stringify(text)})`, 20000)]);
      await shot('2-text-saved');
      // a scene colour from the page palette
      await js('const s = document.querySelectorAll(".ce-swatch"); (s[1] || s[0]).click(); true');
      steps.push(['scene colour changed (free)', await until('/now stands on the/.test(document.querySelector("#ceFeedback").textContent)', 30000)]);
      // a paid AI rewrite: the builder's quote shown, then confirmed
      await js('[...document.querySelectorAll(".ce-item")].find(b => /Headline/.test(b.textContent)).click(); true'); await sleep(200);
      await js('document.querySelector(\'[data-ce="ai-text"]\').click(); true');
      steps.push(['the builder\'s quote shown beside the action', await until('document.querySelector(".ce-confirm") && /uses 1 credit/.test(document.querySelector(".ce-confirm").textContent)', 20000)]);
      await shot('3-quote');
      await js('document.querySelector(\'[data-ce="confirm"]\').click(); true');
      steps.push(['AI rewrite charged its quote and saved a draft', await until('/This used 1 credit/.test(document.querySelector("#ceFeedback").textContent)', 60000)]);
      // Fix text layout on the scene a save before the fix left with the old layout (fixed at the first width; already fitted at the next)
      await js(`document.querySelector('.ce-scene[data-scene="${job.staleScene}"]').click(); true`); await sleep(300);
      steps.push(['"Fix text layout — free" shown with the words', await js('!![...document.querySelectorAll(\'[data-op="text-layout"]\')].find(b => /Fix text layout — free/.test(b.textContent) && b.closest(".ce-group") && /Words/.test(b.closest(".ce-group").textContent))')]);
      await js('document.querySelector(\'[data-op="text-layout"]\').click(); true');
      const fixedOk = await until('/Fixed the text layout|already fit/.test(document.querySelector("#ceFeedback").textContent)', 30000);
      const fb = await js('document.querySelector("#ceFeedback").textContent');
      steps.push([`text layout ${/Fixed/.test(fb) ? 'fixed as a draft' : 'already fitted (nothing saved)'}, free`, fixedOk && /No credits were used/.test(fb) && (/Fixed/.test(fb) ? /Saved as a draft/.test(fb) : /Nothing was saved/.test(fb))]);
      out.widths[width].textLayoutFeedback = fb.slice(0, 300);
      if (/Fixed/.test(fb)) steps.push(['the preview shows the draft', await until(`/source=draft/.test(document.querySelector("#websiteFrame").getAttribute("src") || "")`, 20000)]);
      await sleep(400); await shot('5-text-layout');
      // the picture and 3D controls of a scene that has them
      const picIdx = await js('[...document.querySelectorAll(".ce-scene")].findIndex((b, i) => true)'); void picIdx;
      for (let i = 0; i < await js('document.querySelectorAll(".ce-scene").length'); i++) {
        await js(`document.querySelectorAll(".ce-scene")[${i}].click(); true`); await sleep(250);
        if (await js('!![...document.querySelectorAll(".ce-item")].find(b => /your upload/.test(b.textContent))')) break;
      }
      await js('const b = [...document.querySelectorAll(".ce-item")].find(b => /your upload/.test(b.textContent)); if (b) b.click(); true'); await sleep(300);
      steps.push(['picture actions shown in context', await js('!!document.querySelector(".ce-file") && !!document.querySelector(\'[data-ce="remove-pic"]\')')]);
      await shot('4-picture');
      // MOTION: a scene's headline entrance and its set piece, from the builder's own vocabulary (free)
      await js('document.querySelectorAll(".ce-scene")[1].click(); true'); await sleep(300);
      const hasMove = await js(`!!document.querySelector('[data-ce="move-words"]')`);
      steps.push(['the scene offers its headline and picture motion', hasMove && await js(`!!document.querySelector('[data-ce="move-picture"]')`)]);
      if (hasMove) {
        await js(`(() => { const el = document.querySelector('[data-ce="move-words"]'); el.value = "cascade"; el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
        steps.push(['the headline motion is saved (free)', await until('/Changed how/.test(document.querySelector("#ceFeedback").textContent)', 30000)]);
        steps.push(['the control shows the chosen motion', await until(`/Letters cascade/.test((document.querySelector('[data-ce="move-words"] option') || {}).textContent || "")`, 10000)]);
        out.widths[width].motionFeedback = (await js('document.querySelector("#ceFeedback").textContent')).slice(0, 200);
        const sigs = await js('[...document.querySelectorAll(".ce-scene")].length');
        let setPiece = false;
        for (let i = 1; i < sigs - 1 && !setPiece; i++) { await js(`document.querySelectorAll(".ce-scene")[${i}].click(); true`); await sleep(250);
          const opt = await js(`(() => { const el = document.querySelector('[data-ce="signature"]'); const o = el && [...el.options].find(o => o.value && o.value !== "none"); return o ? o.value : ""; })()`);
          if (!opt) continue;
          await js(`(() => { const el = document.querySelector('[data-ce="signature"]'); el.value = "${opt}"; el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
          setPiece = await until('/set piece|type wall|the page’s (pour|spotlight)/i.test(document.querySelector("#ceFeedback").textContent)', 30000);
          out.widths[width].setPiece = opt + ': ' + (await js('document.querySelector("#ceFeedback").textContent')).slice(0, 160); }
        steps.push(['a set piece can be put on a scene that carries it (free)', setPiece]);
        await js(`(() => { const el = document.querySelector('[data-ce="move-words"]'); if (el) el.scrollIntoView({ block: "center" }); return true; })()`); await sleep(300); await shot('5-motion');
      }
      // ADD A PICTURE: under a scene's pictures; the upload becomes its own new scene after it (a real file input, a real file)
      const n0 = await js('document.querySelectorAll(".ce-scene").length');
      await js('document.querySelectorAll(".ce-scene")[1].click(); true'); await sleep(300);
      const add = await js('(() => { const i = document.querySelector(\'[data-ce="upload-after"]\'); const l = i && i.closest("label"); if (!l) return null; l.scrollIntoView({ block: "center" }); const r = l.getBoundingClientRect(); return { h: r.height, inside: r.left >= 0 && r.right <= innerWidth + 0.5, text: l.textContent.trim() }; })()');
      steps.push(['"+ Add as a new scene" shown under the scene\'s pictures, touch-sized, on screen', !!add && add.h >= 43.5 && add.inside && /new scene/.test(add.text)]);
      await sleep(300); await shot('6-add-picture');
      await js(`(async () => { const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 1200, 800); gr.addColorStop(0, '#d0342c'); gr.addColorStop(1, '#f7c948'); g.fillStyle = gr; g.fillRect(0, 0, 1200, 800);
        const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9)); const dt = new DataTransfer(); dt.items.add(new File([b], 'summer-launch.jpg', { type: 'image/jpeg' }));
        const i = document.querySelector('[data-ce="upload-after"]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      steps.push(['the picture is on the page as a new scene, saved as a draft for free', await until('/new scene/.test(document.querySelector("#ceFeedback").textContent) && /No credits were used/.test(document.querySelector("#ceFeedback").textContent)', 60000)]);
      steps.push(['the outline has one more scene', await until(`document.querySelectorAll(".ce-scene").length === ${n0} + 1`, 20000)]);
      out.widths[width].addPictureFeedback = (await js('document.querySelector("#ceFeedback").textContent')).slice(0, 300);
      // ADD A PICTURE TO THIS SCENE: the upload goes into the chosen scene beside its words -- no new scene
      await sleep(600); const n1 = await js('document.querySelectorAll(".ce-scene").length');
      await js('document.querySelectorAll(".ce-scene")[2].click(); true'); await sleep(400);
      const into = await js('(() => { const i = document.querySelector(\'[data-ce="upload-into"]\'); const l = i && i.closest("label"); if (!l) return null; l.scrollIntoView({ block: "center" }); const r = l.getBoundingClientRect(); return { h: r.height, inside: r.left >= 0 && r.right <= innerWidth + 0.5, text: l.textContent.trim() }; })()');
      steps.push(['"+ Add a picture to this scene" shown, touch-sized, on screen', !!into && into.h >= 43.5 && into.inside && /to this scene/.test(into.text)]);
      await sleep(300); await shot('7b-add-into');
      await js(`(async () => { const c = document.createElement('canvas'); c.width = 1000; c.height = 1200; const g = c.getContext('2d'); g.fillStyle = '#2f6bff'; g.fillRect(0, 0, 1000, 1200); g.fillStyle = '#fff'; g.fillRect(300, 300, 400, 600);
        const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9)); const dt = new DataTransfer(); dt.items.add(new File([b], 'in-the-scene.jpg', { type: 'image/jpeg' }));
        const i = document.querySelector('[data-ce="upload-into"]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      steps.push(['the picture is in that scene, saved as a draft for free', await until('/Added your picture to/.test(document.querySelector("#ceFeedback").textContent) && /No credits were used/.test(document.querySelector("#ceFeedback").textContent)', 60000)]);
      await sleep(800); steps.push(['no new scene', (await js('document.querySelectorAll(".ce-scene").length')) === n1]);
      steps.push(['the scene lists the picture', await until('[...document.querySelectorAll("#creativeEditor .ce-item .ce-label")].some(e => /in-the-scene/.test(e.textContent))', 15000)]);
      // THE OWNER'S OWN 3D MODEL: a real .glb file into this scene, and the preview draws it
      const glbPath = process.env.SITEREMADE_BUILDER_DIR ? path.join(process.env.SITEREMADE_BUILDER_DIR, 'test', 'fixtures', 'three-d', 'product-normalized.glb') : '';
      if (glbPath && fs.existsSync(glbPath)) {
        const b64 = fs.readFileSync(glbPath).toString('base64');
        const btn = await js('(() => { const i = document.querySelector(\'[data-ce="upload-model"]\'); const l = i && i.closest("label"); if (!l) return null; l.scrollIntoView({ block: "center" }); const r = l.getBoundingClientRect(); return { h: r.height, inside: r.left >= 0 && r.right <= innerWidth + 0.5, text: l.textContent.trim() }; })()');
        steps.push(['"Upload your own 3D model (.glb)" shown, touch-sized, on screen', !!btn && btn.h >= 43.5 && btn.inside && /3D model/.test(btn.text)]);
        await sleep(300); await shot('7c-own-model');
        await js(`(() => { const bin = atob("${b64}"); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
          const dt = new DataTransfer(); dt.items.add(new File([u], 'my-orb.glb', { type: '' })); const i = document.querySelector('[data-ce="upload-model"]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        steps.push(['the 3D model is on the page, saved as a draft for free', await until('/Added your 3D model/.test(document.querySelector("#ceFeedback").textContent) && /No credits were used/.test(document.querySelector("#ceFeedback").textContent)', 60000)]);
        steps.push(['the scene shows its 3D model', await until('/Interactive 3D model/.test(document.querySelector("#cePanel").textContent)', 15000)]);
        out.widths[width].ownModelFeedback = (await js('document.querySelector("#ceFeedback").textContent')).slice(0, 300);
      } else steps.push(['(no builder fixture model: own-model upload not checked)', true]);
      await sleep(600); await shot('7-picture-added');
      out.widths[width].overflowAtEnd = await overflow();
      out.widths[width].tapTargetsUnder44 = await js('[...document.querySelectorAll("#creativeEditor button, #creativeEditor select, #creativeEditor .ce-file")].filter(e => e.offsetParent && e.getBoundingClientRect().height < 43.5).map(e => e.textContent.trim().slice(0, 30))');
    } catch (e) { steps.push(['error: ' + (e && e.message), false]); }
    out.widths[width] = Object.assign(out.widths[width] || {}, { steps, errors }); w.destroy();
  }
  fs.writeFileSync(path.join(job.outDir, 'editor-result.json'), JSON.stringify(out, null, 1)); app.exit(0);
}).catch(e => { fs.writeFileSync(path.join(job.outDir, 'editor-result.json'), JSON.stringify({ error: String(e && e.stack || e) })); app.exit(1); });
