// Developer helper: uses Playwright and installed Edge. Runs only the browser mock.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  });
});
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/ui/index.html?demo=auto`);
    await page.waitForFunction(() => document.querySelector('#nav-count-library').textContent.includes('10,440'));
    await page.evaluate(() => {
      mock.played = games.slice(0, 312).map(g => g.id);
      mock.queue.slice(0, 3).forEach(g => { if (!mock.played.includes(g.id)) mock.played.push(g.id); });
      mock.push();
    });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const output = path.join(root, 'docs', 'screenshots'); fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'game-variety.png') });
    await page.evaluate(() => {
      mock.state.auto.active = false;
      mock.run(games.find(g => g.name === 'Stardew Valley') || games[0], 0, Date.now() - 1934000);
      mock.push(); go('gametime');
    });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(output, 'game-time.png') });
    await page.evaluate(() => { mock.state.running = null; mock.push(); go('library'); });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(output, 'library.png') });
    await page.evaluate(() => go('history'));
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(output, 'history.png') });
    // Regression case: the original 312-record history with no measured time.
    await page.evaluate(() => {
      mock.stats = { varietySeconds: 0, gameTimeSeconds: 0, longestSeconds: 0, sessions: 0, legacyGames: 312, legacySeconds: 234000, since: Date.now() };
      mock.played = games.slice(0, 312).map(g => g.id); mock.push();
    });
    await page.waitForTimeout(150);
    const values = await page.locator('#history-stats .stat-value').allTextContents();
    assert.deepEqual(values.slice(0, 3), ['312', '65.0h', '312']);
    assert.match(await page.locator('#history-stats').textContent(), /estimated for 312 earlier games/);
    assert.equal(await page.locator('#open-repo').getAttribute('href'), 'https://github.com/Basirian/discord-badge-booster');
    assert.deepEqual(errors, []);
    console.log('PASS: 312 earlier records show 65.0h estimated and 312 sessions. Four 1440x900 screenshots captured; no game processes started.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
