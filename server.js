/**
 * OPEN TEST BUILD — NO LOGIN / NO AUTH / NO FIREBASE. Run on localhost only, never expose publicly:
 * anyone who can reach it can use the shared Coursatk token.
 *
 * Coursatk API — protected backend (original description below)
 * - Student codes (7-digit) + devices + sessions in Firebase RTDB
 * - Admin panel API (users, permissions, sections, subject IDs)
 * - Stream-Weave key unwrap + AES-128 segment decrypt (upstream token NEVER leaves server)
 * - All student/catalog/stream routes require valid session token
 */
import express from "express";
import cors from "cors";
import compression from "compression";
import crypto from "node:crypto";
import https from "node:https";
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

// ═══════════════════════════════════════════════════════════
// Rate limit — ~50 req / minute / IP (stricter on auth)
// ═══════════════════════════════════════════════════════════
const rateBuckets = new Map();

function clientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.ip || req.socket?.remoteAddress || "unknown";
}

function rateLimit(options = {}) {
  const windowMs = options.windowMs || 60_000;
  const max = options.max || 50;
  const keyFn = options.keyFn || ((req) => clientIp(req) + ":" + (options.scope || "global"));
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let b = rateBuckets.get(key);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(key, b);
    }
    b.count += 1;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - b.count)));
    if (b.count > max) {
      return res.status(429).json({
        success: false,
        message: "طلبات كثيرة — حاول بعد دقيقة"
      });
    }
    next();
  };
}

setInterval(() => {
  const t = Date.now();
  for (const [k, b] of rateBuckets) {
    if (t > b.resetAt) rateBuckets.delete(k);
  }
}, 60_000).unref();



// ═══════════════════════════════════════════════════════════
// CONFIG (in-code — no Railway vars required for core secrets)
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  // Upstream Coursatk — stays SERVER-SIDE only
  COURSATK_API: "https://api.coursatk.online/api/v1",
  COURSATK_TOKEN:
    process.env.COURSATK_TOKEN ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxMDk1NTUsInJvbGUiOiJzdHVkZW50IiwidXVpZCI6IjU3OGIxNjBjMjgxZWVkY2Y1ZTY4MjViNDZmMWExNTY0In0.x9vV-N_13KcrGbx-y9owTgGdirKpKh_X0JXDpolYegs",
  DEFAULT_YEAR_ID: 4,
  STREAM_HOSTS: [
    "api.coursatk.online",
    "stream-weave.com",
    "floravon.online",
    "floravon.shop",   // new CDN domain used for segments
    "c-cdn.online"
  ],
  STREAM_ORIGIN: "https://coursatk.online",
  STREAM_REFERER: "https://coursatk.online/",
  STREAM_X_REQUESTED_WITH: "com.mycompany.app.soulbrowser",
  STREAM_UA:
    "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
  PLAYER_JS: "https://player.stream-weave.com/assets/player.js?v=1.1.1",
  // Session TTL
  STREAM_SESSION_MS: 15 * 60 * 1000,
  MAX_PROXY_BYTES: 12 * 1024 * 1024
};
if (!CONFIG.COURSATK_TOKEN) {
  console.warn("[config] COURSATK_TOKEN غير مضبوط في Variables — طلبات كورساتك هتفشل");
}

function now() {
  return Date.now();
}

// Upstream token (from COURSATK_TOKEN env or the in-code fallback)
async function getCoursatkToken() {
  return CONFIG.COURSATK_TOKEN;
}

// ═══════════════════════════════════════════════════════════
// Stream sessions (in memory)
// ═══════════════════════════════════════════════════════════
const streamSessions = new Map();

function jsonError(res, status, message) {
  return res.status(status).json({ success: false, message });
}

// ── Student auth middleware ──
async function requireStudent(req, _res, next) {
  // OPEN TEST BUILD: no login, no Firebase lookups
  req.student = { code: "OPEN", active: true, section: null, devices: {} };
  req.session = { code: "OPEN", deviceId: null };
  req.sessionToken = "open";
  next();
}

// ═══════════════════════════════════════════════════════════
// Stream-Weave decrypt (server-only)
// ═══════════════════════════════════════════════════════════
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
  const wrapped = Buffer.isBuffer(wrappedBuf)
    ? new Uint8Array(wrappedBuf)
    : new Uint8Array(wrappedBuf);
  if (wrapped.byteLength === 16) return Buffer.from(wrapped);
  const result = await decryptPlaybackKeyFn(wrapped, String(videoId));
  const key = result?.key;
  if (!key) throw new Error("empty key");
  const aes = Buffer.isBuffer(key)
    ? key
    : key instanceof ArrayBuffer
      ? Buffer.from(key)
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

