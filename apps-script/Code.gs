/**
 * 단체 음료 주문 — 구글 시트 백엔드 (Google Apps Script)
 * ──────────────────────────────────────────────────────────────
 * 학교·팀 회의 단체 음료 주문을 시트에 모읍니다.
 * 여러 명이 같은 순간에 주문해도 LockService 로 한 줄씩 처리해서
 * 덮어쓰기·누락이 생기지 않습니다.
 *
 * [설치 순서 — 3분]
 * 1. 구글 드라이브에서 새 스프레드시트를 만듭니다(예: 단체 음료 주문).
 * 2. 그 시트에서 [확장 프로그램] → [Apps Script] 를 엽니다.
 *    (이렇게 열면 이 스크립트가 그 시트에 '붙어(bound)' 있어서
 *     시트 ID를 따로 적지 않아도 됩니다.)
 * 3. 아래 코드 전체를 붙여넣고 저장합니다.
 * 4. 편집기 위쪽 함수 선택에서 setup 을 한 번 실행합니다.
 *    → Config / Orders / Menus / History / Backup 탭이 자동으로 만들어집니다.
 * 5. [배포] → [새 배포] → 유형 '웹 앱'
 *      - 설명: 단체 음료 주문
 *      - 다음 사용자로 실행: 나
 *      - 액세스 권한: 모든 사용자
 *    → 나오는 웹 앱 URL(…/exec)을 앱 관리자 화면 [회차·설정] → [시트 연결]에 붙여넣습니다.
 *
 * [다른 사람에게 나눠 줄 때]
 * 시트를 '사본 만들기'로 복제하고, 그 사본에서 새로 배포하기만 하면 똑같이 동작합니다.
 * (아래 SPREADSHEET_ID 를 비워 두면 언제나 '이 스크립트가 붙은 시트'를 쓰므로
 *  ID를 고칠 필요가 없습니다.)
 *
 * [보안]
 * - 이 스크립트는 자기가 붙은 스프레드시트 한 개만 읽고 씁니다.
 * - 웹 앱 주소는 열쇠와 같습니다. 공개 저장소·SNS·열린 단체방에 올리지 마세요.
 * - 저장되는 것은 이름·메뉴·요청사항·시각뿐입니다. 전화번호·이메일·주소는 받지 않습니다.
 */

/* ── 설정 ─────────────────────────────────────────────── */
/* 비워 두면 '이 스크립트가 붙어 있는 시트'를 씁니다(권장).
   다른 시트에 붙이고 싶을 때만 그 시트 ID를 넣으세요. */
var SPREADSHEET_ID = '';
var TZ = 'Asia/Seoul';

var SH_CONFIG = 'Config';
var SH_ORDERS = 'Orders';
var SH_MENUS = 'Menus';
var SH_HISTORY = 'History';
var SH_BACKUP = 'Backup';

var H_ORDERS = ['라운드ID', '이름', '메뉴', '온도', '요청사항', '시각'];
var H_MENUS = ['브랜드', '수정JSON', '수정시각'];
var H_HISTORY = ['라운드ID', '회차이름', '브랜드', '마감시각', '주문수', '주문JSON'];
var H_BACKUP = ['시각', '라운드ID', '주문수', 'JSON'];

var CONFIG_KEYS = ['roundId', 'roundName', 'brand', 'status', 'roster', 'updatedAt'];

/* ── 진입점 ───────────────────────────────────────────── */
function doGet(e) {
  var p = (e && e.parameter) || {};
  /* JSONP: 앱은 <script> 태그로 부르고 callback= 을 붙입니다.
     null 로 넘기면 래퍼 없는 JSON 이 와서 앱이 '불러오기 실패'로 떨어집니다. */
  return handle_(p, p.callback);
}

function doPost(e) {
  var p = (e && e.parameter) || {};
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: '요청 본문(JSON)을 읽지 못했습니다.' }, p.callback);
  }
  if (typeof body !== 'object' || body === null) body = {};
  for (var k in p) {
    if (Object.prototype.hasOwnProperty.call(p, k) && !(k in body)) body[k] = p[k];
  }
  return handle_(body, p.callback);
}

