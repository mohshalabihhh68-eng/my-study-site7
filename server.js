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

// تقديم ملفات الويب
app.use(express.static(path.join(__dirname, "public")));

// Rate Limiting (حماية بسيطة)
const rateBuckets = new Map();
function rateLimit(options = {}) {
  const windowMs = options.windowMs || 60_000;
  const max = options.max || 150;
  return (req, res, next) => {
    const key = (req.ip || "unknown") + ":" + (options.scope || "global");
    const now = Date.now();
    let b = rateBuckets.get(key);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) return res.status(429).json({ success: false, message: "طلبات كثيرة" });
    next();
  };
}

const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  COURSATK_API: "https://api.coursatk.online/api/v1",
  COURSATK_TOKEN:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxMDk1NTUsInJvbGUiOiJzdHVkZW50IiwidXVpZCI6IjU3OGIxNjBjMjgxZWVkY2Y1ZTY4MjViNDZmMWExNTY0In0.x9vV-N_13KcrGbx-y9owTgGdirKpKh_X0JXDpolYegs",
  DEFAULT_YEAR_ID: 4,
  STREAM_HOSTS: ["api.coursatk.online", "stream-weave.com", "floravon.online", "floravon.shop", "c-cdn.online"],
  STREAM_ORIGIN: "https://coursatk.online",
  STREAM_REFERER: "https://coursatk.online/",
  STREAM_X_REQUESTED_WITH: "com.mycompany.app.soulbrowser",
  STREAM_UA: "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
  PLAYER_JS: "https://player.stream-weave.com/assets/player.js?v=1.1.1",
  STREAM_SESSION_MS: 60 * 60 * 1000,
  MAX_PROXY_BYTES: 15 * 1024 * 1024,
};

async function upstreamHeaders(extra = {}) {
  return { Authorization: `Bearer ${CONFIG.COURSATK_TOKEN}`, Accept: "application/json", ...extra };
}

