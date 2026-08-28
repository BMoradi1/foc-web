// "Our hero has fallen!"
//
// Warcraft III says this itself when a hero dies. No map script is involved --
// nothing in war3map.j mentions it, which is why it had never been ported --
// and the rule is not "play a sound on hero death": UISounds.slk carries a row
// per race for *your* hero and another for an *ally's*, the voice is the
// listening player's race rather than the dead hero's, and there is no enemy
// row at all, so the other side losing a hero is silent.
//
// That makes it a per-client decision, and this checks all four branches by
// handing the client death events for heroes it owns, allies, and enemies.
//
//   FOC_DEBUG=1 PORT=8077 node server/index.js &
//   node tools/warnsound_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// the table itself, straight off the server
const table = await fetch(`http://127.0.0.1:${PORT}/data/uisounds.json`).then((r) => r.json());
const rows = Object.keys(table);
check('the warning table is staged', rows.length > 0, `${rows.length} rows`);
check('it carries a row for your own hero and an ally\'s',
      rows.some((r) => r.startsWith('HeroDies')) && rows.some((r) => r.startsWith('AllyHeroDies')),
      rows.filter((r) => /Human$/.test(r)).join(', '));
check('and none for an enemy, as Warcraft III has none',
      !rows.some((r) => /enemy/i.test(r)));
check('the rows carry their flags, not just a file',
      Object.values(table).every((v) => Array.isArray(v.flags) && v.flags.includes('NODUPLICATES')),
      Object.values(table)[0]?.flags?.join(',') || 'no flags compiled');
check('every row resolves to a real file',
      Object.values(table).every((v) => v.files?.length),
      `${Object.values(table).reduce((n, v) => n + v.files.length, 0)} files`);
const urls = [...new Set(Object.values(table).flatMap((v) => v.files))];
const codes = await Promise.all(urls.map((u) =>
  fetch(`http://127.0.0.1:${PORT}/assets/${u}`).then((r) => r.status)));
check('and every file is actually served', codes.every((c) => c === 200),
      `${codes.filter((c) => c === 200).length}/${codes.length} at 200`);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-warn-${process.pid}`],
  defaultViewport: { width: 900, height: 600 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.evaluateOnNewDocument(() => localStorage.setItem('focs.name', 'Warn'));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'),
                           { timeout: 30000 });
await wait(1200);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('.hcard:not(.nomodel)')];
  (c[0] || document.querySelector('.hcard'))?.click();
});
await wait(600);
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'),
                           { timeout: 30000 });
await wait(3500);

const out = await page.evaluate(() => {
  const { S, net, audio } = window.FOC;
  const me = S.hero?.id;
  const mine = S.ents.get(me);
  if (!mine) return { error: 'no hero on the client' };

  // Record instead of play: a headless page has no audio device, and what is
  // under test is which row gets chosen, not the mixer.
  const played = [];
  audio.playUI = (path, vol) => played.push({ path, vol });
  const fire = (id) => {
    played.length = 0;
    net.handlers.get('event')({ t: 'event', ev: [{ t: 'death', id }] });
    return played.map((p) => p.path.split('/').pop());
  };

  // Two stand-ins, so every branch is reachable in a one-player match: a hero
  // on my team and a hero on the other one. They are only ever read by the
  // death handler.
  const ally  = Object.assign({}, mine, { i: 900001, t: mine.t });
  const enemy = Object.assign({}, mine, { i: 900002, t: mine.t === 0 ? 1 : 0 });
  S.ents.set(ally.i, ally); S.ents.set(enemy.i, enemy);
  // and something that is not a hero at all
  const creep = [...S.ents.values()].find((e) => e.k !== 1 && e.i !== me);

  const r = { own: fire(me), ally: fire(ally.i), enemy: fire(enemy.i),
              creep: creep ? fire(creep.i) : null };
  // NODUPLICATES: the row says Warcraft III will not start this while it is
  // already playing, and in this map heroes die constantly. Two deaths back to
  // back must announce once. (playUI is stubbed, so this exercises the guard in
  // audio.js only if we let the real one run -- restore it and count.)
  delete audio.playUI;
  const started = [];
  const realPlay = audio.play.bind(audio);
  audio.play = (f, g, rt) => { started.push(f); return realPlay(f, g, rt); };
  audio.playing.clear();
  net.handlers.get('event')({ t: 'event', ev: [{ t: 'death', id: me }] });
  net.handlers.get('event')({ t: 'event', ev: [{ t: 'death', id: me }] });
  r.doubled = started.length;
  S.ents.delete(ally.i); S.ents.delete(enemy.i);
  return Object.assign(r, { race: S.hero?.race, rows: Object.keys(S.uiSounds || {}).length });
});
console.log(JSON.stringify(out, null, 1));

check('the client received the table', out.rows > 0, `${out.rows} rows in S.uiSounds`);
check('the client knows its own race', !!out.race, `race=${out.race}`);
check('your own hero falling is announced', out.own.length === 1,
      out.own.join(', ') || 'nothing played');
check('and in your own race\'s voice',
      out.own.length === 1 && rows.some((k) => k.toLowerCase() === ('HeroDies' + out.race).toLowerCase()
        && table[k].files.some((f) => f.endsWith(out.own[0]))),
      `${out.race} -> ${out.own[0]}`);
check('an ally\'s hero gets the ally line, not yours',
      out.ally.length === 1 && out.ally[0] !== out.own[0],
      `${out.own[0]} vs ${out.ally[0]}`);
check('an enemy hero is silent, as Warcraft III leaves it',
      out.enemy.length === 0, out.enemy.join(', ') || '');
check('and a unit that is not a hero says nothing',
      out.creep === null || out.creep.length === 0, (out.creep || []).join(', '));
check('two deaths in a row announce once, as NODUPLICATES says',
      out.doubled === 1, `${out.doubled} sound(s) started for 2 deaths`);
check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