function handle_(req, callback) {
  var action = String((req && req.action) || 'ping');
  try {
    if (action === 'ping') return json_(ping_(), callback);
    if (action === 'load') return json_(load_(req), callback);
    if (action === 'submit') return json_(withLock_(function () { return submit_(req); }), callback);
    if (action === 'remove') return json_(withLock_(function () { return remove_(req); }), callback);
    if (action === 'removeMissing') return json_(withLock_(function () { return removeMissing_(); }), callback);
    if (action === 'config') return json_(withLock_(function () { return config_(req); }), callback);
    if (action === 'roster') return json_(withLock_(function () { return roster_(req); }), callback);
    if (action === 'menus') return json_(withLock_(function () { return menus_(req); }), callback);
    if (action === 'newRound') return json_(withLock_(function () { return newRound_(req); }), callback);
    if (action === 'deleteHistory') return json_(withLock_(function () { return deleteHistory_(req); }), callback);
    return json_({ ok: false, error: '알 수 없는 action: ' + action }, callback);
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) }, callback);
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);          /* 동시에 들어와도 한 명씩 차례로 */
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ── 응답 ─────────────────────────────────────────────── */
function json_(obj, callback) {
  var text = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + text + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function ping_() {
  return { ok: true, app: 'coffee-order', version: 2, time: nowStr_(), spreadsheet: !!ss_() };
}

/* ── 시트 준비 ────────────────────────────────────────── */
function ss_() {
  try {
    if (SPREADSHEET_ID) return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (e) {
    /* 아래에서 bound 시트로 한 번 더 시도 */
  }
  var active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { active = null; }
  return active;
}

function sheet_(name, headers) {
  var ss = ss_();
  if (!ss) throw new Error('시트를 찾지 못했습니다. 이 스크립트를 시트에서 [확장 프로그램] → [Apps Script] 로 열었는지, 또는 SPREADSHEET_ID 를 확인해 주세요.');
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#E8F1FF');
    sh.setFrozenRows(1);
  }
  if (sh.getLastRow() === 0) sh.appendRow(headers);
  return sh;
}

function setup() {
  sheet_(SH_CONFIG, ['key', 'value', 'updatedAt']);
  sheet_(SH_ORDERS, H_ORDERS);
  sheet_(SH_MENUS, H_MENUS);
  sheet_(SH_HISTORY, H_HISTORY);
  sheet_(SH_BACKUP, H_BACKUP);
  if (!readConfig_().roundId) {
    var roundId = 'r' + Date.now().toString(36);
    var brand = 'compose';
    writeConfig_({
      roundId: roundId,
      roundName: todayMD_() + ' 컴포즈커피',
      brand: brand,
      status: 'open',
      roster: [],
      updatedAt: nowStr_()
    });
  }
  Logger.log('준비 완료: ' + nowStr_());
}

/* ── Config ───────────────────────────────────────────── */
function readConfig_() {
  var sh = sheet_(SH_CONFIG, ['key', 'value', 'updatedAt']);
  var out = {};
  var last = sh.getLastRow();
  if (last >= 2) {
    var rows = sh.getRange(2, 1, last - 1, 2).getValues();
    rows.forEach(function (r) {
      var k = String(r[0] || '');
      if (!k) return;
      out[k] = r[1];
    });
  }
  var cfg = {
    roundId: String(out.roundId || ''),
    roundName: String(out.roundName || ''),
    brand: String(out.brand || 'compose'),
    status: String(out.status || 'open'),
    roster: [],
    updatedAt: String(out.updatedAt || '')
  };
  try { cfg.roster = typeof out.roster === 'string' ? JSON.parse(out.roster) : (out.roster || []); } catch (e) { cfg.roster = []; }
  if (!Array.isArray(cfg.roster)) cfg.roster = [];
  return cfg;
}

function writeConfig_(cfg) {
  var sh = sheet_(SH_CONFIG, ['key', 'value', 'updatedAt']);
  var now = nowStr_();
  var values = {
    roundId: cfg.roundId || '',
    roundName: cfg.roundName || '',
    brand: cfg.brand || 'compose',
    status: cfg.status || 'open',
    roster: JSON.stringify(cfg.roster || []),
    updatedAt: cfg.updatedAt || now
  };
  var last = sh.getLastRow();
  var idx = {};
  if (last >= 2) {
    var keys = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) idx[String(keys[i][0])] = i + 2;
  }
  CONFIG_KEYS.forEach(function (k) {
    var v = values[k];
    if (idx[k]) sh.getRange(idx[k], 2, 1, 2).setValues([[v, now]]);
    else sh.appendRow([k, v, now]);
  });
}

