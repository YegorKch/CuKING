'use strict';

// ---------- защита запуска ----------
// Если приложение упало при старте (например, в кеше телефона разошлись версии файлов),
// вместо пустого экрана показываем кнопку, которая чистит кеш и перезагружает.
let booted = false;
function showCrash(err) {
  if (booted || document.getElementById('crash')) return;
  const box = document.createElement('div');
  box.id = 'crash';
  box.innerHTML = '<p>Не удалось запустить приложение.</p><button type="button" class="primary">Обновить приложение</button><small></small>';
  box.querySelector('small').textContent = String(err && (err.message || err) || '');
  box.querySelector('button').onclick = async () => {
    try {
      const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
      await Promise.all(regs.map((r) => r.unregister()));
      if (window.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
    } catch {}
    location.reload();
  };
  document.body.appendChild(box);
}
window.addEventListener('error', (e) => showCrash(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showCrash(e.reason));

// Регистрируем сразу, до остального кода: даже если ниже что-то упадёт, обновление приедет.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- хранилище ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem('c.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('c.' + k, JSON.stringify(v)); } catch {} },
};

const RECENT_DAYS = { 'Основное': 14 };   // остальные колоды — RECENT_DEFAULT
const RECENT_DEFAULT = 3;
const PAUSE_DAYS = 30;
const DAY_CAP = 60;
const DEFAULT_RATING = 4;
const GARNISH_CAT = 'Гарнир';
const RECENT_GARNISHES = 2;
const UNDO_MS = 5000;
const COOK_TTL = 12 * 3600 * 1000;     // недоготовленный рецепт восстанавливается 12 часов
const EDGE = 24;                       // полоса у краёв экрана, где свайп не ловим (системный «назад»)
const SWIPE = 50;
const TIME_OPTIONS = [null, 30, 45, 60];

const state = {
  url: LS.get('url', ''),
  snap: LS.get('snap', null),          // последняя база с сервера
  snapAt: LS.get('snapAt', 0),
  queue: LS.get('queue', []),          // неотправленные записи истории; sendAfter — пока можно отменить
  deckName: LS.get('deck', ''),
  filters: Object.assign({ cat: '', maxTime: null, tags: [] }, LS.get('filters', {})),
  pins: LS.get('pins', []),            // [{ id, garnish }]
  cook: LS.get('cook', null),          // текущая готовка: { dish, garnish, portions, tab, step, checked, at }
  order: [],                           // колода: id блюд в порядке показа
  pos: 0,
  relaxed: false,                      // антиповтор снят, потому что иначе пусто
  garnishes: {},                       // id блюда → { list: [id гарнира | null], i }
  ratings: { re: '', ra: '' },
};

let byId = {};
let stats = {};

const $ = (id) => document.getElementById(id);

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayYmd() { return ymd(new Date()); }
function utc(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function daysBetween(a, b) { return Math.round((utc(b) - utc(a)) / 86400000); }
function addDays(s, n) { return new Date(utc(s) + n * 86400000).toISOString().slice(0, 10); }
function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
}

// ---------- данные ----------
function dishes() { return (state.snap && state.snap.dishes) || []; }
function decks() { return (state.snap && state.snap.decks) || []; }
function currentDeck() { return decks().find((d) => d.name === state.deckName) || decks()[0] || null; }

/** Оценки, последняя готовка и паузы — из истории вместе с ещё не отправленными записями. */
function computeStats() {
  const st = {};
  const s = (id) => st[id] || (st[id] = { last: '', count: 0, sum: 0, n: 0, pause: '' });
  const seen = new Set();
  const uses = [];                     // гарниры по порядку: { date, id, k }
  const all = ((state.snap && state.snap.history) || []).concat(state.queue);
  all.forEach((h, k) => {
    if (seen.has(h.id)) return;
    seen.add(h.id);
    const x = s(h.dish);
    if (h.type === 'пауза') {
      const until = addDays(h.date, PAUSE_DAYS);
      if (until > x.pause) x.pause = until;
      return;
    }
    if (h.type !== 'готовили') return;
    x.count++;
    if (h.date > x.last) x.last = h.date;
    for (const r of [h.re, h.ra]) if (r) { x.sum += Number(r); x.n++; }
    if (h.garnish) {
      const g = s(h.garnish);
      if (h.date > g.last) g.last = h.date;
      uses.push({ date: h.date, id: h.garnish, k: k });
    } else if (byId[h.dish] && byId[h.dish].cat === GARNISH_CAT) {
      uses.push({ date: h.date, id: h.dish, k: k });
    }
  });
  uses.sort((a, b) => (a.date === b.date ? b.k - a.k : a.date < b.date ? 1 : -1));
  const recent = [];
  for (const u of uses) { if (recent.length >= RECENT_GARNISHES) break; if (!recent.includes(u.id)) recent.push(u.id); }
  st.__recentGarnishes = recent;
  return st;
}

function reindex() {
  byId = Object.fromEntries(dishes().map((d) => [d.id, d]));
  stats = computeStats();
}

function rating(id) {
  const x = stats[id];
  return x && x.n ? x.sum / x.n : null;
}

/** вес = R² × D: R — средняя оценка (нет оценок — 4), D — дней с последней готовки (не больше 60). */
function weight(d) {
  const x = stats[d.id];
  const R = rating(d.id) || DEFAULT_RATING;
  const D = x && x.last ? Math.min(daysBetween(x.last, todayYmd()), DAY_CAP) : DAY_CAP;
  return Math.max(R * R * D, 1);
}

function weightedShuffle(list) {
  return list.map((d) => ({ d: d, k: Math.pow(Math.random(), 1 / weight(d)) }))
    .sort((a, b) => b.k - a.k).map((x) => x.d.id);
}

function candidates(relax) {
  const deck = currentDeck();
  if (!deck) return [];
  const today = todayYmd();
  const recentDays = RECENT_DAYS[deck.name] != null ? RECENT_DAYS[deck.name] : RECENT_DEFAULT;
  const f = state.filters;
  const cat = f.cat && deck.cats.includes(f.cat) ? f.cat : '';
  return dishes().filter((d) => {
    const x = stats[d.id] || {};
    if (!deck.cats.includes(d.cat) || !d.active) return false;
    if (x.pause && x.pause > today) return false;
    if (!relax && x.last && daysBetween(x.last, today) < recentDays) return false;
    if (cat && d.cat !== cat) return false;
    if (f.maxTime && d.time > f.maxTime) return false;
    return f.tags.every((t) => d.tags.includes(t));
  });
}

function buildDeck() {
  let list = candidates(false);
  state.relaxed = false;
  if (!list.length) {
    list = candidates(true);
    state.relaxed = list.length > 0;
  }
  state.order = weightedShuffle(list);
  state.pos = 0;
}

function currentId() { return state.order[state.pos] || null; }

function next() {
  if (!state.order.length) return;
  state.pos++;
  if (state.pos >= state.order.length) {
    // Колода кончилась — дотасовываем новый круг, не начиная с того же блюда.
    const more = weightedShuffle(candidates(state.relaxed));
    if (more.length > 1 && more[0] === state.order[state.order.length - 1]) more.push(more.shift());
    state.order = state.order.concat(more);
    if (state.pos >= state.order.length) state.pos = state.order.length - 1;
  }
}
function prev() { if (state.pos > 0) state.pos--; }

// ---------- гарнир ----------
function garnishState(dishId) {
  if (state.garnishes[dishId]) return state.garnishes[dishId];
  const all = dishes().filter((d) => d.cat === GARNISH_CAT && d.active).map((d) => d.id);
  const recent = stats.__recentGarnishes || [];
  const list = shuffle(all.filter((id) => !recent.includes(id)))
    .concat(shuffle(all.filter((id) => recent.includes(id))), [null]);
  const pin = state.pins.find((p) => p.id === dishId);
  const i = pin && pin.garnish !== undefined ? Math.max(list.indexOf(pin.garnish), 0) : 0;
  return (state.garnishes[dishId] = { list: list, i: i });
}
function garnishOf(dishId) {
  const d = byId[dishId];
  if (!d || !d.garnish) return null;
  const g = garnishState(dishId);
  return g.list[g.i];
}
function spinGarnish(dishId) {
  const g = garnishState(dishId);
  g.i = (g.i + 1) % g.list.length;
  const pin = state.pins.find((p) => p.id === dishId);
  if (pin) { pin.garnish = g.list[g.i]; LS.set('pins', state.pins); }
  if (state.cook && state.cook.dish === dishId) {
    state.cook.garnish = g.list[g.i];
    saveCook();
  }
}

// ---------- экраны и навигация ----------
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  if (id === 'recipe') wakeLock(true); else wakeLock(false);
}

