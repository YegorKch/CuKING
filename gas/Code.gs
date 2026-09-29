/**
 * API приложения «CuKING».
 * Скрипт привязан к таблице (Расширения → Apps Script) и опубликован как веб-приложение.
 *
 * Листы «Блюда», «Ингредиенты», «Шаги», «Справочники» правятся руками — скрипт их только читает.
 * Колонки ищутся по заголовкам в первой строке, поэтому порядок колонок можно менять.
 * Лист «История» пишется только через appendRow.
 *
 * GET               → { ok, dishes, ingredients, steps, history, decks, serverTime }
 * POST (text/plain) → { action: 'log', entry: { id, date, dish, garnish, type, re, ra } } → то же, что GET, плюс result
 */

const SHEET_DISHES = 'Блюда';
const SHEET_INGR = 'Ингредиенты';
const SHEET_STEPS = 'Шаги';
const SHEET_HISTORY = 'История';
const SHEET_REF = 'Справочники';

const HISTORY_COLS = ['ID_записи', 'Дата', 'ID_блюда', 'ID_гарнира', 'Тип', 'Оценка_Егор', 'Оценка_Арина'];
const TYPES = ['готовили', 'пауза'];

// ---------- HTTP ----------

function doGet() {
  return respond_(() => snapshot_());
}

