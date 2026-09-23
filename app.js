/* Crate — your personal music collection + auto recommendations.
 * Storage: localStorage (library) + IndexedDB (uploaded audio blobs).
 * Audio: YouTube audio (official IFrame player) for collected tracks,
 *        HTMLAudio for uploads and 30s previews. No backend account needed. */
'use strict';

/* ================= Config ================= */
const API_BASE = 'https://tunebox-api.rahulgabagpt2.workers.dev';
const LS_KEY = 'crate.db.v1';
const IDB_NAME = 'crate-files';
const REC_TTL = 7 * 24 * 3600 * 1000; // refresh recommendations weekly

/* ================= Utils ================= */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtTime = s => {
  s = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(s / 60), sec = s % 60;
  return m + ':' + String(sec).padStart(2, '0');
};
const fmtDur = s => {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? h + 'h ' + m + 'm' : m + ' min';
};
const norm = s => String(s || '').toLowerCase().replace(/[\s'"`’‘“”\-_.,!?:;()[\]{}]+/g, ' ').replace(/\s+/g, ' ').trim();
const songKey = (title, artist) => norm(title) + '␟' + norm(artist);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const ytThumb = id => 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
const itunesArt = (url, px) => String(url || '').replace(/\/\d+x\d+bb(\.jpg)?$/i, '/' + px + 'x' + px + 'bb.jpg');

/* ================= Toasts ================= */
const stickyToasts = new Set();
function toast(msg, sticky) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (sticky ? ' sticky' : '');
  el.textContent = msg;
  box.appendChild(el);
  if (sticky) { stickyToasts.add(el); return () => { el.remove(); stickyToasts.delete(el); }; }
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 2600);
}
function clearStickyToasts() { stickyToasts.forEach(el => el.remove()); stickyToasts.clear(); }

/* ================= Modal ================= */
function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = '<div class="modal-veil"><div class="modal" role="dialog">' + html + '</div></div>';
  root.querySelector('.modal-veil').addEventListener('click', e => { if (e.target.classList.contains('modal-veil')) closeModal(); });
  return root.querySelector('.modal');
}
function closeModal() { $('#modal-root').innerHTML = ''; }

