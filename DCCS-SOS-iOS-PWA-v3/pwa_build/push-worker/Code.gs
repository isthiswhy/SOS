/**
 * Community SOS — Google Apps Script backend
 * -------------------------------------------------
 * Storage : one Google Drive folder (state.json + chat media + stream chunks)
 * Speed   : CacheService keeps hot data so 3-5 s polling from <50 phones is cheap
 * Deploy  : Deploy > New deployment > Web app
 *           Execute as: Me   |   Who has access: Anyone
 */

const CONFIG = {
  ACCESS_CODE: 'change-me-1234',   // <-- CHANGE THIS. Everyone in your network types this once at setup.
  FOLDER_ID: '',                   // Optional: paste the ID of your designated Drive folder.
                                   // Leave '' to auto-create "EmergencyAlarmData" in My Drive.
  FOLDER_NAME: 'EmergencyAlarmData',
  MAX_USERS: 50,
  ALARM_TTL_MS: 2 * 60 * 60 * 1000, // an alarm auto-expires after 2 hours
  STREAM_STALE_MS: 25 * 1000,       // a stream with no new chunk for 25 s counts as ended
  MAX_MEDIA_MB: 20,
  ADMIN_UIDS: [],                   // optional: user ids allowed to clear anybody's alarm

  // ADDED: web push - the URL your Cloudflare Worker printed after `wrangler deploy`.
  PUSH_WORKER_URL: 'https://dccs-sos-push.<your-subdomain>.workers.dev/broadcast'
};

// ADDED: the shared secret you set with `wrangler secret put PUSH_SECRET`.
// Set it once here: Apps Script editor > Project Settings > Script properties > add PUSH_SECRET.
const PUSH_SECRET_ = () => PropertiesService.getScriptProperties().getProperty('PUSH_SECRET');

const TTL = 21600; // 6 h, the CacheService maximum
const cache_ = () => CacheService.getScriptCache();

/* ---------- Run this once from the editor to authorise Drive access ---------- */
function setup() {
  const f = folder_();
  Logger.log('Folder ready: ' + f.getName() + '  (' + f.getId() + ')');
}

/* Optional: run once to auto-delete old media every day. */
function installDailyCleanup() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'cleanup') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('cleanup').timeBased().everyDays(1).atHour(3).create();
}

function cleanup() {
  const now = Date.now();
  const it = folder_().getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const n = f.getName();
    const age = now - f.getDateCreated().getTime();
    if (n.indexOf('c_') === 0 && age > 60 * 60 * 1000) f.setTrashed(true);            // stream chunks: 1 h
    else if (n.indexOf('m_') === 0 && age > 7 * 24 * 60 * 60 * 1000) f.setTrashed(true); // chat media: 7 days
  }
}