function doPost(e) {
  return respond_(() => {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    let result;
    try {
      if (req.action === 'log') result = addLog_(req.entry);
      else throw new Error('Неизвестное действие: ' + req.action);
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
    return Object.assign(snapshot_(), { result: result });
  });
}

function respond_(fn) {
  let body;
  try {
    body = Object.assign({ ok: true }, fn());
  } catch (err) {
    body = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- Чтение ----------

function snapshot_() {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  return {
    dishes: readDishes_(ss),
    ingredients: groupBy_(readSheet_(ss, SHEET_INGR), 'ID_блюда', (r) => ({
      p: str_(r['Продукт']), q: qty_(r['Кол-во']), u: str_(r['Ед.']), req: yes_(r['Обязательный'], true),
    })),
    steps: groupBy_(readSheet_(ss, SHEET_STEPS), 'ID_блюда', (r) => ({
      n: num_(r['Номер']), title: str_(r['Заголовок']), text: str_(r['Текст']), tech: str_(r['Техника']),
    }), (a, b) => a.n - b.n),
    history: readSheet_(ss, SHEET_HISTORY).map((r) => ({
      id: str_(r['ID_записи']),
      date: isDate_(r['Дата']) ? ymd_(r['Дата'], tz) : str_(r['Дата']),
      dish: str_(r['ID_блюда']),
      garnish: str_(r['ID_гарнира']),
      type: str_(r['Тип']),
      re: rating_(r['Оценка_Егор']),
      ra: rating_(r['Оценка_Арина']),
    })).filter((h) => h.dish && h.date),
    decks: readDecks_(ss),
    serverTime: new Date().toISOString(),
  };
}

function readDishes_(ss) {
  return readSheet_(ss, SHEET_DISHES).filter((r) => str_(r['ID'])).map((r) => {
    const g = str_(r['Нужен_гарнир']);
    return {
      id: str_(r['ID']),
      name: str_(r['Название']),
      desc: str_(r['Описание']),
      cat: str_(r['Категория']),
      garnish: g ? yes_(g, false) : null,
      time: num_(r['Время_мин']),
      portions: num_(r['Порций']) || 4,
      tech: list_(r['Техника']),
      diff: num_(r['Сложность']) || 1,
      tags: list_(r['Теги']),
      active: yes_(r['Активно'], true),
    };
  });
}

/** Колоды — пары «Колода / Категории_колоды» из «Справочников». */
function readDecks_(ss) {
  const sh = ss.getSheetByName(SHEET_REF);
  const data = sh.getDataRange().getValues();
  const head = data[0].map(str_);
  const cName = head.indexOf('Колода');
  const cCats = head.indexOf('Категории_колоды');
  if (cName < 0 || cCats < 0) throw new Error('В «Справочниках» нет колонок «Колода» и «Категории_колоды»');
  return data.slice(1)
    .filter((r) => str_(r[cName]))
    .map((r) => ({ name: str_(r[cName]), cats: list_(r[cCats]) }));
}

/** Строки листа как объекты { заголовок: значение }. Пустые строки пропускаются. */
function readSheet_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Нет листа «' + name + '»');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const data = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
  const head = data[0].map(str_);
  return data.slice(1)
    .filter((r) => r.some((v) => v !== ''))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function groupBy_(rows, key, map, sort) {
  const out = {};
  rows.forEach((r) => {
    const k = str_(r[key]);
    if (k) (out[k] = out[k] || []).push(map(r));
  });
  if (sort) Object.keys(out).forEach((k) => out[k].sort(sort));
  return out;
}

// ---------- Запись ----------

/** entry: { id, date: 'YYYY-MM-DD', dish, garnish?, type: 'готовили' | 'пауза', re?, ra? } */
function addLog_(entry) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_HISTORY);
  const e = validate_(ss, entry);

  // Повторная отправка из оффлайн-очереди не должна задвоить запись.
  if (findRow_(sh, e.id)) return { id: e.id, duplicate: true };

  sh.appendRow([e.id, parseYmd_(e.date), e.dish, e.garnish, e.type, e.re, e.ra]);
  return { id: e.id };
}

function validate_(ss, entry) {
  if (!entry) throw new Error('Нет данных записи');
  const e = {
    id: str_(entry.id) || Utilities.getUuid(),
    date: str_(entry.date),
    dish: str_(entry.dish),
    garnish: str_(entry.garnish),
    type: str_(entry.type),
    re: rating_(entry.re),
    ra: rating_(entry.ra),
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new Error('Дата должна быть в формате ГГГГ-ММ-ДД');
  if (TYPES.indexOf(e.type) < 0) throw new Error('Тип: ' + e.type);
  const ids = readSheet_(ss, SHEET_DISHES).map((r) => str_(r['ID']));
  if (ids.indexOf(e.dish) < 0) throw new Error('Нет блюда: ' + e.dish);
  if (e.garnish && ids.indexOf(e.garnish) < 0) throw new Error('Нет гарнира: ' + e.garnish);
  if (e.type === 'пауза') { e.garnish = ''; e.re = ''; e.ra = ''; }
  return e;
}

function findRow_(sh, id) {
  if (!id) return 0;
  const cell = sh.getRange('A:A').createTextFinder(String(id)).matchEntireCell(true).findNext();
  return cell && cell.getRow() > 1 ? cell.getRow() : 0;
}

// ---------- Утилиты ----------

function str_(v) {
  return v == null ? '' : String(v).trim();
}

function num_(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/** Количество: число (в т.ч. «0,5» строкой) или null для «по вкусу». */
function qty_(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(',', '.'));
  return isFinite(n) ? n : null;
}

function rating_(v) {
  const n = Math.round(Number(v));
  return n >= 1 && n <= 5 ? n : '';
}

function yes_(v, dflt) {
  const s = str_(v).toUpperCase();
  if (!s) return dflt;
  return s === 'ДА' || s === 'TRUE' || s === 'YES';
}

function list_(v) {
  return str_(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function ymd_(d, tz) {
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

// instanceof Date ненадёжен для значений из getValues(), поэтому проверяем по тегу.
function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

/**
 * Полночь даты в часовом поясе таблицы. Пояс скрипта не используем: если он отличается
 * от пояса таблицы, дата в ячейке съезжает на день.
 */
function parseYmd_(s) {
  return Utilities.parseDate(String(s), SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

// ---------- Проверка из редактора ----------

/** Запустить из редактора: выводит в журнал сводку того, что получит приложение. */
function debugSnapshot() {
  const s = snapshot_();
  Logger.log('Блюд: %s, с ингредиентами: %s, с шагами: %s, записей истории: %s',
    s.dishes.length, Object.keys(s.ingredients).length, Object.keys(s.steps).length, s.history.length);
  Logger.log('Колоды: %s', JSON.stringify(s.decks));
  const noSteps = s.dishes.filter((d) => !s.steps[d.id]).map((d) => d.id);
  const noIngr = s.dishes.filter((d) => !s.ingredients[d.id]).map((d) => d.id);
  if (noSteps.length) Logger.log('Без шагов: %s', noSteps.join(', '));
  if (noIngr.length) Logger.log('Без ингредиентов: %s', noIngr.join(', '));
  Logger.log('Первое блюдо: %s', JSON.stringify(s.dishes[0]));
}

/** Пишет тестовую запись, проверяет защиту от дубля и удаляет её. В таблице ничего не остаётся. */
function debugWriteCycle() {
  const ss = SpreadsheetApp.getActive();
  const id = 'test-' + Date.now();
  const dish = readDishes_(ss)[0].id;
  const today = ymd_(new Date(), ss.getSpreadsheetTimeZone());
  Logger.log(addLog_({ id: id, date: today, dish: dish, type: 'готовили', re: 5, ra: 4 }));
  Logger.log(addLog_({ id: id, date: today, dish: dish, type: 'готовили' })); // должен вернуть duplicate
  const sh = ss.getSheetByName(SHEET_HISTORY);
  const row = findRow_(sh, id);
  if (row) sh.deleteRow(row);
  Logger.log('Тестовая строка удалена: %s', !findRow_(sh, id));
}