/* ================= IndexedDB (uploaded audio blobs) ================= */
let idb = null;
function idbOpen() {
  return new Promise((res, rej) => {
    if (idb) return res(idb);
    const rq = indexedDB.open(IDB_NAME, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('blobs');
    rq.onsuccess = () => { idb = rq.result; res(idb); };
    rq.onerror = () => rej(rq.error);
  });
}
async function idbPut(key, blob) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put(blob, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const rq = db.transaction('blobs', 'readonly').objectStore('blobs').get(key);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').delete(key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

/* ================= Store ================= */
const Store = {
  db: null,
  load() {
    try { this.db = JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch (e) { this.db = null; }
    if (!this.db) this.db = { songs: [], albums: [], recCache: null, dismissed: [], createdAt: Date.now() };
    this.db.songs = this.db.songs || []; this.db.albums = this.db.albums || [];
    this.db.dismissed = this.db.dismissed || [];
  },
  save() { try { localStorage.setItem(LS_KEY, JSON.stringify(this.db)); } catch (e) { /* quota */ } },
  addSong(s) {
    const key = songKey(s.title, s.artist);
    if (this.db.songs.some(x => songKey(x.title, x.artist) === key)) return null;
    s.id = s.id || uid(); s.addedAt = Date.now(); s.plays = 0; s.lastPlayed = 0; s.liked = false;
    this.db.songs.push(s); this.save(); return s;
  },
  removeSong(id) {
    const i = this.db.songs.findIndex(s => s.id === id);
    if (i < 0) return;
    const s = this.db.songs[i];
    if (s.src && s.src.type === 'file' && s.src.blobKey) idbDel(s.src.blobKey).catch(() => {});
    this.db.songs.splice(i, 1);
    this.db.albums.forEach(a => { a.songIds = a.songIds.filter(x => x !== id); });
    this.save();
  },
  getSong(id) { return this.db.songs.find(s => s.id === id); },
  hasSong(title, artist) {
    const key = songKey(title, artist);
    return this.db.songs.some(x => songKey(x.title, x.artist) === key);
  },
  touchPlayed(s) { s.plays = (s.plays || 0) + 1; s.lastPlayed = Date.now(); this.save(); },
};

/* ================= YouTube audio transport (hardened, ported from Tunebox) ================= */
let ytPlayer = null, ytReadyPromise = null, ytMode = false;
let ytTickTimer = null, ytStallTimer = null, ytStallArmed = false, ytAutoKicked = false;
let ytStickyDismiss = null, ytVideoId = null;

function loadYtApi() {
  return new Promise((resolve, reject) => {
    if (window.YT && YT.Player) return resolve();
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => reject(new Error('YouTube API failed to load'));
    const first = document.getElementsByTagName('script')[0];
    first.parentNode.insertBefore(tag, first);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
    setTimeout(() => reject(new Error('YouTube API timeout')), 20000);
  });
}

function ensureYtPlayer() {
  if (ytReadyPromise) return ytReadyPromise;
  ytReadyPromise = (async () => {
    await loadYtApi();
    await new Promise((resolve, reject) => {
      try {
        ytPlayer = new YT.Player('yt-slot', {
          height: '2', width: '2',
          playerVars: { autoplay: 0, controls: 0, disablekb: 1, rel: 0 },
          events: {
            onReady: () => {
              if (typeof ytPlayer.loadVideoById === 'function') resolve();
              else { ytReadyPromise = null; reject(new Error('Player not ready')); }
            },
            onError: e => { ytReadyPromise = null; reject(new Error('Player error ' + (e && e.data))); },
            onStateChange: onYtState,
          },
        });
      } catch (e) { ytReadyPromise = null; reject(e); }
    });
    return ytPlayer;
  })();
  ytReadyPromise.catch(() => { ytReadyPromise = null; });
  return ytReadyPromise;
}
// Warm up the API during idle so the first tap plays instantly.
if ('requestIdleCallback' in window) requestIdleCallback(() => loadYtApi().catch(() => {}), { timeout: 8000 });
else setTimeout(() => loadYtApi().catch(() => {}), 4000);

function onYtState(e) {
  const st = e.data;
  const playing = st === YT.PlayerState.PLAYING;
  if (ytMode) {
    Player.ytPlaying = playing;
    if (playing) disarmYtStall();
    syncPlayerUI();
  }
  if (st === YT.PlayerState.ENDED && ytMode) Player.next(true);
}

function updateYtProgress() {
  if (!ytMode || !ytPlayer || typeof ytPlayer.getDuration !== 'function') return;
  let dur = 0, pos = 0;
  try { dur = ytPlayer.getDuration() || 0; pos = ytPlayer.getCurrentTime() || 0; } catch (e) { return; }
  if (dur > 0) {
    $('#pb-dur').textContent = fmtTime(dur);
    $('#pb-seek').value = Math.round((pos / dur) * 1000);
    $('#pb-cur').textContent = fmtTime(pos);
    if (pos > 0.5) disarmYtStall();
  }
}

function armYtStall() {
  disarmYtStall();
  ytStallArmed = true; ytAutoKicked = false;
  const t0 = Date.now();
  ytStallTimer = setInterval(() => {
    if (!ytStallArmed || !ytMode) return disarmYtStall();
    let dur = 0, pos = 0, state = -2;
    try {
      dur = ytPlayer.getDuration() || 0;
      pos = ytPlayer.getCurrentTime() || 0;
      state = ytPlayer.getPlayerState();
    } catch (e) { return; }
    if (dur > 0 && pos > 0.5) return disarmYtStall(); // real progress
    const elapsed = Date.now() - t0;
    if (elapsed > 25000) { // waited out even long pre-rolls; ask for a tap
      disarmYtStall(false);
      $('#pb-play').classList.add('stalled');
      ytStickyDismiss = toast('Tap Play to start the audio.', true);
      return;
    }
    if (dur > 0 && elapsed > 9000 && !ytAutoKicked && state !== 1) {
      ytAutoKicked = true; // nudge once from within a non-gesture-safe call
      try { ytPlayer.seekTo(Math.max(0, pos), true); ytPlayer.playVideo(); } catch (e) {}
    }
  }, 1000);
}
function disarmYtStall(clearPulse = true) {
  ytStallArmed = false;
  clearInterval(ytStallTimer); ytStallTimer = null;
  if (clearPulse) {
    $('#pb-play').classList.remove('stalled');
    if (ytStickyDismiss) { ytStickyDismiss(); ytStickyDismiss = null; }
  }
}

async function playYtAudio(videoId) {
  const p = await ensureYtPlayer();
  ytVideoId = videoId; ytMode = true;
  p.loadVideoById(videoId);
  clearInterval(ytTickTimer);
  ytTickTimer = setInterval(updateYtProgress, 500);
  armYtStall();
  Player.ytPlaying = true;
  syncPlayerUI();
}
function pauseYt() { try { ytPlayer.pauseVideo(); } catch (e) {} Player.ytPlaying = false; syncPlayerUI(); }
function resumeYt() {
  disarmYtStall();
  try { ytPlayer.playVideo(); } catch (e) {}
  armYtStall();
  Player.ytPlaying = true; syncPlayerUI();
}
function stopYt() {
  ytMode = false; ytVideoId = null;
  clearInterval(ytTickTimer); ytTickTimer = null;
  disarmYtStall();
  try { ytPlayer.stopVideo(); } catch (e) {}
}
function seekYt(frac) {
  if (!ytPlayer) return;
  try {
    const d = ytPlayer.getDuration() || 0;
    if (d > 0) ytPlayer.seekTo(frac * d, true);
  } catch (e) {}
}
function setYtVolume(v) { try { ytPlayer.setVolume(Math.round(v * 100)); } catch (e) {} }
function muteYt(m) { try { m ? ytPlayer.mute() : ytPlayer.unMute(); } catch (e) {} }

/* ================= Unified player ================= */
const htmlAudio = new Audio();
htmlAudio.preload = 'auto';
let htmlMode = false; // true when htmlAudio (file/preview) is the active source
let objectUrlCache = {};

const Player = {
  queue: [], index: -1, current: null, ytPlaying: false,
  volume: 0.9, muted: false,

  async playSong(song, queue) {
    if (!song || !song.src || song.src.type === 'none') { toast('No audio linked for this track yet.'); return; }
    if (queue && queue.length) { this.queue = queue; this.index = queue.findIndex(s => s.id === song.id); }
    this.stopCurrent(true);
    this.current = song;
    $('#playerbar').classList.remove('hidden');
    $('#pb-title').textContent = song.title || 'Unknown';
    $('#pb-artist').textContent = song.artist || 'Unknown artist';
    setArt($('#pb-art'), song.art, song.title);
    $('#pb-like').classList.toggle('liked', !!song.liked);
    $('#pb-like').textContent = song.liked ? '♥' : '♡';
    $('#pb-src').textContent = song.src.type === 'yt' ? 'YouTube' : song.src.type === 'file' ? 'Local file' : 'Preview';
    $('#pb-cur').textContent = '0:00';
    $('#pb-dur').textContent = song.dur ? fmtTime(song.dur) : '0:00';
    $('#pb-seek').value = 0;
    Store.touchPlayed(song);
    try {
      if (song.src.type === 'yt') {
        htmlMode = false;
        await playYtAudio(song.src.videoId);
      } else if (song.src.type === 'file') {
        htmlMode = true;
        let url = objectUrlCache[song.src.blobKey];
        if (!url) {
          const blob = await idbGet(song.src.blobKey);
          if (!blob) { toast('Audio file not found on this device.'); return; }
          url = URL.createObjectURL(blob); objectUrlCache[song.src.blobKey] = url;
        }
        htmlAudio.src = url; htmlAudio.volume = this.muted ? 0 : this.volume;
        await htmlAudio.play();
      } else if (song.src.type === 'preview') {
        htmlMode = true;
        htmlAudio.src = song.src.url; htmlAudio.volume = this.muted ? 0 : this.volume;
        await htmlAudio.play();
      }
    } catch (e) {
      toast('Could not start playback.');
    }
    syncPlayerUI();
    if (typeof renderView === 'function') renderView(true);
  },

  stopCurrent(silent) {
    if (ytMode) stopYt();
    if (!htmlAudio.paused) htmlAudio.pause();
    htmlAudio.removeAttribute('src'); htmlAudio.load();
    htmlMode = false;
    if (!silent) { this.current = null; syncPlayerUI(); }
  },

  toggle() {
    if (!this.current) return;
    if (this.current.src.type === 'yt') {
      if (this.ytPlaying) pauseYt(); else resumeYt();
    } else {
      if (htmlAudio.paused) { disarmYtStall(); htmlAudio.play().catch(() => {}); }
      else htmlAudio.pause();
      syncPlayerUI();
    }
  },
  next(auto) {
    if (!this.queue.length) return;
    this.index = (this.index + 1) % this.queue.length;
    this.playSong(this.queue[this.index]);
  },
  prev() {
    if (!this.queue.length) return;
    this.index = (this.index - 1 + this.queue.length) % this.queue.length;
    this.playSong(this.queue[this.index]);
  },
  isPlaying() {
    if (!this.current) return false;
    if (this.current.src.type === 'yt') return this.ytPlaying;
    return !htmlAudio.paused;
  },
};

htmlAudio.addEventListener('timeupdate', () => {
  if (!htmlMode || !Player.current) return;
  const d = htmlAudio.duration || Player.current.dur || 0, pos = htmlAudio.currentTime || 0;
  if (d > 0) {
    $('#pb-dur').textContent = fmtTime(d);
    $('#pb-seek').value = Math.round((pos / d) * 1000);
  }
  $('#pb-cur').textContent = fmtTime(pos);
});
htmlAudio.addEventListener('ended', () => Player.next(true));
htmlAudio.addEventListener('play', syncPlayerUI);
htmlAudio.addEventListener('pause', syncPlayerUI);

function setArt(el, src, alt) {
  el.innerHTML = '';
  if (src) {
    const img = document.createElement('img');
    img.src = src; img.alt = alt || ''; img.loading = 'lazy';
    img.onerror = () => { el.innerHTML = '<div class="art-fallback">♪</div>'; };
    el.appendChild(img);
  } else {
    el.innerHTML = '<div class="art-fallback">♪</div>';
  }
}

function syncPlayerUI() {
  const playing = Player.isPlaying();
  const btn = $('#pb-play');
  btn.textContent = playing ? '⏸' : '▶';
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  btn.title = playing ? 'Pause' : 'Play';
  $$('.song-row').forEach(r => r.classList.toggle('playing', !!(Player.current && r.dataset.id === Player.current.id)));
}

/* ================= External APIs ================= */
async function apiSearchYouTube(q) {
  const r = await fetch(API_BASE + '/api/yt/search?q=' + encodeURIComponent(q));
  if (!r.ok) throw new Error('Search failed');
  const j = await r.json();
  return j.items || j.results || j || [];
}
async function apiTrending() {
  const r = await fetch(API_BASE + '/api/yt/trending');
  if (!r.ok) throw new Error('Trending failed');
  const j = await r.json();
  return j.items || j.results || j || [];
}
async function apiRelated(song) {
  const r = await fetch(API_BASE + '/api/yt/related?' + new URLSearchParams({
    videoId: song.src.videoId, title: song.title || '', artist: song.artist || '',
  }));
  if (!r.ok) throw new Error('Related failed');
  const j = await r.json();
  return j.items || j.results || j || [];
}
async function itunesSearch(term, entity, limit) {
  const r = await fetch('https://itunes.apple.com/search?' + new URLSearchParams({
    term, entity, limit: String(limit || 8), media: 'music', country: 'US',
  }));
  if (!r.ok) throw new Error('iTunes lookup failed');
  const j = await r.json();
  return j.results || [];
}
async function itunesLookup(id, entity) {
  const r = await fetch('https://itunes.apple.com/lookup?' + new URLSearchParams({ id: String(id), entity: entity || 'song' }));
  if (!r.ok) throw new Error('iTunes lookup failed');
  const j = await r.json();
  return j.results || [];
}
// MusicBrainz: free, no key. Respect 1 req/sec with a tiny throttle queue.
let mbLast = 0;
async function mbFetch(url) {
  const wait = Math.max(0, 1150 - (Date.now() - mbLast));
  if (wait) await sleep(wait);
  mbLast = Date.now();
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('MusicBrainz ' + r.status);
  return r.json();
}
async function mbArtist(name) {
  const j = await mbFetch('https://musicbrainz.org/ws/2/artist/?' + new URLSearchParams({
    query: 'artist:' + name, fmt: 'json', limit: '1',
  }));
  const a = (j.artists || [])[0];
  if (!a) return null;
  const full = await mbFetch('https://musicbrainz.org/ws/2/artist/' + a.id + '?' + new URLSearchParams({ fmt: 'json', inc: 'tags+artist-rels' }));
  return {
    mbid: a.id, name: a.name,
    tags: (full.tags || []).map(t => t.name),
    relations: (full.relations || []).map(r => r.artist && r.artist.name).filter(Boolean),
  };
}
async function mbArtistsByTag(tag, limit) {
  const j = await mbFetch('https://musicbrainz.org/ws/2/artist/?' + new URLSearchParams({
    query: 'tag:' + tag, fmt: 'json', limit: String(limit || 10),
  }));
  return (j.artists || []).map(a => a.name);
}
// Resolve a title+artist to a YouTube video id for full-length free playback.
async function resolveYouTube(title, artist) {
  const q = (title + ' ' + artist + ' official audio').trim();
  const items = await apiSearchYouTube(q);
  const best = items[0];
  return best ? { videoId: best.id, thumb: best.thumb || ytThumb(best.id), dur: best.dur || 0 } : null;
}

/* ================= Auto recommendations ================= */
const Recs = {
  refreshPromise: null,
  seedArtists() {
    const byArtist = {};
    Store.db.songs.forEach(s => {
      const a = (s.artist || 'Unknown artist').trim();
      if (!byArtist[a]) byArtist[a] = { name: a, score: 0 };
      byArtist[a].score += (s.plays || 0) * 3 + (s.liked ? 4 : 0) + 1;
      if (Date.now() - (s.lastPlayed || 0) < 30 * 864e5) byArtist[a].score += 2;
    });
    return Object.values(byArtist).sort((a, b) => b.score - a.score).slice(0, 5).map(x => x.name);
  },
  get(force) {
    const c = Store.db.recCache;
    if (!force && c && c.items && Date.now() - c.ts < REC_TTL) return Promise.resolve(c);
    return this.refresh();
  },
  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const items = await this.build();
        Store.db.recCache = { ts: Date.now(), items };
        Store.save();
        return Store.db.recCache;
      } finally { this.refreshPromise = null; }
    })();
    return this.refreshPromise;
  },
  collectedKeys() {
    const set = new Set(Store.db.songs.map(s => songKey(s.title, s.artist)));
    (Store.db.dismissed || []).forEach(k => set.add(k));
    return set;
  },
  async build() {
    const seeds = this.seedArtists();
    if (Store.db.songs.length < 3 || !seeds.length) return { needsSeeds: true, list: [] };
    const skip = this.collectedKeys();
    const out = [], seen = new Set();
    const push = r => {
      r.key = songKey(r.title, r.artist);
      if (skip.has(r.key) || seen.has(r.key)) return;
      seen.add(r.key); out.push(r);
    };
    // 1) Similar artists: collaborators/relations first (works even without tags), then shared tags
    const similarPool = [];
    for (const seed of seeds.slice(0, 4)) {
      try {
        const info = await mbArtist(seed);
        if (!info) continue;
        (info.relations || []).forEach(n => {
          if (norm(n) !== norm(seed) && !similarPool.some(x => norm(x.name) === norm(n)))
            similarPool.push({ name: n, via: seed });
        });
        const tag = info.tags && info.tags[0];
        if (tag) {
          const names = await mbArtistsByTag(tag, 8);
          names.forEach(n => {
            if (norm(n) !== norm(seed) && !similarPool.some(x => norm(x.name) === norm(n)))
              similarPool.push({ name: n, via: seed });
          });
        }
      } catch (e) { /* offline or rate-limited: skip */ }
      if (similarPool.length >= 10) break;
    }
    for (const s of similarPool.slice(0, 8)) {
      try {
        const tracks = await itunesSearch(s.name, 'song', 3);
        tracks.filter(t => t.wrapperType === 'track').forEach(t => push({
          title: t.trackName, artist: t.artistName, album: t.collectionName,
          art: itunesArt(t.artworkUrl100, 300), previewUrl: t.previewUrl,
          reason: 'Because you listen to ' + s.via, kind: 'similar',
        }));
      } catch (e) {}
      if (out.length >= 18) break;
    }
    // 1b) Related videos from your most-played tracks (YouTube's own recommendation graph)
    const played = [...Store.db.songs]
      .filter(s => s.src && s.src.type === 'yt' && (s.plays || 0) > 0)
      .sort((a, b) => (b.plays || 0) - (a.plays || 0))
      .slice(0, 3);
    for (const seed of played) {
      try {
        const rel = await apiRelated(seed);
        rel.slice(0, 4).forEach(v => push({
          title: v.title, artist: v.channel, album: '',
          art: v.thumb || ytThumb(v.id), previewUrl: '',
          reason: 'Related to ' + seed.title, kind: 'similar', videoId: v.id,
        }));
      } catch (e) { /* endpoint unavailable: skip */ }
      if (out.length >= 20) break;
    }
    // 2) New releases from your top artists
    for (const seed of seeds.slice(0, 3)) {
      try {
        const albums = await itunesSearch(seed, 'album', 8);
        const sorted = albums.filter(a => a.wrapperType === 'collection')
          .sort((a, b) => new Date(b.releaseDate) - new Date(a.releaseDate));
        const newest = sorted[0];
        if (!newest) continue;
        if (Store.db.songs.some(s => norm(s.album) && norm(s.album) === norm(newest.collectionName))) continue;
        const tracks = await itunesLookup(newest.collectionId, 'song');
        tracks.filter(t => t.wrapperType === 'track').slice(0, 2).forEach(t => push({
          title: t.trackName, artist: t.artistName, album: t.collectionName,
          art: itunesArt(t.artworkUrl100, 300), previewUrl: t.previewUrl,
          reason: 'New from ' + seed, kind: 'new',
        }));
      } catch (e) {}
      if (out.length >= 24) break;
    }
    return { needsSeeds: false, list: out.slice(0, 24) };
  },
  dismiss(key) {
    Store.db.dismissed.push(key);
    if (Store.db.recCache) Store.db.recCache.items.list = Store.db.recCache.items.list.filter(r => r.key !== key);
    Store.save();
  },
};

