const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const icon = (p) => (p ? `/assets/${p}` : '/assets/textures/_teamcolor.png');
// For anything a *player* typed -- names, and the scoreboard cells the map
// script builds from them -- before it lands in innerHTML. A name of
// `<img onerror=...>` is script in every connected browser otherwise.
export const esc = (s) => String(s)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A hero's own model, rendered at build time by tools/hero_portraits.mjs. The
// map ships no icons for its heroes -- every one of them carries whatever art
// the Warcraft III unit it was built from had, so Goku picks as a Paladin and
// Ichigo as a Blood Elf Peasant. The `onerror` falls back to that original icon,
// so a missing portrait costs the card nothing.
const portrait = (id) => `/assets/portraits/${id}.png`;
// Language. The map's text is Korean; data/translations.ko-en.json supplies an
// English overlay and compile_game.py ships both, so this only chooses which of
// the two already-present strings to show. Nothing is translated at runtime.
export const Lang = {
  en: (() => { try { return localStorage.getItem('foc.lang') !== 'ko'; } catch { return true; } })(),
  set(en) {
    this.en = !!en;
    try { localStorage.setItem('foc.lang', this.en ? 'en' : 'ko'); } catch {}
  },
};
/** A field in the chosen language, falling back to the map's own text. */
export const T = (o, field) => {
  if (!o) return '';
  const en = o[field + 'En'];
  return (Lang.en && en) || o[field] || '';
};

const TAVERN_NAMES = { n00M: 'Tavern I', n006: 'Tavern II', ntav: 'Tavern III', n00W: 'Tavern IV' };

export class UI {
  constructor(net) {
    this.net = net;
    this.heroes = [];
    this.selected = null;
    this.tavern = null;
    this.you = null;
    this.players = [];
    this.logLines = [];
  }

  setLoading(msg, pct) {
    $('loadmsg').textContent = msg;
    if (pct != null) $('loadbar').style.width = `${Math.round(pct * 100)}%`;
  }
  hideLoading() { $('loading').classList.add('hidden'); }

  showLobby(game, heroes) {
    this.heroes = heroes;
    $('objective').textContent = game.meta.objective || '';
    $('lobby').classList.remove('hidden');
    $('hud').classList.add('hidden');
    $('gameover').classList.add('hidden');
    // biggest rosters first, so the default tab is a real hero tavern rather
    // than a one-off vendor that happens to sell a hero-flagged unit
    const counts = new Map();
    for (const h of heroes) counts.set(h.tavern, (counts.get(h.tavern) || 0) + 1);
    const tavs = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    // keep whichever tavern is open; only fall back when nothing valid is selected
    if (!tavs.includes(this.tavern)) this.tavern = tavs[0];
    const tabs = $('tavtabs'); tabs.innerHTML = '';
    for (const t of tavs) {
      const b = el('button', t === this.tavern ? 'on' : '', TAVERN_NAMES[t] || t);
      b.onclick = () => { this.tavern = t; this.showLobby(game, heroes); };
      tabs.appendChild(b);
    }
    const grid = $('heroGrid'); grid.innerHTML = '';
    for (const h of heroes.filter((x) => x.tavern === this.tavern)) {
      const c = el('div', 'hcard' + (h.model ? '' : ' nomodel') + (this.selected === h.id ? ' sel' : ''));
      c.dataset.id = h.id;                 // so a test can pick a named hero
      c.innerHTML = `<img src="${portrait(h.id)}" data-icon="${icon(h.icon)}"
          onerror="if(this.dataset.icon){this.src=this.dataset.icon;this.dataset.icon='';}
                   else this.style.opacity=.25">
        <div class="nm">${h.name}</div><div class="ti">${T(h, 'title')}</div>`;
      c.onclick = () => { this.selected = h.id; this.showHero(h); this.showLobby(game, heroes);
                          this.net.send({ t: 'pickHero', heroId: h.id }); };
      grid.appendChild(c);
    }
    if (this.selected) {
      const h = heroes.find((x) => x.id === this.selected);
      if (h) this.showHero(h);
    }
  }