/* ---------- HTTP entry points ---------- */
function doGet() {
  return out_({ ok: true, service: 'Community SOS API', time: Date.now() });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return out_({ ok: false, error: 'bad_request' }); }

  if (req.code !== CONFIG.ACCESS_CODE) return out_({ ok: false, error: 'bad_code' });
  if (req.uid && !/^[\w-]{8,64}$/.test(String(req.uid))) return out_({ ok: false, error: 'bad_uid' });

  const writers = { register: 1, trigger: 1, resolve: 1, chat: 1, upload: 1, streamStart: 1, chunk: 1, streamStop: 1, subscribe: 1 };
  const lock = LockService.getScriptLock();
  try {
    if (writers[req.action]) lock.waitLock(15000);
    switch (req.action) {
      case 'register':    return out_(register_(req));
      case 'state':       return out_(state_(req));
      case 'ping':        return out_(ping_(req));   // light poll used by the Android background service
      case 'trigger':     return out_(trigger_(req));
      case 'resolve':     return out_(resolve_(req));
      case 'chat':        return out_(chat_(req));
      case 'upload':      return out_(upload_(req));
      case 'file':        return out_(file_(req));
      case 'streamStart': return out_(streamStart_(req));
      case 'chunk':       return out_(chunk_(req));
      case 'streamStop':  return out_(streamStop_(req));
      case 'subscribe':   return out_(subscribe_(req)); // ADDED: web push
      default:            return out_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Drive + core state ---------- */
function folder_() {
  if (CONFIG.FOLDER_ID) return DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const it = DriveApp.getFoldersByName(CONFIG.FOLDER_NAME);
  const f = it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.FOLDER_NAME);
  props.setProperty('FOLDER_ID', f.getId());
  return f;
}

function findFile_(name) {
  const it = folder_().getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

function loadCore_() {
  const hit = cache_().get('core');
  if (hit) return JSON.parse(hit);
  let core = { users: {}, alarms: [], msgs: [], seq: 0 };
  const f = findFile_('state.json');
  if (f) { try { core = JSON.parse(f.getBlob().getDataAsString()); } catch (e) {} }
  return core;
}

function saveCore_(core) {
  let s = JSON.stringify(core);
  while (s.length > 60000 && core.msgs.length > 5) { core.msgs.shift(); s = JSON.stringify(core); }
  cache_().put('core', s, TTL);
  const f = findFile_('state.json');
  if (f) f.setContent(s); else folder_().createFile('state.json', s, MimeType.PLAIN_TEXT);
}

function addMsg_(core, m) {
  m.id = ++core.seq;
  m.t = Date.now();
  core.msgs.push(m);
  if (core.msgs.length > 60) core.msgs.shift();
  return m;
}

function clip_(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }

function activeAlarms_(core) {
  const now = Date.now();
  return (core.alarms || []).filter(a => now - a.at < CONFIG.ALARM_TTL_MS);
}

function inFolder_(file) {
  const fid = folder_().getId();
  const p = file.getParents();
  while (p.hasNext()) if (p.next().getId() === fid) return true;
  return false;
}

/* ---------- Actions ---------- */
function register_(req) {
  const name = clip_(req.name, 60), phone = clip_(req.phone, 30), email = clip_(req.email, 100);
  if (name.length < 2) throw new Error('name_required');
  if (!/^[+\d][\d\s\-()]{6,}$/.test(phone)) throw new Error('phone_invalid');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email_invalid');
  const core = loadCore_();
  if (!core.users[req.uid] && Object.keys(core.users).length >= CONFIG.MAX_USERS) throw new Error('network_full');
  core.users[req.uid] = { id: req.uid, name: name, phone: phone, email: email, joined: (core.users[req.uid] || {}).joined || Date.now() };
  saveCore_(core);
  return { ok: true };
}

/* ADDED: web push -------------------------------------------------- */
function subscribe_(req) {
  const core = loadCore_();
  const u = core.users[req.uid];
  if (!u) throw new Error('not_registered');
  if (!req.subscription || !req.subscription.endpoint) throw new Error('bad_subscription');
  u.push = req.subscription; // { endpoint, keys: { p256dh, auth } }
  saveCore_(core);
  return { ok: true };
}

/* Fire-and-forget: push every OTHER registered user with a stored subscription.
   Never throws - a push failure must never break the actual alarm trigger. */
function broadcastPush_(core, triggeringUser) {
  try {
    const secret = PUSH_SECRET_();
    if (!secret || !CONFIG.PUSH_WORKER_URL) return; // push not configured yet - skip quietly

    const subs = Object.values(core.users)
      .filter(u => u.id !== triggeringUser.id && u.push && u.push.endpoint)
      .map(u => u.push);
    if (!subs.length) return;

    const res = UrlFetchApp.fetch(CONFIG.PUSH_WORKER_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + secret },
      payload: JSON.stringify({
        subscriptions: subs,
        title: 'DCCS SOS',
        message: (triggeringUser.name || 'Someone') + ' needs help',
        tag: 'dccs-sos-alarm',
        url: './'
      }),
      muteHttpExceptions: true
    });

    const body = JSON.parse(res.getContentText() || '{}');
    if (body.expired && body.expired.length) {
      const dead = new Set(body.expired);
      let changed = false;
      Object.values(core.users).forEach(u => {
        if (u.push && dead.has(u.push.endpoint)) { u.push = null; changed = true; }
      });
      if (changed) saveCore_(core); // prune subscriptions the push service says are gone
    }
  } catch (e) {
    Logger.log('broadcastPush_ failed: ' + e);
  }
}