// Upstream helpers (token never exposed)
async function upstreamHeaders(extra = {}) {
  const tok = await getCoursatkToken();
  return {
    Authorization: `Bearer ${tok}`,
    Accept: "application/json",
    "User-Agent": CONFIG.STREAM_UA,
    Origin: CONFIG.STREAM_ORIGIN,
    Referer: CONFIG.STREAM_REFERER,
    "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.7,en;q=0.6",
    ...extra
  };
}

async function upstreamJson(apiPath, options = {}) {
  const r = await fetch(`${CONFIG.COURSATK_API}${apiPath}`, {
    ...options,
    headers: await upstreamHeaders(options.headers || {}),
    signal: AbortSignal.timeout(15_000)
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch {
    console.error("[upstream-fail]", {
      path: apiPath, status: r.status, server: r.headers.get("server"),
      cfRay: r.headers.get("cf-ray"), body: text.slice(0, 200)
    });
    throw new Error(`Upstream non-JSON (${r.status})`);
  }
  if (!r.ok) {
    console.error("[upstream-fail]", {
      path: apiPath, status: r.status, server: r.headers.get("server"),
      cfRay: r.headers.get("cf-ray"), body: text.slice(0, 200)
    });
    // include the real HTTP status so it is visible in the browser response
    throw new Error(`${data?.message || "Upstream error"} (HTTP ${r.status})`);
  }
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
  } catch {
    return false;
  }
}

async function streamFetch(session, url, extra = {}, clientHeaders = null) {
  if (!allowedStreamUrl(url, session)) throw new Error(`URL غير مسموح: ${url}`);
  const ch = clientHeaders || {};
  const headers = {
    Accept: "*/*",
    "Cache-Control": "no-cache",
    Origin: CONFIG.STREAM_ORIGIN,
    Referer: CONFIG.STREAM_REFERER,
    "X-Requested-With": CONFIG.STREAM_X_REQUESTED_WITH,
    "User-Agent": ch["user-agent"] || CONFIG.STREAM_UA
  };

  // Master playlist + key on api.stream-weave.com NEED Authorization.
  // Actual media segments on floravon.* / c-cdn.* use only the query token
  // and must NOT receive Authorization (browser also doesn't send it).
  const mediaHost = isMediaHost(url);
  if (!mediaHost && session?.token) {
    headers.Authorization = `Bearer ${session.token}`;
  }
  if (mediaHost) {
    // mimic the plain request the working script sends to the CDN
    delete headers["Cache-Control"];
    delete headers["X-Requested-With"];
    headers["Accept-Encoding"] = "identity";
  } else {
    for (const name of [
      "sec-ch-ua-platform", "sec-ch-ua", "sec-ch-ua-mobile",
      "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "accept-language"
    ]) {
      if (ch[name]) headers[name] = ch[name];
    }
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v != null && v !== "") headers[k] = v;
  }
  return mediaHost ? fetch(url, { headers }) : fetch(url, { headers, cache: "no-store" });
}

// Hosts that need the Bearer token: only the stream-weave / coursatk APIs (master + key).
// Everything else (floravon.*, c-cdn.*, any future CDN domain) uses the URL token only.
function isMediaHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const api = h === "stream-weave.com" || h.endsWith(".stream-weave.com") ||
      h === "coursatk.online" || h.endsWith(".coursatk.online");
    return !api;
  } catch {
    return false;
  }
}

// Raw HTTP/1.1 segment fetch — byte-for-byte the same headers as the working script:
// no Authorization, no sec-*, no X-Requested-With, Accept-Encoding: identity.
const SEG_UA = process.env.SEG_UA ||
  "Mozilla/5.0 (Linux; Android 15; CPH2591 Build/AP3A.240617.008) AppleWebKit/537.36 (KHTML, like Gecko) Jrryilw/4.0 Chrome/155.0.8059.43 Mobile Safari/537.36";
const segAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

