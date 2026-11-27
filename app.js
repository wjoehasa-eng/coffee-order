/* 단체 음료 주문 — 앱 로직
 * ─────────────────────────────────────────────────────────────
 * 참여자: 이름 선택 → 메뉴 선택 → 확인 3단계
 * 편집자: ?admin=1 (또는 #admin=1) 로 들어오는 관리자 화면
 *
 * 저장 방식 두 가지
 *   1) 로컬 모드  — 시트를 연결하지 않으면 이 브라우저(localStorage)에만 저장
 *   2) 시트 모드  — Apps Script 웹앱 주소(#s=...)를 연결하면 구글 시트에 저장
 * 두 모드는 같은 동작(api)을 쓰므로 화면 코드가 하나입니다.
 */
(function () {
  'use strict';

  var APP_VERSION = '1.1.0';
  var LS_DATA = 'coffee-order-v1';
  var LS_SHEET = 'coffee-order-sheet';
  var LS_SRC = 'coffee-order-src';       /* 저장분이 어느 채널의 것인지 */
  var LS_LASTTEMP = 'coffee-order-lasttemp';

  /* 쓰기 응답 본문이 길어 GET(JSONP) 주소로는 부담스러운 요청 */
  var LONG_ACTIONS = { roster: 1, menus: 1 };
  var FB_HOST = /\.(firebasedatabase\.app|firebaseio\.com)(\/|$)/i;

  /* ── 작은 도구들 ───────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayMD(d) {
    d = d || new Date();
    return pad(d.getMonth() + 1) + '/' + pad(d.getDate());
  }
  function nowISO() { return new Date().toISOString(); }
  function newId() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function codeName() { return COMenu.brand(S.data.config.brand).name; }

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 2200);
  }

  /* ── 상태 ──────────────────────────────────────────────── */
  var S = {
    data: null,
    mode: 'user',                 /* user | admin */
    tab: 'stats',                 /* admin 탭 */
    sheetUrl: '',
    connected: false,
    busy: false,
    cached: false,                /* localStorage에 저장분이 있는지 */
    fbMode: false,                /* Firebase 실시간 DB 모드 */
    raw: null,                    /* Firebase 원본 스냅샷 */
    es: null,                     /* EventSource */
    streamOn: false,
    lastBtn: null,                /* 방금 누른 버튼(저장 중… 표시용) */
    nq: '',                       /* 이름 검색어 */
    mq: '',                       /* 메뉴 검색어 */
    cat: 'all',
    editorBrand: '',
    pickItem: null,
    pickTemp: '',
    editMenuId: '',
    editMenuTemp: '',
    editTemp: '',
    confirmCb: null,
    u: { step: 'pick', name: '', draft: null }
  };

  /* ── 기본 데이터 ───────────────────────────────────────── */
  function blankData() {
    var brand = 'compose';
    return {
      config: {
        roundId: newId(),
        roundName: todayMD() + ' ' + COMenu.brand(brand).name,
        brand: brand,
        status: 'open',
        roster: [],
        updatedAt: nowISO()
      },
      orders: [],
      menus: {},
      history: []
    };
  }

  /* ── 로컬 저장소 ───────────────────────────────────────── */
  function readLocal() {
    try {
      var src = localStorage.getItem(LS_SRC) || '';
      if (S.sheetUrl && src && src !== S.sheetUrl) return null;   /* 다른 채널의 저장분 */
      var raw = localStorage.getItem(LS_DATA);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || !d.config) return null;
      d.orders = d.orders || [];
      d.menus = d.menus || {};
      d.history = d.history || [];
      d.config.roster = d.config.roster || [];
      return d;
    } catch (e) { return null; }
  }
  function saveLocal() {
    try {
      localStorage.setItem(LS_DATA, JSON.stringify(S.data));
      localStorage.setItem(LS_SRC, S.sheetUrl || '');
    } catch (e) {}
  }

  /* ── 로컬 API (시트 없이도 완전히 동작) ─────────────────── */
  function localApi(action, p) {
    p = p || {};
    return new Promise(function (resolve) {
      setTimeout(function () {
        try { resolve(localDo(action, p)); }
        catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
      }, 30);
    });
  }

  function localDo(action, p) {
    var d = S.data;

    if (action === 'load') {
      return { ok: true, config: clone(d.config), orders: clone(d.orders), menus: clone(d.menus), history: clone(d.history) };
    }

    if (action === 'submit') {
      if (d.config.status !== 'open') return { ok: false, error: 'closed' };
      var name = String(p.name || '').trim();
      var menu = String(p.menu || '').trim();
      if (!name) return { ok: false, error: '이름이 없습니다.' };
      if (!menu) return { ok: false, error: '메뉴가 없습니다.' };
      var prev = null;
      d.orders = d.orders.filter(function (o) {
        if (o.name === name) { prev = o; return false; }
        return true;
      });
      var order = {
        name: name,
        menu: menu.slice(0, 60),
        temp: String(p.temp || '').slice(0, 4),
        note: String(p.note || '').slice(0, 100),
        ts: nowISO()
      };
      d.orders.push(order);
      d.config.updatedAt = nowISO();
      saveLocal();
      return { ok: true, order: clone(order), replaced: !!prev };
    }

    if (action === 'remove') {
      var nm = String(p.name || '');
      var before = d.orders.length;
      d.orders = d.orders.filter(function (o) { return o.name !== nm; });
      d.config.updatedAt = nowISO();
      saveLocal();
      return { ok: true, removed: before - d.orders.length };
    }

    if (action === 'removeMissing') {
      var set = {};
      d.config.roster.forEach(function (n) { set[n] = 1; });
      var b2 = d.orders.length;
      d.orders = d.orders.filter(function (o) { return set[o.name]; });
      saveLocal();
      return { ok: true, removed: b2 - d.orders.length };
    }

    if (action === 'config') {
      var patch = p.patch || {};
      ['roundName', 'brand', 'status'].forEach(function (k) {
        if (patch[k] != null) d.config[k] = String(patch[k]);
      });
      if (patch.roundId) d.config.roundId = String(patch.roundId);
      d.config.updatedAt = nowISO();
      saveLocal();
      return { ok: true, config: clone(d.config) };
    }

    if (action === 'roster') {
      var list = p.roster || [];
      var seen = {};
      d.config.roster = list.map(function (n) { return String(n).trim(); })
        .filter(function (n) {
          if (!n || n.length > 20 || seen[n]) return false;
          seen[n] = 1; return true;
        });
      d.config.updatedAt = nowISO();
      saveLocal();
      return { ok: true, roster: d.config.roster.slice() };
    }

    if (action === 'menus') {
      var brand = String(p.brand || '');
      if (!brand) return { ok: false, error: '브랜드가 없습니다.' };
      d.menus[brand] = p.ov || { removed: [], renamed: {}, added: [] };
      d.config.updatedAt = nowISO();
      saveLocal();
      return { ok: true, ov: clone(d.menus[brand]) };
    }

    if (action === 'newRound') {
      var archived = null;
      if (d.orders.length) {
        archived = {
          roundId: d.config.roundId,
          roundName: d.config.roundName,
          brand: d.config.brand,
          closedAt: nowISO(),
          total: d.orders.length,
          orders: clone(d.orders)
        };
        d.history.unshift(archived);
        d.history = d.history.slice(0, 50);
      }
      d.orders = [];
      d.config.roundId = newId();
      d.config.roundName = String(p.roundName || (todayMD() + ' ' + COMenu.brand(p.brand || d.config.brand).name));
      if (p.brand) d.config.brand = String(p.brand);
      d.config.status = 'open';
      d.config.updatedAt = nowISO();
      saveLocal();
      return { ok: true, archived: archived ? archived.total : 0, config: clone(d.config) };
    }

    if (action === 'deleteHistory') {
      var rid = String(p.roundId || '');
      if (!rid) return { ok: false, error: '회차가 없습니다.' };
      var beforeDel = (d.history || []).length;
      d.history = (d.history || []).filter(function (h) { return h.roundId !== rid; });
      saveLocal();
      return { ok: true, removed: beforeDel - d.history.length };
    }

    return { ok: false, error: '알 수 없는 action: ' + action };
  }

  /* ── 시트 API ──────────────────────────────────────────── */
  function jsonp(base, params) {
    return new Promise(function (resolve, reject) {
      var cb = 'coCb' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
      var qs = Object.keys(params || {}).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      }).join('&');
      var s = document.createElement('script');
      var done = false;
      var timer = setTimeout(function () {
        if (done) return; done = true; cleanup(); reject(new Error('timeout'));
      }, 15000);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (s.parentNode) s.parentNode.removeChild(s);
      }
      window[cb] = function (data) { if (done) return; done = true; cleanup(); resolve(data); };
      s.onerror = function () { if (done) return; done = true; cleanup(); reject(new Error('network')); };
      s.src = base + (base.indexOf('?') >= 0 ? '&' : '?') + (qs ? qs + '&' : '') +
        'callback=' + cb + '&_=' + Date.now();
      document.body.appendChild(s);
    });
  }

  function postSheet(action, p) {
    var body = { action: action };
    Object.keys(p || {}).forEach(function (k) { body[k] = p[k]; });
    return fetch(S.sheetUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }).catch(function () {});
  }

  function applyRemote(res) {
    if (!res || res.ok === false) throw new Error((res && res.error) || '불러오기 실패');
    if (!res.config) throw new Error('시트에 Config 탭이 없습니다.');
    S.data = {
      config: res.config,
      orders: res.orders || [],
      menus: res.menus || {},
      /* lite 응답에는 history가 없습니다 — 관리자 화면이면 이전 값을 그대로 둡니다 */
      history: res.history || (S.data && S.data.history) || []
    };
    S.data.config.roster = S.data.config.roster || [];
    S.connected = true;
    /* 다음 방문부터는 시트를 기다리지 않고 이 저장분을 바로 그립니다 */
    saveLocal();
    S.cached = true;
  }

  function sheetLoad(lite) {
    /* 참여자 화면은 지난 회차(history)가 필요 없어 그 부분을 빼고 받습니다 */
    var params = { action: 'load' };
    if (lite == null ? S.mode !== 'admin' : lite) params.lite = '1';
    return jsonp(S.sheetUrl, params).then(function (res) {
      applyRemote(res);
      return res;
    });
  }

  /* 쓰기 한 건 — 응답까지 필요한 만큼만 기다립니다(왕복 1회)
     · 짧은 요청: doGet(JSONP) 한 번으로 결과(ok/closed)까지 받는다
     · 긴 요청(roster·menus): POST는 응답을 읽을 수 없어 보내고 바로 화면에 반영한 뒤 동기화 */
  function sheetWrite(action, p) {
    if (LONG_ACTIONS[action]) {
      return postSheet(action, p).then(function () { return { ok: true, optimistic: true }; });
    }
    var params = { action: action };
    Object.keys(p || {}).forEach(function (k) {
      var v = p[k];
      params[k] = (v && typeof v === 'object') ? JSON.stringify(v) : v;
    });
    return jsonp(S.sheetUrl, params);
  }

  /* ── 공통 api ─────────────────────────────────────────── */
  function api(action, p, pre) {
    if (S.fbMode) return action === 'load' ? fbLoad() : fbWrite(action, p, pre);
    if (action === 'load') return S.sheetUrl ? sheetLoad() : localApi('load');
    return S.sheetUrl ? sheetWrite(action, p) : localApi(action, p);
  }

  function backendLoad() {
    return S.fbMode ? fbLoad() : sheetLoad();
  }

  /* ══ Firebase 실시간 DB ══════════════════════════════════
   * 주소: https://<db>.firebasedatabase.app/ch/<key>
   *   <base>/config            회차·브랜드·상태·명단
   *   <base>/orders/<roundId>/<사람키>   사람별 주문 (키가 달라 동시에 써도 안 겹침)
   *   <base>/menus/<brand>     메뉴 수정
   *   <base>/history/<roundId>   지난 회차
   * 읽기는 <base>.json 한 번, 이후는 EventSource 로 실시간 반영.
   */
  function isFbUrl(u) {
    u = String(u || '');
    /* 실서비스: https://<db>.firebasedatabase.app/ch/<key>  ·  로컬 시험용: …/ch/<key> */
    return FB_HOST.test(u) || /\/ch\/[A-Za-z0-9_\-]{6,}\/?$/.test(u);
  }

  function safeKey(s) {
    /* Firebase 키에는 . $ # [ ] / 를 쓸 수 없고, 스트림 경로에서는 ~ 도 피한다 */
    return encodeURIComponent(String(s == null ? '' : s))
      .replace(/\./g, '%2E').replace(/~/g, '%7E');
  }

  function fbBase() {
    return String(S.sheetUrl || '').trim().replace(/\/+$/, '');
  }

  function fbUrl(path) {
    var b = fbBase();
    if (!path || path === '.json') return b + '.json';
    return b + '/' + path;
  }

  function fbReq(method, path, body) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var opts = { method: method, cache: 'no-store' };
    if (ctl) opts.signal = ctl.signal;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 12000);
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    return fetch(fbUrl(path), opts).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('연결 실패(' + r.status + ')');
      return r.text().then(function (t) {
        try { return JSON.parse(t); } catch (e) { return null; }
      });
    }, function (e) { clearTimeout(timer); throw e; });
  }

  /* Firebase 원본 → 화면 상태 */
  function applyFb(raw) {
    raw = raw || {};
    S.raw = raw;
    var cin = raw.config || {};
    var rid = String(cin.roundId || '');
    var bag = (raw.orders && rid && raw.orders[rid]) || {};
    var list = Object.keys(bag).map(function (k) {
      var o = bag[k];
      if (!o || typeof o !== 'object') return null;
      return {
        name: String(o.name || ''), menu: String(o.menu || ''), temp: String(o.temp || ''),
        note: String(o.note || ''), ts: String(o.ts || '')
      };
    }).filter(function (o) { return o && o.name; });

    var hist = Object.keys(raw.history || {}).map(function (k) {
      var h = raw.history[k] || {};
      return {
        roundId: String(h.roundId || k), roundName: String(h.roundName || ''),
        brand: String(h.brand || 'compose'), closedAt: String(h.closedAt || ''),
        total: Number(h.total || 0), orders: h.orders || []
      };
    }).sort(function (a, b) { return String(b.closedAt).localeCompare(String(a.closedAt)); });

    S.data = {
      config: {
        roundId: rid || newId(),
        roundName: String(cin.roundName || ''),
        brand: String(cin.brand || 'compose'),
        status: String(cin.status || 'open'),
        roster: Array.isArray(cin.roster) ? cin.roster.map(String) : [],
        updatedAt: String(cin.updatedAt || '')
      },
      orders: list,
      menus: raw.menus || {},
      history: hist
    };
    S.connected = true;
    saveLocal();
    S.cached = true;
  }

  function fbLoad() {
    return fetch(fbUrl('.json'), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('연결 실패(' + r.status + ')');
      return r.json();
    }).then(function (raw) {
      if (!raw || !raw.config || !raw.config.roundId) return fbInit(raw);
      applyFb(raw);
      startStream();
      return raw;
    });
  }

  /* 빈 채널이면 기본 회차를 만들어 둡니다(처음 연결한 사람이 한 번) */
  function fbInit(raw) {
    var base = {
      roundId: newId(),
      roundName: todayMD() + ' ' + COMenu.brand('compose').name,
      brand: 'compose',
      status: 'open',
      roster: [],
      updatedAt: nowISO()
    };
    return fbReq('PUT', 'config.json', base).then(function () {
      var merged = (raw && typeof raw === 'object') ? raw : {};
      merged.config = base;
      applyFb(merged);
      startStream();
      return merged;
    });
  }

  /* 스트림 이벤트의 path/data 를 원본에 적용 (전체 스냅샷 없이 가볍게) */
  function segsOf(path) {
    return String(path || '/').split('/').filter(function (s) { return s.length > 0; })
      .map(function (s) { return s.replace(/~1/g, '/').replace(/~0/g, '~'); });
  }

  function applyPatch(root, path, data) {
    var segs = segsOf(path);
    if (!segs.length) return data === null || data === undefined ? {} : data;
    var cur = root || {};
    for (var i = 0; i < segs.length - 1; i++) {
      if (!cur[segs[i]] || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
      cur = cur[segs[i]];
    }
    var last = segs[segs.length - 1];
    if (data === null || data === undefined) delete cur[last];
    else cur[last] = data;
    return root;
  }

  function nodeAt(root, path) {
    var cur = root || {};
    segsOf(path).forEach(function (s) {
      if (!cur[s] || typeof cur[s] !== 'object') cur[s] = {};
      cur = cur[s];
    });
    return cur;
  }

  /* Firebase 의 patch 이벤트 — 그 자리에서 자식만 합치고 null 은 삭제 */
  function mergeDeep(dst, src) {
    Object.keys(src || {}).forEach(function (k) {
      var v = src[k];
      if (v === null) delete dst[k];
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (!dst[k] || typeof dst[k] !== 'object' || Array.isArray(dst[k])) dst[k] = {};
        mergeDeep(dst[k], v);
      } else dst[k] = v;
    });
    return dst;
  }

  function startStream() {
    if (!S.fbMode || !window.EventSource || S.es) return;
    try {
      var es = new EventSource(fbUrl('.json'));
      S.es = es;
      es.onopen = function () { S.streamOn = true; };

      function receive(ev, isPatch) {
        if (!ev || !ev.data) return;
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (!msg || msg.path === undefined) return;
        S.streamOn = true;
        var before = S.data ? JSON.stringify(S.data) : '';
        if (isPatch) mergeDeep(nodeAt(S.raw || {}, msg.path), msg.data);
        else S.raw = applyPatch(S.raw || {}, msg.path, msg.data);
        applyFb(S.raw);
        if (S.data && JSON.stringify(S.data) !== before) renderSoon(60);
      }
      /* Firebase 스트림은 event: put / patch 로 옵니다 (기본 message 가 아님) */
      es.addEventListener('put', function (ev) { receive(ev, false); });
      es.addEventListener('patch', function (ev) { receive(ev, true); });
      es.onmessage = function (ev) { receive(ev, false); };
      es.onerror = function () { S.streamOn = false; };
    } catch (e) { /* 스트림이 안 되면 쓰기 후 다시 읽기로 충분 */ }
  }

  function renderSoon(delay) {
    clearTimeout(renderSoon._t);
    renderSoon._t = setTimeout(function () {
      var ae = document.activeElement;
      var typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT');
      if (typing || !$('sheet').hidden) { renderSoon(700); return; }   /* 입력 중이면 미룸 */
      render();
    }, delay == null ? 80 : delay);
  }

  /* pre = 이 요청 직전의 상태(낙관 반영 전). 새 회차·정리처럼 '요청 전 상태'가 필요한 일에 씁니다 */
  function fbWrite(action, p, pre) {
    p = p || {};
    var c = (pre && pre.config) ? pre.config : S.data.config;
    var rid = String(c.roundId || '');
    var curOrders = (pre && pre.orders) ? pre.orders : orders();

    if (action === 'submit') {
      if (c.status !== 'open') return Promise.resolve({ ok: false, error: 'closed' });
      var name = String(p.name || '').trim();
      var menu = String(p.menu || '').trim();
      if (!name) return Promise.resolve({ ok: false, error: '이름이 없습니다.' });
      if (!menu) return Promise.resolve({ ok: false, error: '메뉴가 없습니다.' });
      var order = {
        name: name, menu: menu.slice(0, 60), temp: String(p.temp || '').slice(0, 4),
        note: String(p.note || '').slice(0, 100), ts: nowISO()
      };
      return fbReq('PUT', 'orders/' + safeKey(rid) + '/' + safeKey(name) + '.json', order)
        .then(function () { return { ok: true, order: order }; });
    }

    if (action === 'remove') {
      return fbReq('DELETE', 'orders/' + safeKey(rid) + '/' + safeKey(p.name) + '.json')
        .then(function () { return { ok: true }; });
    }

    if (action === 'removeMissing') {
      var set = {};
      (c.roster || []).forEach(function (n) { set[n] = 1; });
      var gone = curOrders.filter(function (o) { return !set[o.name]; });
      if (!gone.length) return Promise.resolve({ ok: true, removed: 0 });
      var drop = { orders: {} };
      drop.orders[rid] = {};
      gone.forEach(function (o) { drop.orders[rid][safeKey(o.name)] = null; });
      return fbReq('PATCH', '.json', drop).then(function () { return { ok: true, removed: gone.length }; });
    }

    if (action === 'config') {
      var patch = {};
      var src = p.patch || {};
      ['roundName', 'brand', 'status'].forEach(function (k) {
        if (src[k] != null && src[k] !== '') patch[k] = String(src[k]);
      });
      if (src.roundId) patch.roundId = String(src.roundId);
      patch.updatedAt = nowISO();
      return fbReq('PATCH', 'config.json', patch).then(function () {
        return { ok: true, config: Object.assign({}, c, patch) };
      });
    }

    if (action === 'roster') {
      var seen = {};
      var clean = (p.roster || []).map(function (n) { return String(n).trim(); })
        .filter(function (n) {
          if (!n || n.length > 20 || seen[n]) return false;
          seen[n] = 1; return true;
        });
      if (!clean.length && (c.roster || []).length && !p.force) {
        return Promise.resolve({ ok: false, error: '빈 명단으로 덮어쓰기를 차단했습니다.' });
      }
      return fbReq('PUT', 'config/roster.json', clean).then(function () {
        return { ok: true, roster: clean };
      });
    }

    if (action === 'menus') {
      var brand = String(p.brand || '');
      if (!brand) return Promise.resolve({ ok: false, error: '브랜드가 없습니다.' });
      var ov = p.ov || { removed: [], renamed: {}, added: [] };
      return fbReq('PUT', 'menus/' + safeKey(brand) + '.json', ov).then(function () {
        return { ok: true, ov: ov };
      });
    }

    if (action === 'newRound') {
      var cur = curOrders;
      var nextId = newId();
      var nextCfg = {
        roundId: nextId,
        roundName: String(p.roundName || (todayMD() + ' ' + brandName(p.brand || c.brand))).slice(0, 40),
        brand: String(p.brand || c.brand),
        status: 'open',
        roster: c.roster || [],
        updatedAt: nowISO()
      };
      var mv = { config: nextCfg };
      if (cur.length) {
        mv.history = {};
        mv.history[rid] = {
          roundId: rid, roundName: c.roundName, brand: c.brand,
          closedAt: nowISO(), total: cur.length, orders: cur
        };
        mv.orders = {};
        mv.orders[rid] = null;      /* 이번 회차 주문만 비우기 */
      }
      /* 한 번의 PATCH 로 보관·비우기·새 회차를 함께 처리 */
      return fbReq('PATCH', '.json', mv).then(function () {
        return { ok: true, archived: cur.length, config: nextCfg };
      });
    }

    if (action === 'deleteHistory') {
      var hrid = String(p.roundId || '');
      if (!hrid) return Promise.resolve({ ok: false, error: '회차가 없습니다.' });
      return fbReq('DELETE', 'history/' + safeKey(hrid) + '.json').then(function () {
        return { ok: true, removed: 1 };
      });
    }

    return Promise.resolve({ ok: false, error: '알 수 없는 action: ' + action });
  }

  /* ── 버튼 상태·오류 문구 ───────────────────────────────── */
  function setBtnBusy(el, label) {
    if (!el || !el.getAttribute || !document.body.contains(el)) return function () {};
    var html = el.innerHTML;
    var wasDisabled = el.disabled;
    el.disabled = true;
    el.setAttribute('aria-busy', 'true');
    el.textContent = label;
    return function () {
      if (!document.body.contains(el)) return;
      el.disabled = wasDisabled;
      el.removeAttribute('aria-busy');
      el.innerHTML = html;
    };
  }

  /* 다시 그린 뒤에도 같은 버튼을 찾아 '저장 중…'을 이어서 보여 주려고 */
  function sameButton(el, act) {
    if (!el || !act) return null;
    var all = document.querySelectorAll('[data-act="' + act + '"]');
    var nm = el.getAttribute('data-name');
    var id = el.getAttribute('data-id');
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      if (nm != null && b.getAttribute('data-name') !== nm) continue;
      if (id != null && b.getAttribute('data-id') !== id) continue;
      return b;
    }
    return null;
  }

  function errorText(m) {
    if (m === 'closed') return '주문이 마감됐어요';
    if (m === 'timeout' || m === 'network') return '연결을 확인해 주세요';
    if (m && m.indexOf('알 수 없는 action') >= 0) return '이 연결에서는 지원하지 않는 기능이에요';
    return m && m.length < 40 ? m : '저장하지 못했어요';
  }

  /* ── 쓰기 — 즉시 반영하고 뒤에서 실제 저장소와 맞춥니다 ─── */
  var syncTimer = null;

  function syncAfterWrite(delay) {
    if (!S.sheetUrl) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      if (S.streamOn) return;                 /* 실시간이 붙어 있으면 이미 최신 */
      var before = S.data ? JSON.stringify(S.data) : '';
      backendLoad().then(function () {
        if (S.data && JSON.stringify(S.data) !== before) render();
      }).catch(function () {});
    }, delay == null ? 300 : delay);
  }

  function mutate(action, p, btn, opts) {
    opts = opts || {};
    if (S.busy) return Promise.resolve(null);
    S.busy = true;

    var snapshot = S.data ? clone(S.data) : null;
    var hit = btn || S.lastBtn;
    var act = hit && hit.getAttribute ? hit.getAttribute('data-act') : '';
    var live = !!S.sheetUrl;

    /* 1) 시트 모드만 미리 반영(낙관적). 로컬 모드는 바로 저장되므로 두 번 적용하지 않는다 */
    if (live) {
      var localRes;
      try { localRes = localDo(action, p); }
      catch (e) { localRes = { ok: false, error: String((e && e.message) || e) }; }
      if (!localRes || localRes.ok === false) {
        S.busy = false;
        toast(errorText(localRes && localRes.error));
        if (opts.onError) opts.onError(localRes && localRes.error); else render();
        return Promise.resolve(null);
      }
      saveLocal();
    }

    /* 2) 버튼에 '저장 중…' — 다시 그린 화면에서 같은 버튼을 찾아 표시 */
    if (!opts.deferRender) {
      render();
      if (live && !document.body.contains(hit)) hit = sameButton(hit, act);
    }
    var restore = setBtnBusy(hit, '저장 중…');

    /* 3) 서버에 보내고, 결과가 오면 뒤에서 최신 시트와 맞춘다 */
    return api(action, p, snapshot).then(function (res) {
      if (!res || res.ok === false) throw new Error((res && res.error) || 'error');
      if (live) syncAfterWrite(res.optimistic ? 700 : 200);
      return res;
    }).catch(function (e) {
      var m = String((e && e.message) || e);
      if (snapshot) { S.data = snapshot; saveLocal(); }
      toast(errorText(m));
      if (opts.onError) opts.onError(m); else render();
      return null;
    }).then(function (res) {
      if (res && !live && !opts.deferRender) render();
      S.busy = false;
      restore();
      return res;
    });
  }

  /* ── 파생 값 ──────────────────────────────────────────── */
  function cfg() { return S.data.config; }
  function orders() { return S.data.orders || []; }

  function orderOf(name) {
    var hit = null;
    orders().forEach(function (o) { if (o.name === name) hit = o; });
    return hit;
  }

  function resolvedMenu(brandId) {
    var ov = (S.data.menus || {})[brandId] || {};
    return COMenu.resolve(brandId, ov);
  }

  function brandName(id) { return COMenu.brand(id).name; }

  /* 무결점 검증 — 화면 배지와 테스트가 같은 함수를 씁니다 */
  function computeStats(roster, orderList) {
    roster = roster || [];
    orderList = orderList || [];
    var inRoster = {};
    roster.forEach(function (n) { inRoster[n] = 1; });
    var byName = {};
    var outs = [];
    orderList.forEach(function (o) {
      if (!byName[o.name]) byName[o.name] = 0;
      byName[o.name]++;
      if (!inRoster[o.name]) outs.push(o.name);
    });
    var unique = Object.keys(byName);
    var missing = roster.filter(function (n) { return !byName[n]; });
    var dup = unique.filter(function (n) { return byName[n] > 1; });
    var A = orderList.length;                 /* 주문 잔 수 = 선택 완료 수(건) */
    var U = unique.length;                    /* 실제 선택한 사람 수 */
    var B = missing.length;
    var N = roster.length;
    return {
      N: N, A: A, B: B, U: U,
      missing: missing,
      duplicates: dup,
      outsiders: outs,
      ok1: (N === A + B) && outs.length === 0,
      ok2: A === U,
      totalCups: A
    };
  }

  function aggregate(orderList) {
    var map = {};
    (orderList || []).forEach(function (o) {
      var temp = o.temp ? o.temp : '';
      var key = o.menu + '|' + temp;
      if (!map[key]) map[key] = { menu: o.menu, temp: temp, count: 0, names: [] };
      map[key].count++;
      map[key].names.push(o.name);
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) {
        if (b.count !== a.count) return b.count - a.count;
        return (a.menu + a.temp).localeCompare(b.menu + b.temp);
      });
  }

  function labelOf(a) { return a.menu + (a.temp ? ' (' + a.temp + ')' : ''); }

  function orderText(c, orderList) {
    var list = orderList || orders();
    var agg = aggregate(list);
    var lines = [];
    lines.push('[' + (c ? c.roundName : cfg().roundName) + '] 총 ' + list.length + '잔');
    lines.push('');
    if (!agg.length) {
      lines.push('아직 주문이 없어요.');
    } else {
      agg.forEach(function (a) { lines.push(labelOf(a) + ' — ' + a.count + '잔'); });
    }
    var noted = list.filter(function (o) { return o.note; });
    if (noted.length) {
      lines.push('');
      lines.push('요청사항');
      noted.forEach(function (o) {
        lines.push('- ' + o.name + ': ' + o.menu + (o.temp ? ' (' + o.temp + ')' : '') + ' · ' + o.note);
      });
    }
    return lines.join('\n');
  }

  /* ── 회차 배너 ────────────────────────────────────────── */
  function bannerHTML(compact) {
    var c = cfg();
    var st = computeStats(c.roster, orders());
    var open = c.status === 'open';
    return '<div class="banner">' +
      '<div class="banner-body">' +
        '<div class="banner-round">' + esc(c.roundName) + ' · ' + (open ? '주문 받는 중' : '마감됨') + '</div>' +
        '<div class="banner-meta">' + esc(brandName(c.brand)) + ' · ' +
          (compact ? '총 ' + st.totalCups + '잔' : st.A + '/' + c.roster.length + '명 선택') + '</div>' +
      '</div>' +
      '<span class="pill ' + (open ? 'open' : 'closed') + '"><span class="dot"></span>' +
        (open ? '받는 중' : '마감') + '</span>' +
    '</div>';
  }

  /* ── 렌더 ─────────────────────────────────────────────── */
  function render() {
    var app = $('app');
    if (!S.data) {
      /* 첫 방문(저장분 없음) — 빈 화면 대신 무엇을 기다리는지 보여 줍니다 */
      app.className = 'app';
      $('topbar').innerHTML = '<div class="topbar-title"><span class="mark">☕</span>단체 음료 주문</div>';
      $('main').innerHTML = skeletonHTML();
      return;
    }
    app.className = 'app' + (S.mode === 'admin' ? ' is-admin' : '');
    $('topbar').innerHTML = topbarHTML();
    $('main').innerHTML = S.mode === 'admin' ? adminHTML() : userHTML();
  }

  function skeletonHTML() {
    var chips = '';
    for (var i = 0; i < 6; i++) chips += '<div class="sk-chip"></div>';
    return '<div class="banner sk-banner">' +
        '<div class="banner-body"><div class="sk-line w60"></div><div class="sk-line w40"></div></div>' +
        '<div class="sk-pill"></div>' +
      '</div>' +
      '<div class="sk-line w40 tall"></div>' +
      '<div class="sk-line w80"></div>' +
      '<div class="name-grid" style="margin-top:16px">' + chips + '</div>' +
      '<p class="sk-note">명단 불러오는 중…</p>';
  }

  function topbarHTML() {
    if (S.mode === 'admin') {
      return '<div class="topbar-title"><span class="mark">☕</span>단체 음료 주문' +
        '<span class="topbar-tag">관리자</span></div>' +
        '<div class="topbar-actions">' +
          '<button class="tbtn" data-act="reload" title="새로 불러오기">⟳</button>' +
          '<button class="tbtn" data-act="to-user">참여자 화면</button>' +
        '</div>';
    }
    return '<div class="topbar-title"><span class="mark">☕</span>단체 음료 주문</div>' +
      '<div class="topbar-actions">' +
        '<button class="tbtn" data-act="reload" title="새로고침">⟳ 새로고침</button>' +
      '</div>';
  }

  function emptyCard(title, sub, icon) {
    return '<div class="empty-card card"><div class="empty"><span class="e-ic">' + (icon || '🙂') + '</span>' +
      title + (sub ? '<div class="sub" style="margin:6px 0 0">' + sub + '</div>' : '') + '</div></div>';
  }

  /* ── 참여자 화면 ──────────────────────────────────────── */
  function userHTML() {
    var u = S.u;
    if (u.step === 'menu') return menuHTML();
    if (u.step === 'confirm') return confirmHTML();
    if (u.step === 'done') return doneHTML();
    return pickHTML();
  }

  function pickHTML() {
    return bannerHTML() +
      '<div class="stepline"><span class="stepnum">1 / 3</span></div>' +
      '<h1 class="h1">내 이름을 골라 주세요</h1>' +
      '<p class="sub">이름을 누르면 바로 주문할 수 있어요.</p>' +
      '<div class="input-wrap"><span class="ic">🔍</span>' +
        '<input id="name-search" class="input" type="search" placeholder="이름 검색" autocomplete="off" value="' + esc(S.nq) + '"></div>' +
      '<div id="name-grid-wrap" style="margin-top:12px">' + namesHTML() + '</div>';
  }

  function namesHTML() {
    var c = cfg();
    var q = S.nq.trim().toLowerCase();
    if (!c.roster.length) {
      return emptyCard('명단이 아직 없어요', '관리자가 명단을 등록하면 여기에 이름이 나타나요.', '📋');
    }
    var list = c.roster.filter(function (n) { return !q || n.toLowerCase().indexOf(q) >= 0; });
    if (!list.length) return emptyCard('검색 결과가 없어요', '이름을 다시 확인해 주세요.', '🔎');
    var by = {};
    orders().forEach(function (o) { by[o.name] = o; });
    return '<div class="name-grid">' + list.map(function (n) {
      var o = by[n];
      return '<button class="name-chip' + (o ? ' is-done' : '') + '" data-act="pick-name" data-name="' + esc(n) + '">' +
        '<span class="nm">' + esc(n) + '</span>' +
        '<span class="st">' + (o ? '✓ 선택 완료 · ' + esc(o.menu) + (o.temp ? ' ' + o.temp : '') : '아직 선택 전') + '</span>' +
        '</button>';
    }).join('') + '</div>';
  }

  function menuHTML() {
    var c = cfg();
    var menu = resolvedMenu(c.brand);
    var u = S.u;
    var mine = orderOf(u.name);
    return '<div class="stepline"><button class="back" data-act="back" aria-label="뒤로">‹</button>' +
      '<span class="stepnum">2 / 3</span></div>' +
      '<h1 class="h1">' + esc(u.name) + '님, 무엇을 드릴까요?</h1>' +
      '<p class="sub">' + esc(brandName(c.brand)) + ' 메뉴 ' + menu.items.length + '종' +
        (mine ? ' · 지금 ' + esc(mine.menu) + (mine.temp ? ' ' + mine.temp : '') + ' 선택됨' : '') + '</p>' +
      '<div class="input-wrap"><span class="ic">🔍</span>' +
        '<input id="menu-search" class="input" type="search" placeholder="메뉴 검색 (예: 아메리카노)" autocomplete="off" value="' + esc(S.mq) + '"></div>' +
      catTabsHTML(menu) +
      '<div id="menu-list-wrap">' + menuListHTML(menu) + '</div>';
  }

  function catTabsHTML(menu) {
    var tabs = [{ id: 'all', name: '전체' }, { id: 'pop', name: '⭐ 인기' }].concat(menu.cats);
    return '<div class="cats">' + tabs.map(function (t) {
      return '<button class="cat' + (S.cat === t.id ? ' on' : '') + '" data-act="cat" data-cat="' + esc(t.id) + '">' +
        esc(t.name) + '</button>';
    }).join('') + '</div>';
  }

  function menuListHTML(menu) {
    menu = menu || resolvedMenu(cfg().brand);
    var q = S.mq.trim().toLowerCase();
    if (S.cat !== 'all' && S.cat !== 'pop' && !menu.cats.some(function (c) { return c.id === S.cat; })) S.cat = 'all';
    var items = menu.items.filter(function (it) {
      if (S.cat === 'pop' && !it.pop) return false;
      if (S.cat !== 'all' && S.cat !== 'pop' && it.cat !== S.cat) return false;
      if (q && it.name.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    if (!items.length) {
      return '<div class="menu-list"><div class="empty"><span class="e-ic">🔎</span>' +
        (S.cat === 'pop' ? '인기 메뉴가 아직 없어요' : '찾는 메뉴가 없어요') +
        '<div class="sub" style="margin-top:6px">다른 카테고리에서 찾아보거나 관리자에게 메뉴 추가를 부탁해 주세요.</div></div></div>';
    }
    return '<div class="menu-list">' + items.map(function (it) {
      return '<button class="menu-item" data-act="choose" data-id="' + esc(it.id) + '">' +
        '<span class="mi-body"><span class="mi-name">' + esc(it.name) +
          (it.pop ? '<span class="tag-pop">인기</span>' : '') + '</span>' +
          (it.memo ? '<span class="mi-memo">' + esc(it.memo) + '</span>' : '') +
        '</span>' +
        tempBadgeHTML(it.temp) +
        '<span class="chev">›</span>' +
      '</button>';
    }).join('') + '</div>';
  }

  function tempBadgeHTML(temp) {
    if (temp === 'hot') return '<span class="temp-badge"><span class="t-hot">HOT</span></span>';
    if (temp === 'ice') return '<span class="temp-badge"><span class="t-ice">ICE</span></span>';
    return '<span class="temp-badge"><span class="t-hot">HOT</span><span class="t-ice">ICE</span></span>';
  }

  function confirmHTML() {
    var d = S.u.draft || {};
    return '<div class="stepline"><button class="back" data-act="back" aria-label="뒤로">‹</button>' +
      '<span class="stepnum">3 / 3</span></div>' +
      '<h1 class="h1">이렇게 등록할까요?</h1>' +
      '<p class="sub">' + esc(S.u.name) + '님 주문이에요.</p>' +
      '<div class="card"><div class="summary">' +
        '<div class="row"><span class="k">이름</span><span class="v">' + esc(S.u.name) + '</span></div>' +
        '<div class="divider"></div>' +
        '<div class="row"><span class="k">메뉴</span><span class="v big">' + esc(d.menu || '') + '</span></div>' +
        '<div class="row"><span class="k">온도</span><span class="v">' + esc(d.temp || '—') + '</span></div>' +
      '</div></div>' +
      '<div class="stack" style="margin-top:16px">' +
        '<button class="btn" data-act="submit">주문 등록</button>' +
        '<button class="btn ghost" data-act="back">메뉴 다시 고르기</button>' +
      '</div>';
  }

  function doneHTML() {
    var d = S.u.draft || {};
    return '<div class="done-hero"><span class="done-check">✓</span>' +
        '<h1 class="h1">' + esc(S.u.name) + '님 주문이 등록됐어요</h1></div>' +
      '<div class="card"><div class="summary">' +
        '<div class="row"><span class="k">메뉴</span><span class="v big">' + esc(d.menu || '') + '</span></div>' +
        '<div class="row"><span class="k">온도</span><span class="v">' + esc(d.temp || '—') + '</span></div>' +
      '</div></div>' +
      '<div class="stack" style="margin-top:16px">' +
        '<button class="btn ghost" data-act="edit-again">내 주문 바꾸기</button>' +
        '<button class="btn white" data-act="reset">다른 사람 주문하기</button>' +
      '</div>';
  }

  /* ── 관리자 화면 ──────────────────────────────────────── */
  function adminHTML() {
    var tabs = [['stats', '주문 현황'], ['roster', '명단'], ['menu', '메뉴판'], ['round', '회차·설정']];
    var body = S.tab === 'roster' ? rosterHTML()
      : S.tab === 'menu' ? menuEditorHTML()
      : S.tab === 'round' ? roundHTML()
      : statsHTML();
    return bannerHTML(true) +
      '<div class="tabs">' + tabs.map(function (t) {
        return '<button class="tab' + (S.tab === t[0] ? ' on' : '') + '" data-act="tab" data-tab="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div>' + body;
  }

  function statsHTML() {
    var c = cfg();
    var list = orders();
    var st = computeStats(c.roster, list);
    var agg = aggregate(list);

    var badge1 = st.ok1
      ? '<div class="badge"><span class="bi">✓</span><span>총원 ' + st.N + '명 = 선택 완료 ' + st.A + '명 + 미선택 ' + st.B + '명</span></div>'
      : '<div class="badge bad"><span class="bi">⚠️</span><span>총원 ' + st.N + '명 ≠ 선택 ' + st.A + '명 + 미선택 ' + st.B + '명' +
        '<span class="bd">' + (st.outsiders.length ? '명단에 없는 이름의 주문 ' + st.outsiders.length + '건' : '숫자가 맞지 않아요') + '</span></span></div>';
    var badge2 = st.ok2
      ? '<div class="badge"><span class="bi">✓</span><span>총 주문 ' + st.totalCups + '잔 = 선택 완료 ' + st.U + '명</span></div>'
      : '<div class="badge bad"><span class="bi">⚠️</span><span>총 주문 ' + st.totalCups + '잔 ≠ 선택 완료 ' + st.U + '명' +
        '<span class="bd">같은 이름의 주문이 ' + (st.totalCups - st.U) + '건 겹쳐 있어요</span></span></div>';

    var aggRows = agg.length
      ? '<table class="tbl"><thead><tr><th>메뉴</th><th class="num">수량</th></tr></thead><tbody>' +
        agg.map(function (a) {
          return '<tr><td class="nm">' + esc(labelOf(a)) + '</td><td class="num">' + a.count + '잔</td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty"><span class="e-ic">☕</span>아직 주문이 없어요<div class="sub" style="margin-top:6px">참여자 링크를 보내 주문을 받아 보세요.</div></div>';

    var missing = st.missing.length
      ? '<div class="person-list">' + st.missing.map(function (n) {
          return '<div class="person miss"><div class="p-body"><div class="p-name">' + esc(n) + '</div>' +
            '<div class="p-menu">아직 고르지 않았어요</div></div></div>';
        }).join('') + '</div>'
      : '<div class="empty" style="padding:8px"><span class="e-ic">🎉</span>모두 골랐어요</div>';

    var chosen = list.length
      ? '<div class="person-list">' + list.map(function (o) {
          var outside = c.roster.indexOf(o.name) < 0;
          return '<div class="person"><div class="p-body">' +
            '<div class="p-name">' + esc(o.name) + (outside ? ' <span class="tag-pop">명단 밖</span>' : '') + '</div>' +
            '<div class="p-menu">' + esc(o.menu) + (o.temp ? ' (' + esc(o.temp) + ')' : '') +
              (o.note ? ' <span class="p-note">· ' + esc(o.note) + '</span>' : '') + '</div></div>' +
            '<div class="p-tools">' +
              '<button class="btn xs ghost" data-act="adm-edit" data-name="' + esc(o.name) + '">수정</button>' +
              '<button class="btn xs danger" data-act="adm-del" data-name="' + esc(o.name) + '">취소</button>' +
            '</div></div>';
        }).join('') + '</div>'
      : '<div class="empty" style="padding:8px"><span class="e-ic">🕐</span>아직 주문이 없어요</div>';

    return '<div class="card"><div class="badges">' + badge1 + badge2 + '</div>' +
        (st.outsiders.length || st.duplicates.length
          ? '<button class="btn ghost sm" style="width:100%;margin-top:10px" data-act="clean">명단 밖·중복 주문 정리하기</button>' : '') +
      '</div>' +
      '<div class="card"><div class="stat-grid">' +
        '<div class="stat-cell"><div class="n">' + st.N + '</div><div class="l">총원</div></div>' +
        '<div class="stat-cell blue"><div class="n">' + st.U + '</div><div class="l">선택 완료</div></div>' +
        '<div class="stat-cell"><div class="n">' + st.B + '</div><div class="l">미선택</div></div>' +
      '</div></div>' +
      '<div class="sec-title">메뉴별 합계 <span class="cnt">' + st.totalCups + '잔</span></div>' +
      '<div class="card">' + aggRows +
        '<button class="btn ghost" style="margin-top:14px" data-act="copy-order">📋 주문서 복사</button>' +
        '<pre class="order-box" id="order-text">' + esc(orderText(c, list)) + '</pre>' +
      '</div>' +
      '<div class="sec-title">미선택 <span class="cnt">' + st.missing.length + '명</span></div>' +
      '<div class="card card-tight">' + missing + '</div>' +
      '<div class="sec-title">선택 완료 <span class="cnt">' + list.length + '건</span></div>' +
      '<div class="card card-tight">' + chosen + '</div>';
  }

  function rosterHTML() {
    var c = cfg();
    return '<div class="card">' +
        '<div class="kv"><span class="k">등록된 이름</span><span class="v">' + c.roster.length + '명</span></div>' +
        '<div class="chips" style="margin-top:12px">' +
          (c.roster.length ? c.roster.map(function (n) {
            return '<span class="name-tag">' + esc(n) +
              '<button class="x" data-act="rm-roster" data-name="' + esc(n) + '" aria-label="' + esc(n) + ' 삭제">✕</button></span>';
          }).join('') : '<span class="sub" style="margin:0">아직 이름이 없어요. 아래에서 추가해 주세요.</span>') +
        '</div>' +
      '</div>' +
      '<div class="sec-title">한 명씩 추가</div>' +
      '<div class="card"><div class="btn-row">' +
        '<input id="roster-name" class="input plain" placeholder="이름" autocomplete="off" style="flex:1">' +
        '<button class="btn sm" data-act="add-roster" style="flex:0 0 auto">추가</button>' +
      '</div></div>' +
      '<div class="sec-title">여러 명 한꺼번에 붙여넣기</div>' +
      '<div class="card">' +
        '<textarea id="roster-bulk" class="input plain" placeholder="이름을 줄바꿈 또는 쉼표로 구분해 붙여넣으세요&#10;예) 가람, 나래, 다온&#10;또는 한 줄에 한 명씩"></textarea>' +
        '<button class="btn" style="margin-top:10px" data-act="bulk-roster">명단에 추가</button>' +
      '</div>';
  }

  function menuEditorHTML() {
    var c = cfg();
    var brand = S.editorBrand || c.brand;
    var menu = resolvedMenu(brand);
    var ov = (S.data.menus || {})[brand] || {};
    var removed = ov.removed || [];
    var renamed = ov.renamed || {};
    var added = (ov.added || []).map(function (x) { return x.id; });

    var groups = menu.cats.map(function (cat) {
      var its = menu.items.filter(function (it) { return it.cat === cat.id; });
      if (!its.length) return '';
      return '<div class="sec-title" style="margin:16px 2px 8px;font-size:13px">' + esc(cat.name) + ' <span class="cnt">' + its.length + '</span></div>' +
        '<div class="card card-tight" style="padding:4px 14px">' +
        its.map(function (it) {
          var hidden = removed.indexOf(it.id) >= 0;
          return '<div class="person">' +
            '<div class="p-body"><div class="p-name" style="' + (hidden ? 'text-decoration:line-through;color:#B0B8C1' : '') + '">' +
              esc(it.name) + (renamed[it.id] ? ' <span class="tag-pop">수정됨</span>' : '') +
              (added.indexOf(it.id) >= 0 ? ' <span class="tag-pop">추가</span>' : '') + '</div>' +
              '<div class="p-menu">' + (it.temp === 'both' ? 'HOT / ICE' : it.temp.toUpperCase()) + '</div></div>' +
            '<div class="p-tools">' +
              '<button class="btn xs ghost" data-act="edit-menu" data-id="' + esc(it.id) + '">이름·온도</button>' +
              '<button class="btn xs ghost" data-act="toggle-menu" data-id="' + esc(it.id) + '">' + (hidden ? '보이기' : '숨김') + '</button>' +
              (added.indexOf(it.id) >= 0 ? '<button class="btn xs danger" data-act="del-menu" data-id="' + esc(it.id) + '">삭제</button>' : '') +
            '</div></div>';
        }).join('') + '</div>';
    }).join('');

    var others = menu.items.filter(function (it) {
      return !menu.cats.some(function (cat) { return cat.id === it.cat; });
    });
    if (others.length) {
      groups += '<div class="card card-tight" style="padding:4px 14px;margin-top:10px">' + others.map(function (it) {
        return '<div class="person"><div class="p-body"><div class="p-name">' + esc(it.name) + '</div></div>' +
          '<div class="p-tools"><button class="btn xs danger" data-act="del-menu" data-id="' + esc(it.id) + '">삭제</button></div></div>';
      }).join('') + '</div>';
    }

    var catOpts = menu.cats.map(function (ct) {
      return '<option value="' + esc(ct.id) + '">' + esc(ct.name) + '</option>';
    }).join('');

    return '<div class="card">' +
        '<label class="sub" style="margin:0 0 8px 2px;font-weight:800">브랜드 메뉴판 고르기</label>' +
        '<select class="select" id="editor-brand">' + COMenu.order.map(function (b) {
          return '<option value="' + b + '"' + (b === brand ? ' selected' : '') + '>' + esc(COMenu.brand(b).name) + '</option>';
        }).join('') + '</select>' +
        '<p class="sub" style="margin:10px 2px 0;font-size:12px">메뉴 ' + menu.items.length + '종 · 숨김 ' + removed.length + '종 · 추가 ' + added.length + '종</p>' +
      '</div>' +
      '<div class="sec-title">메뉴 추가</div>' +
      '<div class="card">' +
        '<input id="new-menu-name" class="input plain" placeholder="메뉴 이름 (예: 흑당 버블 라떼)">' +
        '<div class="btn-row" style="margin-top:8px">' +
          '<select class="select" id="new-menu-cat" style="flex:1;box-shadow:none;background:#F2F4F6">' + catOpts + '</select>' +
          '<select class="select" id="new-menu-temp" style="flex:0 0 110px;box-shadow:none;background:#F2F4F6">' +
            '<option value="both">HOT/ICE</option><option value="ice">ICE만</option><option value="hot">HOT만</option>' +
          '</select>' +
        '</div>' +
        '<button class="btn" style="margin-top:10px" data-act="add-menu">메뉴 추가</button>' +
      '</div>' +
      groups +
      '<button class="btn ghost" style="margin-top:14px" data-act="reset-menu">이 브랜드 메뉴판을 기본값으로 되돌리기</button>';
  }

  function roundHTML() {
    var c = cfg();
    var hist = (S.data.history || []).slice(0, 10);
    return '<div class="card">' +
        '<div class="kv"><span class="k">현재 회차</span><span class="v">' + esc(c.roundName) + '</span></div>' +
        '<div class="kv"><span class="k">상태</span><span class="v">' + (c.status === 'open' ? '주문 받는 중' : '마감됨') + '</span></div>' +
        '<div class="kv"><span class="k">주문</span><span class="v">' + orders().length + '건</span></div>' +
      '</div>' +
      '<div class="sec-title">브랜드</div>' +
      '<div class="brand-cards">' + COMenu.order.map(function (b) {
        var br = COMenu.brand(b);
        return '<button class="brand-card' + (c.brand === b ? ' on' : '') + '" data-act="set-brand" data-brand="' + b + '">' +
          '<div class="bn">' + esc(br.name) + '</div><div class="bs">' + esc(br.tagline) + '</div></button>';
      }).join('') + '</div>' +
      '<div class="sec-title">회차 이름</div>' +
      '<div class="card"><div class="btn-row">' +
        '<input id="round-name" class="input plain" value="' + esc(c.roundName) + '" style="flex:1">' +
        '<button class="btn sm" data-act="save-round-name" style="flex:0 0 auto">저장</button>' +
      '</div></div>' +
      '<div class="sec-title">주문 상태</div>' +
      '<div class="card">' +
        /* 열려 있을 때는 강조(파란색) — 누르면 마감. 마감 뒤에는 회색 */
        '<button class="btn' + (c.status === 'open' ? '' : ' ghost') + '" data-act="toggle-status">' +
          (c.status === 'open' ? '주문 마감하기' : '다시 주문 받기') + '</button>' +
      '</div>' +
      '<div class="sec-title">새 주문 열기</div>' +
      '<div class="card">' +
        '<button class="btn" data-act="new-round">＋ 새 주문 열기 (라운드 전환)</button>' +
        '<p class="sub" style="margin:10px 2px 0;font-size:12px">지금 주문 ' + orders().length + '건은 <b>History</b>로 옮겨요.</p>' +
      '</div>' +
      '<div class="sec-title">링크</div>' +
      '<div class="card"><div class="stack">' +
        '<button class="btn" data-act="copy-user-link">🔗 참여자 링크 복사</button>' +
        '<button class="btn ghost" data-act="copy-admin-link">🔐 관리자 링크 복사</button>' +
      '</div></div>' +
      '<div class="sec-title">저장 연결 (선택)</div>' +
      '<div class="card">' +
        (S.sheetUrl
          ? '<div class="kv"><span class="k">상태</span><span class="v" style="color:#00B26B">' +
              (S.fbMode ? '✓ 실시간 연결됨' : '✓ 구글 시트 연결됨') + '</span></div>'
          : '<div class="note-card warn">아직 연결하지 않았어요. 지금은 이 브라우저에만 저장돼요.</div>' +
            '<input id="sheet-url" class="input plain" style="margin-top:10px" placeholder="https://….firebasedatabase.app/ch/…">' +
            '<button class="btn" style="margin-top:10px" data-act="connect">연결</button>') +
      '</div>' +
      '<div class="sec-title">지난 회차</div>' +
      '<div class="card card-tight">' +
        (hist.length ? hist.map(function (h) {
          return '<div class="person"><div class="p-body"><div class="p-name">' + esc(h.roundName) + '</div>' +
            '<div class="p-menu">' + esc(brandName(h.brand)) + ' · ' + (h.total || 0) + '건</div></div>' +
            '<div class="p-tools"><button class="btn xs" data-act="copy-history" data-i="' + esc(h.roundId) + '">주문서</button>' +
              '<button class="btn xs danger" data-act="delete-history" data-i="' + esc(h.roundId) + '">삭제</button></div></div>';
        }).join('') : '<div class="empty" style="padding:10px">아직 지난 회차가 없어요</div>') +
      '</div>' +
      '<p class="sub" style="margin:18px 2px 0;font-size:11.5px;color:#B0B8C1">앱 버전 ' + APP_VERSION + '</p>';
  }

  /* ── 하단 시트 ────────────────────────────────────────── */
  function openSheet(html) {
    $('sheet-body').innerHTML = html;
    $('sheet').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    $('sheet').hidden = true;
    $('sheet-body').innerHTML = '';
    document.body.style.overflow = '';
  }

  function sheetTitle(title, sub) {
    return '<h2 id="sheet-title">' + title + '</h2>' + (sub ? '<p class="sheet-sub">' + sub + '</p>' : '');
  }

  /* 무언가를 지우거나 바꾸기 전에 한 번 묻는 시트 (브라우저 confirm 대신) */
  function askConfirm(title, sub, okText, fn, danger) {
    S.confirmCb = fn;
    openSheet(sheetTitle(esc(title), sub ? esc(sub) : '') +
      '<div class="sheet-actions"><button class="btn ghost" data-act="sheet-close">취소</button>' +
      '<button class="btn' + (danger ? ' danger' : '') + '" data-act="confirm-ok">' + esc(okText) + '</button></div>');
  }

  function openConfirmPerson(name) {
    openSheet(sheetTitle(esc(name) + '님 맞나요?', '이 이름으로 주문을 시작할게요.') +
      '<div class="sheet-actions"><button class="btn ghost" data-act="sheet-close">아니에요</button>' +
      '<button class="btn" data-act="start-order" data-name="' + esc(name) + '">맞아요</button></div>');
  }

  function openExistingOrder(name, o) {
    openSheet(sheetTitle(esc(name) + '님은 이미 주문했어요',
        esc(o.menu) + (o.temp ? ' (' + o.temp + ')' : '') + (o.note ? ' · ' + esc(o.note) : '')) +
      '<div class="sheet-actions"><button class="btn ghost" data-act="sheet-close">그대로 둘게요</button>' +
      '<button class="btn" data-act="start-order" data-name="' + esc(name) + '">수정할게요</button></div>');
  }

  function openClosedBlocked(name, o) {
    if (o) {
      openSheet(sheetTitle(esc(name) + '님 주문', esc(o.menu) + (o.temp ? ' (' + o.temp + ')' : '') +
          (o.note ? ' · ' + esc(o.note) : '')) +
        '<div class="note-card warn">주문이 마감되어 지금은 바꿀 수 없어요.</div>' +
        '<div class="sheet-actions"><button class="btn" data-act="sheet-close">확인</button></div>');
    } else {
      openSheet(sheetTitle('주문이 마감됐어요', '지금은 주문을 받지 않아요. 관리자에게 문의해 주세요.') +
        '<div class="sheet-actions"><button class="btn" data-act="sheet-close">확인</button></div>');
    }
  }

  function openOptions(item) {
    var temp = item.temp === 'both'
      ? (localStorage.getItem(LS_LASTTEMP) || 'ICE')
      : (item.temp === 'hot' ? 'HOT' : 'ICE');
    S.pickItem = item;
    S.pickTemp = temp;
    var seg = item.temp === 'both'
      ? '<div class="seg">' +
          '<button data-act="set-temp" data-temp="HOT" class="' + (temp === 'HOT' ? 'on hot' : '') + '">HOT</button>' +
          '<button data-act="set-temp" data-temp="ICE" class="' + (temp === 'ICE' ? 'on ice' : '') + '">ICE</button>' +
        '</div>'
      : '<div class="seg"><button class="on ' + (item.temp === 'hot' ? 'hot' : 'ice') + '" disabled>' +
          (item.temp === 'hot' ? 'HOT 전용' : 'ICE 전용') + '</button></div>';

    openSheet('<div class="item-hero"><div class="ih-cat">' + esc(catName(item.cat)) + '</div>' +
      '<div class="ih-name">' + esc(item.name) + '</div></div>' +
      '<div class="field"><label>온도</label>' + seg + '</div>' +
      '<div class="sheet-actions"><button class="btn ghost" data-act="sheet-close">취소</button>' +
      '<button class="btn" data-act="pick-save">이걸로 할게요</button></div>');
  }

  function catName(id) {
    var menu = resolvedMenu(cfg().brand);
    for (var i = 0; i < menu.cats.length; i++) if (menu.cats[i].id === id) return menu.cats[i].name;
    return '메뉴';
  }

  function openAdminEdit(name) {
    var o = orderOf(name) || { menu: '', temp: 'ICE', note: '' };
    S.editTemp = o.temp || '';
    var menu = resolvedMenu(cfg().brand);
    openSheet(sheetTitle(esc(name) + '님 주문 수정', '오입력이 있으면 바로 고쳐 주세요.') +
      '<div class="field"><label>메뉴</label>' +
        '<input id="edit-menu" class="input plain" value="' + esc(o.menu) + '" list="edit-menu-list" maxlength="50">' +
        '<datalist id="edit-menu-list">' + menu.items.map(function (it) {
          return '<option value="' + esc(it.name) + '">';
        }).join('') + '</datalist></div>' +
      '<div class="field"><label>온도</label><div class="seg">' +
        '<button data-act="edit-temp" data-temp="HOT" class="' + (o.temp === 'HOT' ? 'on hot' : '') + '">HOT</button>' +
        '<button data-act="edit-temp" data-temp="ICE" class="' + (o.temp === 'ICE' ? 'on ice' : '') + '">ICE</button>' +
        '<button data-act="edit-temp" data-temp="" class="' + (!o.temp ? 'on' : '') + '">없음</button>' +
      '</div></div>' +
      '<div class="field"><label>요청사항</label>' +
        '<input id="edit-note" class="input plain" value="' + esc(o.note || '') + '" maxlength="60"></div>' +
      '<div class="sheet-actions"><button class="btn ghost" data-act="sheet-close">취소</button>' +
      '<button class="btn" data-act="save-admin-edit" data-name="' + esc(name) + '">저장</button></div>');
  }

  function openNewRound() {
    var name = todayMD() + ' ' + brandName(cfg().brand);
    openSheet(sheetTitle('새 주문 열기', '지금 주문 ' + orders().length + '건은 History에 보관하고 새 회차를 시작해요.') +
      '<div class="field"><label>새 회차 이름</label>' +
        '<input id="new-round-name" class="input plain" value="' + esc(name) + '" maxlength="40"></div>' +
      '<div class="note-card">명단은 그대로 남아서, 참여자 링크를 다시 보내지 않아도 돼요.</div>' +
      '<div class="sheet-actions"><button class="btn ghost" data-act="sheet-close">취소</button>' +
      '<button class="btn" data-act="do-new-round">새로 열기</button></div>');
  }

  /* ── 동작 ─────────────────────────────────────────────── */
  function pickName(name) {
    var c = cfg();
    var o = orderOf(name);
    if (c.status !== 'open') { openClosedBlocked(name, o); return; }
    S.u.name = name;
    if (o) openExistingOrder(name, o);
    else openConfirmPerson(name);
  }

  function startOrder(name) {
    S.u.name = name || S.u.name;
    S.u.step = 'menu';
    S.mq = '';
    S.cat = 'all';
    closeSheet();
    render();
  }

  function chooseItem(id) {
    var menu = resolvedMenu(cfg().brand);
    var item = null;
    menu.items.forEach(function (it) { if (it.id === id) item = it; });
    if (!item) return;
    openOptions(item);
  }

  function saveDraft(draft) {
    S.u.draft = draft;
    S.u.step = 'confirm';
    closeSheet();
    render();
  }

  /* 등록 — 화면은 바로 '등록됐어요'로 넘기고, 서버 응답이 실패하면 되돌립니다 */
  function doSubmit(btn) {
    var d = S.u.draft;
    if (!d || S.busy) return;
    if (cfg().status !== 'open') { toast('주문이 마감됐어요'); openClosedBlocked(S.u.name, orderOf(S.u.name)); return; }
    var who = S.u.name;
    var draft = d;
    mutate('submit', { name: who, menu: d.menu, temp: d.temp, note: '' }, btn, {
      deferRender: true,
      onError: function (err) {
        if (S.u.name !== who || S.u.step !== 'done') return;   /* 이미 다음 단계로 갔으면 건드리지 않음 */
        S.u.step = 'confirm';
        S.u.draft = draft;
        render();
        if (String(err) === 'closed') openClosedBlocked(who, orderOf(who));
      }
    }).then(function (res) {
      if (!res) return;
      S.u.step = 'done';
      render();
    });
    S.u.step = 'done';
    render();
  }

  function goBack() {
    if (S.u.step === 'menu') { S.u.step = 'pick'; render(); return; }
    if (S.u.step === 'confirm') { S.u.step = 'menu'; render(); }
  }

  function resetFlow() {
    S.u = { step: 'pick', name: '', draft: null };
    S.nq = '';
    render();
  }

  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? okMsg : '복사가 막혀 있어요. 내용을 길게 눌러 복사해 주세요.');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
    } else fallback();
  }

  function pageBase() {
    return location.origin + location.pathname.replace(/(?:index|admin)\.html$/, '');
  }
  function participantLink() {
    return pageBase() + (S.sheetUrl ? '#s=' + encodeURIComponent(S.sheetUrl) : '');
  }
  function adminLink() {
    return pageBase() + 'admin.html' + (S.sheetUrl ? '#s=' + encodeURIComponent(S.sheetUrl) : '');
  }

  function parseBulk(text) {
    return String(text || '').split(/[\n,;\t]+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0 && s.length <= 20; });
  }

  function addRosterNames(names) {
    var cur = cfg().roster.slice();
    var set = {};
    cur.forEach(function (n) { set[n] = 1; });
    var added = 0;
    names.forEach(function (n) {
      if (!set[n]) { set[n] = 1; cur.push(n); added++; }
    });
    if (!added) { toast('이미 있는 이름이에요'); return; }
    mutate('roster', { roster: cur }).then(function (res) {
      if (res) toast(added + '명을 추가했어요');
    });
  }

  function removeRoster(n) {
    var rest = cfg().roster.filter(function (x) { return x !== n; });
    mutate('roster', { roster: rest, force: !rest.length }).then(function (res) {
      if (res) toast(n + '님을 명단에서 뺐어요');
    });
  }

  function setTemp(t) {
    S.pickTemp = t;
    var buttons = document.querySelectorAll('[data-act="set-temp"]');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var on = b.getAttribute('data-temp') === t;
      b.className = on ? ('on' + (t === 'HOT' ? ' hot' : t === 'ICE' ? ' ice' : '')) : '';
    }
    if (t) localStorage.setItem(LS_LASTTEMP, t);
  }

  function setEditTemp(t) {
    S.editTemp = t;
    var buttons = document.querySelectorAll('[data-act="edit-temp"]');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var on = b.getAttribute('data-temp') === t;
      b.className = on ? ('on' + (t === 'HOT' ? ' hot' : t === 'ICE' ? ' ice' : '')) : '';
    }
  }

  function saveMenuOv(brand, ov) {
    return mutate('menus', { brand: brand, ov: ov });
  }

  function currentOv(brand) {
    var ov = (S.data.menus || {})[brand];
    return {
      removed: (ov && ov.removed ? ov.removed : []).slice(),
      renamed: Object.assign({}, (ov && ov.renamed) || {}),
      added: (ov && ov.added ? ov.added.map(function (x) { return Object.assign({}, x); }) : [])
    };
  }

  /* ── 이벤트 ───────────────────────────────────────────── */
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act');
    var name = t.getAttribute('data-name');
    S.lastBtn = t;                 /* 저장 중… 표시를 위해 방금 누른 버튼을 기억 */

    switch (act) {
      /* 시트 닫기 */
      case 'sheet-close': closeSheet(); break;
      case 'confirm-ok': {
        var fn = S.confirmCb; S.confirmCb = null;
        closeSheet();
        if (fn) fn();
        break;
      }

      /* 참여자 */
      case 'pick-name': pickName(name); break;
      case 'start-order': startOrder(name); break;
      case 'back': goBack(); break;
      case 'cat': {
        S.cat = t.getAttribute('data-cat');
        var menuC = resolvedMenu(cfg().brand);
        document.querySelectorAll('[data-act="cat"]').forEach(function (b) {
          b.classList.toggle('on', b.getAttribute('data-cat') === S.cat);
        });
        var mwC = $('menu-list-wrap');
        if (mwC) mwC.innerHTML = menuListHTML(menuC);
        break;
      }
      case 'choose': chooseItem(t.getAttribute('data-id')); break;
      case 'set-temp': setTemp(t.getAttribute('data-temp')); break;
      case 'pick-save': {
        saveDraft({ menu: S.pickItem.name, temp: S.pickTemp, note: '', itemId: S.pickItem.id });
        break;
      }
      case 'submit': doSubmit(t); break;
      case 'edit-again': S.u.step = 'menu'; render(); break;
      case 'reset': resetFlow(); break;

      /* 공통 */
      case 'reload': refresh(true); break;
      case 'to-user': {
        S.mode = 'user';
        S.u = { step: 'pick', name: '', draft: null };
        try { history.replaceState(null, '', participantLink()); } catch (e) {}
        render();
        break;
      }
      case 'to-admin': {
        S.mode = 'admin';
        try { history.replaceState(null, '', adminLink()); } catch (e) {}
        render();
        break;
      }
      case 'tab': S.tab = t.getAttribute('data-tab'); render(); break;

      /* 관리자 — 주문 */
      case 'adm-edit': openAdminEdit(name); break;
      case 'edit-temp': setEditTemp(t.getAttribute('data-temp')); break;
      case 'save-admin-edit': {
        var em = ($('edit-menu') && $('edit-menu').value || '').trim();
        if (!em) { toast('메뉴를 적어 주세요'); break; }
        var et = S.editTemp == null ? (orderOf(name) || {}).temp : S.editTemp;
        var en = ($('edit-note') && $('edit-note').value || '').trim();
        closeSheet();
        mutate('submit', { name: name, menu: em, temp: et || '', note: en.slice(0, 100) });
        break;
      }
      case 'adm-del': {
        askConfirm(name + '님의 주문을 취소할까요?', '취소하면 이 사람은 미선택으로 돌아가요.', '주문 취소', function () {
          mutate('remove', { name: name });
        }, true);
        break;
      }
      case 'clean': {
        askConfirm('명단 밖 주문을 정리할까요?', '명단에 없는 이름의 주문을 지워 숫자를 맞춰요.', '정리하기', function () {
          mutate('removeMissing', {}).then(function (res) { if (res) toast('정리했어요'); });
        });
        break;
      }
      case 'copy-order': {
        var txt = $('order-text') ? $('order-text').textContent : orderText(cfg(), orders());
        copyText(txt, '주문서를 복사했어요 — 카톡·배달앱에 붙여넣으세요');
        break;
      }
      case 'copy-history': {
        var rid = t.getAttribute('data-i');
        var h = (S.data.history || []).filter(function (x) { return x.roundId === rid; })[0];
        if (!h) break;
        copyText(orderText({ roundName: h.roundName }, h.orders || []), '지난 주문서를 복사했어요');
        break;
      }

      /* 관리자 — 명단 */
      case 'add-roster': {
        var v = ($('roster-name') && $('roster-name').value || '').trim();
        if (!v) { toast('이름을 적어 주세요'); break; }
        addRosterNames([v]);
        if ($('roster-name')) $('roster-name').value = '';
        break;
      }
      case 'bulk-roster': {
        var txt2 = ($('roster-bulk') && $('roster-bulk').value || '');
        var names = parseBulk(txt2);
        if (!names.length) { toast('추가할 이름이 없어요'); break; }
        addRosterNames(names);
        if ($('roster-bulk')) $('roster-bulk').value = '';
        break;
      }
      case 'rm-roster': removeRoster(name); break;

      /* 관리자 — 메뉴판 */
      case 'toggle-menu': {
        var brand = S.editorBrand || cfg().brand;
        var ov = currentOv(brand);
        var id = t.getAttribute('data-id');
        var i = ov.removed.indexOf(id);
        if (i >= 0) ov.removed.splice(i, 1); else ov.removed.push(id);
        saveMenuOv(brand, ov);
        break;
      }
      case 'del-menu': {
        var brand2 = S.editorBrand || cfg().brand;
        var ov2 = currentOv(brand2);
        var id2 = t.getAttribute('data-id');
        ov2.added = ov2.added.filter(function (x) { return x.id !== id2; });
        ov2.removed = ov2.removed.filter(function (x) { return x !== id2; });
        delete ov2.renamed[id2];
        saveMenuOv(brand2, ov2);
        break;
      }
      case 'edit-menu': {
        var idm = t.getAttribute('data-id');
        var bm = S.editorBrand || cfg().brand;
        var menuM = resolvedMenu(bm);
        var itm = null;
        menuM.items.forEach(function (x) { if (x.id === idm) itm = x; });
        if (!itm) break;
        S.editMenuId = idm;
        S.editMenuTemp = itm.temp;
        openSheet(sheetTitle('메뉴 수정', '이름을 바꾸거나 온도 옵션을 조정할 수 있어요.') +
          '<div class="field"><label>메뉴 이름</label>' +
            '<input id="menu-name" class="input plain" value="' + esc(itm.name) + '" maxlength="40"></div>' +
          '<div class="field"><label>온도</label><div class="seg">' +
            ['both', 'hot', 'ice'].map(function (tv) {
              return '<button data-act="edit-menu-temp" data-temp="' + tv + '" class="' + (itm.temp === tv ? 'on' : '') + '">' +
                (tv === 'both' ? 'HOT/ICE' : tv.toUpperCase()) + '</button>';
            }).join('') + '</div></div>' +
          '<div class="sheet-actions"><button class="btn ghost" data-act="sheet-close">취소</button>' +
          '<button class="btn" data-act="save-menu-edit" data-id="' + esc(idm) + '">저장</button></div>');
        break;
      }
      case 'edit-menu-temp':
        S.editMenuTemp = t.getAttribute('data-temp');
        document.querySelectorAll('[data-act="edit-menu-temp"]').forEach(function (b) {
          b.classList.toggle('on', b.getAttribute('data-temp') === S.editMenuTemp);
        });
        break;
      case 'save-menu-edit': {
        var idE = t.getAttribute('data-id');
        var nmE = ($('menu-name') && $('menu-name').value || '').trim();
        if (!nmE) { toast('메뉴 이름을 적어 주세요'); break; }
        var bE = S.editorBrand || cfg().brand;
        var ovE = currentOv(bE);
        var addedHit = null;
        ovE.added.forEach(function (x) { if (x.id === idE) addedHit = x; });
        if (addedHit) { addedHit.name = nmE; addedHit.temp = S.editMenuTemp; }
        else {
          var base = COMenu.brand(bE).items.filter(function (x) { return x.id === idE; })[0];
          var baseName = base ? base.name : '';
          if (nmE === baseName) delete ovE.renamed[idE]; else ovE.renamed[idE] = nmE;
          if (base && base.temp !== S.editMenuTemp) {
            /* 기본 온도를 바꾸는 경우: 숨기고 같은 메뉴를 추가 항목으로 넣는다 */
            ovE.removed.push(idE);
            ovE.added.push({ id: 'x-' + idE, name: nmE, cat: base.cat, temp: S.editMenuTemp });
          }
        }
        closeSheet();
        saveMenuOv(bE, ovE).then(function (res) { if (res) toast('메뉴를 저장했어요'); });
        break;
      }
      case 'add-menu': {
        var nmA = ($('new-menu-name') && $('new-menu-name').value || '').trim();
        if (!nmA) { toast('메뉴 이름을 적어 주세요'); break; }
        var bA = S.editorBrand || cfg().brand;
        var ovA = currentOv(bA);
        ovA.added.push({
          id: 'a' + Date.now().toString(36),
          name: nmA,
          cat: ($('new-menu-cat') && $('new-menu-cat').value) || 'etc',
          temp: ($('new-menu-temp') && $('new-menu-temp').value) || 'both'
        });
        saveMenuOv(bA, ovA).then(function (res) {
          if (res) { toast('메뉴를 추가했어요'); if ($('new-menu-name')) $('new-menu-name').value = ''; }
        });
        break;
      }
      case 'reset-menu': {
        askConfirm('기본 메뉴판으로 되돌릴까요?', '이 브랜드의 이름 수정·메뉴 추가·숨김이 모두 지워져요.', '되돌리기', function () {
          saveMenuOv(S.editorBrand || cfg().brand, { removed: [], renamed: {}, added: [] })
            .then(function (res) { if (res) toast('기본 메뉴판으로 되돌렸어요'); });
        }, true);
        break;
      }

      /* 관리자 — 회차 */
      case 'set-brand': {
        var nb = t.getAttribute('data-brand');
        var oldName = brandName(cfg().brand);
        var patch = { brand: nb };
        var rn = cfg().roundName;
        if (rn.indexOf(oldName) >= 0) patch.roundName = rn.replace(oldName, brandName(nb));
        mutate('config', { patch: patch }).then(function (res) {
          if (res) toast(brandName(nb) + ' 메뉴판으로 바꿨어요');
        });
        break;
      }
      case 'save-round-name': {
        var rv = ($('round-name') && $('round-name').value || '').trim();
        if (!rv) { toast('회차 이름을 적어 주세요'); break; }
        mutate('config', { patch: { roundName: rv } }).then(function (res) { if (res) toast('회차 이름을 저장했어요'); });
        break;
      }
      case 'toggle-status': {
        var next = cfg().status === 'open' ? 'closed' : 'open';
        mutate('config', { patch: { status: next } }).then(function (res) {
          if (res) toast(next === 'open' ? '다시 주문을 받아요' : '주문을 마감했어요');
        });
        break;
      }
      case 'new-round': openNewRound(); break;
      case 'do-new-round': {
        var nrn = ($('new-round-name') && $('new-round-name').value || '').trim();
        closeSheet();
        mutate('newRound', { roundName: nrn, brand: cfg().brand }).then(function (res) {
          if (res) toast('새 회차를 열었어요');
        });
        break;
      }
      case 'copy-user-link': {
        /* 바로 복사하지 않고, 어느 회차 링크인지 보여 주며 한 번 확인 */
        var cur = cfg();
        askConfirm('이 회차의 참여자 링크를 복사하시겠습니까?',
          cur.roundName + ' · ' + brandName(cur.brand) +
            (S.sheetUrl ? '' : '\n(아직 저장 연결 전이라 이 기기에만 저장돼요.)'),
          '링크 복사', function () {
            copyText(participantLink(), '참여자 링크를 복사했어요');
          });
        break;
      }
      case 'copy-admin-link': copyText(adminLink(), '관리자 링크를 복사했어요 — 따로 보관하세요'); break;
      case 'delete-history': {
        var hid = t.getAttribute('data-i');
        var hh = (S.data.history || []).filter(function (x) { return x.roundId === hid; })[0];
        if (!hh) break;
        askConfirm('이 지난 회차를 삭제할까요?',
          '「' + hh.roundName + '」 · ' + (hh.total || 0) + '건\n지우면 주문서를 다시 볼 수 없어요.',
          '삭제', function () {
            mutate('deleteHistory', { roundId: hid }).then(function (res) {
              if (res) toast('지난 회차를 지웠어요');
            });
          }, true);
        break;
      }
      case 'connect': {
        var url = ($('sheet-url') && $('sheet-url').value || '').trim().replace(/\/+$/, '');
        if (!isFbUrl(url) && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(url)) {
          toast('실시간 DB 주소나 웹앱 주소(…/exec)를 확인해 주세요');
          break;
        }
        if (S.es) { try { S.es.close(); } catch (e) {} S.es = null; S.streamOn = false; }
        S.sheetUrl = url;
        S.fbMode = isFbUrl(url);
        localStorage.setItem(LS_SHEET, url);
        backendLoad().then(function () {
          S.mode = 'admin';
          render();
          toast(S.fbMode ? '실시간 DB에 연결했어요' : '시트에 연결했어요');
        }).catch(function () {
          toast('불러오지 못했어요 — 주소와 권한을 확인해 주세요');
        });
        break;
      }
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target.id === 'editor-brand') {
      S.editorBrand = e.target.value;
      S.tab = 'menu';
      render();
    }
  });

  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el.id === 'name-search') {
      S.nq = el.value;
      var wrap = $('name-grid-wrap');
      if (wrap) wrap.innerHTML = namesHTML();
    } else if (el.id === 'menu-search') {
      S.mq = el.value;
      var mw = $('menu-list-wrap');
      if (mw) mw.innerHTML = menuListHTML();
    } else if (el.id === 'editor-brand') {
      S.editorBrand = el.value;
      render();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('sheet').hidden) closeSheet();
    if (e.key === 'Enter') {
      if (e.target.id === 'roster-name') {
        e.preventDefault();
        var b = document.querySelector('[data-act="add-roster"]');
        if (b) b.click();
      }
      if (e.target.id === 'menu-name' || e.target.id === 'edit-menu') {
        e.preventDefault();
        var s = document.querySelector('[data-act="save-menu-edit"],[data-act="save-admin-edit"]');
        if (s) s.click();
      }
    }
  });

  /* ── 시작 ─────────────────────────────────────────────── */
  function readParams() {
    var out = {};
    var parts = [];
    if (location.search.length > 1) parts.push(location.search.slice(1));
    if (location.hash.length > 1) parts.push(location.hash.slice(1));
    parts.join('&').split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = i < 0 ? kv : kv.slice(0, i);
      var v = i < 0 ? '1' : kv.slice(i + 1);
      try { k = decodeURIComponent(k); v = decodeURIComponent(v); } catch (e) {}
      out[k] = v;
    });
    return out;
  }

  function refresh(silent) {
    if (!S.sheetUrl) { render(); if (silent) toast('최신 상태로 다시 그렸어요'); return Promise.resolve(); }
    return backendLoad().then(function () {
      render();
      if (!silent) toast('최신 상태로 불려왔어요');
      return true;
    }).catch(function () {
      if (!silent) toast('불러오지 못했어요');
      return false;
    });
  }

  function boot() {
    var p = readParams();
    var stored = '';
    try { stored = localStorage.getItem(LS_SHEET) || ''; } catch (e) {}
    S.sheetUrl = String(p.s || stored || '').trim();
    if (S.sheetUrl) { try { localStorage.setItem(LS_SHEET, S.sheetUrl); } catch (e) {} }
    S.mode = (window.__COFFEE_ADMIN_ENTRY || p.admin === '1' || p.admin === 'true') ? 'admin' : 'user';
    S.fbMode = isFbUrl(S.sheetUrl);

    /* 저장분(캐시)이 있으면 연결을 기다리지 않고 바로 그립니다 */
    var local = readLocal();
    S.data = local || null;
    S.cached = !!local;
    if (local) S.editorBrand = local.config.brand;

    if (!S.sheetUrl && !S.data) {
      /* 처음 쓰는 로컬 모드 — 빈 앱장은 즉시 */
      S.data = blankData();
      saveLocal();
      S.editorBrand = S.data.config.brand;
    }

    render();

    if (S.sheetUrl) {
      backendLoad().then(function () {
        S.editorBrand = S.editorBrand || S.data.config.brand;
        render();
      }).catch(function () {
        if (!S.data) { S.data = blankData(); saveLocal(); S.editorBrand = S.data.config.brand; }
        toast('연결하지 못했어요 — 이 브라우저 저장분으로 보여 드려요');
        render();
      });
    }

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () {});
      });
    }
  }

  /* 테스트·디버깅용 최소 공개 API */
  window.COApp = {
    version: APP_VERSION,
    get state() { return S; },
    get storage() { return S.fbMode ? 'firebase' : (S.sheetUrl ? 'script' : 'local'); },
    computeStats: computeStats,
    aggregate: aggregate,
    orderText: orderText,
    resolveMenu: resolvedMenu,
    participantLink: participantLink,
    adminLink: adminLink,
    orderOf: orderOf,
    refresh: refresh,
    safeKey: safeKey,
    applyPatch: applyPatch
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