/**
 * Своя история переходов, чтобы жест «назад» на телефоне возвращал по экранам,
 * а не закрывал приложение. Корень — рандомайзер (depth 0).
 */
function go(screen) {
  history.pushState({ screen: screen, depth: (currentNav().depth || 0) + 1 }, '');
  show(screen);
  render(screen);
}
function currentNav() { return history.state || { screen: 'deck', depth: 0 }; }
function toRoot() {
  const d = currentNav().depth || 0;
  if (d > 0) history.go(-d); else { show('deck'); render('deck'); }
}

window.addEventListener('popstate', (e) => {
  const s = e.state || { screen: 'deck', depth: 0 };
  $('more-sheet').hidden = true;
  let screen = s.screen;
  if (['list', 'recipe', 'done'].includes(screen) && !state.cook) screen = 'deck';
  // Вернулись на главный — готовку бросили, при следующем запуске рецепт не восстанавливаем.
  if (screen === 'deck' && state.cook) { state.cook = null; LS.set('cook', null); }
  show(screen);
  render(screen);
});

function render(screen) {
  if (screen === 'deck') renderDeck();
  else if (screen === 'list') renderList();
  else if (screen === 'recipe') renderRecipe();
  else if (screen === 'done') renderDone();
}

let toastTimer;
function toast(msg, undo) {
  $('toast-text').textContent = msg;
  $('toast-undo').hidden = !undo;
  $('toast-undo').onclick = () => { $('toast').hidden = true; clearTimeout(toastTimer); undo(); };
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, undo ? UNDO_MS : 2200);
}

