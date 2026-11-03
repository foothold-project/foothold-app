// Headless only, ephemeral loopback port. Run sync-web first; FH_PLAYWRIGHT required.
// FH_DISMISS_BASE=<old commit> reproduces the old behavior; FH_SHOT=<png> saves local evidence.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www');
const baseline = process.env.FH_DISMISS_BASE;
const oldMain = baseline && execFileSync('git', ['show', `${baseline}:mobile/sim/main.js`]);
// Both web /sim and the app package use this exact source through sync-web.
assert.deepEqual(readFileSync('mobile/sim/main.js'), readFileSync(resolve(root, 'sim/main.js')));
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    const body = oldMain && path === '/sim/main.js' ? oldMain : readFileSync(file);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
assert.ok(![8453, 8792, 5190, 5191, 8870, 9430, 9761].includes(server.address().port));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const hasTouch of baseline ? [false] : [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, hasTouch });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?map=warehouse&policyBackend=f32${hasTouch ? '' : '&from=web'}`);
    await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, null, { timeout: 90000 });
    assert.equal(await page.evaluate(() => __sim.err), null);
    const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const panel = async open => {
      assert.equal(await page.locator('#scenarioPanel').isVisible(), open);
      assert.equal(await page.getAttribute('#scenarioMenu', 'aria-expanded'), String(open));
    };
    const open = async () => { await page.click('#scenarioMenu'); await panel(true); };
    const cdp = await page.context().newCDPSession(page);
    // Short input burst avoids turning a tap into a long press under software rendering.
    const tap = async (x, y) => {
      if (hasTouch) {
        await Promise.all([
          cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] }),
          cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
        ]);
      } else await page.mouse.click(x, y);
      await page.evaluate(() => __sim.settled()); await frame();
    };
    const drag = async (x, y) => {
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + 70, y + 40, { steps: 3 }); await page.mouse.up(); await frame();
    };
    await page.click('#cam'); await frame();
    await page.mouse.move(550, 400); await page.mouse.wheel(0, -1400); await frame();
    await page.mouse.move(650, 600); await page.mouse.down();
    await page.mouse.move(1050, 600, { steps: 3 }); await page.mouse.up(); await frame();
    const floor = await page.evaluate(() => __sim.toScreen(-1, 0));
    await page.click('#go'); await open();
    if (process.env.FH_SHOT) await page.screenshot({ path: process.env.FH_SHOT.replace(/\.png$/, '-open.png') });
    assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, floor), 'CANVAS', `free floor point is outside the panel: ${JSON.stringify({ floor, panel: await page.locator('#scenarioPanel').boundingBox() })}`);
    await tap(...floor);
    if (baseline) {
      await panel(true);
      assert.equal(await page.evaluate(() => __sim.marks().length), 1, 'baseline click also places a goal');
      if (process.env.FH_SHOT) await page.screenshot({ path: process.env.FH_SHOT });
      console.log('scenario dismiss baseline reproduced: outside tap keeps panel open and places a goal');
      await page.close(); continue;
    }
    await panel(false);
    assert.equal(await page.evaluate(() => __sim.marks().length), 0);
    assert.equal(await page.evaluate(() => __sim.goalNote()), '');
    assert.equal(await page.evaluate(() => __sim.stopped()), false, 'dismiss only');
    if (process.env.FH_SHOT && !hasTouch) await page.screenshot({ path: process.env.FH_SHOT });
    // The following intentional tap is accepted again.
    await tap(...floor);
    assert.equal(await page.evaluate(() => __sim.marks().length), 1, 'next tap places a goal');
    await page.click('#stop'); await page.click('#go');

    await open();
    const options = await page.locator('#scenarioSelect option').evaluateAll(nodes => nodes.map(n => n.value));
    assert.ok(options.length > 1);
    await page.click('#scenarioSelect'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#scenarioSelect').inputValue(), options[1]); await panel(true);
    await page.click('#scenarioRun'); await page.evaluate(() => __sim.settled()); await panel(true);
    assert.equal(await page.evaluate(() => __sim.scenario.active), true, 'inside button runs scenario');
    await page.click('#scenarioHalt'); await panel(true);
    await page.click('#scenarioMenu'); await panel(false); // menu itself still toggles
    await page.click('#go');

    await open();
    const before = await page.evaluate(() => __sim.view());
    await drag(...floor); await panel(false);
    assert.deepEqual(await page.evaluate(() => __sim.view()), before, 'dismiss drag cannot pan');
    assert.equal(await page.evaluate(() => __sim.marks().length), 0);
    await open();
    await page.click('#cam'); await panel(false);
    assert.equal(await page.evaluate(() => __sim.top()), true, 'dismiss click cannot toggle another button');
    await page.click('#cam');
    assert.equal(await page.evaluate(() => __sim.top()), false, 'next button click works');
    await page.click('#cam'); await open();
    await page.evaluate(() => {
      const button = document.getElementById('cam');
      for (const type of ['pointerdown', 'pointerup']) button.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 99 }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    });
    await panel(false);
    assert.equal(await page.evaluate(() => __sim.top()), true, 'legacy WebView click is swallowed too');
    await page.click('#cam');
    assert.equal(await page.evaluate(() => __sim.top()), false, 'legacy click leaves no stale suppression');
    await open();
    const orbit = await page.evaluate(() => __sim.view());
    await drag(800, 600); await panel(false);
    assert.deepEqual(await page.evaluate(() => __sim.view()), orbit, 'dismiss drag cannot orbit');

    if (hasTouch) {
      for (const id of ['stickL', 'stickR']) {
        await open();
        const box = await page.locator('#' + id).boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height * .15); await page.mouse.down();
        await panel(false);
        assert.deepEqual(await page.evaluate(() => __sim.joy()), [0, 0, 0], 'dismiss cannot start joystick');
        await page.mouse.move(box.x + box.width * .8, box.y + box.height * .1); await page.mouse.up();
        assert.deepEqual(await page.evaluate(() => __sim.joy()), [0, 0, 0]);
      }
    }
    await open();
    await page.keyboard.down('KeyW'); await page.waitForFunction(() => __sim.cmd()[0] > 0);
    // Hit the nested SVG, verify STOP already worked before pointerup/click.
    const stop = await page.locator('#stop .bar').boundingBox();
    await page.mouse.move(stop.x + stop.width / 2, stop.y + stop.height / 2); await page.mouse.down();
    await panel(false);
    assert.equal(await page.evaluate(() => __sim.stopped()), true);
    assert.deepEqual(await page.evaluate(() => __sim.cmd()), [0, 0, 0], 'STOP command immediately neutral');
    await page.mouse.up(); await page.keyboard.up('KeyW');
    await page.click('#go'); await open(); await page.focus('#scenarioSelect');
    await page.keyboard.press('Escape'); await panel(false);
    assert.equal(await page.evaluate(() => __sim.stopped()), true, 'existing Escape STOP retained');
    assert.deepEqual(errors, []);
    console.log(`scenario dismiss PASS (${hasTouch ? 'app/touch' : 'web/mouse'}): outside tap/no goal, next tap, select/buttons/menu, drag/no pan/orbit, click/no toggle, joystick guard, immediate STOP, Escape`);
    await page.close();
  }
} finally { await browser?.close(); await new Promise(r => server.close(r)); }
