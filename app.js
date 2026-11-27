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

  var APP_VERSION = '1.0.0';
  var LS_DATA = 'coffee-order-v1';
  var LS_SHEET = 'coffee-order-sheet';
  var LS_LASTTEMP = 'coffee-order-lasttemp';

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
    nq: '',                       /* 이름 검색어 */
    mq: '',                       /* 메뉴 검색어 */
    cat: 'all',
    editorBrand: '',
    pickItem: null,
    pickTemp: '',
    pickChips: [],
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
    try { localStorage.setItem(LS_DATA, JSON.stringify(S.data)); } catch (e) {}
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
      history: res.history || []
    };
    S.data.config.roster = S.data.config.roster || [];
    S.connected = true;
  }

  function sheetLoad() {
    return jsonp(S.sheetUrl, { action: 'load' }).then(function (res) {
      applyRemote(res);
      return res;
    });
  }

  function sheetApi(action, p) {
    if (action === 'load') return sheetLoad();
    return postSheet(action, p).then(function () { return sheetLoad(); });
  }

  /* ── 공통 api ─────────────────────────────────────────── */
  function api(action, p) {
    return S.sheetUrl ? sheetApi(action, p) : localApi(action, p);
  }

  function mutate(action, p) {
    if (S.busy) return Promise.resolve(null);
    S.busy = true;
    return api(action, p).then(function (res) {
      if (res && res.ok === false) throw new Error(res.error || 'error');
      return res;
    }).catch(function (e) {
      var m = String((e && e.message) || e);
      if (m === 'closed') toast('주문이 마감됐어요');
      else if (m === 'timeout' || m === 'network') toast('연결을 확인해 주세요');
      else toast(m && m.length < 40 ? m : '저장하지 못했어요');
      return null;
    }).then(function (res) {
      S.busy = false;
      render();
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
      app.className = 'app';
      $('topbar').innerHTML = '<div class="topbar-title"><span class="mark">☕</span>단체 음료 주문</div>';
      $('main').innerHTML = '<div class="card"><div class="empty"><span class="e-ic">⏳</span>불러오는 중…</div></div>';
      return;
    }
    app.className = 'app' + (S.mode === 'admin' ? ' is-admin' : '');
    $('topbar').innerHTML = topbarHTML();
    $('main').innerHTML = S.mode === 'admin' ? adminHTML() : userHTML();
  }

  function topbarHTML() {
    if (S.mode === 'admin') {
      return '<div class="topbar-title"><span class="mark">☕</span>단체 음료 주문' +
        '<span class="topbar-tag">관리자</span></div>' +
        '<div class="topbar-actions">' +
          '<button class="tbtn" data-act="reload" title="시트에서 새로 불러오기">⟳</button>' +
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
    var c = cfg();
    return bannerHTML() +
      '<div class="stepline"><span class="stepnum">1 / 3</span></div>' +
      '<h1 class="h1">내 이름을 골라 주세요</h1>' +
      '<p class="sub">이름을 누르면 바로 주문할 수 있어요. 비밀번호는 없어요.</p>' +
      '<div class="input-wrap"><span class="ic">🔍</span>' +
        '<input id="name-search" class="input" type="search" placeholder="이름 검색" autocomplete="off" value="' + esc(S.nq) + '"></div>' +
      '<div id="name-grid-wrap" style="margin-top:12px">' + namesHTML() + '</div>' +
      (c.roster.length ? '<p class="sub" style="margin:14px 2px 0;font-size:12.5px">이미 주문한 사람은 <b>✓ 선택 완료</b>로 보여요. 다시 눌러 바꿀 수 있어요.</p>' : '');
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
      '<div id="menu-list-wrap">' + menuListHTML(menu) + '</div>' +
      '<button class="direct" data-act="direct">' +
        '<span class="di-ic">✏️</span>' +
        '<span class="mi-body"><span class="di-name">직접 입력</span>' +
          '<span class="di-sub">메뉴판에 없는 메뉴도 괜찮아요</span></span>' +
        '<span class="chev">›</span>' +
      '</button>';
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
        '<div class="sub" style="margin-top:6px">아래 <b>✏️ 직접 입력</b>으로 적어 주세요.</div></div></div>';
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
      '<p class="sub">' + esc(S.u.name) + '님 주문이에요. 마지막으로 한 번만 확인해 주세요.</p>' +
      '<div class="card"><div class="summary">' +
        '<div class="row"><span class="k">이름</span><span class="v">' + esc(S.u.name) + '</span></div>' +
        '<div class="divider"></div>' +
        '<div class="row"><span class="k">메뉴</span><span class="v big">' + esc(d.menu || '') + '</span></div>' +
        '<div class="row"><span class="k">온도</span><span class="v">' + esc(d.temp || '—') + '</span></div>' +
        '<div class="row"><span class="k">요청사항</span><span class="v">' + esc(d.note || '없음') + '</span></div>' +
      '</div></div>' +
      '<div class="stack" style="margin-top:16px">' +
        '<button class="btn" data-act="submit">주문 등록</button>' +
        '<button class="btn ghost" data-act="back">메뉴 다시 고르기</button>' +
      '</div>';
  }

  function doneHTML() {
    var d = S.u.draft || {};
    return '<div class="done-hero"><span class="done-check">✓</span>' +
        '<h1 class="h1">' + esc(S.u.name) + '님 주문이 등록됐어요</h1>' +
        '<p class="sub">관리자가 확인하면 준비를 시작해요.</p></div>' +
      '<div class="card"><div class="summary">' +
        '<div class="row"><span class="k">메뉴</span><span class="v big">' + esc(d.menu || '') + '</span></div>' +
        '<div class="row"><span class="k">온도</span><span class="v">' + esc(d.temp || '—') + '</span></div>' +
        '<div class="row"><span class="k">요청사항</span><span class="v">' + esc(d.note || '없음') + '</span></div>' +
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
        '<p class="sub" style="margin:10px 2px 0;font-size:12px">이미 있는 이름은 중복으로 들어가지 않아요. 줄바꿈·쉼표·탭 모두 구분자로 인식해요.</p>' +
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
    var hist = (S.data.history || []).slice(0, 5);
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
        '<button class="btn ' + (c.status === 'open' ? 'ghost' : '') + '" data-act="toggle-status">' +
          (c.status === 'open' ? '주문 마감하기' : '다시 주문 받기') + '</button>' +
      '</div>' +
      '<div class="sec-title">새 주문 열기</div>' +
      '<div class="card">' +
        '<button class="btn" data-act="new-round">＋ 새 주문 열기 (라운드 전환)</button>' +
        '<p class="sub" style="margin:10px 2px 0;font-size:12px">지금 주문 ' + orders().length + '건은 시트 <b>History</b>에 보관하고 현재 주문판만 비워요. 참여자 링크는 그대로 쓸 수 있어요.</p>' +
      '</div>' +
      '<div class="sec-title">링크</div>' +
      '<div class="card"><div class="stack">' +
        '<button class="btn" data-act="copy-user-link">🔗 참여자 링크 복사</button>' +
        '<button class="btn ghost" data-act="copy-admin-link">🔐 관리자 링크 복사</button>' +
        '<p class="sub" style="margin:2px 2px 0;font-size:12px">참여자 링크에는 관리자 표시가 들어가지 않아요.</p>' +
      '</div></div>' +
      '<div class="sec-title">시트 연결 (선택)</div>' +
      '<div class="card">' +
        (S.sheetUrl
          ? '<div class="kv"><span class="k">연결됨</span><span class="v" style="color:#00B26B">구글 시트</span></div>' +
            '<button class="btn ghost" style="margin-top:10px" data-act="disconnect">연결 해제</button>'
          : '<div class="note-card warn">아직 연결하지 않았어요. 지금은 이 브라우저에만 저장돼요.<br>시트를 연결하면 여러 명이 동시에 주문해도 한 곳에 모여요.</div>' +
            '<input id="sheet-url" class="input plain" style="margin-top:10px" placeholder="https://script.google.com/macros/s/.../exec">' +
            '<button class="btn" style="margin-top:10px" data-act="connect">시트 연결</button>') +
      '</div>' +
      '<div class="sec-title">지난 회차</div>' +
      '<div class="card card-tight">' +
        (hist.length ? hist.map(function (h) {
          return '<div class="person"><div class="p-body"><div class="p-name">' + esc(h.roundName) + '</div>' +
            '<div class="p-menu">' + esc(brandName(h.brand)) + ' · ' + (h.total || 0) + '건</div></div>' +
            '<div class="p-tools"><button class="btn xs" data-act="copy-history" data-i="' + esc(h.roundId) + '">주문서</button></div></div>';
        }).join('') : '<div class="empty" style="padding:10px">아직 지난 회차가 없어요</div>') +
      '</div>';
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

  var NOTE_CHIPS = ['덜 달게', '샷 추가', '얼음 적게', '시럽 빼기', '휘핑 빼기', '두유로 변경'];

  function openOptions(item) {
    var temp = item.temp === 'both'
      ? (localStorage.getItem(LS_LASTTEMP) || 'ICE')
      : (item.temp === 'hot' ? 'HOT' : 'ICE');
    S.pickItem = item;
    S.pickTemp = temp;
    S.pickChips = [];
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
      '<div class="field"><label>요청사항 (선택)</label>' +
        '<div class="cnote-chips">' + NOTE_CHIPS.map(function (c) {
          return '<button class="cnote" data-act="chip" data-chip="' + esc(c) + '">' + esc(c) + '</button>';
        }).join('') + '</div>' +
      '</div>' +
      '<div class="field"><label>직접 적기</label>' +
        '<input id="pick-note" class="input plain" placeholder="예: 얼음은 조금만" maxlength="60"></div>' +
      '<div class="sheet-actions"><button class="btn ghost" data-act="sheet-close">취소</button>' +
      '<button class="btn" data-act="pick-save">이걸로 할게요</button></div>');
  }

  function catName(id) {
    var menu = resolvedMenu(cfg().brand);
    for (var i = 0; i < menu.cats.length; i++) if (menu.cats[i].id === id) return menu.cats[i].name;
    return '메뉴';
  }

  function openDirect() {
    var temp = localStorage.getItem(LS_LASTTEMP) || 'ICE';
    S.pickItem = null;
    S.pickTemp = temp;
    openSheet(sheetTitle('직접 입력', '메뉴판에 없는 메뉴를 적어 주세요.') +
      '<div class="field"><label>메뉴 이름</label>' +
        '<input id="direct-name" class="input plain" placeholder="예: 딸기 스무디 (Large)" maxlength="40"></div>' +
      '<div class="field"><label>온도</label><div class="seg">' +
        '<button data-act="set-temp" data-temp="HOT" class="' + (temp === 'HOT' ? 'on hot' : '') + '">HOT</button>' +
        '<button data-act="set-temp" data-temp="ICE" class="' + (temp === 'ICE' ? 'on ice' : '') + '">ICE</button>' +
      '</div></div>' +
      '<div class="field"><label>요청사항 (선택)</label>' +
        '<input id="direct-note" class="input plain" placeholder="예: 텀블러에 담아 주세요" maxlength="60"></div>' +
      '<div class="sheet-actions"><button class="btn ghost" data-act="sheet-close">취소</button>' +
      '<button class="btn" data-act="direct-save">이걸로 할게요</button></div>');
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

  function collectNote(chips, text) {
    var parts = (chips || []).slice();
    var t = String(text || '').trim();
    if (t) parts.push(t);
    return parts.join(', ').slice(0, 100);
  }

  function saveDraft(draft) {
    S.u.draft = draft;
    S.u.step = 'confirm';
    closeSheet();
    render();
  }

  function doSubmit() {
    var d = S.u.draft;
    if (!d) return;
    if (cfg().status !== 'open') { toast('주문이 마감됐어요'); openClosedBlocked(S.u.name, orderOf(S.u.name)); return; }
    var btn = document.querySelector('[data-act="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '등록 중…'; }
    mutate('submit', { name: S.u.name, menu: d.menu, temp: d.temp, note: d.note }).then(function (res) {
      if (!res) { if (btn) { btn.disabled = false; btn.textContent = '주문 등록'; } return; }
      S.u.step = 'done';
      render();
    });
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
    return location.origin + location.pathname;
  }
  function participantLink() {
    return pageBase() + (S.sheetUrl ? '#s=' + encodeURIComponent(S.sheetUrl) : '');
  }
  function adminLink() {
    return pageBase() + '?admin=1' + (S.sheetUrl ? '#s=' + encodeURIComponent(S.sheetUrl) : '');
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
    mutate('roster', { roster: rest }).then(function (res) {
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

  function toggleChip(btn, chip) {
    var i = S.pickChips.indexOf(chip);
    if (i >= 0) { S.pickChips.splice(i, 1); btn.classList.remove('on'); }
    else { S.pickChips.push(chip); btn.classList.add('on'); }
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
      case 'direct': openDirect(); break;
      case 'set-temp': setTemp(t.getAttribute('data-temp')); break;
      case 'chip': toggleChip(t, t.getAttribute('data-chip')); break;
      case 'pick-save': {
        var noteEl = $('pick-note');
        var note = collectNote(S.pickChips, noteEl ? noteEl.value : '');
        saveDraft({ menu: S.pickItem.name, temp: S.pickTemp, note: note, itemId: S.pickItem.id });
        break;
      }
      case 'direct-save': {
        var nm = ($('direct-name') && $('direct-name').value || '').trim();
        if (!nm) { toast('메뉴 이름을 적어 주세요'); break; }
        var dnote = ($('direct-note') && $('direct-note').value || '').trim();
        saveDraft({ menu: nm, temp: S.pickTemp, note: dnote.slice(0, 100), itemId: '', direct: true });
        break;
      }
      case 'submit': doSubmit(); break;
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
      case 'copy-user-link': copyText(participantLink(), '참여자 링크를 복사했어요'); break;
      case 'copy-admin-link': copyText(adminLink(), '관리자 링크를 복사했어요 — 따로 보관하세요'); break;
      case 'connect': {
        var url = ($('sheet-url') && $('sheet-url').value || '').trim();
        if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(url)) {
          toast('웹앱 주소(…/exec)를 확인해 주세요');
          break;
        }
        S.sheetUrl = url;
        localStorage.setItem(LS_SHEET, url);
        sheetLoad().then(function () {
          S.mode = 'admin';
          render();
          toast('시트에 연결했어요');
        }).catch(function () {
          toast('불러오지 못했어요 — 주소와 배포 권한을 확인해 주세요');
        });
        break;
      }
      case 'disconnect': {
        askConfirm('시트 연결을 해제할까요?', '이 브라우저에 있는 데이터는 그대로 남아 있어요.', '연결 해제', function () {
          S.sheetUrl = '';
          S.connected = false;
          localStorage.removeItem(LS_SHEET);
          if (location.hash.indexOf('#s=') >= 0) history.replaceState(null, '', location.pathname + location.search);
          render();
        }, true);
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
    return sheetLoad().then(function () {
      render();
      if (!silent) toast('시트에서 불러왔어요');
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
    S.sheetUrl = p.s || stored || '';
    if (p.s) { try { localStorage.setItem(LS_SHEET, p.s); } catch (e) {} }
    S.mode = (p.admin === '1' || p.admin === 'true') ? 'admin' : 'user';

    var local = readLocal();
    S.data = local || blankData();
    if (!local) saveLocal();
    S.editorBrand = S.data.config.brand;

    if (S.sheetUrl) {
      render();
      sheetLoad().then(function () {
        render();
      }).catch(function () {
        toast('시트에 연결하지 못했어요 — 이 브라우저 저장분으로 보여 드려요');
        render();
      });
    } else {
      render();
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
    computeStats: computeStats,
    aggregate: aggregate,
    orderText: orderText,
    resolveMenu: resolvedMenu,
    participantLink: participantLink,
    adminLink: adminLink,
    orderOf: orderOf,
    refresh: refresh
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