async function upstreamJson(apiPath, options = {}) {
  const r = await fetch(`${CONFIG.COURSATK_API}${apiPath}`, {
    ...options,
    headers: await upstreamHeaders(options.headers || {})
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Upstream non-JSON (${r.status})`); }
  if (!r.ok) throw new Error(data?.message || `Upstream HTTP ${r.status}`);
  return data;
}

let decryptPlaybackKeyFn = null;

async function loadDecryptionUtils() {
  const cachePath = path.join(__dirname, "player.stream-weave.cache.js");
  let source = null;
  try { if (fs.existsSync(cachePath)) source = fs.readFileSync(cachePath, "utf8"); } catch {}
  if (!source) {
    const r = await fetch(CONFIG.PLAYER_JS, { headers: { "User-Agent": "Mozilla/5.0" } });
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
    document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }), head: { appendChild() {} }, body: { appendChild() {} }, querySelector: () => null, addEventListener() {} },
    navigator: { userAgent: "Node" }, location: { href: "https://coursatk.online/" },
    HTMLElement: class {}, HTMLVideoElement: class {}, MediaSource: class {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} }, Blob: class { constructor(p) { this.p = p; } },
    fetch: async () => ({ ok: false }), XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} }
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox; sandbox.global = sandbox;
  vm.runInNewContext(source, sandbox, { timeout: 8000 });
  const du = sandbox.DecryptionUtils;
  if (!du?.decryptPlaybackKey) throw new Error("DecryptionUtils missing");
  decryptPlaybackKeyFn = du.decryptPlaybackKey.bind(du);
}

async function unwrapKey(wrappedBuf, videoId) {
  if (!decryptPlaybackKeyFn) throw new Error("crypto not loaded");
  const wrapped = Buffer.isBuffer(wrappedBuf) ? new Uint8Array(wrappedBuf) : new Uint8Array(wrappedBuf);
  if (wrapped.byteLength === 16) return Buffer.from(wrapped);
  const result = await decryptPlaybackKeyFn(wrapped, String(videoId));
  const key = result?.key;
  if (!key) throw new Error("empty key");
  const aes = Buffer.isBuffer(key) ? key : key instanceof ArrayBuffer ? Buffer.from(key) : Buffer.from(key.buffer || key, key.byteOffset || 0, key.byteLength || key.length);
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

function allowedStreamUrl(raw, session = null) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const hosts = new Set(CONFIG.STREAM_HOSTS);
    if (session?.allowedHosts) for (const h of session.allowedHosts) hosts.add(h);
    if (session?.streamUrl) { try { hosts.add(new URL(session.streamUrl).hostname); } catch {} }
    return [...hosts].some(h => u.hostname === h || u.hostname.endsWith("." + h));
  } catch { return false; }
}

async function streamFetch(session, url, extra = {}, clientHeaders = null) {
  if (!allowedStreamUrl(url, session)) throw new Error(`URL غير مسموح: ${url}`);
  const ch = clientHeaders || {};
  const headers = {
    Accept: "*/*", "Cache-Control": "no-cache", Origin: CONFIG.STREAM_ORIGIN, Referer: CONFIG.STREAM_REFERER,
    "X-Requested-With": CONFIG.STREAM_X_REQUESTED_WITH, "User-Agent": ch["user-agent"] || CONFIG.STREAM_UA
  };
  const isMediaSegmentHost = /floravon\.(online|shop)|c-cdn\.online/i.test(url);
  if (!isMediaSegmentHost && session?.token) headers.Authorization = `Bearer ${session.token}`;
  for (const name of ["sec-ch-ua-platform", "sec-ch-ua", "sec-ch-ua-mobile", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "accept-language"]) {
    if (ch[name]) headers[name] = ch[name];
  }
  for (const [k, v] of Object.entries(extra || {})) { if (v != null && v !== "") headers[k] = v; }
  return fetch(url, { headers, cache: "no-store" });
}

const globalLimiter = rateLimit({ max: 150, windowMs: 60_000, scope: "global" });
app.use((req, res, next) => req.path.startsWith("/api/stream/") ? next() : globalLimiter(req, res, next));

app.get("/health", (_req, res) => { res.json({ ok: true, cryptoReady: Boolean(decryptPlaybackKeyFn) }); });

app.get("/api/subjects/:id", async (req, res) => {
  try {
    const yearId = Number(req.params.id) || CONFIG.DEFAULT_YEAR_ID;
    res.json(await upstreamJson(`/user/subjects/${encodeURIComponent(yearId)}`));
  } catch (e) { res.status(502).json({ success: false, message: e.message }); }
});

app.get("/api/subjects/:id/teachers", async (req, res) => {
  try { res.json(await upstreamJson(`/user/subjects/${encodeURIComponent(req.params.id)}/teachers`)); } catch (e) { res.status(502).json({ success: false, message: e.message }); }
});

app.get("/api/teachers/:id/chapters", async (req, res) => {
  try { res.json(await upstreamJson(`/user/teachers/${encodeURIComponent(req.params.id)}/chapters`)); } catch (e) { res.status(502).json({ success: false, message: e.message }); }
});

app.get("/api/chapters/:id/lectures", async (req, res) => {
  try { res.json(await upstreamJson(`/user/chapters/${encodeURIComponent(req.params.id)}/lectures`)); } catch (e) { res.status(502).json({ success: false, message: e.message }); }
});

app.get("/api/lectures/:id/content", async (req, res) => {
  try { res.json(await upstreamJson(`/user/lectures/${encodeURIComponent(req.params.id)}/content`)); } catch (e) { res.status(502).json({ success: false, message: e.message }); }
});

const streamSessions = new Map();

app.post("/api/play/:videoId", async (req, res) => {
  try {
    const data = await upstreamJson(`/video/${encodeURIComponent(req.params.videoId)}/stream-weave/play`, { method: "POST", headers: { Accept: "application/json" } });
    if (!data?.success || !data?.data?.token || !data?.data?.stream_url || !data?.data?.video_id) throw new Error("Playback response ناقص");
    const id = crypto.randomUUID();
    streamSessions.set(id, {
      id, videoId: String(data.data.video_id), token: data.data.token, streamUrl: data.data.stream_url,
      playId: String(req.params.videoId), createdAt: Date.now(), lastUsed: Date.now(),
      plainKey: null, defaultIv: null, allowedHosts: new Set([new URL(data.data.stream_url).hostname])
    });
    res.json({ success: true, data: { session: id, video_id: data.data.video_id, manifest_url: `/api/stream/manifest/${id}` } });
  } catch (e) { res.status(502).json({ success: false, message: e.message }); }
});

function getStreamSession(id) {
  const s = streamSessions.get(id);
  if (!s) return null;
  const last = s.lastUsed || s.createdAt;
  if (Date.now() - last > CONFIG.STREAM_SESSION_MS) { streamSessions.delete(id); return null; }
  s.lastUsed = Date.now();
  return s;
}

app.get("/api/stream/manifest/:sessionId", async (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) return res.status(404).json({ success: false, message: "جلسة التشغيل منتهية" });
  try {
    let master = await streamFetch(session, session.streamUrl, {}, req.headers);
    if (!master.ok) throw new Error(`Stream master HTTP ${master.status}`);
    const masterText = await master.text();
    const lines = masterText.split(/\r?\n/);
    let variant = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("#EXT-X-STREAM-INF")) {
        const next = lines[i + 1]?.trim();
        if (next && !next.startsWith("#")) { variant = new URL(next, session.streamUrl).href; break; }
      }
    }
    if (variant) {
      let variantRes = await streamFetch(session, variant, {}, req.headers);
      if (!variantRes.ok) throw new Error(`Variant HTTP ${variantRes.status}`);
      return rewritePlaylist(req.params.sessionId, session, await variantRes.text(), variant, res, req.headers);
    }
    return rewritePlaylist(req.params.sessionId, session, masterText, session.streamUrl, res, req.headers);
  } catch (e) { res.status(502).json({ success: false, message: e.message }); }
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
        session.defaultIv = currentIv; keyFetched = true;
      } else if (uri && !keyFetched) {
        const keyUrl = new URL(uri, baseUrl).href;
        try { session.allowedHosts.add(new URL(keyUrl).hostname); } catch {}
        const keyRes = await streamFetch(session, keyUrl, {}, clientHeaders);
        if (!keyRes.ok) throw new Error(`Key HTTP ${keyRes.status}`);
        const wrapped = Buffer.from(await keyRes.arrayBuffer());
        session.plainKey = await unwrapKey(wrapped, session.videoId);
        session.defaultIv = currentIv; keyFetched = true;
      }
      continue;
    }
    if (line && !line.startsWith("#")) {
      const segmentUrl = new URL(line, baseUrl).href;
      try { session.allowedHosts.add(new URL(segmentUrl).hostname); } catch {}
      const seq = mediaSeq + segIndex;
      const iv = currentIv || ivFromMediaSequence(seq);
      const payload = Buffer.from(JSON.stringify({ u: segmentUrl, iv: iv.toString("hex"), s: seq }), "utf8").toString("base64url");
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

app.get("/api/stream/segment/:sessionId/:encoded", async (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) return res.status(404).json({ success: false, message: "جلسة التشغيل منتهية" });
  if (!session.plainKey) return res.status(404).json({ success: false, message: "مفتاح غير متاح" });
  let meta;
  try { meta = JSON.parse(Buffer.from(req.params.encoded, "base64url").toString("utf8")); } catch { return res.status(400).json({ success: false, message: "segment meta غير صالح" }); }
  const url = meta?.u;
  if (!url || !allowedStreamUrl(url, session)) return res.status(403).json({ success: false, message: "رابط غير مسموح" });
  const iv = parseIvHex(meta.iv) || session.defaultIv || ivFromMediaSequence(meta.s || 0);
  try {
    const upstream = await streamFetch(session, url, { Range: req.headers.range || undefined }, req.headers);
    if (!upstream.ok && upstream.status !== 206) throw new Error(`Segment HTTP ${upstream.status}`);
    const encrypted = Buffer.from(await upstream.arrayBuffer());
    if (encrypted.length > CONFIG.MAX_PROXY_BYTES) return res.status(413).json({ success: false, message: "المقطع كبير" });
    let plain;
    try { plain = decryptSegment(encrypted, session.plainKey, iv); } catch (decErr) { plain = encrypted; }
    res.status(200);
    res.set({ "Content-Type": "video/mp2t", "Content-Length": String(plain.length), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    res.send(plain);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ success: false, message: e.message }); else res.end();
  }
});

// ═══════════════════════════════════════════════════════════
// 🔥 السر هنا: توجيه أي مسار تاني لملف index.html
// ═══════════════════════════════════════════════════════════

app.get("*", (req, res) => {
  // لو مسار API مش معروف، رجع 404
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ success: false, message: "المسار غير موجود (API)" });
  }
  
  // أي مسار تاني (سواء / أو /anything) هيفتح index.html
  res.sendFile(path.join(__dirname, "public", "index.html"), (err) => {
    if (err) {
      res.status(404).send("ملف index.html مش موجود في فولدر public.");
    }
  });
});

setInterval(() => {
  const t = Date.now();
  for (const [k, s] of streamSessions) {
    if (t - (s.lastUsed || s.createdAt) > CONFIG.STREAM_SESSION_MS) streamSessions.delete(k);
  }
}, 60_000).unref();

await loadDecryptionUtils();

app.listen(CONFIG.PORT, () => {
  console.log(`[API] :${CONFIG.PORT} running · segment-decrypt ON`);
});