/* ================= Navigation & shared components ================= */
let currentView = 'home', viewParams = {};
const CRUMBS = { home: 'Home', collection: 'Collection', albums: 'Albums', artists: 'Artists', foryou: 'For You', add: 'Add Music', album: 'Album', artist: 'Artist' };

function nav(view, params) {
  currentView = view; viewParams = params || {};
  $$('#nav .nav-item, #mobile-nav .mnav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#crumb').textContent = CRUMBS[view] || view;
  $('#sidebar').classList.remove('open');
  renderView();
  $('#view').scrollTop = 0;
}
function rerender() { renderView(true); }
function renderView(keepScroll) {
  const v = $('#view');
  const st = keepScroll ? v.scrollTop : 0;
  ({ home: renderHome, collection: renderCollection, albums: renderAlbums, artists: renderArtists,
     foryou: renderForYou, add: renderAdd, album: renderAlbumDetail, artist: renderArtistDetail,
  }[currentView] || renderHome)();
  v.scrollTop = st;
}

function collageHTML(songs) {
  const arts = [...new Set(songs.map(s => s.art).filter(Boolean))].slice(0, 4);
  if (!arts.length) return '<div class="art-fallback">♪</div>';
  if (arts.length < 4) return '<img src="' + esc(arts[0]) + '" loading="lazy" alt="" onerror="this.outerHTML=\'<div class=art-fallback>♪</div>\'">';
  return '<div class="collage">' + arts.map(a => '<img src="' + esc(a) + '" loading="lazy" alt="" onerror="this.remove()">').join('') + '</div>';
}
function artImg(s, cls) {
  return s.art
    ? '<img src="' + esc(s.art) + '" loading="lazy" alt="" onerror="this.outerHTML=\'<div class=art-fallback>♪</div>\'">'
    : '<div class="art-fallback">♪</div>';
}
function songRow(s, opts) {
  opts = opts || {};
  const playable = s.src && s.src.type !== 'none';
  return '<div class="song-row' + (Player.current && Player.current.id === s.id ? ' playing' : '') + '" data-id="' + s.id + '">'
    + '<div class="s-art">' + artImg(s) + '</div>'
    + '<div class="s-main"><div class="s-title">' + esc(s.title) + '</div>'
    + '<div class="s-sub">' + esc(s.artist || 'Unknown artist') + (s.album ? ' · ' + esc(s.album) : '') + '</div></div>'
    + '<span class="s-plays">' + (s.plays ? esc(s.plays) + ' plays' : '') + '</span>'
    + '<span class="s-dur">' + (s.dur ? fmtTime(s.dur) : '') + '</span>'
    + (playable ? '<button class="icon-btn row-play" data-act="play" title="Play">▶</button>' : '<button class="icon-btn row-play" data-act="find" title="Find audio">🔍</button>')
    + '<button class="icon-btn' + (s.liked ? ' liked' : '') + '" data-act="like" title="Like">' + (s.liked ? '♥' : '♡') + '</button>'
    + '<button class="icon-btn" data-act="menu" title="More">⋯</button>'
    + '</div>';
}
function sectionHead(title, linkText, linkView) {
  return '<div class="sec-head"><h2>' + esc(title) + '</h2>'
    + (linkText ? '<button class="link-btn" data-nav="' + linkView + '">' + esc(linkText) + ' →</button>' : '') + '</div>';
}

