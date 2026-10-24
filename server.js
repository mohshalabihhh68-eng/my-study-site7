/**
 * Coursatk API — النسخة المدمجة النهائية (بدون مشاكل 404)
 */
import express from "express";
import cors from "cors";
import compression from "compression";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "512kb" }));
app.use(compression());

// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════
const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  
  FIREBASE: "https://my-platform-e46a6-default-rtdb.europe-west1.firebasedatabase.app",
  
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "admin123",
  
  COURSATK_API: "https://api.coursatk.online/api/v1",
  // التوكن الاحتياطي (لو الطالب مش باعت توكن)
  COURSATK_TOKEN: process.env.COURSATK_TOKEN || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxMDk1NTUsInJvbGUiOiJzdHVkZW50IiwidXVpZCI6IjU3OGIxNjBjMjgxZWVkY2Y1ZTY4MjViNDZmMWExNTY0In0.x9vV-N_13KcrGbx-y9owTgGdirKpKh_X0JXDpolYegs",
  
  STREAM_HOSTS: [
    "api.coursatk.online",
    "stream-weave.com",
    "floravon.online",
    "floravon.shop",
    "c-cdn.online"
  ],
  STREAM_ORIGIN: "https://coursatk.online",
  STREAM_REFERER: "https://coursatk.online/",
  STREAM_UA: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  PLAYER_JS: "https://player.stream-weave.com/assets/player.js?v=1.1.1",
  
  CODE_TYPES: {
    trial: { label: "تجربة", ms: 1 * 3600 * 1000 },
    month: { label: "شهر", ms: 30 * 24 * 3600 * 1000 },
    term:  { label: "ترم", ms: 180 * 24 * 3600 * 1000 },
    year:  { label: "سنة", ms: 365 * 24 * 3600 * 1000 }
  },
  
  STUDENT_SESSION_MS: 7 * 24 * 3600 * 1000,
  ADMIN_SESSION_MS: 12 * 3600 * 1000,
  STREAM_SESSION_MS: 15 * 60 * 1000,
  MAX_PROXY_BYTES: 12 * 1024 * 1024
};

// ═══════════════════════════════════════════════
// Firebase REST
// ═══════════════════════════════════════════════
async function fbGet(p) {
  const r = await fetch(`${CONFIG.FIREBASE}/${p}.json`);
  if (!r.ok) throw new Error(`Firebase GET ${p} → ${r.status}`);
  return r.json();
}
async function fbSet(p, data) {
  const r = await fetch(`${CONFIG.FIREBASE}/${p}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Firebase PUT ${p} → ${r.status}`);
  return r.json();
}
async function fbPatch(p, data) {
  const r = await fetch(`${CONFIG.FIREBASE}/${p}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Firebase PATCH ${p} → ${r.status}`);
  return r.json();
}
async function fbDelete(p) {
  const r = await fetch(`${CONFIG.FIREBASE}/${p}.json`, { method: "DELETE" });
  if (!r.ok) throw new Error(`Firebase DELETE ${p} → ${r.status}`);
  return true;
}

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════
const now = () => Date.now();
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const randomCode7 = () => String(Math.floor(1000000 + Math.random() * 9000000));

function jsonError(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function getBearer(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  if (req.headers["x-session-token"]) return String(req.headers["x-session-token"]).trim();
  if (req.query && req.query.token) return String(req.query.token).trim();
  return "";
}

// ═══════════════════════════════════════════════
// الجلسات
// ═══════════════════════════════════════════════
const studentSessions = new Map();
const adminSessions = new Map();
const streamSessions = new Map();

const studentCache = new Map();
async function getStudentCached(code) {
  const c = studentCache.get(code);
  if (c && Date.now() - c.at < 30_000) return c.student;
  let student;
  try {
    student = await fbGet(`students/${code}`);
  } catch {
    await new Promise((r) => setTimeout(r, 300));
    try { student = await fbGet(`students/${code}`); }
    catch (e) {
      if (c) return c.student;
      throw e;
    }
  }
  studentCache.set(code, { student, at: Date.now() });
  return student;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, c] of studentCache) if (t - c.at > 120_000) studentCache.delete(k);
}, 60_000).unref();

