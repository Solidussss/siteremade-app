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
            for (let n; (n = tw.nextNode());) { if (n.parentElement.closest('[aria-hidden]')) continue; const re = /\\S+/g; let m; while ((m = re.exec(n.data))) { rg.setStart(n, m.index); rg.setEnd(n, m.index + m[0].length); const r = [...rg.getClientRects()].filter(x => x.width)[0]; if (!r) continue; right = Math.max(right, r.right); left = Math.min(left, r.left); const row = rows.find(x => Math.abs(x.top - r.top) < 8); if (row) row.words.push(m[0]); else rows.push({ top: r.top, words: [m[0]] }); } }
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
      out.widths[width].overflowAtEnd = await overflow();
      out.widths[width].tapTargetsUnder44 = await js('[...document.querySelectorAll("#creativeEditor button, #creativeEditor select, #creativeEditor .ce-file")].filter(e => e.offsetParent && e.getBoundingClientRect().height < 43.5).map(e => e.textContent.trim().slice(0, 30))');
    } catch (e) { steps.push(['error: ' + (e && e.message), false]); }
    out.widths[width] = Object.assign(out.widths[width] || {}, { steps, errors }); w.destroy();
  }
  fs.writeFileSync(path.join(job.outDir, 'editor-result.json'), JSON.stringify(out, null, 1)); app.exit(0);
}).catch(e => { fs.writeFileSync(path.join(job.outDir, 'editor-result.json'), JSON.stringify({ error: String(e && e.stack || e) })); app.exit(1); });