/* ---- Global click delegation ---- */
document.addEventListener('click', e => {
  const navBtn = e.target.closest('[data-nav]');
  if (navBtn) { nav(navBtn.dataset.nav); return; }
  const navItem = e.target.closest('#nav .nav-item, #mobile-nav .mnav-item');
  if (navItem) { nav(navItem.dataset.view); return; }
  const card = e.target.closest('[data-album-open]');
  if (card && !e.target.closest('button')) { nav('album', { id: card.dataset.albumOpen }); return; }
  const acard = e.target.closest('[data-artist-open]');
  if (acard && !e.target.closest('button')) { nav('artist', { name: acard.dataset.artistOpen }); return; }

  const actBtn = e.target.closest('[data-act]');
  if (actBtn) {
    const row = actBtn.closest('.song-row');
    const s = row && Store.getSong(row.dataset.id);
    const act = actBtn.dataset.act;
    if (act === 'play' && s) { playFromList(s); return; }
    if (act === 'find' && s) { findAudioFor(s); return; }
    if (act === 'like' && s) {
      s.liked = !s.liked; Store.save(); syncPlayerUI(); rerender();
      if (Player.current && Player.current.id === s.id) { $('#pb-like').textContent = s.liked ? '♥' : '♡'; $('#pb-like').classList.toggle('liked', s.liked); }
      return;
    }
    if (act === 'menu' && s) { songMenu(s); return; }
  }
  const addBtn = e.target.closest('[data-add-rec]');
  if (addBtn) { addRec(addBtn.dataset.addRec, addBtn); return; }
  const disBtn = e.target.closest('[data-dismiss-rec]');
  if (disBtn) { Recs.dismiss(disBtn.dataset.dismissRec); rerender(); toast('Removed from recommendations.'); return; }
  const pvBtn = e.target.closest('[data-preview]');
  if (pvBtn) { previewToggle(pvBtn.dataset.preview, pvBtn); return; }
});
function playFromList(song) {
  const rows = $$('#view .song-row').map(r => Store.getSong(r.dataset.id)).filter(Boolean);
  Player.playSong(song, rows.length ? rows : Store.db.songs);
}
async function findAudioFor(s) {
  toast('Searching for audio…');
  try {
    const hit = await resolveYouTube(s.title, s.artist);
    if (!hit) { toast('No match found yet — try again later.'); return; }
    s.src = { type: 'yt', videoId: hit.videoId };
    s.art = s.art || hit.thumb; s.dur = s.dur || hit.dur;
    Store.save(); rerender(); toast('Audio linked — ready to play.');
  } catch (e) { toast('Search failed. Check your connection.'); }
}
function songMenu(s) {
  const albums = Store.db.albums;
  const m = openModal('<h2>' + esc(s.title) + '</h2><div class="msub">' + esc(s.artist || '') + '</div>'
    + '<div class="msub">Add to album:</div>'
    + '<div class="check-list">' + (albums.length ? albums.map(a =>
      '<div class="check-item" data-album-add="' + a.id + '"><span>▦</span><span>' + esc(a.name) + '</span></div>').join('')
      : '<div class="check-item"><span>No albums yet — create one from the Albums tab.</span></div>') + '</div>'
    + '<div class="modal-actions"><button class="btn ghost small" data-close>Cancel</button>'
    + '<button class="btn small" data-newalbum>＋ New album</button>'
    + '<button class="btn ghost small" data-remove style="color:var(--danger)">Remove</button></div>');
  m.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) closeModal();
    const aa = e.target.closest('[data-album-add]');
    if (aa) {
      const a = Store.db.albums.find(x => x.id === aa.dataset.albumAdd);
      if (a && !a.songIds.includes(s.id)) { a.songIds.push(s.id); Store.save(); toast('Added to ' + a.name); }
      closeModal();
    }
    if (e.target.closest('[data-newalbum]')) { closeModal(); albumCreateModal(s.id); }
    if (e.target.closest('[data-remove]')) {
      if (confirm('Remove "' + s.title + '" from your collection?')) { Store.removeSong(s.id); closeModal(); rerender(); toast('Removed.'); }
    }
  });
}

/* ---- 30s preview player for recommendation cards ---- */
const previewAudio = new Audio();
let previewBtn = null;
function previewToggle(url, btn) {
  if (previewBtn === btn && !previewAudio.paused) { previewAudio.pause(); btn.textContent = '▶ Preview'; previewBtn = null; return; }
  if (previewBtn) previewBtn.textContent = '▶ Preview';
  previewAudio.src = url; previewAudio.play().catch(() => {});
  btn.textContent = '⏸ Playing'; previewBtn = btn;
}
previewAudio.addEventListener('ended', () => { if (previewBtn) { previewBtn.textContent = '▶ Preview'; previewBtn = null; } });

