// 티커 Service Worker
// 캐싱 안 함 — index.html 수정이 항상 즉시 반영되도록. PWA 설치 가능하게만 등록.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', () => {}); // 기본 네트워크 통과 (설치 요건 충족용)