function rawSegmentFetch(url, range = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {
      Origin: CONFIG.STREAM_ORIGIN,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
      "Accept-Encoding": "identity",
      "User-Agent": SEG_UA,
      Referer: CONFIG.STREAM_REFERER,
      Host: u.host,
      Connection: "Keep-Alive"
    };
    if (range) headers.Range = range;
    const rq = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "GET",
        headers,
        agent: segAgent,
        timeout: 20_000
      },
      (r) => {
        const chunks = [];
        let size = 0;
        r.on("data", (c) => {
          size += c.length;
          if (size > CONFIG.MAX_PROXY_BYTES * 2) { rq.destroy(new Error("segment too large")); return; }
          chunks.push(c);
        });
        r.on("end", () => {
          const buf = Buffer.concat(chunks);
          const st = r.statusCode || 0;
          resolve({
            ok: st >= 200 && st < 300,
            status: st,
            headers: { get: (n) => r.headers[String(n).toLowerCase()] ?? null },
            text: async () => buf.toString("utf8"),
            arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
          });
        });
        r.on("error", reject);
      }
    );
    rq.on("timeout", () => rq.destroy(new Error("segment timeout")));
    rq.on("error", reject);
    rq.end();
  });
}


// ═══════════════════════════════════════════════════════════
// PUBLIC (no auth)
// ═══════════════════════════════════════════════════════════
const globalLimiter = rateLimit({ max: 50, windowMs: 60_000, scope: "global" });
app.use((req, res, next) =>
  req.path.startsWith("/api/stream/") ? next() : globalLimiter(req, res, next)
);

// Debug (open build): /api/debug/upstream?path=/user/lectures/5548/content
app.get("/api/debug/upstream", async (req, res) => {
  const apiPath = String(req.query.path || `/user/subjects/${CONFIG.DEFAULT_YEAR_ID}`);
  const out = {};
  const timed = async (name, fn) => {
    const t0 = Date.now();
    try { out[name] = { ...(await fn()), ms: Date.now() - t0 }; }
    catch (e) { out[name] = { error: e.message, ms: Date.now() - t0 }; }
  };
  const probe = async (headers) => {
    const r = await fetch(`${CONFIG.COURSATK_API}${apiPath}`, { headers, signal: AbortSignal.timeout(15_000) });
    return {
      status: r.status,
      server: r.headers.get("server"),
      cfRay: r.headers.get("cf-ray"),
      body: (await r.text()).slice(0, 200)
    };
  };
  const tok = await getCoursatkToken();
  await timed("outbound_ip", async () => ({
    ip: await (await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(8000) })).text()
  }));
  await timed("plain_headers", () => probe({ Authorization: `Bearer ${tok}`, Accept: "application/json" }));
  await timed("browser_headers", async () => probe(await upstreamHeaders()));
  res.json({ path: apiPath, ...out });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "coursatk-protected-api",
    cryptoReady: Boolean(decryptPlaybackKeyFn),
    decryptSegments: true,
    now: new Date().toISOString()
  });
});

// ═══════════════════════════════════════════════════════════
// CATALOG (student token required) — proxies upstream, hides COURSATK token
// ═══════════════════════════════════════════════════════════
app.get("/api/config", requireStudent, async (req, res) => {
  let yearId = CONFIG.DEFAULT_YEAR_ID;
  let subjectIds = [];
  res.json({
    success: true,
    yearId,
    subjectIds,
    cryptoReady: Boolean(decryptPlaybackKeyFn),
    decryptSegments: true
  });
});