/* ── Orders ───────────────────────────────────────────── */
function readOrders_(roundId) {
  var sh = sheet_(SH_ORDERS, H_ORDERS);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, H_ORDERS.length).getValues();
  var out = [];
  rows.forEach(function (r) {
    if (String(r[0]) !== roundId) return;
    if (!String(r[1])) return;
    out.push({
      name: String(r[1]),
      menu: String(r[2] || ''),
      temp: String(r[3] || ''),
      note: String(r[4] || ''),
      ts: String(r[5] || '')
    });
  });
  return out;
}

function rowIndexesFor_(sh, roundId, name) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, 2).getValues();
  var idx = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === roundId && String(rows[i][1]) === name) idx.push(i + 2);
  }
  return idx;
}

/* ── 메뉴 ─────────────────────────────────────────────── */
function readMenus_() {
  var sh = sheet_(SH_MENUS, H_MENUS);
  var last = sh.getLastRow();
  var out = {};
  if (last < 2) return out;
  var rows = sh.getRange(2, 1, last - 1, 2).getValues();
  rows.forEach(function (r) {
    var b = String(r[0] || '');
    if (!b) return;
    var ov = null;
    try { ov = typeof r[1] === 'string' ? JSON.parse(r[1]) : r[1]; } catch (e) { ov = null; }
    if (ov && typeof ov === 'object') out[b] = ov;
  });
  return out;
}

/* ── History ──────────────────────────────────────────── */
function readHistory_(limit) {
  var sh = sheet_(SH_HISTORY, H_HISTORY);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, H_HISTORY.length).getValues();
  var out = rows.map(function (r) {
    var orders = [];
    try { orders = typeof r[5] === 'string' ? JSON.parse(r[5]) : []; } catch (e) { orders = []; }
    return {
      roundId: String(r[0] || ''),
      roundName: String(r[1] || ''),
      brand: String(r[2] || 'compose'),
      closedAt: String(r[3] || ''),
      total: Number(r[4] || 0),
      orders: orders
    };
  }).filter(function (h) { return h.roundId; });
  out.reverse();
  return limit ? out.slice(0, limit) : out;
}

/* ── load ─────────────────────────────────────────────── */
function load_(req) {
  var cfg = readConfig_();
  if (!cfg.roundId) {
    /* 완전히 빈 시트면 기본 회차를 만들어 준다 (setup 을 안 돌린 경우 대비) */
    setup();
    cfg = readConfig_();
  }
  /* lite=1 — 참여자 화면은 지난 회차가 필요 없어 그 몫을 빼고 내려준다 */
  var lite = String((req && req.lite) || '') === '1' || (req && req.lite === true);
  var out = {
    ok: true,
    app: 'coffee-order',
    config: cfg,
    orders: readOrders_(cfg.roundId),
    menus: readMenus_(),
    time: nowStr_()
  };
  if (!lite) out.history = readHistory_(20);
  return out;
}

/* ── submit ───────────────────────────────────────────── */
function submit_(req) {
  var cfg = readConfig_();
  if (!cfg.roundId) throw new Error('시트에 회차가 없습니다. setup 을 실행해 주세요.');
  if (cfg.status !== 'open') return { ok: false, error: 'closed' };

  var name = String(req.name || '').trim();
  var menu = String(req.menu || '').trim();
  var temp = String(req.temp || '').trim();
  var note = String(req.note || '').trim().slice(0, 100);
  if (!name) return { ok: false, error: '이름이 없습니다.' };
  if (!menu) return { ok: false, error: '메뉴가 없습니다.' };
  if (name.length > 20) return { ok: false, error: '이름이 너무 깁니다.' };

  var sh = sheet_(SH_ORDERS, H_ORDERS);
  var now = nowStr_();
  var idx = rowIndexesFor_(sh, cfg.roundId, name);

  if (idx.length) {
    /* 같은 사람이 다시 고르면 마지막 주문만 남긴다 (중복 0) */
    sh.getRange(idx[0], 1, 1, H_ORDERS.length).setValues([[cfg.roundId, name, menu, temp, note, now]]);
    for (var i = idx.length - 1; i >= 1; i--) sh.deleteRow(idx[i]);
  } else {
    sh.appendRow([cfg.roundId, name, menu, temp, note, now]);
  }
  writeConfig_({ roundId: cfg.roundId, roundName: cfg.roundName, brand: cfg.brand, status: cfg.status, roster: cfg.roster, updatedAt: now });
  return { ok: true, order: { name: name, menu: menu, temp: temp, note: note, ts: now } };
}