// ═══════════════════════════════════════════════
// Auth middleware
// ═══════════════════════════════════════════════
async function requireStudent(req, res, next) {
  try {
    const token = getBearer(req);
    if (!token) return jsonError(res, 401, "مطلوب تسجيل الدخول");

    let sess = studentSessions.get(token);
    if (!sess) {
      const remote = await fbGet(`sessions/${token}`);
      if (!remote) return jsonError(res, 401, "جلسة غير صالحة");
      sess = remote;
      studentSessions.set(token, sess);
    }

    if (sess.expiresAt && now() > sess.expiresAt) {
      studentSessions.delete(token);
      try { await fbDelete(`sessions/${token}`); } catch {}
      return jsonError(res, 401, "انتهت صلاحية الجلسة");
    }

    const student = await getStudentCached(sess.code);
    if (!student || student.active === false) {
      studentSessions.delete(token);
      return jsonError(res, 401, "الحساب غير موجود أو موقوف");
    }
    if (student.expiresAt && now() > student.expiresAt) {
      return jsonError(res, 403, "انتهت صلاحية كود الاشتراك");
    }

    const devices = student.devices || {};
    if (sess.deviceId && !devices[sess.deviceId]) {
      studentSessions.delete(token);
      studentCache.delete(sess.code);
      try { await fbDelete(`sessions/${token}`); } catch {}
      return jsonError(res, 401, "تم تسجيل خروج هذا الجهاز من لوحة التحكم");
    }

    req.student = student;
    req.session = sess;
    req.sessionToken = token;
    next();
  } catch (e) {
    console.error("[auth student]", e.message);
    return jsonError(res, 500, "خطأ في التحقق من الجلسة");
  }
}

function requireAdmin(req, res, next) {
  const token = getBearer(req);
  if (!token) return jsonError(res, 401, "مطلوب دخول الأدمن");

  const sess = adminSessions.get(token);
  if (!sess) return jsonError(res, 401, "جلسة أدمن غير صالحة");

  if (sess.expiresAt && now() > sess.expiresAt) {
    adminSessions.delete(token);
    return jsonError(res, 401, "انتهت جلسة الأدمن");
  }

  req.adminSession = sess;
  req.adminToken = token;
  next();
}

// ═══════════════════════════════════════════════
// Stream decrypt
// ═══════════════════════════════════════════════
let decryptPlaybackKeyFn = null;

async function loadDecryptionUtils() {
  const cachePath = path.join(__dirname, "player.stream-weave.cache.js");
  let source = null;
  try {
    if (fs.existsSync(cachePath)) source = fs.readFileSync(cachePath, "utf8");
  } catch {}
  if (!source) {
    console.log("[crypto] fetching player.js…");
    const r = await fetch(CONFIG.PLAYER_JS, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" }
    });
    if (!r.ok) throw new Error(`player.js HTTP ${r.status}`);
    source = await r.text();
    try { fs.writeFileSync(cachePath, source); } catch {}
  }
  const { webcrypto } = crypto;
  const sandbox = {
    window: {}, self: {}, globalThis: {}, global: {},
    console: { log() {}, warn() {}, error() {}, info() {} },
    crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Error, Object, Array, String, Number, Boolean, Math, JSON, Date,
    Map, Set, WeakMap, Symbol, Proxy, Reflect,
    document: {
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
      head: { appendChild() {} }, body: { appendChild() {} },
      querySelector: () => null, addEventListener() {}
    },
    navigator: { userAgent: "Node" },
    location: { href: "https://coursatk.online/" },
    HTMLElement: class {}, HTMLVideoElement: class {}, MediaSource: class {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: class { constructor(p) { this.p = p; } },
    fetch: async () => ({ ok: false }),
    XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} }
  };
  sandbox.window = sandbox; sandbox.self = sandbox;
  sandbox.globalThis = sandbox; sandbox.global = sandbox;
  vm.runInNewContext(source, sandbox, { timeout: 8000 });
  const du = sandbox.DecryptionUtils;
  if (!du?.decryptPlaybackKey) throw new Error("DecryptionUtils missing");
  decryptPlaybackKeyFn = du.decryptPlaybackKey.bind(du);
  console.log("[crypto] ready");
}

