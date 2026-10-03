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
    const shot = async name => { const img = await Promise.race([w.webContents.capturePage(), sleep(8000).then(() => null)]); if (img) fs.writeFileSync(path.join(job.outDir, `${width}-${name}.png`), img.toPNG()); };
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
    out.widths[width].steps = steps; out.widths[width].errors = errors; w.destroy();
  }
  fs.writeFileSync(path.join(job.outDir, 'editor-result.json'), JSON.stringify(out, null, 1)); app.exit(0);
}).catch(e => { fs.writeFileSync(path.join(job.outDir, 'editor-result.json'), JSON.stringify({ error: String(e && e.stack || e) })); app.exit(1); });
