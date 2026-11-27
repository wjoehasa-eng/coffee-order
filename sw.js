/* 단체 음료 주문 — 오프라인 캐시 (앱 껍데기만 캐시, 주문 데이터는 localStorage/시트) */
var CACHE = 'coffee-order-v1.1.12';
var ASSETS = [
  './',
  'index.html',
  'admin.html',
  'styles.css?v=1.1.12',
  'menus.js?v=1.1.12',
  'app.js?v=1.1.12',
  'manifest.webmanifest',
  'admin.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(ASSETS).catch(function () {});
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  /* 구글 시트(웹앱) 요청은 절대 캐시하지 않음 — 항상 최신 주문을 읽어야 함 */
  if (url.hostname.indexOf('script.google.com') >= 0 || url.hostname.indexOf('googleusercontent') >= 0) return;

  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then(function (hit) {
      if (hit) {
        fetch(req).then(function (res) {
          if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(req, res.clone()); });
        }).catch(function () {});
        return hit;
      }
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match('index.html');
      });
    }));
  }
});