// ---------- сеть ----------
async function apiGet() {
  const r = await fetch(state.url, { cache: 'no-store' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Ошибка сервера');
  return j;
}
async function apiPost(body) {
  const r = await fetch(state.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) { const e = new Error(j.error || 'Ошибка сервера'); e.server = true; throw e; }
  return j;
}

function applySnap(j) {
  const first = !state.snap;
  state.snap = j;
  state.snapAt = Date.now();
  LS.set('snap', j);
  LS.set('snapAt', state.snapAt);
  reindex();
  // Колоду не перетасовываем посреди листания — только убираем пропавшие блюда.
  state.order = state.order.filter((id) => byId[id]);
  if (state.pos >= state.order.length) state.pos = Math.max(state.order.length - 1, 0);
  if (first || !state.order.length) buildDeck();
  if (!$('deck').hidden) renderDeck();
  renderStamp();
}

async function refresh() {
  if (!state.url) return;
  try {
    applySnap(await apiGet());
  } catch {
    renderStamp(true);
  }
}

let flushing = false;
let flushTimer;
async function flush() {
  if (flushing || !state.queue.length || !state.url) return;
  flushing = true;
  clearTimeout(flushTimer);
  try {
    while (state.queue.length) {
      const item = state.queue[0];
      if (item.sendAfter && item.sendAfter > Date.now()) {
        flushTimer = setTimeout(flush, item.sendAfter - Date.now() + 50);
        break;
      }
      let j;
      try {
        const entry = Object.assign({}, item);
        delete entry.sendAfter;
        j = await apiPost({ action: 'log', entry: entry });
      } catch (e) {
        if (e.server) {                // сервер отказал — повторять бессмысленно
          toast('Не записано: ' + e.message);
          dequeue(item.id);
          continue;
        }
        break;                         // нет сети — попробуем позже
      }
      dequeue(item.id);
      applySnap(j);
    }
  } finally {
    flushing = false;
    renderStamp();
  }
}

function enqueue(entry) {
  state.queue.push(entry);
  LS.set('queue', state.queue);
  reindex();
  flush();
}
function dequeue(id) {
  state.queue = state.queue.filter((q) => q.id !== id);
  LS.set('queue', state.queue);
}

function renderStamp(offline) {
  const s = $('stamp');
  const off = offline || !navigator.onLine;
  const pending = state.queue.filter((q) => !q.sendAfter || q.sendAfter <= Date.now()).length;
  let text = '';
  if (off && state.snapAt) {
    const d = new Date(state.snapAt);
    text = 'нет сети · база от ' + d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' '
      + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  if (pending) text += (text ? ' · ' : '') + `не отправлено: ${pending}`;
  s.textContent = text;
  s.classList.toggle('offline', off || !!pending);
}

// ---------- экран 1: рандомайзер ----------
function renderDeck() {
  renderDeckSeg();
  renderFilters();
  renderPins();
  const id = currentId();
  const d = id && byId[id];
  $('card').hidden = !d;
  $('deck-empty').hidden = !!d;
  $('card-back').hidden = !d || state.order.length < 2;
  if (!d) return;

  $('c-cat').textContent = d.cat;
  $('c-name').textContent = d.name;
  $('c-desc').textContent = d.desc;
  const meta = $('c-meta');
  meta.innerHTML = '';
  const add = (text, cls) => { const s = document.createElement('span'); s.textContent = text; if (cls) s.className = cls; meta.appendChild(s); };
  add(`${d.time} мин`);
  add(`${d.portions} ${plural(d.portions, 'порция', 'порции', 'порций')}`);
  const diff = document.createElement('span');
  diff.innerHTML = 'Сложность <span class="diff"></span>';
  diff.lastChild.textContent = '●'.repeat(d.diff) + '○'.repeat(Math.max(3 - d.diff, 0));
  meta.appendChild(diff);
  $('c-tech').textContent = d.tech.join(' · ');

  const x = stats[id] || {};
  const note = $('c-note');
  const r = rating(id);
  if (state.relaxed && x.last) {
    const n = daysBetween(x.last, todayYmd());
    note.textContent = n === 0 ? 'готовили сегодня' : `готовили ${n} ${plural(n, 'день', 'дня', 'дней')} назад`;
    note.style.color = '';
  } else if (x.count) {
    note.textContent = (r ? `★ ${r.toFixed(1).replace('.', ',')} · ` : '') + `готовили ${x.count} ${plural(x.count, 'раз', 'раза', 'раз')}`;
    note.style.color = 'var(--muted)';
  } else {
    note.textContent = 'ещё не готовили';
    note.style.color = 'var(--muted)';
  }
  note.hidden = false;

  $('c-garnish').hidden = !d.garnish;
  if (d.garnish) {
    const g = garnishOf(id);
    $('c-garnish-name').textContent = g ? byId[g].name : 'без гарнира';
  }
  $('c-pin').setAttribute('aria-pressed', String(state.pins.some((p) => p.id === id)));
  syncBack();
}

function renderDeckSeg() {
  const box = $('deck-seg');
  const list = decks();
  box.hidden = list.length < 2;
  box.innerHTML = '';
  const cur = currentDeck();
  for (const dk of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = dk.name;
    b.className = cur && dk.name === cur.name ? 'on' : '';
    b.onclick = () => {
      if (cur && dk.name === cur.name) return;
      state.deckName = dk.name;
      LS.set('deck', dk.name);
      buildDeck();
      renderDeck();
    };
    box.appendChild(b);
  }
}

function filtersActive() {
  const deck = currentDeck();
  const f = state.filters;
  return !!((f.cat && deck && deck.cats.includes(f.cat)) || f.maxTime || f.tags.length);
}

function renderFilters() {
  const deck = currentDeck();
  const f = state.filters;
  $('filter-btn').classList.toggle('on', filtersActive());
  $('filter-btn').setAttribute('aria-expanded', String(!$('filters').hidden));
  if (!deck) return;

  const chip = (box, text, on, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (on ? ' on' : '');
    b.textContent = text;
    b.onclick = () => { fn(); LS.set('filters', state.filters); buildDeck(); renderDeck(); };
    box.appendChild(b);
  };

  const cat = $('f-cat');
  cat.innerHTML = '';
  $('f-cat-row').hidden = deck.cats.length < 2;
  const curCat = deck.cats.includes(f.cat) ? f.cat : '';
  chip(cat, 'Всё', !curCat, () => { f.cat = ''; });
  deck.cats.forEach((c) => chip(cat, c, curCat === c, () => { f.cat = c; }));

  const time = $('f-time');
  time.innerHTML = '';
  TIME_OPTIONS.forEach((t) => chip(time, t ? `до ${t} мин` : 'Любое', f.maxTime === t, () => { f.maxTime = t; }));

  const tags = $('f-tags');
  tags.innerHTML = '';
  const present = [];
  dishes().filter((d) => deck.cats.includes(d.cat)).forEach((d) => d.tags.forEach((t) => { if (!present.includes(t)) present.push(t); }));
  f.tags.filter((t) => !present.includes(t)).forEach((t) => present.push(t));
  present.forEach((t) => chip(tags, t.replace(/_/g, ' '), f.tags.includes(t), () => {
    f.tags = f.tags.includes(t) ? f.tags.filter((x) => x !== t) : f.tags.concat(t);
  }));
}

function renderPins() {
  const box = $('pins');
  state.pins = state.pins.filter((p) => byId[p.id]);
  box.hidden = !state.pins.length;
  box.innerHTML = '';
  for (const p of state.pins) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pin-chip' + (p.id === currentId() ? ' current' : '');
    b.textContent = '📌 ' + byId[p.id].name;
    b.onclick = () => openPinned(p.id);
    box.appendChild(b);
  }
}

function openPinned(id) {
  if (currentId() === id) return;
  state.order.splice(state.pos + 1, 0, id);
  state.pos++;
  animateCard(-1, renderDeck);
}

function togglePin() {
  const id = currentId();
  if (!id) return;
  const i = state.pins.findIndex((p) => p.id === id);
  if (i >= 0) state.pins.splice(i, 1);
  else state.pins.push({ id: id, garnish: byId[id].garnish ? garnishOf(id) : undefined });
  LS.set('pins', state.pins);
  renderDeck();
}

function pauseCurrent() {
  const id = currentId();
  if (!id) return;
  const pos = state.pos;
  const entry = { id: uid(), date: todayYmd(), dish: id, garnish: '', type: 'пауза', re: '', ra: '', sendAfter: Date.now() + UNDO_MS };
  const pinIdx = state.pins.findIndex((p) => p.id === id);
  const pin = pinIdx >= 0 ? state.pins.splice(pinIdx, 1)[0] : null;
  LS.set('pins', state.pins);
  state.order = state.order.filter((x) => x !== id);
  if (state.pos >= state.order.length) state.pos = Math.max(state.order.length - 1, 0);
  enqueue(entry);
  if (!state.order.length) buildDeck();
  renderDeck();
  toast('Скрыто на месяц', () => {
    dequeue(entry.id);
    reindex();
    state.order.splice(pos, 0, id);
    state.pos = pos;
    if (pin) { state.pins.splice(pinIdx, 0, pin); LS.set('pins', state.pins); }
    renderDeck();
  });
}

function relax() {
  state.filters = { cat: '', maxTime: null, tags: [] };
  LS.set('filters', state.filters);
  buildDeck();
  renderDeck();
}

/** Колода под карточкой — той же высоты, что и карточка. */
function syncBack() {
  $('card-back').style.height = $('card').offsetHeight + 'px';
}

/**
 * Карточка как в колоде: тянется за пальцем с наклоном, улетает с поворотом,
 * следующая поднимается из-под неё с пружинкой. Назад — наоборот: текущая уходит в колоду,
 * предыдущая прилетает сбоку.
 */
const FLY_MS = 170;
const RISE_MS = 240;
const SPRING = 'cubic-bezier(.2,.9,.3,1.25)';
const BACK_SINK_MS = 180;
const BACK_IN_MS = 380;
const EASE_OUT = 'cubic-bezier(.22,1,.36,1)';
let animating = false;

function dragCard(dx) {
  const card = $('card');
  const back = $('card-back');
  card.style.transition = 'none';
  card.style.transform = `translateX(${dx}px) rotate(${dx * 0.05}deg)`;
  const k = Math.min(Math.abs(dx) / 200, 1);
  back.style.transition = 'none';
  back.style.transform = `translateY(${12 - 12 * k}px) scale(${0.94 + 0.06 * k})`;
  back.style.opacity = String(0.7 + 0.3 * k);
}

function releaseCard() {
  const card = $('card');
  const back = $('card-back');
  card.style.transition = `transform ${RISE_MS}ms ${SPRING}`;
  card.style.transform = '';
  back.style.transition = `transform ${RISE_MS}ms ease, opacity ${RISE_MS}ms ease`;
  back.style.transform = '';
  back.style.opacity = '';
}

function animateCard(dir, change) {
  const card = $('card');
  const back = $('card-back');
  if (animating || card.hidden) { change(); return; }
  animating = true;
  if (navigator.vibrate) navigator.vibrate(6);
  const done = () => {
    back.style.transition = 'none';
    back.style.transform = '';
    back.style.opacity = '';
    setTimeout(() => { card.style.transition = ''; animating = false; }, RISE_MS);
  };
  if (dir < 0) {
    // Вперёд: текущая улетает влево с поворотом, новая поднимается из колоды.
    card.style.transition = `transform ${FLY_MS}ms ease-in, opacity ${FLY_MS}ms ease-in`;
    card.style.transform = `translateX(-130%) rotate(-18deg)`;
    card.style.opacity = '0';
    back.style.transition = `transform ${FLY_MS}ms ease-out, opacity ${FLY_MS}ms ease-out`;
    back.style.transform = 'translateY(0) scale(1)';
    back.style.opacity = '1';
    setTimeout(() => {
      change();
      card.style.transition = 'none';
      card.style.transform = 'translateY(12px) scale(.94)';
      card.style.opacity = '1';
      void card.offsetWidth;
      card.style.transition = `transform ${RISE_MS}ms ${SPRING}`;
      card.style.transform = '';
      done();
    }, FLY_MS);
  } else {
    // Назад: текущая мягко оседает в колоду, предыдущая плавно въезжает слева — без пружины и резкого поворота.
    card.style.transition = `transform ${BACK_SINK_MS}ms ease-out, opacity ${BACK_SINK_MS}ms ease-out`;
    card.style.transform = 'translateY(12px) scale(.94)';
    card.style.opacity = '0';
    setTimeout(() => {
      change();
      card.style.transition = 'none';
      card.style.transform = 'translateX(-105%) rotate(-8deg)';
      card.style.opacity = '0';
      void card.offsetWidth;
      card.style.transition = `transform ${BACK_IN_MS}ms ${EASE_OUT}, opacity ${BACK_IN_MS * 0.6}ms ease-out`;
      card.style.transform = '';
      card.style.opacity = '1';
      back.style.transition = 'none';
      back.style.transform = '';
      back.style.opacity = '';
      setTimeout(() => { card.style.transition = ''; animating = false; }, BACK_IN_MS);
    }, BACK_SINK_MS);
  }
}

function goNext() { if (currentId()) animateCard(-1, () => { next(); renderDeck(); }); }
function goPrev() { if (state.pos > 0) animateCard(1, () => { prev(); renderDeck(); }); }

// ---------- готовка ----------
function saveCook() {
  if (state.cook) state.cook.at = Date.now();
  LS.set('cook', state.cook);
}

function startCook() {
  const id = currentId();
  const d = id && byId[id];
  if (!d) return;
  state.cook = {
    dish: id,
    garnish: d.garnish ? garnishOf(id) : null,
    portions: d.portions,
    tab: 'steps',
    checked: {},
  };
  saveCook();
  go('list');
}

/** Пересчёт количества под порции: г/мл до 20 — до 1, выше — до 5; кг/л — до 0,1; штуки и ложки — до 0,5. */
function scaleQty(q, u, k) {
  if (q == null || k === 1 || u === 'по вкусу' || u === 'щепотка') return q;
  const v = q * k;
  const step = u === 'г' || u === 'мл' ? (v < 20 ? 1 : 5) : u === 'кг' || u === 'л' ? 0.1 : 0.5;
  const r = Math.round(v / step) * step;
  return +(r > 0 ? r : step).toFixed(2);
}
function qtyText(q, u) {
  return q == null ? u : String(q).replace('.', ',') + ' ' + u;
}

// ---------- экран 2: продукты ----------
function renderList() {
  const c = state.cook;
  const d = byId[c.dish];
  const g = c.garnish && byId[c.garnish];
  const title = $('l-title');
  title.textContent = d.name;
  if (d.garnish) {
    const s = document.createElement('small');
    s.textContent = g ? '+ ' + g.name : 'без гарнира';
    title.appendChild(s);
  }
  $('p-value').textContent = c.portions;
  $('p-minus').disabled = c.portions <= 1;
  renderIngredients($('l-body'), () => { spinGarnish(c.dish); renderList(); });
}

/**
 * Продукты блюда и гарнира с галочками. Общий для экрана продуктов и вкладки «Продукты» в рецепте:
 * галочки одни и те же. onSpin — смена гарнира; без него кнопки «Сменить» нет.
 */
function renderIngredients(body, onSpin) {
  const c = state.cook;
  const d = byId[c.dish];
  const g = c.garnish && byId[c.garnish];
  body.innerHTML = '';
  const ings = state.snap.ingredients || {};
  const group = (label, dishId, items, action) => {
    if (!items.length && !action) return;
    const h = document.createElement('div');
    h.className = 'group-title';
    h.innerHTML = '<span></span>';
    h.firstChild.textContent = label;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.text;
      b.onclick = action.fn;
      h.appendChild(b);
    }
    body.appendChild(h);
    if (!items.length) return;
    const k = c.portions / (byId[dishId].portions || 1);
    const ul = document.createElement('ul');
    ul.className = 'ing';
    for (const it of items) {
      const key = dishId + '|' + it.i;
      const li = document.createElement('li');
      li.className = c.checked[key] ? 'on' : '';
      li.innerHTML = '<span class="box">✓</span><span class="p"></span><span class="q"></span>';
      li.querySelector('.p').textContent = it.p;
      li.querySelector('.q').textContent = qtyText(scaleQty(it.q, it.u, k), it.u);
      li.onclick = () => {
        c.checked[key] = !c.checked[key];
        li.classList.toggle('on', c.checked[key]);
        saveCook();
      };
      ul.appendChild(li);
    }
    body.appendChild(ul);
  };

  const main = (ings[c.dish] || []).map((x, i) => Object.assign({ i: i }, x));
  group('Нужно', c.dish, main.filter((x) => x.req));
  group('По желанию', c.dish, main.filter((x) => !x.req));
  if (d.garnish) {
    const gi = g ? (ings[g.id] || []).map((x, i) => Object.assign({ i: i }, x)) : [];
    const label = g ? 'Гарнир: ' + g.name : 'Без гарнира';
    group(label, g ? g.id : c.dish, gi, onSpin ? { text: 'Сменить ⟳', fn: onSpin } : null);
  }
}

function changePortions(delta) {
  const c = state.cook;
  c.portions = Math.min(Math.max(c.portions + delta, 1), 20);
  saveCook();
  renderList();
}

// ---------- экран 3: рецепт ----------
/** Весь рецепт одной страницей: шаги блюда, затем шаги гарнира. Вкладка «Продукты» — те же галочки, что на экране 2. */
function renderRecipe() {
  const c = state.cook;
  if (c.tab !== 'ing') c.tab = 'steps';
  for (const b of $('r-tabs').children) b.classList.toggle('on', b.dataset.v === c.tab);
  $('r-steps').hidden = c.tab !== 'steps';
  $('r-ing').hidden = c.tab !== 'ing';

  if (c.tab === 'ing') {
    renderIngredients($('r-ing'), null);
    const note = document.createElement('div');
    note.className = 'r-sub';
    note.textContent = `На ${c.portions} ${plural(c.portions, 'порцию', 'порции', 'порций')}`;
    $('r-ing').prepend(note);
    return;
  }

  const box = $('r-steps');
  box.innerHTML = '';
  const d = byId[c.dish];
  const g = c.garnish && byId[c.garnish];
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  box.appendChild(el('h1', 'r-title', d.name));
  box.appendChild(el('div', 'r-sub', [`${d.time} мин`, g ? '+ ' + g.name : ''].filter(Boolean).join(' · ')));

  const section = (title, id) => {
    if (title) box.appendChild(el('div', 'r-section', title));
    const steps = state.snap.steps[id] || [];
    if (!steps.length) { box.appendChild(el('p', 'muted', 'Шагов нет — добавьте их в таблице, лист «Шаги».')); return; }
    const ol = el('ol', 'steps');
    for (const s of steps) {
      const li = el('li');
      if (s.title) li.appendChild(el('b', '', s.title));
      li.appendChild(el('p', '', s.text));
      if (s.tech) li.appendChild(el('small', '', s.tech));
      ol.appendChild(li);
    }
    box.appendChild(ol);
  };
  section(g ? d.name : '', c.dish);
  if (g) section('Гарнир: ' + g.name, g.id);
}

function setRecipeTab(tab) {
  const c = state.cook;
  if (!c || c.tab === tab) return;
  c.tab = tab;
  saveCook();
  renderRecipe();
  window.scrollTo(0, 0);
}

// Экран не гаснет, пока открыт рецепт. Нет поддержки — молча без неё.
let lock = null;
async function wakeLock(on) {
  try {
    if (on && !lock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } else if (!on && lock) {
      await lock.release();
      lock = null;
    }
  } catch { lock = null; }
}

// ---------- финал ----------
function renderDone() {
  const c = state.cook;
  const d = byId[c.dish];
  $('d-title').textContent = d ? d.name : 'Готово!';
  for (const box of document.querySelectorAll('.stars')) {
    const who = box.dataset.who;
    box.innerHTML = '';
    for (let n = 1; n <= 5; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '★';
      b.setAttribute('aria-label', `${n} из 5`);
      b.className = state.ratings[who] >= n ? 'on' : '';
      b.onclick = () => { state.ratings[who] = state.ratings[who] === n ? '' : n; renderDone(); };
      box.appendChild(b);
    }
  }
}

function saveDone() {
  const c = state.cook;
  enqueue({
    id: uid(), date: todayYmd(), dish: c.dish, garnish: c.garnish || '', type: 'готовили',
    re: state.ratings.re, ra: state.ratings.ra,
  });
  const name = byId[c.dish] ? byId[c.dish].name : '';
  state.cook = null;
  LS.set('cook', null);
  state.ratings = { re: '', ra: '' };
  state.pins = [];
  LS.set('pins', state.pins);
  state.garnishes = {};
  buildDeck();
  toRoot();
  toast('Записано: ' + name);
}

// ---------- настройки ----------
function openSetup(first) {
  $('setup-url').value = state.url;
  $('setup-cancel').hidden = first;
  $('setup-err').hidden = true;
  if (first) show('setup'); else go('setup');
}

async function saveSetup() {
  const url = $('setup-url').value.trim();
  const err = (m) => { $('setup-err').textContent = m; $('setup-err').hidden = false; };
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) return err('Нужен адрес вида https://script.google.com/macros/s/…/exec');
  $('setup-save').disabled = true;
  $('setup-save').textContent = 'Проверяю…';
  const prevUrl = state.url;
  state.url = url;
  try {
    const j = await apiGet();
    LS.set('url', url);
    applySnap(j);
    if (currentNav().screen === 'setup') history.back(); else { show('deck'); renderDeck(); }
    flush();
  } catch (e) {
    state.url = prevUrl;
    err('Не удалось подключиться: ' + e.message);
  } finally {
    $('setup-save').disabled = false;
    $('setup-save').textContent = 'Готово';
  }
}