async function unwrapKey(wrappedBuf, videoId) {
  if (!decryptPlaybackKeyFn) throw new Error("crypto not loaded");
  const wrapped = new Uint8Array(wrappedBuf);
  if (wrapped.byteLength === 16) return Buffer.from(wrapped);
  const result = await decryptPlaybackKeyFn(wrapped, String(videoId));
  const key = result?.key;
  if (!key) throw new Error("empty key");
  const aes = Buffer.isBuffer(key) ? key
    : key instanceof ArrayBuffer ? Buffer.from(key)
    : Buffer.from(key.buffer || key, key.byteOffset || 0, key.byteLength || key.length);
  if (aes.length !== 16) throw new Error(`key len ${aes.length}`);
  return aes;
}

function decryptSegment(encrypted, key, iv) {
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function parseIvHex(hex) {
  const h = String(hex || "").replace(/^0x/i, "").trim();
  if (!/^[0-9a-fA-F]{32}$/.test(h)) return null;
  return Buffer.from(h, "hex");
}

function ivFromMediaSequence(seq) {
  const iv = Buffer.alloc(16, 0);
  iv.writeUInt32BE(Number(seq) >>> 0, 12);
  return iv;
}

// ═══════════════════════════════════════════════
// Upstream helpers (السر هنا: بياخد توكن الطالب)
// ═══════════════════════════════════════════════
async function upstreamJson(apiPath, options = {}, req = null) {
  // 1. بنجيب التوكن من هيدر الطلب (لو موجود)، ولو مش موجود بناخد اللي في الإعدادات
  const clientAuth = req?.headers?.authorization || "";
  let tokenToUse = CONFIG.COURSATK_TOKEN;
  
  if (clientAuth.startsWith("Bearer ")) {
    tokenToUse = clientAuth.slice(7).trim();
  }

  const r = await fetch(`${CONFIG.COURSATK_API}${apiPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${tokenToUse}`,
      Accept: "application/json",
      Origin: "https://coursatk.online",
      Referer: "https://coursatk.online/",
      "User-Agent": CONFIG.STREAM_UA,
      ...(options.headers || {})
    }
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Upstream non-JSON (${r.status})`); }
  if (!r.ok) throw new Error(data?.message || `Upstream HTTP ${r.status}`);
  return data;
}

function allowedStreamUrl(raw, session = null) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const hosts = new Set(CONFIG.STREAM_HOSTS);
    if (session?.allowedHosts) for (const h of session.allowedHosts) hosts.add(h);
    if (session?.streamUrl) {
      try { hosts.add(new URL(session.streamUrl).hostname); } catch {}
    }
    return [...hosts].some(h => u.hostname === h || u.hostname.endsWith("." + h));
  } catch { return false; }
}

async function streamFetch(session, url, extra = {}, clientHeaders = null) {
  if (!allowedStreamUrl(url, session)) throw new Error(`URL غير مسموح: ${url}`);
  const ch = clientHeaders || {};
  const headers = {
    Accept: "*/*",
    "Cache-Control": "no-cache",
    Origin: CONFIG.STREAM_ORIGIN,
    Referer: CONFIG.STREAM_REFERER,
    "User-Agent": ch["user-agent"] || CONFIG.STREAM_UA
  };
  const isMediaSegmentHost = /floravon\.(online|shop)|c-cdn\.online/i.test(url);
  if (!isMediaSegmentHost && session?.token) {
    headers.Authorization = `Bearer ${session.token}`;
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v != null && v !== "") headers[k] = v;
  }
  return fetch(url, { headers, cache: "no-store" });
}

// ═══════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════
app.get("/health", (_req, res) => {
  res.json({ ok: true, cryptoReady: Boolean(decryptPlaybackKeyFn) });
});

app.get("/api/public/code-types", (_req, res) => {
  const types = {};
  for (const [k, v] of Object.entries(CONFIG.CODE_TYPES)) {
    types[k] = { label: v.label, durationMs: v.ms };
  }
  res.json({ success: true, data: types });
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim();
    const deviceId = String(req.body?.deviceId || "").trim();
    const deviceName = String(req.body?.deviceName || "Unknown").slice(0, 80);

    if (!/^\d{7}$/.test(code)) return jsonError(res, 400, "الكود يجب أن يكون 7 أرقام");
    if (!deviceId || deviceId.length < 8) return jsonError(res, 400, "deviceId مطلوب");

    const student = await fbGet(`students/${code}`);
    if (!student || student.active === false) return jsonError(res, 401, "كود غير صحيح أو موقوف");
    if (student.expiresAt && now() > student.expiresAt) return jsonError(res, 403, "انتهت صلاحية الاشتراك");

    const devices = student.devices || {};
    const maxDevices = Number(student.maxDevices || 1);

    if (!devices[deviceId]) {
      if (Object.keys(devices).length >= maxDevices) {
        return jsonError(res, 403, `تم بلوغ الحد الأقصى للأجهزة (${maxDevices}).`);
      }
      devices[deviceId] = { name: deviceName, addedAt: now(), lastSeen: now() };
      await fbSet(`students/${code}/devices`, devices);
    } else {
      devices[deviceId].lastSeen = now();
      await fbSet(`students/${code}/devices/${deviceId}`, devices[deviceId]);
    }

    const sessionTtl = Math.min(
      CONFIG.STUDENT_SESSION_MS,
      Math.max(60_000, (student.expiresAt || now() + CONFIG.STUDENT_SESSION_MS) - now())
    );
    const token = randomToken(32);
    const sess = {
      token, code, deviceId,
      name: student.name,
      section: student.section || null,
      createdAt: now(),
      expiresAt: now() + sessionTtl
    };
    studentSessions.set(token, sess);
    await fbSet(`sessions/${token}`, sess);

    res.json({
      success: true,
      data: {
        token, expiresAt: sess.expiresAt,
        student: {
          name: student.name, code, section: student.section || null,
          expiresAt: student.expiresAt, maxDevices, deviceId
        }
      }
    });
  } catch (e) {
    jsonError(res, 500, e.message);
  }
});

app.post("/api/auth/logout", requireStudent, async (req, res) => {
  try {
    studentSessions.delete(req.sessionToken);
    await fbDelete(`sessions/${req.sessionToken}`);
    res.json({ success: true });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/auth/me", requireStudent, async (req, res) => {
  try {
    const s = req.student;
    res.json({
      success: true,
      data: {
        name: s.name, code: req.session.code, section: s.section || null,
        expiresAt: s.expiresAt, maxDevices: s.maxDevices || 1,
        devices: Object.keys(s.devices || {}).length, deviceId: req.session.deviceId,
        sessionExpiresAt: req.session.expiresAt
      }
    });
  } catch (e) { jsonError(res, 500, e.message); }
});

// الكاتالوج (بياخد التوكن من الطالب)
app.get("/api/years", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson("/user/years", {}, req)); }
  catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/subjects/:id", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson(`/user/subjects/${encodeURIComponent(req.params.id)}`, {}, req)); }
  catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/subjects/:id/teachers", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson(`/user/subjects/${encodeURIComponent(req.params.id)}/teachers`, {}, req)); }
  catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/teachers/:id/chapters", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson(`/user/teachers/${encodeURIComponent(req.params.id)}/chapters`, {}, req)); }
  catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/chapters/:id/lectures", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson(`/user/chapters/${encodeURIComponent(req.params.id)}/lectures`, {}, req)); }
  catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/lectures/:id/content", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson(`/user/lectures/${encodeURIComponent(req.params.id)}/content`, {}, req)); }
  catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/profile", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson("/user/profile", {}, req)); }
  catch (e) { jsonError(res, 502, e.message); }
});

// Stream Routes
app.post("/api/play/:videoId", requireStudent, async (req, res) => {
  try {
    const data = await upstreamJson(
      `/video/${encodeURIComponent(req.params.videoId)}/stream-weave/play`,
      { method: "POST", headers: { Accept: "application/json" } },
      req
    );
    if (!data?.success || !data?.data?.token || !data?.data?.stream_url || !data?.data?.video_id) {
      throw new Error("Playback response ناقص");
    }
    const id = crypto.randomUUID();
    streamSessions.set(id, {
      id, videoId: String(data.data.video_id),
      token: data.data.token, streamUrl: data.data.stream_url,
      playId: String(req.params.videoId), createdAt: now(), lastUsed: now(),
      plainKey: null, defaultIv: null,
      allowedHosts: new Set([new URL(data.data.stream_url).hostname]),
      ownerCode: req.session.code
    });
    res.json({
      success: true,
      data: { session: id, video_id: data.data.video_id, manifest_url: `/api/stream/manifest/${id}` }
    });
  } catch (e) { jsonError(res, 502, e.message); }
});

function getStreamSession(id) {
  const s = streamSessions.get(id);
  if (!s) return null;
  if (now() - (s.lastUsed || s.createdAt) > CONFIG.STREAM_SESSION_MS) {
    streamSessions.delete(id);
    return null;
  }
  s.lastUsed = now();
  return s;
}

async function refreshPlayback(session, req) {
  const data = await upstreamJson(
    `/video/${encodeURIComponent(session.playId)}/stream-weave/play`,
    { method: "POST", headers: { Accept: "application/json" } },
    req
  );
  if (!data?.success || !data?.data?.token) throw new Error("فشل تجديد التوكن");
  session.token = data.data.token;
  session.streamUrl = data.data.stream_url;
  try { session.allowedHosts.add(new URL(session.streamUrl).hostname); } catch {}
  session.lastUsed = now();
}

app.get("/api/stream/manifest/:sessionId", requireStudent, async (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) return jsonError(res, 404, "جلسة التشغيل منتهية");
  if (session.ownerCode !== req.session.code) return jsonError(res, 403, "جلسة ليست لك");

  try {
    let master = await streamFetch(session, session.streamUrl, {}, req.headers);
    if (master.status === 401 && session.playId) {
      await refreshPlayback(session, req);
      master = await streamFetch(session, session.streamUrl, {}, req.headers);
    }
    if (!master.ok) throw new Error(`Stream master HTTP ${master.status}`);
    const masterText = await master.text();
    const lines = masterText.split(/\r?\n/);

    let variant = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("#EXT-X-STREAM-INF")) {
        const next = lines[i + 1]?.trim();
        if (next && !next.startsWith("#")) {
          variant = new URL(next, session.streamUrl).href;
          break;
        }
      }
    }

    if (variant) {
      let variantRes = await streamFetch(session, variant, {}, req.headers);
      if (variantRes.status === 401 && session.playId) {
        await refreshPlayback(session, req);
        variantRes = await streamFetch(session, variant, {}, req.headers);
      }
      if (!variantRes.ok) throw new Error(`Variant HTTP ${variantRes.status}`);
      return rewritePlaylist(req.params.sessionId, session, await variantRes.text(), variant, res, req.headers);
    }
    return rewritePlaylist(req.params.sessionId, session, masterText, session.streamUrl, res, req.headers);
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

async function rewritePlaylist(sessionId, session, text, baseUrl, res, clientHeaders) {
  try { session.allowedHosts.add(new URL(baseUrl).hostname); } catch {}
  const lines = text.split(/\r?\n/);
  const out = [];
  let mediaSeq = 0;
  let currentIv = null;
  let keyFetched = false;

  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("#EXT-X-MEDIA-SEQUENCE:")) mediaSeq = Number(t.split(":")[1]) || 0;
  }

  let segIndex = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-KEY:")) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      const ivHex = line.match(/IV=(0x[0-9a-fA-F]+|[0-9a-fA-F]{32})/i)?.[1];
      if (ivHex) currentIv = parseIvHex(ivHex);
      if (uri && !keyFetched && session.plainKey) {
        session.defaultIv = currentIv;
        keyFetched = true;
      } else if (uri && !keyFetched) {
        const keyUrl = new URL(uri, baseUrl).href;
        try { session.allowedHosts.add(new URL(keyUrl).hostname); } catch {}
        const keyRes = await streamFetch(session, keyUrl, {}, clientHeaders);
        if (!keyRes.ok) throw new Error(`Key HTTP ${keyRes.status}`);
        const wrapped = Buffer.from(await keyRes.arrayBuffer());
        session.plainKey = await unwrapKey(wrapped, session.videoId);
        session.defaultIv = currentIv;
        keyFetched = true;
      }
      continue;
    }
    if (line && !line.startsWith("#")) {
      const segmentUrl = new URL(line, baseUrl).href;
      try { session.allowedHosts.add(new URL(segmentUrl).hostname); } catch {}
      const seq = mediaSeq + segIndex;
      const iv = currentIv || ivFromMediaSequence(seq);
      const payload = Buffer.from(
        JSON.stringify({ u: segmentUrl, iv: iv.toString("hex"), s: seq }), "utf8"
      ).toString("base64url");
      out.push(`/api/stream/segment/${sessionId}/${payload}`);
      segIndex++;
      continue;
    }
    out.push(raw);
  }
  if (!session.plainKey) throw new Error("فشل تجهيز مفتاح التشفير");

  res.set({ "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  res.send(out.join("\n"));
}

app.get("/api/stream/segment/:sessionId/:encoded", requireStudent, async (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) return jsonError(res, 404, "جلسة التشغيل منتهية");
  if (session.ownerCode !== req.session.code) return jsonError(res, 403, "جلسة ليست لك");
  if (!session.plainKey) return jsonError(res, 404, "مفتاح غير متاح");

  let meta;
  try { meta = JSON.parse(Buffer.from(req.params.encoded, "base64url").toString("utf8")); }
  catch { return jsonError(res, 400, "segment meta غير صالح"); }
  const url = meta?.u;
  if (!url || !allowedStreamUrl(url, session)) return jsonError(res, 403, "رابط غير مسموح");

  const iv = parseIvHex(meta.iv) || session.defaultIv || ivFromMediaSequence(meta.s || 0);
  try {
    const upstream = await streamFetch(session, url, { Range: req.headers.range || undefined }, req.headers);
    if (!upstream.ok && upstream.status !== 206) throw new Error(`Segment HTTP ${upstream.status}`);
    const encrypted = Buffer.from(await upstream.arrayBuffer());
    if (encrypted.length > CONFIG.MAX_PROXY_BYTES) return jsonError(res, 413, "المقطع كبير");
    let plain;
    try { plain = decryptSegment(encrypted, session.plainKey, iv); }
    catch (decErr) { plain = encrypted; }
    res.status(200).set({ "Content-Type": "video/mp2t", "Content-Length": String(plain.length), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    res.send(plain);
  } catch (e) {
    if (!res.headersSent) jsonError(res, 502, e.message); else res.end();
  }
});

// Admin Routes
app.post("/api/admin/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (username !== CONFIG.ADMIN_USERNAME || password !== CONFIG.ADMIN_PASSWORD) {
      return jsonError(res, 401, "بيانات الدخول خطأ");
    }
    const token = randomToken(32);
    adminSessions.set(token, { token, username, createdAt: now(), expiresAt: now() + CONFIG.ADMIN_SESSION_MS });
    res.json({ success: true, data: { token, expiresAt: now() + CONFIG.ADMIN_SESSION_MS, username } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  adminSessions.delete(req.adminToken);
  res.json({ success: true });
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ success: true, data: { username: req.adminSession.username } });
});

app.get("/api/admin/students", requireAdmin, async (_req, res) => {
  try {
    const all = (await fbGet("students")) || {};
    const list = Object.entries(all).map(([code, s]) => ({
      code, name: s.name, section: s.section || null, type: s.type || null,
      expiresAt: s.expiresAt, maxDevices: s.maxDevices || 1,
      devices: Object.keys(s.devices || {}).length, active: s.active !== false, createdAt: s.createdAt || null
    }));
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ success: true, data: list });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/admin/students/:code", requireAdmin, async (req, res) => {
  try {
    const s = await fbGet(`students/${req.params.code}`);
    if (!s) return jsonError(res, 404, "الطالب غير موجود");
    res.json({ success: true, data: { code: req.params.code, ...s, deviceList: Object.entries(s.devices || {}).map(([id, d]) => ({ deviceId: id, ...d })) } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/admin/students", requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const section = String(req.body?.section || "").trim();
    const type = String(req.body?.type || "month");
    const maxDevices = Math.max(1, Math.min(10, Number(req.body?.maxDevices || 1)));
    let code = String(req.body?.code || "").trim();
    if (!name) return jsonError(res, 400, "اسم الطالب مطلوب");
    if (!CONFIG.CODE_TYPES[type]) return jsonError(res, 400, "نوع غير صالح");
    if (code) {
      if (!/^\d{7}$/.test(code)) return jsonError(res, 400, "الكود يجب 7 أرقام");
      if (await fbGet(`students/${code}`)) return jsonError(res, 409, "الكود مستخدم");
    } else {
      for (let i = 0; i < 30; i++) {
        code = randomCode7();
        if (!(await fbGet(`students/${code}`))) break;
      }
    }
    const record = {
      name, section: section || null, type, maxDevices, devices: {}, active: true,
      createdAt: now(), expiresAt: now() + CONFIG.CODE_TYPES[type].ms, createdBy: req.adminSession.username
    };
    await fbSet(`students/${code}`, record);
    res.json({ success: true, data: { code, ...record } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.patch("/api/admin/students/:code", requireAdmin, async (req, res) => {
  try {
    const code = req.params.code;
    const s = await fbGet(`students/${code}`);
    if (!s) return jsonError(res, 404, "غير موجود");
    const patch = {};
    if (req.body.name != null) patch.name = String(req.body.name).trim();
    if (req.body.section != null) patch.section = String(req.body.section).trim() || null;
    if (req.body.maxDevices != null) patch.maxDevices = Math.max(1, Math.min(10, Number(req.body.maxDevices)));
    if (req.body.active != null) patch.active = Boolean(req.body.active);
    if (req.body.type && CONFIG.CODE_TYPES[req.body.type]) {
      patch.type = req.body.type;
      if (req.body.renew) patch.expiresAt = now() + CONFIG.CODE_TYPES[req.body.type].ms;
    }
    if (req.body.extendMs) {
      const base = Math.max(s.expiresAt || now(), now());
      patch.expiresAt = base + Number(req.body.extendMs);
    }
    await fbPatch(`students/${code}`, patch);
    res.json({ success: true, data: { code, ...s, ...patch } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.delete("/api/admin/students/:code", requireAdmin, async (req, res) => {
  try {
    const code = req.params.code;
    const sessions = (await fbGet("sessions")) || {};
    for (const [tok, sess] of Object.entries(sessions)) {
      if (sess && sess.code === code) {
        studentSessions.delete(tok);
        await fbDelete(`sessions/${tok}`);
      }
    }
    await fbDelete(`students/${code}`);
    res.json({ success: true });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.delete("/api/admin/students/:code/devices/:deviceId", requireAdmin, async (req, res) => {
  try {
    const { code, deviceId } = req.params;
    const s = await fbGet(`students/${code}`);
    if (!s) return jsonError(res, 404, "غير موجود");
    const devices = { ...(s.devices || {}) };
    delete devices[deviceId];
    await fbSet(`students/${code}/devices`, devices);
    const sessions = (await fbGet("sessions")) || {};
    for (const [tok, sess] of Object.entries(sessions)) {
      if (sess && sess.code === code && sess.deviceId === deviceId) {
        studentSessions.delete(tok);
        await fbDelete(`sessions/${tok}`);
      }
    }
    res.json({ success: true, message: "تم تسجيل خروج الجهاز" });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ success: false, message: "Not found" });
  if (req.path.endsWith(".html")) return res.sendFile(path.join(__dirname, "public", req.path));
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

setInterval(() => {
  const t = now();
  for (const [k, s] of studentSessions) if (s.expiresAt && t > s.expiresAt) studentSessions.delete(k);
  for (const [k, s] of adminSessions) if (s.expiresAt && t > s.expiresAt) adminSessions.delete(k);
  for (const [k, s] of streamSessions) if (t - (s.lastUsed || s.createdAt) > CONFIG.STREAM_SESSION_MS) streamSessions.delete(k);
}, 60_000).unref();

await loadDecryptionUtils();

app.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`[API] :${CONFIG.PORT} · decrypt ON`);
});