/* ================= HOME ================= */
function renderHome() {
  const songs = Store.db.songs;
  const artists = new Set(songs.map(s => norm(s.artist || 'unknown')));
  const totalSecs = songs.reduce((a, s) => a + (s.dur || 0), 0);
  const last = [...songs].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))[0];
  const recent = [...songs].sort((a, b) => b.addedAt - a.addedAt).slice(0, 5);
  const top = [...songs].sort((a, b) => (b.plays || 0) - (a.plays || 0)).slice(0, 5);
  const v = $('#view');

  if (!songs.length) {
    v.innerHTML = '<div class="hero"><h1>Build your crate 🎵</h1>'
      + '<p>Collect every song you love in one place — search YouTube, pull from iTunes, or upload your own files. Then Crate learns your taste and recommends what to add next.</p>'
      + '<button class="btn" data-nav="add">＋ Add your first songs</button></div>'
      + '<div class="empty"><h3>Your collection is empty</h3><p>Add at least 3 songs and the <b>For You</b> tab will start suggesting new music automatically.</p></div>';
    return;
  }
  let html = '<div class="hero"><h1>Your crate 🎵</h1><p>' + songs.length + ' songs · ' + artists.size
    + ' artists · ' + fmtDur(totalSecs) + ' of music. Crate watches your taste and suggests what to add next.</p>'
    + '<button class="btn" data-nav="add">＋ Add music</button> '
    + '<button class="btn ghost" data-nav="foryou" style="margin-left:8px">✦ See recommendations</button></div>';
  html += '<div class="stats-row">'
    + stat(songs.length, 'Songs') + stat(artists.size, 'Artists')
    + stat(Store.db.albums.length, 'Albums') + stat(fmtDur(totalSecs), 'Listening time') + '</div>';
  if (last && last.lastPlayed) {
    html += sectionHead('Continue listening', 'Collection', 'collection')
      + songRow(last);
  }
  if (recent.length) html += sectionHead('Recently added', 'Collection', 'collection') + recent.map(s => songRow(s)).join('');
  if (top.some(s => s.plays)) html += sectionHead('Most played') + top.filter(s => s.plays).map(s => songRow(s)).join('');
  html += '<div id="home-recs">' + sectionHead('Recommended for you', 'For You', 'foryou')
    + '<div class="skel"></div></div>';
  v.innerHTML = html;
  Recs.get().then(c => {
    const box = $('#home-recs'); if (!box) return;
    const list = (c.items && c.items.list) || [];
    box.innerHTML = sectionHead('Recommended for you', 'For You', 'foryou')
      + (list.length ? '<div class="grid-cards">' + list.slice(0, 4).map(recCard).join('') + '</div>'
        : '<div class="empty"><h3>Nothing yet</h3><p>Keep adding songs you love — recommendations appear automatically.</p></div>');
  }).catch(() => { const box = $('#home-recs'); if (box) box.innerHTML = ''; });
  function stat(n, l) { return '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>'; }
}

function recCard(r) {
  return '<div class="card"><div class="art">' + (r.art ? '<img src="' + esc(r.art) + '" loading="lazy" alt="">' : '<div class="art-fallback">♪</div>') + '</div>'
    + '<h3>' + esc(r.title) + '</h3><p>' + esc(r.artist) + '</p>'
    + '<div class="reason">✦ ' + esc(r.reason) + '</div>'
    + '<div class="card-actions">'
    + (r.previewUrl ? '<button class="mini-btn" data-preview="' + esc(r.previewUrl) + '">▶ Preview</button>' : '')
    + '<button class="mini-btn primary" data-add-rec="' + esc(r.key) + '">＋ Add</button>'
    + '<button class="mini-btn" data-dismiss-rec="' + esc(r.key) + '" title="Not interested">✕</button>'
    + '</div></div>';
}
const recIndex = {};
function indexRecs(list) { list.forEach(r => { recIndex[r.key] = r; }); }
async function addRec(key, btn) {
  const r = recIndex[key];
  if (!r) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    let src = null, art = r.art || '', dur = 0;
    if (r.videoId) { src = { type: 'yt', videoId: r.videoId }; }
    else {
      const hit = await resolveYouTube(r.title, r.artist).catch(() => null);
      if (hit) { src = { type: 'yt', videoId: hit.videoId }; art = art || hit.thumb; dur = hit.dur || 0; }
      else if (r.previewUrl) src = { type: 'preview', url: r.previewUrl };
      else src = { type: 'none' };
    }
    const added = Store.addSong({ title: r.title, artist: r.artist, album: r.album || '', art, dur, src });
    if (!added) { toast('Already in your collection.'); }
    else {
      toast(src.type === 'none' ? 'Saved to wishlist — tap 🔍 to find audio later.' : 'Added to your collection ✓');
      Recs.dismiss(key);
    }
    rerender();
  } catch (e) { toast('Could not add — check connection.'); btn.disabled = false; btn.textContent = '＋ Add'; }
}

