/* Crate Shield — service worker ad & tracker blocker.
 * Intercepts subresource requests from Crate pages and drops anything
 * matching the built-in ad/tracker filter list. Our own first-party
 * requests and media/API hosts are never blocked. */
'use strict';

const ENABLED_DEFAULT = true;
let shieldOn = ENABLED_DEFAULT;
let blockedCount = 0;

// Compact filter list: well-known advertising, tracking & analytics hosts.
const BLOCK = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'adservice.google.com', 'pagead2.googlesyndication.com', 'tpc.googlesyndication.com',
  'ads.yahoo.com', 'advertising.com', 'adsystem.com',
  'amazon-adsystem.com', 'aax.amazon-adsystem.com',
  'facebook.net', 'fbcdn.net', 'connect.facebook.net',
  'hotjar.com', 'hotjar.io', 'mixpanel.com', 'segment.com', 'segment.io',
  'amplitude.com', 'fullstory.com', 'crazyegg.com', 'mouseflow.com',
  'scorecardresearch.com', 'quantserve.com', 'quantcast.com',
  'outbrain.com', 'taboola.com', 'revcontent.com', 'mgid.com',
  'criteo.com', 'criteo.net', 'rubiconproject.com', 'pubmatic.com',
  'openx.net', 'openx.com', 'adsrvr.org', 'moatads.com', 'iasds01.com',
  '2mdn.net', 'ads-twitter.com', 'static.ads-twitter.com',
  'ads.linkedin.com', 'px.ads.linkedin.com',
  'snap.licdn.com', 'analytics.tiktok.com', 'ads.tiktok.com',
  'doubleverify.com', 'demdex.net', 'bluekai.com',
  'crwdcntrl.net', 'agkn.com', 'mathtag.com', 'simpli.fi',
  'newrelic.com', 'nr-data.net', 'bugsnag.com',
  'intercom.io', 'drift.com', 'zendesk.com',
  'popads.net', 'popcash.net', 'adcash.com', 'propellerads.com',
];

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}
function isBlocked(url) {
  const h = hostOf(url);
  if (!h) return false;
  return BLOCK.some(d => h === d || h.endsWith('.' + d));
}

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'shield-set') shieldOn = !!d.on;
  if (d.type === 'shield-get' && e.source) e.source.postMessage({ type: 'shield-blocked', count: blockedCount });
});

self.addEventListener('fetch', e => {
  if (!shieldOn) return;
  // Only filter subresource requests; never touch navigations or same-origin app shell.
  if (e.request.mode === 'navigate') return;
  const url = e.request.url;
  if (url.startsWith(self.location.origin)) return;
  if (isBlocked(url)) {
    blockedCount++;
    e.waitUntil((async () => {
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach(c => c.postMessage({ type: 'shield-blocked', count: blockedCount }));
    })());
    e.respondWith(new Response(null, { status: 204, statusText: 'Blocked by Crate Shield' }));
  }
});