function state_(req) {
  const core = loadCore_();
  const now = Date.now();
  const c = cache_();

  if (req.uid && core.users[req.uid]) {
    c.put('seen_' + req.uid, String(now), TTL);
    if (typeof req.lat === 'number' && typeof req.lng === 'number') {
      c.put('loc_' + req.uid, JSON.stringify({ lat: req.lat, lng: req.lng, acc: req.acc || 0, t: now }), TTL);
    }
  }

  const ids = Object.keys(core.users);
  const keys = [];
  ids.forEach(id => keys.push('seen_' + id, 'loc_' + id));
  const got = keys.length ? c.getAll(keys) : {};

  const users = ids.map(id => {
    const u = core.users[id];
    let loc = null;
    try { loc = got['loc_' + id] ? JSON.parse(got['loc_' + id]) : null; } catch (e) {}
    return {
      id: id, name: u.name, phone: u.phone, email: u.email,
      lat: loc ? loc.lat : null, lng: loc ? loc.lng : null, acc: loc ? loc.acc : null, t: loc ? loc.t : null,
      seen: got['seen_' + id] ? Number(got['seen_' + id]) : 0
    };
  });

  const since = Number(req.since) || 0;
  const streams = liveStreams_(now);

  return {
    ok: true, now: now, users: users,
    alarms: activeAlarms_(core),
    msgs: core.msgs.filter(m => m.id > since),
    streams: streams
  };
}

/* Light-weight poll for the Android background service: heartbeat + location + active alarms only. */
function ping_(req) {
  const core = loadCore_();
  const now = Date.now();
  if (req.uid && core.users[req.uid]) {
    const c = cache_();
    c.put('seen_' + req.uid, String(now), TTL);
    if (typeof req.lat === 'number' && typeof req.lng === 'number') {
      c.put('loc_' + req.uid, JSON.stringify({ lat: req.lat, lng: req.lng, acc: req.acc || 0, t: now }), TTL);
    }
  }
  return { ok: true, now: now, alarms: activeAlarms_(core) };
}

function trigger_(req) {
  const core = loadCore_();
  const u = core.users[req.uid];
  if (!u) throw new Error('not_registered');
  core.alarms = activeAlarms_(core);
  if (!core.alarms.some(a => a.uid === req.uid)) {
    const a = {
      id: 'a' + (++core.seq), uid: req.uid, name: u.name, at: Date.now(),
      lat: typeof req.lat === 'number' ? req.lat : null,
      lng: typeof req.lng === 'number' ? req.lng : null
    };
    core.alarms.push(a);
    addMsg_(core, { type: 'sys', text: '🚨 ' + u.name + ' triggered an EMERGENCY alarm' });
    saveCore_(core);
    broadcastPush_(core, u); // ADDED: push everyone else in the network
  }
  return { ok: true, alarms: core.alarms };
}

function resolve_(req) {
  const core = loadCore_();
  const u = core.users[req.uid];
  if (!u) throw new Error('not_registered');
  const admin = CONFIG.ADMIN_UIDS.indexOf(req.uid) >= 0;
  const before = core.alarms.length;
  core.alarms = activeAlarms_(core).filter(a => !(a.uid === req.uid || (admin && (!req.target || a.uid === req.target))));
  if (core.alarms.length !== before) {
    addMsg_(core, { type: 'sys', text: '✅ ' + u.name + ' is safe — alarm cleared' });
    saveCore_(core);
  }
  return { ok: true, alarms: core.alarms };
}