// ---------- жесты ----------
/**
 * Горизонтальный свайп по элементу. Старт в полосе EDGE у краёв экрана игнорируется,
 * чтобы не спорить с системным жестом «назад». Короткое касание без сдвига — onTap.
 */
function swipeable(el, { onLeft, onRight, onTap, onMove, onCancel }) {
  let sx = 0, sy = 0, active = false, horiz = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.clientX < EDGE || e.clientX > window.innerWidth - EDGE) return;
    if (e.target.closest('button')) return;
    sx = e.clientX; sy = e.clientY; active = true; horiz = null;
  });
  el.addEventListener('pointermove', (e) => {
    if (!active) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (horiz === null && Math.abs(dx) + Math.abs(dy) > 8) horiz = Math.abs(dx) > Math.abs(dy);
    if (horiz && onMove && !animating) onMove(dx);
  });
  const end = (e) => {
    if (!active) return;
    active = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (horiz && dx < -SWIPE) onLeft();
    else if (horiz && dx > SWIPE) onRight();
    else {
      if (horiz && onCancel && !animating) onCancel();
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && onTap && e.type === 'pointerup') onTap(e);
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// ---------- события ----------
function openMore() {
  const id = currentId();
  if (!id) return;
  $('more-title').textContent = byId[id].name;
  $('more-sheet').hidden = false;
  history.pushState(Object.assign({}, currentNav(), { sheet: true }), '');
}
function closeMore() {
  if ($('more-sheet').hidden) return;
  if (currentNav().sheet) history.back();   // popstate сам закроет лист
  else $('more-sheet').hidden = true;
}

function bind() {
  // Жест ловим на всей свободной области. Тап по карточке — открыть блюдо, тап мимо — следующее.
  swipeable($('stage'), {
    onLeft: goNext,
    onRight: () => { if (state.pos > 0) goPrev(); else releaseCard(); },
    onTap: (e) => { if (e.target.closest('#card')) startCook(); else goNext(); },
    onMove: dragCard,
    onCancel: releaseCard,
  });
  window.addEventListener('resize', () => { if (!$('deck').hidden) syncBack(); });
  swipeable($('r-body'), { onLeft: () => setRecipeTab('ing'), onRight: () => setRecipeTab('steps') });

  $('c-pin').onclick = togglePin;
  $('c-more').onclick = openMore;
  $('c-garnish').onclick = () => { const id = currentId(); if (id) { spinGarnish(id); renderDeck(); } };
  $('m-pause').onclick = () => { closeMore(); pauseCurrent(); };
  $('more-sheet').addEventListener('click', (e) => { if (e.target.id === 'more-sheet' || e.target.dataset.close != null) closeMore(); });
  $('relax').onclick = relax;
  $('filter-btn').onclick = () => { $('filters').hidden = !$('filters').hidden; renderFilters(); };
  $('settings').onclick = () => openSetup(false);

  $('p-minus').onclick = () => changePortions(-1);
  $('p-plus').onclick = () => changePortions(1);
  $('to-recipe').onclick = () => go('recipe');
  $('list-back').onclick = $('list-back2').onclick = () => { state.cook = null; LS.set('cook', null); toRoot(); };

  $('recipe-back').onclick = () => history.back();
  $('r-done').onclick = () => go('done');
  $('r-tabs').addEventListener('click', (e) => { if (e.target.dataset.v) setRecipeTab(e.target.dataset.v); });

  $('done-back').onclick = () => history.back();
  $('d-save').onclick = saveDone;

  $('setup-save').onclick = saveSetup;
  $('setup-cancel').onclick = () => history.back();

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (!$('deck').hidden) {
      if (e.key === 'ArrowLeft' || e.key === ' ') goNext();
      else if (e.key === 'ArrowRight') goPrev();
      else if (e.key === 'Enter') startCook();
    } else if (!$('recipe').hidden) {
      if (e.key === 'ArrowLeft') setRecipeTab('ing');
      else if (e.key === 'ArrowRight') setRecipeTab('steps');
    }
  });

  window.addEventListener('online', () => { flush(); refresh(); });
  window.addEventListener('offline', () => renderStamp(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    flush();
    refresh();
    if (!$('recipe').hidden) wakeLock(true);   // браузер отпускает блокировку при сворачивании
  });
}

// ---------- старт ----------
bind();
history.replaceState({ screen: 'deck', depth: 0 }, '');
if (!state.url) {
  openSetup(true);
} else {
  reindex();
  if (state.snap) buildDeck();
  const cook = state.cook;
  if (cook && byId[cook.dish] && Date.now() - (cook.at || 0) < COOK_TTL) {
    // Телефон выгрузил приложение посреди готовки — возвращаемся к рецепту.
    // Chrome пропускает записи истории, добавленные без касания пользователя, и «назад» закрыл бы
    // приложение. Поэтому запись рецепта кладём при первом касании, до обработчиков кнопок.
    history.replaceState({ screen: 'deck', depth: 0 }, '');
    show('recipe');
    renderRecipe();
    const arm = () => {
      document.removeEventListener('click', arm, true);
      if (currentNav().depth === 0 && !$('recipe').hidden) history.pushState({ screen: 'recipe', depth: 1 }, '');
    };
    document.addEventListener('click', arm, true);
  } else {
    state.cook = null;
    LS.set('cook', null);
    show('deck');
    renderDeck();                       // мгновенно из кеша
  }
  renderStamp();
  flush().then(refresh);                // свежая база — в фоне
}

booted = true;