app.get("/api/subjects/:id", requireStudent, async (req, res) => {
  try {
    // 1) Load section subject IDs (fixed catalog per شعبة)
    let wantedIds = [];
    let yearId = Number(req.params.id) || CONFIG.DEFAULT_YEAR_ID;
    // 2) Fetch year subjects once (upstream list)
    const yearData = await upstreamJson(`/user/subjects/${encodeURIComponent(yearId)}`);
    let yearList = Array.isArray(yearData.data) ? yearData.data : [];
    const byId = new Map(yearList.map((s) => [Number(s.id), s]));

    // 3) If no section filter → return full year list
    if (!wantedIds.length) {
      return res.json({ ...yearData, data: yearList });
    }

    // 4) For each fixed ID: use year list, otherwise fetch via /teachers
    //    (coursatk returns subject name+image on teachers endpoint)
    const results = [];
    for (const sid of wantedIds) {
      if (byId.has(sid)) {
        results.push(byId.get(sid));
        continue;
      }
      try {
        const t = await upstreamJson(`/user/subjects/${sid}/teachers`);
        const d = t?.data;
        if (d && (d.id || d.name)) {
          results.push({
            id: Number(d.id) || sid,
            name: d.name || `مادة ${sid}`,
            image_url: d.image_url || null,
            year_id: yearId,
            is_published: true,
            order_index: results.length + 1
          });
        } else {
          results.push({
            id: sid,
            name: `مادة ${sid}`,
            image_url: null,
            year_id: yearId,
            is_published: true,
            order_index: results.length + 1
          });
        }
      } catch (err) {
        console.warn(`[subjects] resolve ${sid}:`, err.message);
        results.push({
          id: sid,
          name: `مادة ${sid}`,
          image_url: null,
          year_id: yearId,
          is_published: true,
          order_index: results.length + 1
        });
      }
    }

    res.json({
      success: true,
      message: "Success",
      data: results
    });
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.get("/api/subjects/:id/teachers", requireStudent, async (req, res) => {
  try {
    res.json(
      await upstreamJson(`/user/subjects/${encodeURIComponent(req.params.id)}/teachers`)
    );
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.get("/api/teachers/:id/chapters", requireStudent, async (req, res) => {
  try {
    res.json(
      await upstreamJson(`/user/teachers/${encodeURIComponent(req.params.id)}/chapters`)
    );
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.get("/api/chapters/:id/lectures", requireStudent, async (req, res) => {
  try {
    res.json(
      await upstreamJson(`/user/chapters/${encodeURIComponent(req.params.id)}/lectures`)
    );
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.get("/api/lectures/:id/content", requireStudent, async (req, res) => {
  try {
    res.json(
      await upstreamJson(`/user/lectures/${encodeURIComponent(req.params.id)}/content`)
    );
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

// ═══════════════════════════════════════════════════════════
// STREAM (student token) — decrypted segments
// ═══════════════════════════════════════════════════════════
app.post("/api/play/:videoId", requireStudent, async (req, res) => {
  try {
    const data = await upstreamJson(
      `/video/${encodeURIComponent(req.params.videoId)}/stream-weave/play`,
      { method: "POST", headers: { Accept: "application/json" } }
    );
    if (!data?.success || !data?.data?.token || !data?.data?.stream_url || !data?.data?.video_id) {
      throw new Error("Playback response ناقص");
    }
    const id = crypto.randomUUID();
    streamSessions.set(id, {
      id,
      videoId: String(data.data.video_id),
      token: data.data.token,
      streamUrl: data.data.stream_url,
      playId: String(req.params.videoId),
      createdAt: now(),
      lastUsed: now(),
      plainKey: null,
      defaultIv: null,
      allowedHosts: new Set([new URL(data.data.stream_url).hostname]),
      ownerCode: req.session.code
    });
    res.json({
      success: true,
      data: {
        session: id,
        video_id: data.data.video_id,
        manifest_url: `/api/stream/manifest/${id}`
      }
    });
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

function getStreamSession(id) {
  const s = streamSessions.get(id);
  if (!s) return null;
  const last = s.lastUsed || s.createdAt;
  if (now() - last > CONFIG.STREAM_SESSION_MS) {
    streamSessions.delete(id);
    return null;
  }
  s.lastUsed = now();
  return s;
}

// Re-issue playback token when upstream returns 401 on the master playlist
async function refreshPlayback(session) {
  const data = await upstreamJson(
    `/video/${encodeURIComponent(session.playId)}/stream-weave/play`,
    { method: "POST", headers: { Accept: "application/json" } }
  );
  if (!data?.success || !data?.data?.token || !data?.data?.stream_url) {
    throw new Error("فشل تجديد التوكن");
  }
  session.token = data.data.token;
  session.streamUrl = data.data.stream_url;
  try { session.allowedHosts.add(new URL(session.streamUrl).hostname); } catch {}
  session.lastUsed = now();
  console.log(`[refresh] playback token renewed for ${session.videoId}`);
}

app.get("/api/stream/manifest/:sessionId", requireStudent, async (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) return jsonError(res, 404, "جلسة التشغيل منتهية");
  if (session.ownerCode !== req.session.code) {
    return jsonError(res, 403, "جلسة تشغيل ليست لك");
  }

  try {
    let master = await streamFetch(session, session.streamUrl, {}, req.headers);
    if (master.status === 401 && session.playId) {
      await refreshPlayback(session);
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
        await refreshPlayback(session);
        variantRes = await streamFetch(session, variant, {}, req.headers);
      }
      if (!variantRes.ok) throw new Error(`Variant HTTP ${variantRes.status}`);
      return rewritePlaylist(
        req.params.sessionId, session, await variantRes.text(), variant, res, req.headers
      );
    }
    return rewritePlaylist(
      req.params.sessionId, session, masterText, session.streamUrl, res, req.headers
    );
  } catch (e) {
    console.error("[manifest]", e.message);
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
        console.log(`[key] unwrapped for ${session.videoId}`);
      }
      continue; // strip KEY — segments are plain
    }
    if (line && !line.startsWith("#")) {
      const segmentUrl = new URL(line, baseUrl).href;
      try { session.allowedHosts.add(new URL(segmentUrl).hostname); } catch {}
      const seq = mediaSeq + segIndex;
      const iv = currentIv || ivFromMediaSequence(seq);
      const payload = Buffer.from(
        JSON.stringify({ u: segmentUrl, iv: iv.toString("hex"), s: seq }),
        "utf8"
      ).toString("base64url");
      out.push(`/api/stream/segment/${sessionId}/${payload}`);
      segIndex++;
      continue;
    }
    out.push(raw);
  }
  if (!session.plainKey) throw new Error("فشل تجهيز مفتاح التشفير");

  res.set({
    "Content-Type": "application/vnd.apple.mpegurl",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.send(out.join("\n"));
}

app.get("/api/stream/segment/:sessionId/:encoded", requireStudent, async (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) return jsonError(res, 404, "جلسة التشغيل منتهية");
  if (session.ownerCode !== req.session.code) return jsonError(res, 403, "جلسة ليست لك");
  if (!session.plainKey) return jsonError(res, 404, "مفتاح غير متاح");

  let meta;
  try {
    meta = JSON.parse(Buffer.from(req.params.encoded, "base64url").toString("utf8"));
  } catch {
    return jsonError(res, 400, "segment meta غير صالح");
  }
  const url = meta?.u;
  if (!url || !allowedStreamUrl(url, session)) return jsonError(res, 403, "رابط غير مسموح");

  const iv = parseIvHex(meta.iv) || session.defaultIv || ivFromMediaSequence(meta.s || 0);
  try {
    let upstream = await rawSegmentFetch(url, req.headers.range || null);
    if (upstream.status === 401 || upstream.status === 403) {
      const retry = await streamFetch(session, url, { Range: req.headers.range || undefined }, req.headers);
      if (retry.ok || retry.status === 206) upstream = retry;
    }
    if (!upstream.ok && upstream.status !== 206) {
      const body = (await upstream.text().catch(() => "")).slice(0, 300);
      console.error("[segment-fail]", {
        status: upstream.status,
        host: new URL(url).hostname,
        server: upstream.headers.get("server"),
        cfRay: upstream.headers.get("cf-ray"),
        ageSec: Math.round((now() - session.createdAt) / 1000),
        body
      });
      throw new Error(`Segment HTTP ${upstream.status}`);
    }
    const encrypted = Buffer.from(await upstream.arrayBuffer());
    if (encrypted.length > CONFIG.MAX_PROXY_BYTES) {
      return jsonError(res, 413, "المقطع كبير");
    }
    let plain;
    try {
      plain = decryptSegment(encrypted, session.plainKey, iv);
    } catch (decErr) {
      console.warn("[segment-decrypt-fail]", {
        host: new URL(url).hostname,
        len: encrypted.length,
        err: decErr.message
      });
      plain = encrypted; // fallback: send as-is (may still fail to play)
    }
    res.status(200);
    res.set({
      "Content-Type": "video/mp2t",
      "Content-Length": String(plain.length),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    res.send(plain);
  } catch (e) {
    if (!res.headersSent) jsonError(res, 502, e.message);
    else res.end();
  }
});

// ═══════════════════════════════════════════════════════════
// Fallback
// ═══════════════════════════════════════════════════════════
// Root / unknown — require client handshake (no API dump)
app.get("/", (_req, res) => {
  res.json({ ok: true, mode: "open-test", note: "افتح test.html وحط رابط السيرفر" });
});

app.use((req, res) => {
  res.status(403).json({
    success: false,
    message: "خطأ: يلزم مصادقة أو المسار غير موجود.",
    path: req.path
  });
});

// Cleanup timers
setInterval(() => {
  const t = now();
  for (const [k, s] of streamSessions) {
    if (t - (s.lastUsed || s.createdAt) > CONFIG.STREAM_SESSION_MS) streamSessions.delete(k);
  }
}, 60_000).unref();

// Boot: load decrypt utils (non-fatal — server still starts, /health shows cryptoReady)
try {
  await loadDecryptionUtils();
} catch (e) {
  console.warn("[crypto] تحميل أدوات فك التشفير فشل:", e.message);
}

app.listen(CONFIG.PORT, () => {
  console.log(`[API] :${CONFIG.PORT} OPEN TEST BUILD (no auth) · segment-decrypt ON`);
});