  showHero(h) {
    // #heroInfo, not #heroDetail: the spin canvas is a sibling and must survive,
    // or every pick throws away a WebGL context and builds another
    const d = $('heroInfo');
    d.innerHTML = `<h2>${h.name}</h2><div class="sub">${T(h, 'title')}${h.model ? '' : ' · no imported model'}</div>
      <div class="statgrid">
        <span>Health</span><b>${h.hp}</b><span>Mana</span><b>${h.mana}</b>
        <span>Damage</span><b>${h.dmg}</b><span>Armor</span><b>${h.armor}</b>
        <span>Move</span><b>${h.moveSpeed}</b><span>Range</span><b>${h.atkRange}</b>
        <span>STR / AGI / INT</span><b>${h.str} / ${h.agi} / ${h.int}</b>
      </div>`;
    if (this.onHeroShown) this.onHeroShown(h);
    for (const a of h.abilities || []) {
      const row = el('div', 'ab');
      row.innerHTML = `<img src="${icon(a.icon)}" onerror="this.style.opacity=.25">
        <div><b>${T(a, 'name')}</b><p>${T(a, 'desc').slice(0, 220)}</p></div>`;
      d.appendChild(row);
    }
  }

  renderTeams(players, you, phase) {
    this.players = players; this.you = you;
    const box = $('teams'); box.innerHTML = '';
    for (const t of [0, 1]) {
      box.appendChild(el('h3', null, `Team ${t + 1}`));
      for (const p of players.filter((x) => x.team === t)) {
        const hero = this.heroes.find((h) => h.id === p.heroId);
        const row = el('div', 'pslot' + (p.id === you ? ' me' : ''));
        row.innerHTML = `<i class="rd ${p.ready ? 'on' : ''}"></i><span>${esc(p.name)}</span>
                         <small>${hero ? hero.name : '—'}</small>`;
        box.appendChild(row);
      }
    }
    $('btnTeam0').classList.toggle('on', players.find((p) => p.id === you)?.team === 0);
    $('btnTeam1').classList.toggle('on', players.find((p) => p.id === you)?.team === 1);
  }

  startGame() {
    $('lobby').classList.add('hidden');
    $('hud').classList.remove('hidden');
    // Nothing ever re-hid this, so the second match in a room was played under
    // the first one's opaque, click-eating banner.
    $('gameover').classList.add('hidden');
    // let the preview go: the game needs the memory more than the menu does
    if (this.onLobbyClosed) this.onLobbyClosed();
  }

  /**
   * Warcraft III's timer dialog, in the corner where the game puts it.
   *
   * This map runs its duel countdown through one -- "Duel in", five minutes --
   * and it is the only clock a player gets, since the map never touches the
   * day/night cycle. The title arrives with Warcraft III's own colour markup
   * (`|cAARRGGBB ... |r`), which is honoured rather than stripped: the map
   * chose yellow and it should read yellow.
   */
  updateClock(clock) {
    const box = $('gameclock');
    if (!box) return;
    if (!clock) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const m = /\|c[0-9a-f]{2}([0-9a-f]{6})/i.exec(clock.title || '');
    const title = String(clock.title || '').replace(/\|c[0-9a-f]{8}|\|r/gi, '');
    const t = $('clockTitle');
    t.textContent = title;
    t.style.color = m ? '#' + m[1] : '';
    const left = Math.max(0, clock.left || 0);
    const mm = Math.floor(left / 60);
    const ss = Math.floor(left % 60);
    $('clockTime').textContent = mm + ':' + String(ss).padStart(2, '0');
    box.classList.toggle('soon', left <= 15);
  }

  /** The map maintains its own scoreboard; mirror it verbatim. */
  updateScore(board, killsToWin) {
    this.board = board;
    if (board?.kind === 'multiboard') {
      const t = board.teams || [];
      $('k0').textContent = t[0] ? t[0].value : 0;
      $('k1').textContent = t[1] ? t[1].value : 0;
      if (t[0]) { $('k0').title = t[0].label; $('k0').previousElementSibling; }
      $('scoreMid').textContent = board.title || '';
      const lbl = document.querySelectorAll('#topbar .score span');
      if (lbl[0] && t[0]) lbl[0].textContent = t[0].label;
      if (lbl[1] && t[1]) lbl[1].textContent = t[1].label;
    } else if (board?.rows?.length) {
      const r = board.rows;
      $('k0').textContent = r[0] ? r[0].value : 0;
      $('k1').textContent = r[1] ? r[1].value : 0;
      $('scoreMid').textContent = board.title || '';
    } else {
      $('scoreMid').textContent = `first to ${killsToWin} kills`;
    }
  }