/* ================= COLLECTION ================= */
let colQuery = '', colSort = 'recent';
function renderCollection() {
  const v = $('#view');
  let songs = [...Store.db.songs];
  if (colQuery) {
    const q = norm(colQuery);
    songs = songs.filter(s => norm(s.title + ' ' + s.artist + ' ' + (s.album || '')).includes(q));
  }
  const sorts = {
    recent: (a, b) => b.addedAt - a.addedAt,
    title: (a, b) => norm(a.title).localeCompare(norm(b.title)),
    artist: (a, b) => norm(a.artist).localeCompare(norm(b.artist)),
    played: (a, b) => (b.plays || 0) - (a.plays || 0),
    liked: (a, b) => (b.liked - a.liked) || (b.plays - a.plays),
  };
  songs.sort(sorts[colSort] || sorts.recent);
  v.innerHTML = '<div class="toolbar"><input type="search" id="col-q" placeholder="Filter songs, artists, albums…" value="' + esc(colQuery) + '">'
    + '<select id="col-sort">'
    + [['recent', 'Recently added'], ['title', 'Title A–Z'], ['artist', 'Artist A–Z'], ['played', 'Most played'], ['liked', 'Liked first']]
      .map(o => '<option value="' + o[0] + '"' + (colSort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('')
    + '</select></div>'
    + (songs.length ? songs.map(s => songRow(s)).join('')
      : '<div class="empty"><h3>No songs found</h3><p>' + (Store.db.songs.length ? 'Try a different search.' : 'Your collection is empty — add some music to get started.') + '</p>'
      + (Store.db.songs.length ? '' : '<button class="btn" data-nav="add">＋ Add music</button>') + '</div>');
  $('#col-q').addEventListener('input', debounce(e => { colQuery = e.target.value; renderView(true); const q = $('#col-q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 300));
  $('#col-sort').addEventListener('change', e => { colSort = e.target.value; renderView(true); });
}

/* ================= ALBUMS ================= */
function smartAlbums() {
  const groups = {};
  Store.db.songs.forEach(s => {
    if (!s.album) return;
    const k = norm(s.album) + '␟' + norm(s.artist);
    if (!groups[k]) groups[k] = { name: s.album, artist: s.artist, songs: [] };
    groups[k].songs.push(s);
  });
  return Object.values(groups).sort((a, b) => b.songs.length - a.songs.length);
}
function albumCard(a, smart) {
  const songs = smart ? a.songs : a.songIds.map(id => Store.getSong(id)).filter(Boolean);
  return '<div class="card" data-album-open="' + (smart ? 'smart:' + esc(a.name) : a.id) + '">'
    + '<div class="art">' + collageHTML(songs) + '</div>'
    + '<h3>' + esc(a.name) + '</h3><p>' + esc(a.artist || (smart ? '' : songs.length + ' songs')) + (smart ? '' : ' · ' + songs.length + ' songs') + '</p></div>';
}
function renderAlbums() {
  const v = $('#view');
  const customs = Store.db.albums, smarts = smartAlbums();
  v.innerHTML = '<div class="toolbar"><button class="btn small" id="new-album-btn">＋ New album</button></div>'
    + (customs.length ? sectionHead('Your albums') + '<div class="grid-cards">' + customs.map(a => albumCard(a)).join('') + '</div>' : '')
    + (smarts.length ? sectionHead('From your library') + '<div class="grid-cards">' + smarts.map(a => albumCard(a, true)).join('') + '</div>' : '')
    + (!customs.length && !smarts.length ? '<div class="empty"><h3>No albums yet</h3><p>Create albums to group your songs — posters are generated automatically from artwork.</p><button class="btn" id="new-album-btn2">＋ New album</button></div>' : '');
  const go = () => albumCreateModal();
  const b1 = $('#new-album-btn'); if (b1) b1.onclick = go;
  const b2 = $('#new-album-btn2'); if (b2) b2.onclick = go;
}
function albumCreateModal(preselectId) {
  const songs = [...Store.db.songs].sort((a, b) => norm(a.title).localeCompare(norm(b.title)));
  const m = openModal('<h2>New album</h2><div class="msub">Group songs under one cover. The poster builds itself from artwork.</div>'
    + '<label style="font-size:13px;font-weight:600;color:var(--mut)">Album name</label>'
    + '<input type="text" id="al-name" placeholder="e.g. Late night drives" style="width:100%;background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:11px 14px;outline:none;margin-top:6px">'
    + '<div class="msub" style="margin-top:14px">Pick songs:</div><div class="check-list">'
    + songs.map(s => '<label class="check-item"><input type="checkbox" value="' + s.id + '"' + (preselectId === s.id ? ' checked' : '') + '>'
      + '<div class="s-art" style="width:38px;height:38px;border-radius:6px;overflow:hidden;flex:0 0 38px">' + artImg(s) + '</div>'
      + '<span><b>' + esc(s.title) + '</b><br><small style="color:var(--mut)">' + esc(s.artist || '') + '</small></span></label>').join('')
    + '</div><div class="modal-actions"><button class="btn ghost small" data-close>Cancel</button><button class="btn small" data-create>Create album</button></div>');
  m.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) closeModal();
    if (e.target.closest('[data-create]')) {
      const name = $('#al-name').value.trim();
      if (!name) { toast('Give the album a name.'); return; }
      const ids = $$('.check-item input:checked').map(c => c.value);
      const artists = [...new Set(ids.map(id => { const s = Store.getSong(id); return s && s.artist; }).filter(Boolean))];
      Store.db.albums.push({ id: uid(), name, artist: artists.slice(0, 2).join(', '), songIds: ids, createdAt: Date.now() });
      Store.save(); closeModal(); toast('Album created ✓'); nav('albums');
    }
  });
}
function getAlbum(id) {
  if (id.startsWith('smart:')) {
    const name = id.slice(6);
    return smartAlbums().find(a => a.name === name) || null;
  }
  return Store.db.albums.find(a => a.id === id) || null;
}
function renderAlbumDetail() {
  const v = $('#view');
  const a = getAlbum(viewParams.id);
  if (!a) { v.innerHTML = '<div class="empty"><h3>Album not found</h3></div>'; return; }
  const smart = viewParams.id.startsWith('smart:');
  const songs = smart ? a.songs : a.songIds.map(id => Store.getSong(id)).filter(Boolean);
  const dur = songs.reduce((x, s) => x + (s.dur || 0), 0);
  v.innerHTML = '<button class="back-btn" data-nav="albums">← Albums</button>'
    + '<div class="detail-head"><div class="detail-art">' + collageHTML(songs) + '</div>'
    + '<div><h1>' + esc(a.name) + '</h1><div class="dsub">' + esc(a.artist || '') + ' · ' + songs.length + ' songs' + (dur ? ' · ' + fmtDur(dur) : '') + '</div>'
    + '<button class="btn small" id="alb-play">▶ Play all</button> '
    + (smart ? '' : '<button class="btn ghost small" id="alb-del">Delete</button>') + '</div></div>'
    + (songs.length ? songs.map(s => songRow(s)).join('') : '<div class="empty"><h3>No songs in this album</h3></div>');
  $('#alb-play').onclick = () => { if (songs.length) Player.playSong(songs[0], songs); };
  const del = $('#alb-del');
  if (del) del.onclick = () => {
    if (confirm('Delete album "' + a.name + '"? (Songs stay in your collection.)')) {
      Store.db.albums = Store.db.albums.filter(x => x.id !== a.id);
      Store.save(); nav('albums');
    }
  };
}

/* ================= ARTISTS ================= */
function artistGroups() {
  const g = {};
  Store.db.songs.forEach(s => {
    const name = (s.artist || 'Unknown artist').trim();
    const k = norm(name);
    if (!g[k]) g[k] = { name, songs: [] };
    g[k].songs.push(s);
  });
  return Object.values(g).sort((a, b) => b.songs.length - a.songs.length);
}
function renderArtists() {
  const v = $('#view');
  const groups = artistGroups();
  v.innerHTML = groups.length
    ? '<div class="grid-cards">' + groups.map(g =>
      '<div class="card" data-artist-open="' + esc(g.name) + '"><div class="art">' + collageHTML(g.songs) + '</div>'
      + '<h3>' + esc(g.name) + '</h3><p>' + g.songs.length + ' song' + (g.songs.length > 1 ? 's' : '') + '</p></div>').join('') + '</div>'
    : '<div class="empty"><h3>No artists yet</h3><p>Add songs and your artists will line up here.</p><button class="btn" data-nav="add">＋ Add music</button></div>';
}
function renderArtistDetail() {
  const v = $('#view');
  const g = artistGroups().find(x => norm(x.name) === norm(viewParams.name));
  if (!g) { v.innerHTML = '<div class="empty"><h3>Artist not found</h3></div>'; return; }
  const dur = g.songs.reduce((x, s) => x + (s.dur || 0), 0);
  v.innerHTML = '<button class="back-btn" data-nav="artists">← Artists</button>'
    + '<div class="detail-head"><div class="detail-art">' + collageHTML(g.songs) + '</div>'
    + '<div><h1>' + esc(g.name) + '</h1><div class="dsub">' + g.songs.length + ' songs' + (dur ? ' · ' + fmtDur(dur) : '') + '</div>'
    + '<button class="btn small" id="art-play">▶ Play all</button></div></div>'
    + g.songs.map(s => songRow(s)).join('');
  $('#art-play').onclick = () => Player.playSong(g.songs[0], g.songs);
}

/* ================= FOR YOU ================= */
function renderForYou() {
  const v = $('#view');
  v.innerHTML = '<div class="toolbar"><span style="color:var(--mut);font-size:13.5px">✦ Generated automatically from your taste — refreshes weekly, or anytime.</span>'
    + '<button class="btn ghost small" id="rec-refresh" style="margin-left:auto">↻ Refresh now</button></div>'
    + '<div id="rec-list"><div class="grid-cards"><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div></div>';
  const paint = c => {
    const box = $('#rec-list'); if (!box) return;
    const data = c.items || {};
    if (data.needsSeeds || !(data.list || []).length) {
      box.innerHTML = '<div class="empty"><h3>Not enough to go on yet</h3>'
        + '<p>Add at least <b>3 songs</b> you love and Crate will dig up similar artists, new releases from your favourites, and hidden gems — all free, all addable in one tap.</p>'
        + '<button class="btn" data-nav="add">＋ Add songs</button></div>';
      return;
    }
    indexRecs(data.list);
    const sim = data.list.filter(r => r.kind === 'similar'), nw = data.list.filter(r => r.kind === 'new');
    box.innerHTML =
      (sim.length ? sectionHead('Because of your taste') + '<div class="grid-cards">' + sim.map(recCard).join('') + '</div>' : '')
      + (nw.length ? sectionHead('New from artists you collect') + '<div class="grid-cards">' + nw.map(recCard).join('') + '</div>' : '')
      + '<p style="color:var(--dim);font-size:12px;margin-top:22px">Sources: community music data (MusicBrainz), the iTunes catalogue and YouTube. Previews are 30 seconds; adding a track links full-length audio automatically.</p>';
  };
  Recs.get().then(paint).catch(() => { const box = $('#rec-list'); if (box) box.innerHTML = '<div class="empty"><h3>Could not load recommendations</h3><p>Check your connection and try again.</p></div>'; });
  $('#rec-refresh').onclick = async e => {
    e.target.disabled = true; e.target.textContent = 'Working…';
    try { paint(await Recs.refresh()); toast('Recommendations refreshed ✦'); }
    catch (err) { toast('Refresh failed — try again.'); }
    e.target.disabled = false; e.target.textContent = '↻ Refresh now';
  };
}

/* ================= ADD MUSIC ================= */
let addTab = 'youtube';
const addState = { youtube: { q: '', results: [] }, itunes: { q: '', results: [] } };
function renderAdd() {
  const v = $('#view');
  v.innerHTML = '<div class="tabs">'
    + [['youtube', 'YouTube'], ['itunes', 'iTunes'], ['upload', 'Upload'], ['manual', 'Manual']]
      .map(t => '<button class="tab' + (addTab === t[0] ? ' active' : '') + '" data-atab="' + t[0] + '">' + t[1] + '</button>').join('')
    + '</div><div id="add-body"></div>';
  $$('#view [data-atab]').forEach(b => b.onclick = () => { addTab = b.dataset.atab; renderView(true); });
  ({ youtube: addYouTube, itunes: addItunes, upload: addUpload, manual: addManual })[addTab]();
}
function addResultRow(r, kind) {
  const title = r.title || r.trackName, artist = r.artist || r.artistName || r.channel;
  const art = r.thumb || (r.artworkUrl100 ? itunesArt(r.artworkUrl100, 200) : '');
  const key = songKey(title, artist);
  const inLib = Store.hasSong(title, artist);
  return '<div class="search-result"><div style="width:64px;height:64px;border-radius:8px;overflow:hidden;flex:0 0 64px;background:var(--card2)">'
    + (art ? '<img src="' + esc(art) + '" loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover">' : '<div class="art-fallback">♪</div>') + '</div>'
    + '<div class="sr-main"><div class="sr-title">' + esc(title) + '</div><div class="sr-sub">' + esc(artist || '') + '</div></div>'
    + '<span class="sr-dur">' + (r.dur ? fmtTime(r.dur) : r.trackTimeMillis ? fmtTime(r.trackTimeMillis / 1000) : '') + '</span>'
    + (kind === 'itunes' && r.previewUrl ? '<button class="mini-btn" data-preview="' + esc(r.previewUrl) + '">▶</button>' : '')
    + '<button class="mini-btn ' + (inLib ? 'added' : 'primary') + '" data-add-result=\'' + esc(JSON.stringify({ kind, r })) + '\''
    + (inLib ? ' disabled' : '') + '>' + (inLib ? '✓ Added' : '＋ Add') + '</button></div>';
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-add-result]');
  if (b && !b.disabled) addSearchResult(JSON.parse(b.dataset.addResult), b);
});
async function addSearchResult(payload, btn) {
  btn.disabled = true; btn.textContent = '…';
  try {
    if (payload.kind === 'youtube') {
      const r = payload.r;
      const title = r.title, artist = r.channel || '';
      const added = Store.addSong({ title, artist, art: r.thumb || ytThumb(r.id), dur: r.dur || 0, src: { type: 'yt', videoId: r.id } });
      toast(added ? 'Added ✓' : 'Already in your collection.');
    } else {
      const t = payload.r;
      const title = t.trackName, artist = t.artistName;
      let src = null, art = itunesArt(t.artworkUrl100, 300), dur = Math.round((t.trackTimeMillis || 0) / 1000);
      const hit = await resolveYouTube(title, artist).catch(() => null);
      if (hit) { src = { type: 'yt', videoId: hit.videoId }; art = art || hit.thumb; dur = dur || hit.dur; }
      else if (t.previewUrl) src = { type: 'preview', url: t.previewUrl };
      else src = { type: 'none' };
      const added = Store.addSong({ title, artist, album: t.collectionName || '', art, dur, src });
      toast(added ? (src.type === 'none' ? 'Saved — tap 🔍 on it later to find audio.' : 'Added ✓') : 'Already in your collection.');
    }
    Store.db.recCache = null; Store.save(); // taste changed -> recs rebuild next visit
    renderView(true);
  } catch (err) { toast('Could not add — check connection.'); btn.disabled = false; btn.textContent = '＋ Add'; }
}
function addYouTube() {
  const body = $('#add-body');
  const st = addState.youtube;
  body.innerHTML = '<div class="toolbar"><input type="search" id="yt-q" placeholder="Search songs, artists…" value="' + esc(st.q) + '"></div><div id="yt-res"></div>';
  const paint = () => {
    $('#yt-res').innerHTML = st.results.length ? st.results.map(r => addResultRow(r, 'youtube')).join('')
      : (st.q ? '<div class="empty"><h3>No results</h3></div>' : '');
  };
  paint();
  const run = debounce(async () => {
    const q = $('#yt-q').value.trim();
    st.q = q;
    if (q.length < 2) { st.results = []; $('#yt-res').innerHTML = ''; return; }
    $('#yt-res').innerHTML = '<div class="spin"></div>';
    try {
      st.results = await apiSearchYouTube(q);
      paint();
    } catch (e) { $('#yt-res').innerHTML = '<div class="empty"><h3>Search failed</h3><p>Check your connection.</p></div>'; }
  }, 450);
  $('#yt-q').addEventListener('input', run);
}
function addItunes() {
  const body = $('#add-body');
  const st = addState.itunes;
  body.innerHTML = '<div class="toolbar"><input type="search" id="it-q" placeholder="Search the iTunes catalogue…" value="' + esc(st.q) + '"></div>'
    + '<p style="color:var(--dim);font-size:12.5px">Previews are 30 seconds — adding links the full-length track automatically.</p><div id="it-res"></div>';
  const paint = () => {
    $('#it-res').innerHTML = st.results.length ? st.results.map(t => addResultRow(t, 'itunes')).join('')
      : (st.q ? '<div class="empty"><h3>No results</h3></div>' : '');
  };
  paint();
  const run = debounce(async () => {
    const q = $('#it-q').value.trim();
    st.q = q;
    if (q.length < 2) { st.results = []; $('#it-res').innerHTML = ''; return; }
    $('#it-res').innerHTML = '<div class="spin"></div>';
    try {
      const items = await itunesSearch(q, 'song', 15);
      st.results = items.filter(t => t.wrapperType === 'track');
      paint();
    } catch (e) { $('#it-res').innerHTML = '<div class="empty"><h3>Search failed</h3><p>Check your connection.</p></div>'; }
  }, 450);
  $('#it-q').addEventListener('input', run);
}
function addUpload() {
  const body = $('#add-body');
  body.innerHTML = '<div class="drop" id="drop">📁 <b>Drop audio files here</b> or tap to browse'
    + '<div style="font-size:12.5px;margin-top:6px">MP3, M4A, WAV, OGG… stored privately on this device.</div></div>'
    + '<input type="file" id="up-files" accept="audio/*" multiple hidden><div id="up-list" style="margin-top:16px"></div>';
  const dz = $('#drop'), fi = $('#up-files');
  dz.onclick = () => fi.click();
  ;['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.style.borderColor = 'var(--acc)'; }));
  ;['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.style.borderColor = ''; }));
  dz.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
  fi.addEventListener('change', () => handleFiles(fi.files));
  async function handleFiles(files) {
    for (const f of files) {
      if (!f.type.startsWith('audio')) continue;
      const key = uid();
      await idbPut(key, f).catch(() => {});
      const dur = await new Promise(res => {
        const a = document.createElement('audio');
        a.preload = 'metadata';
        a.onloadedmetadata = () => res(Math.round(a.duration || 0));
        a.onerror = () => res(0);
        a.src = URL.createObjectURL(f);
      });
      const guess = f.name.replace(/\.[^.]+$/, '').split(' - ');
      const title = (guess[1] || guess[0] || f.name).trim(), artist = (guess[1] ? guess[0] : '').trim();
      Store.addSong({ title, artist, art: '', dur, src: { type: 'file', blobKey: key, name: f.name } });
      const row = document.createElement('div');
      row.innerHTML = '<div class="search-result"><div class="sr-main"><div class="sr-title">' + esc(title) + '</div><div class="sr-sub">' + esc(f.name) + '</div></div><span class="sr-dur">✓</span></div>';
      $('#up-list').prepend(row);
    }
    Store.db.recCache = null; Store.save();
    toast('Uploads added to your collection ✓');
  }
}
function addManual() {
  const body = $('#add-body');
  body.innerHTML = '<div class="form-card"><h2 style="margin:0 0 4px">Add by name</h2>'
    + '<div class="msub">We\'ll try to link full-length audio automatically.</div>'
    + '<label>Title</label><input type="text" id="m-title" placeholder="Song title">'
    + '<label>Artist</label><input type="text" id="m-artist" placeholder="Artist">'
    + '<label>Album (optional)</label><input type="text" id="m-album" placeholder="Album">'
    + '<div class="modal-actions"><button class="btn" id="m-add">＋ Add to collection</button></div></div>';
  $('#m-add').onclick = async e => {
    const title = $('#m-title').value.trim(), artist = $('#m-artist').value.trim(), album = $('#m-album').value.trim();
    if (!title) { toast('Title is required.'); return; }
    e.target.disabled = true; e.target.textContent = 'Linking audio…';
    let src = { type: 'none' }, art = '', dur = 0;
    const hit = await resolveYouTube(title, artist).catch(() => null);
    if (hit) { src = { type: 'yt', videoId: hit.videoId }; art = hit.thumb; dur = hit.dur; }
    const added = Store.addSong({ title, artist, album, art, dur, src });
    Store.db.recCache = null; Store.save();
    toast(added ? (src.type === 'none' ? 'Saved — tap 🔍 on it later to find audio.' : 'Added ✓') : 'Already in your collection.');
    nav('collection');
  };
}

/* ================= Backup / restore ================= */
function exportBackup() {
  const data = JSON.stringify({ app: 'crate', v: 1, exportedAt: Date.now(), db: Store.db }, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = 'crate-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  toast('Backup downloaded ✓');
}
function importBackup(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const j = JSON.parse(rd.result);
      const db = j.db || j;
      if (!db.songs || !Array.isArray(db.songs)) throw 0;
      let added = 0;
      db.songs.forEach(s => { if (Store.addSong(s)) added++; });
      (db.albums || []).forEach(a => {
        if (!Store.db.albums.some(x => x.id === a.id)) Store.db.albums.push(a);
      });
      Store.db.recCache = null; Store.save();
      toast('Restored — ' + added + ' new songs added ✓');
      nav('home');
    } catch (e) { toast('That file is not a Crate backup.'); }
  };
  rd.readAsText(file);
}

/* ================= Crate Shield — inbuilt ad & tracker blocker ================= */
const Shield = {
  count: 0, on: (localStorage.getItem('crate.shield') || 'on') === 'on',
  async init() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      this.send();
      navigator.serviceWorker.addEventListener('message', e => {
        const d = e.data || {};
        if (d.type === 'shield-blocked') { this.count = d.count; this.paint(); }
      });
      // ask the worker for the current count
      if (reg.active) reg.active.postMessage({ type: 'shield-get' });
    } catch (e) { /* SW unavailable: shield UI still explains */ }
    this.paint();
  },
  send() {
    if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'shield-set', on: this.on });
    else navigator.serviceWorker.ready.then(r => r.active && r.active.postMessage({ type: 'shield-set', on: this.on })).catch(() => {});
  },
  toggle() {
    this.on = !this.on;
    localStorage.setItem('crate.shield', this.on ? 'on' : 'off');
    this.send(); this.paint();
    toast(this.on ? '🛡 Shield on — ads & trackers blocked.' : 'Shield off.');
  },
  paint() {
    const b = $('#shield-btn'); if (!b) return;
    b.classList.toggle('off', !this.on);
    b.innerHTML = '🛡' + (this.count > 0 ? '<span class="sh-n">' + (this.count > 99 ? '99+' : this.count) + '</span>' : '');
    b.title = this.on ? 'Shield is on — ' + this.count + ' blocked' : 'Shield is off';
  },
  info() {
    const m = openModal('<h2>🛡 Crate Shield</h2>'
      + '<div class="msub">A built-in ad & tracker blocker for this app.</div>'
      + '<div class="msub" style="line-height:1.6">'
      + (this.on ? 'Status: <b style="color:var(--acc2)">ON</b> — ' + this.count + ' ad/tracker requests blocked so far.'
        : 'Status: <b style="color:var(--warn)">OFF</b>.')
      + '<br><br>Shield blocks third-party advertising and tracking requests across Crate (banners, trackers, analytics beacons) using a built-in filter list — no extension needed.'
      + '<br><br><span style="color:var(--dim);font-size:12.5px">One honest note: ads that play <i>inside</i> the YouTube player come from YouTube itself and can only be removed by YouTube Premium or a browser-level blocker such as Brave Shields. Everything else on this page is covered.</span></div>'
      + '<div class="modal-actions"><button class="btn ghost small" data-close>Close</button>'
      + '<button class="btn small" data-toggle>' + (this.on ? 'Turn off' : 'Turn on') + '</button></div>');
    m.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) closeModal();
      if (e.target.closest('[data-toggle]')) { this.toggle(); closeModal(); }
    });
  },
};