/* ── remove ───────────────────────────────────────────── */
function remove_(req) {
  var cfg = readConfig_();
  var name = String(req.name || '').trim();
  if (!name) return { ok: false, error: '이름이 없습니다.' };
  var sh = sheet_(SH_ORDERS, H_ORDERS);
  var idx = rowIndexesFor_(sh, cfg.roundId, name);
  for (var i = idx.length - 1; i >= 0; i--) sh.deleteRow(idx[i]);
  return { ok: true, removed: idx.length };
}

/* 명단에 없는 이름의 주문 정리 */
function removeMissing_() {
  var cfg = readConfig_();
  var sh = sheet_(SH_ORDERS, H_ORDERS);
  var last = sh.getLastRow();
  if (last < 2) return { ok: true, removed: 0 };
  var roster = {};
  (cfg.roster || []).forEach(function (n) { roster[n] = 1; });
  var rows = sh.getRange(2, 1, last - 1, 2).getValues();
  var doomed = [];
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0]) !== cfg.roundId) continue;
    if (!roster[String(rows[i][1])]) doomed.push(i + 2);
  }
  doomed.forEach(function (r) { sh.deleteRow(r); });
  return { ok: true, removed: doomed.length };
}

/* ── config ───────────────────────────────────────────── */
function config_(req) {
  var cfg = readConfig_();
  var patch = req.patch;
  if (typeof patch === 'string') {
    try { patch = JSON.parse(patch); } catch (e) { patch = null; }
  }
  if (!patch) patch = req;

  if (patch.roundName !== undefined && String(patch.roundName).trim()) {
    cfg.roundName = String(patch.roundName).trim().slice(0, 40);
  }
  if (patch.brand !== undefined && String(patch.brand).trim()) {
    cfg.brand = String(patch.brand).trim();
  }
  if (patch.status !== undefined) {
    var st = String(patch.status);
    if (st === 'open' || st === 'closed') cfg.status = st;
  }
  cfg.updatedAt = nowStr_();
  writeConfig_(cfg);
  return { ok: true, config: cfg };
}

/* ── roster ───────────────────────────────────────────── */
function roster_(req) {
  var cfg = readConfig_();
  var incoming = req.roster;
  if (typeof incoming === 'string') {
    try {
      incoming = JSON.parse(incoming);
    } catch (e) {
      incoming = incoming.split(/[\n,;\t]+/);
    }
  }
  if (!Array.isArray(incoming)) return { ok: false, error: '명단 형식이 아닙니다.' };

  var seen = {};
  var clean = [];
  incoming.forEach(function (v) {
    var n = String(v == null ? '' : v).trim();
    if (!n || n.length > 20 || seen[n]) return;
    seen[n] = 1;
    clean.push(n);
  });

  /* 빈 명단으로 기존 명단을 지우는 사고 방지 (force 없이는 막는다) */
  if (!clean.length && (cfg.roster || []).length && req.force !== true && String(req.force) !== 'true') {
    return { ok: false, error: '빈 명단으로 덮어쓰기를 차단했습니다.' };
  }

  cfg.roster = clean;
  cfg.updatedAt = nowStr_();
  writeConfig_(cfg);
  return { ok: true, roster: clean };
}