  updateHero(h) {
    this.hero = h;
    $('pname2').textContent = `${h.name} — ${h.title || ''}  (lvl ${h.level}${h.maxLevel ? `/${h.maxLevel}` : ''})`;
    const set = (bar, txt, v, m) => {
      $(bar).style.width = `${Math.max(0, Math.min(100, (v / Math.max(1, m)) * 100))}%`;
      if (txt) $(txt).textContent = `${Math.round(v)} / ${Math.round(m)}`;
    };
    set('hpbar', 'hptext', h.hp, h.maxHp);
    set('mpbar', 'mptext', h.mana, h.maxMana);
    set('xpbar', null, h.xp, h.xpNeed || 1);
    $('stats').innerHTML =
      `<span>DMG</span><b>${h.dmg}</b><span>ARM</span><b>${h.armor}</b>
       <span>STR</span><b>${h.str}</b><span>AGI</span><b>${h.agi}</b>
       <span>INT</span><b>${h.int}</b><span>MS</span><b>${h.moveSpeed}</b>
       <span>GOLD</span><b>${h.gold}</b><span>K/D</span><b>${h.kills}/${h.deaths}</b>`;
    this.renderAbilities(h);
    this.renderInventory(h);
    const r = $('respawn');
    if (!h.alive) { r.classList.remove('hidden'); r.textContent = `Reviving in ${h.respawnIn}s`; }
    else r.classList.add('hidden');
  }

  /**
   * The hero's inventory: six slots, as Warcraft III gives one.
   *
   * Items apply their bonuses passively the moment they are carried, so this is
   * only about seeing and spending them -- click to use a charge, right-click to
   * drop.  Empty slots are still drawn, because knowing how much room is left is
   * half of what an inventory is for.
   */
  renderInventory(h) {
    queueMicrotask(() => this.placeCard());
    const box = $('inventory');
    if (!box) return;
    box.innerHTML = '';
    const carried = h.items || [];
    for (let i = 0; i < 6; i++) {
      const it = carried[i];
      const cell = el('div', 'islot' + (it ? '' : ' empty'));
      if (it) {
        cell.innerHTML = `<img src="${icon(it.icon)}" onerror="this.style.opacity=.2">` +
                         (it.charges > 0 ? `<b class="chg">${it.charges}</b>` : '');
        cell.title = `${it.name}${it.charges > 0 ? ` (${it.charges} charges)` : ''}` +
                     '\nclick to use · right-click to drop';
        cell.onclick = () => this.net.send({ t: 'useItem', slot: i });
        // right-click drops; shift+right-click sells it back. Warcraft III sells
        // by dragging the item onto a shop, which a single canvas cannot offer,
        // so the gesture is ours -- the refund and the event it fires are not.
        cell.oncontextmenu = (ev) => {
          ev.preventDefault();
          this.net.send({ t: ev.shiftKey ? 'pawnItem' : 'dropItem', slot: i });
        };
      }
      box.appendChild(cell);
    }
  }