/* ================= Player bar wiring ================= */
function wirePlayer() {
  $('#pb-play').onclick = () => Player.toggle();
  $('#pb-next').onclick = () => Player.next();
  $('#pb-prev').onclick = () => Player.prev();
  $('#pb-seek').addEventListener('input', e => {
    const frac = e.target.value / 1000;
    if (Player.current && Player.current.src.type === 'yt' && ytMode) seekYt(frac);
    else if (htmlMode && htmlAudio.duration) htmlAudio.currentTime = frac * htmlAudio.duration;
  });
  $('#pb-vol').addEventListener('input', e => {
    Player.volume = e.target.value / 100;
    Player.muted = false;
    htmlAudio.volume = Player.volume; htmlAudio.muted = false;
    setYtVolume(Player.volume); muteYt(false);
    $('#pb-mute').textContent = '🔊';
  });
  $('#pb-mute').onclick = () => {
    Player.muted = !Player.muted;
    htmlAudio.muted = Player.muted; muteYt(Player.muted);
    $('#pb-mute').textContent = Player.muted ? '🔇' : '🔊';
  };
  $('#pb-like').onclick = () => {
    const s = Player.current; if (!s) return;
    s.liked = !s.liked; Store.save();
    $('#pb-like').textContent = s.liked ? '♥' : '♡';
    $('#pb-like').classList.toggle('liked', s.liked);
    rerender();
  };
}

/* ================= Global search ================= */
function wireSearch() {
  const inp = $('#global-search');
  inp.addEventListener('input', debounce(() => {
    colQuery = inp.value;
    if (currentView !== 'collection') nav('collection');
    else renderCollection();
  }, 350));
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');
}

/* ================= Init ================= */
function init() {
  Store.load();
  wirePlayer();
  wireSearch();
  $('#export-btn').onclick = exportBackup;
  $('#import-btn').onclick = () => $('#import-file').click();
  $('#import-file').addEventListener('change', e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });
  // Shield button in the topbar
  const sh = document.createElement('button');
  sh.id = 'shield-btn'; sh.className = 'icon-btn'; sh.style.position = 'relative';
  sh.onclick = () => Shield.info();
  $('.top-actions').prepend(sh);
  Shield.init();
  nav('home');
  // Idle: pre-warm recommendations cache in the background
  if ('requestIdleCallback' in window) requestIdleCallback(() => Recs.get().catch(() => {}), { timeout: 20000 });
  else setTimeout(() => Recs.get().catch(() => {}), 15000);
}
document.addEventListener('DOMContentLoaded', init);