function chat_(req) {
  const core = loadCore_();
  const u = core.users[req.uid];
  if (!u) throw new Error('not_registered');
  const text = clip_(req.text, 500);
  const m = { type: 'text', uid: req.uid, name: u.name, text: text };
  if (req.fileId) {
    const f = DriveApp.getFileById(String(req.fileId));
    if (!inFolder_(f)) throw new Error('bad_file');
    m.type = String(req.mime || '').indexOf('video/') === 0 ? 'video' : 'image';
    m.fileId = f.getId();
    m.mime = clip_(req.mime, 40);
    if (req.thumb && String(req.thumb).length <= 8000 && String(req.thumb).indexOf('data:image/') === 0) m.thumb = req.thumb;
  }
  if (!m.text && !m.fileId) throw new Error('empty');
  addMsg_(core, m);
  saveCore_(core);
  return { ok: true };
}

function upload_(req) {
  if (!getUser_(req.uid)) throw new Error('not_registered');
  const mime = String(req.mime || '');
  if (!/^(image|video)\//.test(mime)) throw new Error('bad_mime');
  const bytes = Utilities.base64Decode(String(req.data || ''));
  if (bytes.length > CONFIG.MAX_MEDIA_MB * 1024 * 1024) throw new Error('too_large');
  const file = folder_().createFile(Utilities.newBlob(bytes, mime, 'm_' + req.uid.slice(0, 8) + '_' + Date.now()));
  return { ok: true, fileId: file.getId() };
}

function file_(req) {
  if (!getUser_(req.uid)) throw new Error('not_registered');
  const f = DriveApp.getFileById(String(req.id));
  if (!inFolder_(f)) throw new Error('bad_file');
  const blob = f.getBlob();
  return { ok: true, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

function getUser_(uid) { return loadCore_().users[uid]; }

/* ---------- Live stream (near-live: short chunks) ---------- */
function streams_() {
  const s = cache_().get('streams');
  return s ? JSON.parse(s) : {};
}
function saveStreams_(s) { cache_().put('streams', JSON.stringify(s), TTL); }

function liveStreams_(now) {
  const s = streams_(), out = {};
  Object.keys(s).forEach(uid => {
    if (now - s[uid].updated < CONFIG.STREAM_STALE_MS) out[uid] = s[uid];
  });
  return out;
}

function trashChunks_(st) {
  (st.chunks || []).forEach(c => { try { DriveApp.getFileById(c.id).setTrashed(true); } catch (e) {} });
}

function streamStart_(req) {
  const core = loadCore_();
  const u = core.users[req.uid];
  if (!u) throw new Error('not_registered');
  const s = streams_();
  if (s[req.uid]) trashChunks_(s[req.uid]);
  s[req.uid] = { uid: req.uid, name: u.name, started: Date.now(), updated: Date.now(), chunks: [] };
  saveStreams_(s);
  addMsg_(core, { type: 'sys', text: '📹 ' + u.name + ' started a live stream' });
  saveCore_(core);
  return { ok: true };
}

function chunk_(req) {
  const s = streams_();
  const st = s[req.uid];
  if (!st) throw new Error('no_stream');
  const mime = String(req.mime || 'video/webm');
  if (mime.indexOf('video/') !== 0) throw new Error('bad_mime');
  const bytes = Utilities.base64Decode(String(req.data || ''));
  const seq = Number(req.seq) || 0;
  const file = folder_().createFile(Utilities.newBlob(bytes, mime, 'c_' + req.uid.slice(0, 8) + '_' + seq));
  st.chunks.push({ seq: seq, id: file.getId(), mime: mime });
  while (st.chunks.length > 6) {
    const old = st.chunks.shift();
    try { DriveApp.getFileById(old.id).setTrashed(true); } catch (e) {}
  }
  st.updated = Date.now();
  saveStreams_(s);
  return { ok: true };
}

function streamStop_(req) {
  const s = streams_();
  if (s[req.uid]) {
    trashChunks_(s[req.uid]);
    delete s[req.uid];
    saveStreams_(s);
  }
  return { ok: true };
}
