/* 단체 음료 주문 — 브랜드 메뉴판 데이터
 * ─────────────────────────────────────────────────────────────
 * 2026년 11월 기준 각 브랜드 공식 메뉴·가격표(본사 권장가) 보도자료와
 * 매장 메뉴판 자료를 대조해 정리했습니다. 매장·시기에 따라 달라질 수 있습니다.
 *
 * temp 규칙
 *   both = HOT / ICE 모두 가능
 *   hot  = HOT 전용
 *   ice  = ICE 전용
 * pop  = 많이 찾는 메뉴(화면에서 '인기' 표시)
 * memo = 화면에 작게 붙는 설명
 */
(function () {
  'use strict';

  var COFFEE = 'coffee';
  var DECAF = 'decaf';
  var NON = 'noncoffee';
  var TEA = 'tea';
  var ADE = 'ade';
  var SMOOTHIE = 'smoothie';

  var COMMON_CATS = [
    { id: COFFEE, name: '커피' },
    { id: DECAF, name: '디카페인' },
    { id: NON, name: '음료·라떼' },
    { id: TEA, name: '차' },
    { id: ADE, name: '에이드·주스' },
    { id: SMOOTHIE, name: '스무디·프라페' }
  ];

  function item(id, name, cat, temp, opt) {
    var o = { id: id, name: name, cat: cat, temp: temp };
    if (opt) {
      if (opt.pop) o.pop = 1;
      if (opt.memo) o.memo = opt.memo;
    }
    return o;
  }

  var brands = {};

  /* ── 컴포즈커피 ───────────────────────────────────────── */
  brands.compose = {
    id: 'compose',
    name: '컴포즈커피',
    tagline: '가성비 대표 · 아메리카노 1,500원대',
    cats: COMMON_CATS,
    items: [
      item('cp-esp', '에스프레소', COFFEE, 'hot'),
      item('cp-ame', '아메리카노', COFFEE, 'both', { pop: 1 }),
      item('cp-ame-big', '빅포즈 아메리카노', COFFEE, 'ice', { memo: '대용량' }),
      item('cp-ame-honey', '꿀아메리카노', COFFEE, 'both'),
      item('cp-latte', '카페라떼', COFFEE, 'both', { pop: 1 }),
      item('cp-latte-big', '빅포즈 카페라떼', COFFEE, 'ice', { memo: '대용량' }),
      item('cp-capu', '카푸치노', COFFEE, 'both'),
      item('cp-vanilla', '바닐라라떼', COFFEE, 'both', { pop: 1 }),
      item('cp-hazel', '헤이즐넛라떼', COFFEE, 'both'),
      item('cp-caramel', '카라멜마끼아또', COFFEE, 'both'),
      item('cp-mocha', '카페모카', COFFEE, 'both'),
      item('cp-dolce', '돌체라떼', COFFEE, 'both'),
      item('cp-ashot', '아샷추', COFFEE, 'ice'),
      item('cp-cold', '콜드브루', COFFEE, 'ice'),
      item('cp-coldlatte', '콜드브루 라떼', COFFEE, 'ice'),
      item('cp-black-cafe', '흑당 카페라떼', COFFEE, 'ice'),
      item('cp-einspanner', '아인슈페너라떼', COFFEE, 'ice'),

      item('cp-d-ame', '디카페인 아메리카노', DECAF, 'both'),
      item('cp-d-latte', '디카페인 카페라떼', DECAF, 'both'),
      item('cp-d-vanilla', '디카페인 바닐라라떼', DECAF, 'both'),
      item('cp-d-hazel', '디카페인 헤이즐넛라떼', DECAF, 'both'),
      item('cp-d-dolce', '디카페인 돌체라떼', DECAF, 'both'),
      item('cp-d-cold', '디카페인 콜드브루', DECAF, 'ice'),
      item('cp-d-coldlatte', '디카페인 콜드브루 라떼', DECAF, 'ice'),

      item('cp-grain', '곡물라떼', NON, 'both'),
      item('cp-sweetpotato', '고구마라떼', NON, 'both'),
      item('cp-greentea', '그린티라떼', NON, 'both'),
      item('cp-choco', '더블초코라떼', NON, 'both'),
      item('cp-cookie', '쿠키초코라떼', NON, 'both'),
      item('cp-strawberry', '딸기라떼', NON, 'ice'),
      item('cp-mango', '망고라떼', NON, 'ice'),
      item('cp-milktea', '밀크티', NON, 'both'),
      item('cp-black-latte', '흑당라떼', NON, 'ice'),
      item('cp-choco-fresh', '생초콜릿라떼', NON, 'ice'),

      item('cp-icetea', '복숭아 아이스티', TEA, 'ice', { pop: 1 }),
      item('cp-grapefruit-tea', '자몽허니블랙티', TEA, 'both'),
      item('cp-chamomile', '캐모마일', TEA, 'hot'),
      item('cp-peppermint', '페퍼민트', TEA, 'hot'),
      item('cp-earlgrey', '얼그레이', TEA, 'both'),
      item('cp-yuja', '유자차', TEA, 'both'),
      item('cp-lemon-tea', '레몬차', TEA, 'both'),

      item('cp-grapefruit-ade', '자몽에이드', ADE, 'ice'),
      item('cp-lemon-ade', '레몬에이드', ADE, 'ice'),
      item('cp-grape-ade', '청포도에이드', ADE, 'ice'),
      item('cp-mango-ade', '망고에이드', ADE, 'ice'),
      item('cp-yuja-ade', '유자에이드', ADE, 'ice'),

      item('cp-straw-smoothie', '딸기스무디', SMOOTHIE, 'ice'),
      item('cp-mango-smoothie', '망고스무디', SMOOTHIE, 'ice'),
      item('cp-blue-smoothie', '블루베리스무디', SMOOTHIE, 'ice'),
      item('cp-yogurt-smoothie', '요거트스무디', SMOOTHIE, 'ice'),
      item('cp-choco-frappe', '리얼초코자바칩프라페', SMOOTHIE, 'ice'),
      item('cp-green-frappe', '그린티프라페', SMOOTHIE, 'ice')
    ]
  };

  /* ── 메가MGC커피 ─────────────────────────────────────── */
  brands.mega = {
    id: 'mega',
    name: '메가커피',
    tagline: '대용량 · 프라페 인기',
    cats: COMMON_CATS,
    items: [
      item('mg-ame', '아메리카노', COFFEE, 'both', { pop: 1 }),
      item('mg-megaricano', '메가리카노', COFFEE, 'ice', { memo: '946ml' }),
      item('mg-heotgae', '헛개리카노', COFFEE, 'ice'),
      item('mg-honey-ame', '꿀아메리카노', COFFEE, 'ice'),
      item('mg-vanilla-ame', '바닐라아메리카노', COFFEE, 'ice'),
      item('mg-hazel-ame', '헤이즐넛아메리카노', COFFEE, 'ice'),
      item('mg-latte', '카페라떼', COFFEE, 'both', { pop: 1 }),
      item('mg-capu', '카푸치노', COFFEE, 'both'),
      item('mg-vanilla', '바닐라라떼', COFFEE, 'both', { pop: 1 }),
      item('mg-hazel', '헤이즐넛라떼', COFFEE, 'both'),
      item('mg-caramel', '카라멜마끼아또', COFFEE, 'both'),
      item('mg-mocha', '카페모카', COFFEE, 'both'),
      item('mg-condensed', '연유라떼', COFFEE, 'both'),
      item('mg-cold', '콜드브루 오리지널', COFFEE, 'ice'),
      item('mg-coldlatte', '콜드브루 라떼', COFFEE, 'ice'),

      item('mg-d-ame', '디카페인 아메리카노', DECAF, 'both'),
      item('mg-d-latte', '디카페인 카페라떼', DECAF, 'both'),
      item('mg-d-vanilla', '디카페인 바닐라라떼', DECAF, 'both'),
      item('mg-d-hazel', '디카페인 헤이즐넛라떼', DECAF, 'both'),
      item('mg-d-mocha', '디카페인 카페모카', DECAF, 'both'),
      item('mg-d-cold', '콜드브루 디카페인', DECAF, 'ice'),

      item('mg-grain', '곡물라떼', NON, 'both'),
      item('mg-sweetpotato', '고구마라떼', NON, 'both'),
      item('mg-greentea', '녹차라떼', NON, 'both'),
      item('mg-choco', '초코라떼', NON, 'both'),
      item('mg-strawberry', '딸기라떼', NON, 'ice', { pop: 1 }),
      item('mg-toffee', '토피넛라떼', NON, 'both'),
      item('mg-royalmilk', '로얄밀크티라떼', NON, 'both'),
      item('mg-black-latte', '흑당라떼', NON, 'ice'),
      item('mg-black-bubble', '흑당버블라떼', NON, 'ice'),
      item('mg-hotchoco', '핫초코', NON, 'hot'),
      item('mg-icechoco', '아이스초코', NON, 'ice'),

      item('mg-icetea', '복숭아 아이스티', TEA, 'ice', { pop: 1 }),
      item('mg-grapefruit-tea', '허니자몽블랙티', TEA, 'both'),
      item('mg-apple-yuja', '사과유자차', TEA, 'both'),
      item('mg-yuja', '유자차', TEA, 'both'),
      item('mg-lemon-tea', '레몬차', TEA, 'both'),
      item('mg-grapefruit-tea2', '자몽차', TEA, 'both'),
      item('mg-chamomile', '캐모마일', TEA, 'hot'),
      item('mg-peppermint', '페퍼민트', TEA, 'hot'),
      item('mg-earlgrey', '얼그레이', TEA, 'hot'),
      item('mg-greentea-tea', '녹차', TEA, 'hot'),

      item('mg-ade', '메가에이드', ADE, 'ice'),
      item('mg-lemon-ade', '레몬에이드', ADE, 'ice'),
      item('mg-blue-lemon-ade', '블루레몬에이드', ADE, 'ice'),
      item('mg-grapefruit-ade', '자몽에이드', ADE, 'ice'),
      item('mg-grape-ade', '청포도에이드', ADE, 'ice'),
      item('mg-cherry-cola', '체리콜라', ADE, 'ice'),

      item('mg-cookie-frappe', '쿠키프라페', SMOOTHIE, 'ice', { pop: 1 }),
      item('mg-choco-frappe', '리얼초코프라페', SMOOTHIE, 'ice'),
      item('mg-coffee-frappe', '커피프라페', SMOOTHIE, 'ice'),
      item('mg-green-frappe', '녹차프라페', SMOOTHIE, 'ice'),
      item('mg-mint-frappe', '민트프라페', SMOOTHIE, 'ice'),
      item('mg-yogurt-smoothie', '플레인요거트스무디', SMOOTHIE, 'ice'),
      item('mg-straw-yogurt', '딸기요거트스무디', SMOOTHIE, 'ice'),
      item('mg-mango-yogurt', '망고요거트스무디', SMOOTHIE, 'ice'),
      item('mg-straw-juice', '딸기주스', SMOOTHIE, 'ice')
    ]
  };

  /* ── 빽다방 ──────────────────────────────────────────── */
  brands.paik = {
    id: 'paik',
    name: '빽다방',
    tagline: '원조커피 · 빽사이즈',
    cats: COMMON_CATS,
    items: [
      item('pk-esp', '더블에스프레소', COFFEE, 'hot'),
      item('pk-ame', '아메리카노', COFFEE, 'both', { pop: 1 }),
      item('pk-ame-big', '빽사이즈 아메리카노', COFFEE, 'ice', { memo: '4샷 · 대용량' }),
      item('pk-original', '원조커피', COFFEE, 'both', { pop: 1, memo: '믹스커피' }),
      item('pk-original-zero', '원조커피 제로슈거', COFFEE, 'both'),
      item('pk-condensed', '달달연유라떼', COFFEE, 'both'),
      item('pk-latte', '카페라떼', COFFEE, 'both', { pop: 1, memo: 'HOT은 생크림' }),
      item('pk-latte-big', '빽사이즈 카페라떼', COFFEE, 'ice'),
      item('pk-vanilla', '바닐라라떼', COFFEE, 'both'),
      item('pk-hazel', '헤이즐넛라떼', COFFEE, 'both'),
      item('pk-caramel', '카라멜마끼아또', COFFEE, 'both'),
      item('pk-mocha', '카페모카', COFFEE, 'both'),
      item('pk-ashot', '아이스티 샷추가(아.샷.추)', COFFEE, 'ice'),
      item('pk-ice-latte', '아이스크림 카페라떼', COFFEE, 'ice'),
      item('pk-ice-vanilla', '아이스크림 바닐라라떼', COFFEE, 'ice'),
      item('pk-cold', '콜드브루', COFFEE, 'both'),
      item('pk-coldlatte', '콜드브루라떼', COFFEE, 'both'),
      item('pk-cold-black', '콜드브루 흑당라떼', COFFEE, 'both'),

      item('pk-d-ame', '디카페인 아메리카노', DECAF, 'both'),
      item('pk-d-latte', '디카페인 카페라떼', DECAF, 'both'),
      item('pk-d-vanilla', '디카페인 바닐라라떼', DECAF, 'both'),
      item('pk-d-caramel', '디카페인 카라멜마끼아또', DECAF, 'both'),
      item('pk-d-mocha', '디카페인 카페모카', DECAF, 'both'),
      item('pk-d-cold', '디카페인 콜드브루', DECAF, 'both'),
      item('pk-d-coldlatte', '디카페인 콜드브루라떼', DECAF, 'both'),

      item('pk-misutgaru', '미숫가루(우유)', NON, 'ice'),
      item('pk-sweetpotato', '고구마라떼', NON, 'both'),
      item('pk-matcha', '말차라떼', NON, 'both'),
      item('pk-choco', '초코라떼', NON, 'both'),
      item('pk-strawberry', '딸기라떼', NON, 'ice'),
      item('pk-yulmu', '율무라떼', NON, 'both'),
      item('pk-mintchoco', '민트초코라떼', NON, 'both'),
      item('pk-ube', '우베라떼', NON, 'ice'),
      item('pk-ssanghwa', '쌍화라떼', NON, 'hot'),
      item('pk-black-bubble', '흑당버블카페라떼', NON, 'ice'),

      item('pk-icetea', '아이스티', TEA, 'ice', { pop: 1 }),
      item('pk-grapefruit-tea', '자몽티', TEA, 'ice'),
      item('pk-chamomile', '캐모마일', TEA, 'hot'),
      item('pk-peppermint', '페퍼민트', TEA, 'hot'),
      item('pk-earlgrey', '얼그레이', TEA, 'hot'),

      item('pk-grapefruit-ade', '자몽에이드', ADE, 'ice'),
      item('pk-peach-ade', '복숭아에이드', ADE, 'ice'),
      item('pk-calamansi-ade', '깔라만시에이드', ADE, 'ice'),
      item('pk-zero-lemonade', '제로슈거 레모네이드', ADE, 'ice'),
      item('pk-grape-soda', '포도소다', ADE, 'ice'),

      item('pk-original-bbang', '원조빽스치노', SMOOTHIE, 'ice'),
      item('pk-matcha-bbang', '말차빽스치노', SMOOTHIE, 'ice'),
      item('pk-mint-bbang', '민트초코빽스치노', SMOOTHIE, 'ice'),
      item('pk-bbang', '빽스치노(베이직)', SMOOTHIE, 'ice'),
      item('pk-yogurt-smoothie', '플레인요거트스무디', SMOOTHIE, 'ice'),
      item('pk-straw-yogurt', '딸기요거트스무디', SMOOTHIE, 'ice'),
      item('pk-watermelon', '우리수박주스', SMOOTHIE, 'ice'),
      item('pk-tangerine', '제주감귤주스', SMOOTHIE, 'ice')
    ]
  };

  /* ── 직접 설정 (편집자가 메뉴를 직접 넣는 브랜드) ────── */
  brands.custom = {
    id: 'custom',
    name: '직접 설정',
    tagline: '편집자 화면에서 메뉴를 채워 주세요',
    cats: [
      { id: 'drink', name: '음료' },
      { id: 'etc', name: '기타' }
    ],
    items: []
  };

  var ORDER = ['compose', 'mega', 'paik', 'custom'];

  window.COMenu = {
    free: ['drink', 'etc'],
    brands: brands,
    order: ORDER,
    brand: function (id) { return brands[id] || brands.compose; },
    /* 편집자가 바꾼 내용(숨김·이름변경·추가)을 기본 메뉴판 위에 얹는다 */
    resolve: function (brandId, ov) {
      var base = brands[brandId] || brands.compose;
      ov = ov || {};
      var removed = ov.removed || [];
      var renamed = ov.renamed || {};
      var cats = base.cats.slice();
      var items = base.items.filter(function (it) { return removed.indexOf(it.id) < 0; })
        .map(function (it) {
          if (!renamed[it.id]) return it;
          return { id: it.id, name: renamed[it.id], cat: it.cat, temp: it.temp, pop: it.pop, memo: it.memo, renamed: 1 };
        });
      (ov.added || []).forEach(function (it) {
        if (!it || !it.name) return;
        if (!cats.some(function (c) { return c.id === it.cat; })) cats.push({ id: it.cat, name: it.cat });
        items.push({ id: it.id, name: it.name, cat: it.cat, temp: it.temp || 'both', added: 1, memo: it.memo });
      });
      return { id: base.id, name: (ov.name || base.name), cats: cats, items: items };
    }
  };
})();