  renderAbilities(h) {
    queueMicrotask(() => this.placeCard());
    const box = $('abilities');
    // The key each ability actually binds to, resolved in main.js from the
    // map's own 'ahky' -- read here rather than re-derived, so the letter
    // printed on the button is by construction the letter that casts it.
    box.innerHTML = '';

    // Unspent skill points are easy to miss, and a hero that cannot cast because
    // nothing is learned yet just looks broken -- so say so plainly.
    if (h.skillPoints > 0) {
      const canLearn = h.abilities.some((a) => a.lvl < (a.cap ?? a.maxLvl));
      const note = el('div', 'skillnote' + (canLearn ? '' : ' idle'));
      note.textContent = canLearn
        ? `${h.skillPoints} skill point${h.skillPoints > 1 ? 's' : ''} — click a + to learn`
        : `${h.skillPoints} skill point${h.skillPoints > 1 ? 's' : ''} — nothing available until you level up`;
      box.appendChild(note);
    }

    h.abilities.forEach((a, i) => {
      const cap = a.cap ?? a.maxLvl;
      const gated = cap < 1;                       // hero level too low for rank 1
      const canRank = h.skillPoints > 0 && a.lvl < cap;
      const s = el('div', 'slot' + (a.lvl < 1 ? ' unlearned' : '')
                              + (gated ? ' gated' : '') + (canRank ? ' ready' : ''));
      s.style.backgroundImage = a.icon ? `url(/assets/${a.icon})` : 'none';
      if (!a.icon) { s.style.background = '#1c2130'; s.dataset.initial = (T(a, 'name') || '?')[0]; }

      const nextAt = a.reqLevel + a.cap * a.levelSkip;
      const gate = gated ? `\nUnlocks at hero level ${a.reqLevel}`
                 : (a.lvl >= cap && a.lvl < a.maxLvl && a.levelSkip
                    ? `\nNext rank at hero level ${nextAt}` : '');
      const how = canRank ? '\nClick + to learn (or right-click the icon)' : '';
      s.title = `${T(a, 'name')}${gate}${how}\n${T(a, 'desc')}`;

      s.innerHTML = `<span class="key">${(a.key || '').toUpperCase()}</span>
        <span class="lv">${a.lvl}/${a.maxLvl}</span>
        ${a.cdLeft > 0.1 ? `<span class="cd">${a.cdLeft.toFixed(0)}</span>` : ''}
        ${gated ? `<span class="req">Lv ${a.reqLevel}</span>` : ''}
        ${a.icon ? '' : `<span class="noicon">${(T(a, 'name') || '?')[0]}</span>`}`;

      if (canRank) {
        const up = el('button', 'up', '+');
        up.title = `Learn ${T(a, 'name')}`;
        up.onclick = (ev) => { ev.stopPropagation(); this.net.send({ t: 'learn', slot: i }); };
        s.appendChild(up);
      }
      s.oncontextmenu = (ev) => { ev.preventDefault(); this.net.send({ t: 'learn', slot: i }); };
      s.onclick = () => {
        if (a.lvl < 1) { if (canRank) this.net.send({ t: 'learn', slot: i }); return; }
        this.onCastSlot?.(i);
      };
      box.appendChild(s);
    });
  }

  /**
   * The build tag in the corner.
   *
   * The build number is the useful half day to day -- it answers "is the server
   * running what I just changed?" -- so it leads. The hash is what identifies a
   * build to anyone else, and the date is only ever wanted once, so both go in
   * the tooltip rather than on screen.
   */
  /**
   * @param map  which map this server is serving, from game.json's meta.name
   *
   * The build number hashes client/, server/ and shared/ and deliberately not
   * data/, so two servers built from the same code but a different map report
   * the same number. That is the right answer for "which build" and the wrong
   * one for "which server am I looking at", which is the question you actually
   * have when more than one is running. The map name settles it.
   */
  setBuild(b, debug, map) {
    const box = $('build');
    if (!box || !b) return;
    box.innerHTML = `v${b.v} \u00b7 <b>build ${b.n}</b>`
      + (debug ? ' \u00b7 <span class="dbg">DEBUG</span>' : '')
      + (map ? `<span class="map">${esc(map)}</span>` : '');
    const when = b.t ? new Date(b.t) : null;
    box.title = `${b.hash}${when ? ` \u00b7 ${when.toLocaleString()}` : ''}`
      + (map ? `\n${map}` : '')
      + (debug ? '\nFOC_DEBUG is on: L levels the hero to the cap' : '');
  }

  /**
   * Lay the ability and inventory buttons into the command card's own cells.
   *
   * The cells are measured out of the console art rather than chosen, so this
   * only has to hand each button the rectangle the game left for it. Called
   * again after either panel re-renders, since both replace their children.
   */
  placeCard() {
    const cells = this.cardCells;
    if (!cells || !cells.length) return;
    const put = (el, style) => {
      if (!el || !style) return;
      el.style.position = 'fixed';
      for (const k of ['left', 'right', 'top', 'bottom']) el.style[k] = 'auto';
      Object.assign(el.style, style);
      el.style.width = style.width;
      el.style.height = style.height;
    };
    const slots = [...document.querySelectorAll('#abilities .slot')];
    const items = [...document.querySelectorAll('#inventory .islot')];
    for (const host of ['abilities', 'inventory']) {
      const e = $(host);
      if (e) { e.style.position = 'static'; e.style.display = 'contents'; }
    }
    // The command card is the abilities' and the inventory has its own six
    // slots beside it, which is where Warcraft III puts them.
    slots.forEach((el, i) => put(el, cells[i]));
    items.forEach((el, i) => put(el, (this.invCells || [])[i]));
  }

