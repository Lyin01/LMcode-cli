// Deterministic fake-clock capture for rAF-driven canvas animations.
// Usage: node capture.cjs <html-path> "<comma-separated-seconds>" <out-dir>
const path = require('path');
const fs = require('fs');

const CHROME = path.join(process.env.USERPROFILE, 'AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe');

(async () => {
  const { chromium } = require(path.join(__dirname, '_pw', 'node_modules', 'playwright-core'));
  const [htmlPath, secondsArg, outDir] = process.argv.slice(2);
  const seconds = secondsArg.split(',').map(Number);
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  await page.addInitScript(() => {
    let now = 0;
    let rafQueue = [];
    performance.now = () => now;
    Date.now = () => now;
    window.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
    window.cancelAnimationFrame = () => {};
    window.__stepTo = (targetMs, stepMs) => {
      while (now < targetMs) {
        now = Math.min(now + stepMs, targetMs);
        const cbs = rafQueue;
        rafQueue = [];
        for (const cb of cbs) { try { cb(now); } catch (e) { console.error('rAF cb error:', e.message); } }
      }
    };
  });

  page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
  page.on('pageerror', e => console.log('[pageerror]', e.message));

  await page.goto('file:///' + path.resolve(htmlPath).replace(/\\/g, '/'));
  await page.waitForTimeout(300);

  for (const s of seconds) {
    await page.evaluate((ms) => window.__stepTo(ms, 16.6), s * 1000);
    const out = path.join(outDir, `t${String(s).padStart(2, '0')}s.png`);
    await page.screenshot({ path: out });
    console.log('captured', out);
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