/* ── menus ────────────────────────────────────────────── */
function menus_(req) {
  var brand = String(req.brand || '').trim();
  if (!brand) return { ok: false, error: '브랜드가 없습니다.' };
  var ov = req.ov;
  if (typeof ov === 'string') {
    try { ov = JSON.parse(ov); } catch (e) { ov = null; }
  }
  if (!ov || typeof ov !== 'object') return { ok: false, error: '메뉴 수정 내용이 없습니다.' };
  ov.removed = Array.isArray(ov.removed) ? ov.removed : [];
  ov.renamed = ov.renamed && typeof ov.renamed === 'object' ? ov.renamed : {};
  ov.added = Array.isArray(ov.added) ? ov.added : [];

  var sh = sheet_(SH_MENUS, H_MENUS);
  var now = nowStr_();
  var last = sh.getLastRow();
  var row = 0;
  if (last >= 2) {
    var brands = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < brands.length; i++) {
      if (String(brands[i][0]) === brand) { row = i + 2; break; }
    }
  }
  if (row) sh.getRange(row, 2, 1, 2).setValues([[JSON.stringify(ov), now]]);
  else sh.appendRow([brand, JSON.stringify(ov), now]);
  return { ok: true, ov: ov };
}

/* ── newRound ─────────────────────────────────────────── */
function newRound_(req) {
  var cfg = readConfig_();
  var orders = readOrders_(cfg.roundId);
  var archived = 0;

  if (orders.length) {
    /* 지금 주문은 History 에 통째로 보관 */
    var shH = sheet_(SH_HISTORY, H_HISTORY);
    shH.appendRow([
      cfg.roundId, cfg.roundName, cfg.brand, nowStr_(), orders.length, JSON.stringify(orders)
    ]);
    archived = orders.length;

    backup_(cfg, orders);

    /* 현재 라운드 주문만 지운다 (이전 라운드 기록은 남긴다) */
    var sh = sheet_(SH_ORDERS, H_ORDERS);
    var last = sh.getLastRow();
    if (last >= 2) {
      var rows = sh.getRange(2, 1, last - 1, 1).getValues();
      for (var i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i][0]) === cfg.roundId) sh.deleteRow(i + 2);
      }
    }
  }

  var brand = String(req.brand || cfg.brand || 'compose');
  var next = {
    roundId: 'r' + Date.now().toString(36),
    roundName: String(req.roundName || (todayMD_() + ' ' + brand)).trim().slice(0, 40),
    brand: brand,
    status: 'open',
    roster: cfg.roster || [],
    updatedAt: nowStr_()
  };
  writeConfig_(next);
  return { ok: true, archived: archived, config: next };
}

/* ── deleteHistory ────────────────────────────────────── */
/* 지난 회차 한 건을 History 탭에서 지운다 (roundId 기준) */
function deleteHistory_(req) {
  var roundId = String((req && req.roundId) || '').trim();
  if (!roundId) return { ok: false, error: '회차가 없습니다.' };
  var sh = sheet_(SH_HISTORY, H_HISTORY);
  var last = sh.getLastRow();
  if (last < 2) return { ok: true, removed: 0 };
  var rows = sh.getRange(2, 1, last - 1, 1).getValues();
  var doomed = [];
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0]) === roundId) doomed.push(i + 2);
  }
  doomed.forEach(function (r) { sh.deleteRow(r); });
  return { ok: true, removed: doomed.length };
}

/* ── 백업 ─────────────────────────────────────────────── */
function backup_(cfg, orders) {
  try {
    var sh = sheet_(SH_BACKUP, H_BACKUP);
    sh.appendRow([nowStr_(), cfg.roundId, orders.length, JSON.stringify(orders)]);
    var rows = sh.getLastRow();
    if (rows > 61) sh.deleteRows(2, rows - 61);
  } catch (e) {
    /* 백업 실패가 라운드 전환을 막지 않게 */
  }
}

/* ── 유틸 ─────────────────────────────────────────────── */
function nowStr_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

function todayMD_() {
  return Utilities.formatDate(new Date(), TZ, 'MM/dd');
}

/* ── 편집기 메뉴 ──────────────────────────────────────── */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('☕ 단체 음료 주문')
      .addItem('시트 준비 (setup)', 'setup')
      .addItem('현재 주문 시트로 보기', 'openAppHint')
      .addToUi();
  } catch (e) { /* 웹 전용 실행에서는 무시 */ }
}

function openAppHint() {
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
  var msg = url
    ? '웹 앱 주소입니다. 앱 관리자 화면의 [시트 연결]에 붙여넣으세요.\n\n' + url
    : '아직 배포되지 않았습니다. [배포] → [새 배포] → 웹 앱으로 배포해 주세요.';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}
