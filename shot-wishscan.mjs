// Dev-only: screenshots the wishlist scan flow (button, prefilled form, pick sheet).
// Borrows Playwright from the sibling snap-workbench install. node shot-wishscan.mjs [outdir]
import { createRequire } from 'module';
import fs from 'fs';
import http from 'http';
import path from 'path';
const { chromium } = createRequire('C:/Users/cjmer/Projects/snap-workbench/package.json')('playwright');

const OUT = process.argv[2] || 'shots-wishscan';
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html':'text/html', '.json':'application/json', '.png':'image/png', '.webmanifest':'application/manifest+json', '.js':'text/javascript' };
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0]; if (p === '/') p = '/index.html';
  try { const b = fs.readFileSync(path.join(process.cwd(), p)); res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(b); }
  catch (e) { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(8799, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:8799/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// seed a small shelf + one wish so dup flags have something to hit
await page.evaluate(() => {
  upsertBottle({ name: 'Campari', category: 'amaro', subtype: 'campari', level: 'full' });
  upsertBottle({ name: 'Rittenhouse Rye', category: 'whiskey', subtype: 'rye', level: 'full' });
  upsertWish({ name: 'Chartreuse V.E.P.', notes: 'saw it downtown', img: null });
  setTab('shelf');
  document.getElementById('btn-addwish').scrollIntoView({ block: 'center' });
});
await page.waitForTimeout(500);
await page.screenshot({ path: OUT + '/w1-buttons.png' });

// a fake bottle photo, drawn in-page (amber rectangle stands in for a label shot)
const fakePhoto = await page.evaluate(() => {
  const cv = document.createElement('canvas'); cv.width = 240; cv.height = 320;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#2a1c10'; cx.fillRect(0, 0, 240, 320);
  cx.fillStyle = '#c9a15a'; cx.fillRect(60, 40, 120, 240);
  cx.fillStyle = '#1a1410'; cx.fillRect(75, 110, 90, 70);
  return cv.toDataURL('image/jpeg', 0.8);
});

// single-bottle result -> prefilled wish form
await page.evaluate(ph => {
  wishScanRoute([{ name: 'Amaro Nardini', category: 'amaro', subtype: 'nardini' }], null, ph);
}, fakePhoto);
await page.waitForTimeout(500);
await page.screenshot({ path: OUT + '/w2-prefilled-form.png' });

// multi-bottle result -> pick sheet with both dup flavors
await page.evaluate(ph => {
  openWishScanSheet([
    { name: 'Campari', category: 'amaro', subtype: 'campari' },
    { name: 'Chartreuse V.E.P.', category: 'liqueur' },
    { name: 'Michter’s Small Batch', category: 'whiskey', subtype: 'bourbon' },
    { name: 'Suze', category: 'liqueur', subtype: 'gentian' },
  ], null, ph);
}, fakePhoto);
await page.waitForTimeout(500);
await page.screenshot({ path: OUT + '/w3-pick-sheet.png' });

await browser.close();
server.close();
console.log('shots written to ' + OUT);