  /** Match the minimap's drawing buffer to the opening the console gives it. */
  fitMinimap() {
    const c = $('mmcanvas');
    if (!c) return;
    const r = c.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
  }

  /**
   * The connection is gone.
   *
   * Rejoining properly means the server keeping the slot and the client
   * replaying state onto it; until that exists, the honest thing is to say so
   * rather than leave a frozen battlefield looking playable.
   */
  showDisconnected() {
    const d = $('disconnected');
    if (!d || !d.classList.contains('hidden')) return;
    d.classList.remove('hidden');
    const b = $('btnRejoin');
    if (b) b.onclick = () => location.reload();
  }

  log(text, cls) {
    this.logLines.push({ text, cls, t: performance.now() });
    if (this.logLines.length > 9) this.logLines.shift();
    const box = $('log'); box.innerHTML = '';
    for (const l of this.logLines) box.appendChild(el('div', l.cls, l.text));
  }

  showShop(shops, hero) {
    const s = $('shop');
    if (!s.classList.contains('hidden')) { s.classList.add('hidden'); return; }
    s.classList.remove('hidden');
    s.innerHTML = '';
    for (const sh of shops) {
      s.appendChild(el('h3', null, sh.name));
      for (const it of sh.items) {
        const row = el('div', 'item');
        row.innerHTML = `<img src="${icon(it.icon)}" onerror="this.style.opacity=.25">
          <div><b>${it.name}</b></div><span class="g">${it.gold || 0}g</span>`;
        row.title = it.desc || it.tip || '';
        row.onclick = () => this.net.send({ t: 'buy', itemId: it.id });
        s.appendChild(row);
      }
    }
  }

  gameOver(winner, board) {
    const g = $('gameover');
    g.classList.remove('hidden');
    const rows = (board && board.rows || [])
      .map((r) => `${esc(String(r.label).replace(/\|c........|\|r/g, ''))} ${esc(r.value)}`).join(' &nbsp;·&nbsp; ');
    g.innerHTML = `<div class="box"><h2>${winner != null ? `Team ${winner + 1} wins` : 'Match over'}</h2>
      <p class="dim">${rows}</p></div>`;
  }

  toggleScore(show) {
    const s = $('score');
    if (!show) { s.classList.add('hidden'); return; }
    s.classList.remove('hidden');
    // prefer the map's own scoreboard when it built one
    if (this.board?.kind === 'multiboard' && this.board.rows.length) {
      const [head, ...body] = this.board.rows;
      s.innerHTML = `<table><caption>${esc(this.board.title)}</caption><tr>${
        head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${
        body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
      return;
    }
    const rows = this.players.map((p) => {
      const h = this.heroes.find((x) => x.id === p.heroId);
      return `<tr><td>${esc(p.name)}</td><td>${h ? h.name : '—'}</td>
              <td>Team ${p.team + 1}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`;
    }).join('');
    s.innerHTML = `<table><tr><th>Player</th><th>Hero</th><th>Team</th><th>K</th><th>D</th></tr>${rows}</table>`;
  }

  drawMinimap(bounds, ents, youId, terrainImg) {
    const c = $('mmcanvas'), g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    if (terrainImg) g.drawImage(terrainImg, 0, 0, W, H);
    else { g.fillStyle = '#0d1017'; g.fillRect(0, 0, W, H); }
    const bx = bounds.maxX - bounds.minX, by = bounds.maxY - bounds.minY;
    for (const e of ents) {
      const px = ((e.x - bounds.minX) / bx) * W;
      const py = H - ((e.y - bounds.minY) / by) * H;
      if (e.k === 4) continue;
      g.fillStyle = e.i === youId ? '#ffe680' : e.t === 0 ? '#5aa9e6' : e.t === 1 ? '#e2564d' : '#9a9a9a';
      const r = e.i === youId ? 3.5 : e.k === 2 ? 3 : 2.5;
      g.beginPath(); g.arc(px, py, r, 0, 6.284); g.fill();
    }
  }
}
