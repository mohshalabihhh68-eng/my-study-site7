/**
 * Thanawya World API — Protected Backend
 * VERSION v1.8.0 — taleb.pro primary + coursatk/bunny optional — + Bunny/HossamEssa (iframe protect bypass) + anti-bulk-download
 */
import express from "express";
import cors from "cors";
import compression from "compression";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

let ProxyAgent = null;
let undiciFetch = null;
let undiciAgent = null;
try {
  const undici = await import("undici");
  ProxyAgent = undici.ProxyAgent;
  undiciFetch = undici.fetch;
  if (undici.Agent) {
    undiciAgent = new undici.Agent({
      allowH2: false,
      keepAliveTimeout: 10_000,
      connections: 24,
      connect: { timeout: 12_000, rejectUnauthorized: true }
    });
  }
} catch {
  console.warn("[API] undici not available — UPSTREAM_PROXY disabled");
}

import {
  thanawicaLogin,
  thSubjectsForYear,
  thTeachers,
  thChapters,
  thLectures,
  thLectureContent,
  thGetVideoSource,
  thResolveMp4Url,
  thMintAndFetchSegment,
  thResolvePlaylistHash,
  thResolveVideo,
  isChemOrMathName,
  chemMathKind,
  isThId,
  encodeThId,
  decodeThId,
  getThanawicaSessionInfo
} from "./thanawica.js";

// ===== taleb.pro adapter =====
import {
  buildTalebSource,
  getTalebTeachers,
  getTalebKey,
  getTalebPlaylist,
  TALEB_STREAM_HOSTS,
  updateTalebCookies
} from "./taleb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const TEMP_DIR = path.join(DATA_DIR, "temp_files");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch {}
const APP_VERSION = "v1.8.0";

process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", (r && r.stack) || r));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", (e && e.stack) || e));

function wrapAsync(fn) {
  return function (req, res, next) {
    try {
      const r = fn(req, res, next);
      if (r && typeof r.catch === "function") r.catch(next);
    } catch (e) {
      next(e);
    }
  };
}

const app = express();
for (const m of ["get", "post", "put", "patch", "delete", "use"]) {
  const orig = app[m].bind(app);
  app[m] = (...args) => {
    if (m === "get" && args.length === 1) return orig(...args);
    return orig(...args.map((a) => (typeof a === "function" && a.length < 4 ? wrapAsync(a) : a)));
  };
}
app.set("trust proxy", 1);
// CORS مفتوح لكل المواقع (أي Origin يُسمح له + credentials)
// لو حابب تقيّد لاحقًا: CORS_STRICT=1 + ALLOWED_ORIGINS=domain1,domain2
const ALLOWED_ORIGINS = new Set([
  "https://www.durosakplus.com",
  "https://durosakplus.com",
  "https://thanawya-club.up.railway.app",
  "https://thanawya-club.vercel.app",
  ...String(process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean)
]);
// Railway/Vercel public domain من البيئة
for (const envKey of ["RAILWAY_PUBLIC_DOMAIN", "RAILWAY_STATIC_URL", "VERCEL_URL"]) {
  const v = String(process.env[envKey] || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (v) {
    ALLOWED_ORIGINS.add("https://" + v);
    ALLOWED_ORIGINS.add("http://" + v);
  }
}
const CORS_STRICT = process.env.CORS_STRICT === "1";
app.use(cors({
  credentials: true,
  origin: (origin, cb) => {
    // بدون Origin (مثل curl/تطبيقات) → اسمح
    if (!origin) return cb(null, true);
    // وضع صارم: الدومينات المسموحة فقط
    if (CORS_STRICT) return cb(null, ALLOWED_ORIGINS.has(origin));
    // الافتراضي: افتح لكل المواقع واعكس الـ Origin عشان credentials تشتغل
    return cb(null, true);
  }
}));
app.use(express.json({ limit: "20mb" }));
// طلب Client Hints من المتصفح (موديل الجهاز وغيره)
app.use((req, res, next) => {
  res.setHeader(
    "Accept-CH",
    "Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List"
  );
  res.setHeader(
    "Permissions-Policy",
    "ch-ua-model=*, ch-ua-platform=*, ch-ua-platform-version=*, ch-ua-mobile=*"
  );
  res.setHeader("Critical-CH", "Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Mobile");
  next();
});
app.use(
  compression({
    level: 6,
    threshold: 512,
    filter: (req, res) => {
      const p = req.path || "";
      if (p.startsWith("/api/hls/") || p.startsWith("/api/stream/segment/") || p.startsWith("/api/file-proxy")) return false;
      if (p.includes("/messages/stream") || p.endsWith("/stream")) return false;
      return compression.filter(req, res);
    }
  })
);

app.use(express.static(path.join(__dirname, "public"), {
  maxAge: process.env.NODE_ENV === "production" ? "30d" : 0,
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    const base = String(filePath || "").replace(/\\/g, "/").toLowerCase();
    // track-visit لازم يتحدث فورًا — ممنوع كاش 30 يوم
    if (base.endsWith("/track-visit.js") || base.endsWith("track-visit.js")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    } else if (/\.(?:js|css|png|jpg|jpeg|webp|svg|woff2?|ico)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
    } else if (/\.html?$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=120, must-revalidate");
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
}));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const UPSTREAM_PROXY = (process.env.UPSTREAM_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "").trim();
const UPSTREAM_RELAY_URL = (process.env.UPSTREAM_RELAY_URL || "").trim().replace(/\/$/, "");
let proxyAgent = null;
if (UPSTREAM_PROXY && ProxyAgent) {
  try {
    proxyAgent = new ProxyAgent(UPSTREAM_PROXY);
    console.log("[API] UPSTREAM_PROXY enabled:", UPSTREAM_PROXY.replace(/:[^:@/]+@/, ":****@"));
  } catch (e) {
    console.warn("[API] UPSTREAM_PROXY invalid:", e.message);
  }
} else if (UPSTREAM_PROXY && !ProxyAgent) {
  console.warn("[API] UPSTREAM_PROXY set but undici/ProxyAgent unavailable");
}
if (UPSTREAM_RELAY_URL) console.log("[API] UPSTREAM_RELAY_URL:", UPSTREAM_RELAY_URL);

const UA_PROFILES = [
  {
    "User-Agent": "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
    "X-Requested-With": "com.mycompany.app.soulbrowser",
    Origin: "https://coursatk.online",
    Referer: "https://coursatk.online/"
  },
  {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    Origin: "https://coursatk.online",
    Referer: "https://coursatk.online/"
  },
  {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Origin: "https://coursatk.online",
    Referer: "https://coursatk.online/"
  },
  {
    "User-Agent": "okhttp/4.12.0",
    Accept: "application/json",
    Origin: "https://coursatk.online",
    Referer: "https://coursatk.online/"
  }
];

function isCloudflareBlock(status, text) {
  if (status !== 403 && status !== 503) return false;
  const s = String(text || "").slice(0, 800).toLowerCase();
  return s.includes("cloudflare") || s.includes("cf-ray") || s.includes("attention required") || s.includes("sorry, you have been blocked") || s.includes("cf-browser-verification");
}

async function rawFetch(url, opts = {}, timeout = 15_000) {
  const signal = opts.signal || AbortSignal.timeout(timeout);
  const fetchOpts = { ...opts, signal };
  // استخدم undici + HTTP/1.1 دائمًا لو متاح (يتجنب 426 من بعض الـ CDNs)
  if (undiciFetch) {
    const dispatcher = proxyAgent || undiciAgent || undefined;
    return undiciFetch(url, dispatcher ? { ...fetchOpts, dispatcher } : fetchOpts);
  }
  return fetch(url, fetchOpts);
}

async function relayFetch(url, opts = {}, timeout = 15_000) {
  if (!UPSTREAM_RELAY_URL) throw new Error("no relay");
  const method = (opts.method || "GET").toUpperCase();
  const headers = { ...(opts.headers || {}) };
  let bodyB64 = null;
  if (opts.body != null && method !== "GET" && method !== "HEAD") {
    if (Buffer.isBuffer(opts.body)) bodyB64 = opts.body.toString("base64");
    else if (typeof opts.body === "string") bodyB64 = Buffer.from(opts.body).toString("base64");
    else bodyB64 = Buffer.from(String(opts.body)).toString("base64");
  }
  const relayHeaders = { "Content-Type": "application/json", Accept: "application/json" };
  const relaySecret = (process.env.RELAY_SECRET || "").trim();
  if (relaySecret) relayHeaders["X-Relay-Secret"] = relaySecret;
  const relayRes = await rawFetch(UPSTREAM_RELAY_URL, {
    method: "POST",
    headers: relayHeaders,
    body: JSON.stringify({ url, method, headers, bodyBase64: bodyB64, timeout })
  }, timeout + 5_000);
  const ct = relayRes.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await relayRes.json();
    if (j.error && !j.status) throw new Error("relay: " + j.error);
    const status = j.status || relayRes.status;
    let buf;
    if (j.bodyBase64) buf = Buffer.from(j.bodyBase64, "base64");
    else if (typeof j.body === "string") buf = Buffer.from(j.body);
    else buf = Buffer.from(JSON.stringify(j.body ?? j));
    return new Response(buf, { status, headers: j.headers || { "content-type": j.contentType || "application/octet-stream" } });
  }
  return relayRes;
}

const UPSTREAM_FETCH_RETRIES = Number(process.env.UPSTREAM_FETCH_RETRIES || 7);
async function fetchT(url, opts = {}, { timeout = 15_000, retries = 0, retryOn = [429, 502, 503, 504, 408, 500] } = {}) {
  let lastErr;
  const tryRelay = Boolean(UPSTREAM_RELAY_URL);
  for (let a = 0; a <= retries; a++) {
    try {
      let r;
      try {
        r = await rawFetch(url, opts, timeout);
      } catch (e) {
        if (tryRelay) r = await relayFetch(url, opts, timeout);
        else throw e;
      }
      if (tryRelay && (r.status === 403 || r.status === 503)) {
        const peek = await r.clone().text().catch(() => "");
        if (isCloudflareBlock(r.status, peek)) {
          console.warn("[fetchT] CF block on direct → relay", String(url).slice(0, 80));
          r = await relayFetch(url, opts, timeout);
        }
      }
      if (a < retries && retryOn.includes(r.status)) {
        try { await r.arrayBuffer(); } catch {}
        lastErr = new Error("HTTP " + r.status);
        await delay(200 * (a + 1) + Math.random() * 150);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e && e.name === "TimeoutError" ? new Error(`timeout ${timeout}ms`) : e;
      if (a < retries) {
        await delay(200 * (a + 1) + Math.random() * 150);
        continue;
      }
    }
  }
  throw lastErr;
}

const inflight = new Map();
function coalesce(key, fn) {
  const hit = inflight.get(key);
  if (hit) return hit;
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function makeLimiter(max, maxQueue = 3000) {
  let active = 0;
  const q = [];
  const pump = () => {
    while (active < max && q.length) {
      const { fn, res, rej } = q.shift();
      active++;
      Promise.resolve().then(fn).then(res, rej).finally(() => { active--; pump(); });
    }
  };
  const run = (fn) => new Promise((res, rej) => {
    if (q.length >= maxQueue) {
      const e = new Error("السيرفر مشغول جدًا — جرّب بعد لحظات");
      e.status = 503;
      return rej(e);
    }
    q.push({ fn, res, rej });
    pump();
  });
  run.stats = () => ({ active, queued: q.length });
  return run;
}
const upstreamSlot = makeLimiter(Number(process.env.UPSTREAM_CONCURRENCY || 96));

const SEG_CACHE_MAX = Number(process.env.SEGMENT_CACHE_MB || 256) * 1024 * 1024;
const SEG_CACHE_TTL = 10 * 60_000;
const PREFETCH_AHEAD = Number(process.env.PREFETCH_AHEAD || 3);
const segCache = new Map();
let segCacheBytes = 0;
function segDel(k) {
  const e = segCache.get(k);
  if (e) { segCacheBytes -= e.buf.length; segCache.delete(k); }
}
function segGet(k) {
  const e = segCache.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { segDel(k); return null; }
  segCache.delete(k); segCache.set(k, e);
  return e.buf;
}
function segSet(k, buf) {
  if (buf.length > SEG_CACHE_MAX / 4) return;
  segDel(k);
  segCache.set(k, { buf, exp: Date.now() + SEG_CACHE_TTL });
  segCacheBytes += buf.length;
  for (const kk of segCache.keys()) {
    if (segCacheBytes <= SEG_CACHE_MAX) break;
    segDel(kk);
  }
}

const rateBuckets = new Map();
const banBuckets = new Map();

function clientIp(req) {
  // Railway / Cloudflare / البروكسيات: خُذ أول IP عام من السلسلة
  const candidates = [
    req.headers["cf-connecting-ip"],
    req.headers["true-client-ip"],
    req.headers["x-real-ip"],
    ...(String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim())),
    req.ip,
    req.socket?.remoteAddress
  ].filter(Boolean).map((s) => String(s).replace(/^::ffff:/, "").trim());

  const isPrivate = (ip) =>
    !ip ||
    ip === "unknown" ||
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("fe80");

  for (const ip of candidates) {
    if (!isPrivate(ip) && /^[\d.a-fA-F:]+$/.test(ip)) return ip;
  }
  return candidates[0] || "unknown";
}

function rateLimit(options = {}) {
  const windowMs = options.windowMs || 60_000;
  const max = options.max || 40;
  const scope = options.scope || "global";
  const banAfter = options.banAfter || 0;
  const banMs = options.banMs || 5 * 60_000;
  const skip = options.skip;
  const keyFn = options.keyFn;
  const limitMessage = options.message || "طلبات كثيرة — حاول بعد قليل";
  return (req, res, next) => {
    if (skip && skip(req)) return next();
    const ip = keyFn ? keyFn(req) : clientIp(req);
    const banKey = ip + ":ban:" + scope;
    const bannedUntil = banBuckets.get(banKey) || 0;
    if (bannedUntil > Date.now()) {
      const sec = Math.ceil((bannedUntil - Date.now()) / 1000);
      res.setHeader("Retry-After", String(sec));
      return res.status(429).json({ success: false, message: `محظور مؤقتًا — حاول بعد ${sec} ثانية` });
    }
    const key = ip + ":" + scope;
    const t = Date.now();
    let b = rateBuckets.get(key);
    if (!b || t > b.resetAt) {
      b = { count: 0, resetAt: t + windowMs, hits429: 0 };
      rateBuckets.set(key, b);
    }
    b.count += 1;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - b.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(b.resetAt / 1000)));
    if (b.count > max) {
      b.hits429 = (b.hits429 || 0) + 1;
      if (banAfter > 0 && b.hits429 >= banAfter) banBuckets.set(banKey, Date.now() + banMs);
      const sec = Math.ceil((b.resetAt - t) / 1000);
      res.setHeader("Retry-After", String(Math.max(1, sec)));
      return res.status(429).json({ success: false, message: limitMessage });
    }
    next();
  };
}

setInterval(() => {
  const t = Date.now();
  for (const [k, b] of rateBuckets) if (t > b.resetAt) rateBuckets.delete(k);
  for (const [k, until] of banBuckets) if (t > until) banBuckets.delete(k);
}, 30_000).unref();

const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60_000;
const loginFails = new Map();

function loginFailKey(kind, deviceOrIp, id) {
  return kind + ":" + String(deviceOrIp || "unknown") + ":" + String(id || "").toLowerCase();
}
function _lockStatus(key) {
  const row = loginFails.get(key);
  if (!row) return null;
  if (row.lockedUntil && Date.now() < row.lockedUntil) {
    const sec = Math.ceil((row.lockedUntil - Date.now()) / 1000);
    return { locked: true, sec, remaining: 0 };
  }
  if (row.lockedUntil && Date.now() >= row.lockedUntil) { loginFails.delete(key); return null; }
  return { locked: false, remaining: Math.max(0, LOGIN_MAX_FAILS - (row.count || 0)) };
}
function checkLoginLock(kind, deviceOrIp, id) { return _lockStatus(loginFailKey(kind, deviceOrIp, id)); }
function checkLoginLockAny(kind, deviceId, ip, id) {
  const a = deviceId ? checkLoginLock(kind, "dev:" + deviceId, id) : null;
  const b = checkLoginLock(kind, "ip:" + ip, id);
  if (a && a.locked) return a;
  if (b && b.locked) return b;
  return a || b;
}
function recordLoginFail(kind, deviceOrIp, id) {
  const key = loginFailKey(kind, deviceOrIp, id);
  const row = loginFails.get(key) || { count: 0, lockedUntil: 0 };
  row.count = (row.count || 0) + 1;
  if (row.count >= LOGIN_MAX_FAILS) { row.lockedUntil = Date.now() + LOGIN_LOCK_MS; row.count = 0; }
  loginFails.set(key, row);
  if (row.lockedUntil && Date.now() < row.lockedUntil) {
    return { locked: true, sec: Math.ceil((row.lockedUntil - Date.now()) / 1000) };
  }
  return { locked: false, remaining: Math.max(0, LOGIN_MAX_FAILS - row.count) };
}
function recordLoginFailBoth(kind, deviceId, ip, id) {
  let worst = { locked: false, remaining: LOGIN_MAX_FAILS };
  if (deviceId) {
    const r = recordLoginFail(kind, "dev:" + deviceId, id);
    if (r.locked || (r.remaining != null && r.remaining < (worst.remaining ?? 99))) worst = r;
  }
  const r2 = recordLoginFail(kind, "ip:" + ip, id);
  if (r2.locked) worst = r2;
  else if (!worst.locked && r2.remaining != null && r2.remaining < (worst.remaining ?? 99)) worst = r2;
  return worst;
}
function clearLoginFail(kind, deviceOrIp, id) { loginFails.delete(loginFailKey(kind, deviceOrIp, id)); }
function clearLoginFailBoth(kind, deviceId, ip, id) {
  if (deviceId) clearLoginFail(kind, "dev:" + deviceId, id);
  clearLoginFail(kind, "ip:" + ip, id);
}

setInterval(() => {
  const t = Date.now();
  for (const [k, row] of loginFails) if (row.lockedUntil && t > row.lockedUntil + 60_000) loginFails.delete(k);
}, 60_000).unref();

const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  COURSATK_API: "https://api.coursatk.online/api/v1",
  COURSATK_TOKEN: process.env.COURSATK_TOKEN || "",
  DEFAULT_YEAR_ID: 4,
  STREAM_HOSTS: [
    "api.coursatk.online",
    "stream-weave.com",
    "api.stream-weave.com",
    "floravon.online",
    "floravon.shop",
    "suo2.floravon.online",
    "c-cdn.online",
    "thanawica.com",
    "www.thanawica.com",
    "b-cdn.net",
    "mediadelivery.net",
    "iframe.mediadelivery.net",
    "vz-878412bf-692.b-cdn.net",
    // taleb.pro
    "video.talep.pro",
    "talep.pro"
  ],
  // Bunny Stream (د. حسام عيسى / drhossamissa.com)
  BUNNY_CDN_HOST: (process.env.BUNNY_CDN_HOST || "vz-878412bf-692.b-cdn.net").replace(/^https?:\/\//, "").replace(/\/$/, ""),
  BUNNY_LIBRARY_ID: process.env.BUNNY_LIBRARY_ID || "396717",
  BUNNY_REFERER: "https://iframe.mediadelivery.net/",
  BUNNY_ORIGIN: "https://iframe.mediadelivery.net",
  BUNNY_ENABLED: process.env.BUNNY_ENABLED !== "0",
  STREAM_ORIGIN: "https://coursatk.online",
  STREAM_REFERER: "https://coursatk.online/",
  STREAM_X_REQUESTED_WITH: "com.mycompany.app.soulbrowser",
  STREAM_UA: "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/153.0.0.0 Mobile Safari/537.36",
  PLAYER_JS: "https://player.stream-weave.com/assets/player.js?v=3.0.0",
  FIREBASE: (process.env.FIREBASE_URL || "https://plus-f09b5-default-rtdb.firebaseio.com").replace(/\/$/, ""),
  BOOTSTRAP_ADMIN: {
    username: process.env.ADMIN_USER || "admin",
    passwordHash: "",
    passwordPlain: process.env.ADMIN_PASSWORD || "admin123",
    permissions: {
      students_create: true, students_edit: true, students_delete: true, students_view: true,
      devices_kick: true, sections_manage: true, admins_manage: true
    }
  },
  STUDENT_SESSION_MS: 7 * 24 * 3600 * 1000,
  ADMIN_SESSION_MS: 12 * 3600 * 1000,
  STREAM_SESSION_MS: 15 * 60 * 1000,
  STREAM_IDLE_MS: 45 * 60 * 1000,
  STREAM_MAX_MS: 12 * 3600 * 1000,
  MAX_PROXY_BYTES: 12 * 1024 * 1024,
  THANAWICA_CODE: process.env.THANAWICA_CODE || "",
  THANAWICA_ENABLED: process.env.THANAWICA_ENABLED !== "0",
  CODE_TYPES: {
    h1: { label: "ساعة واحدة", ms: 1 * 3600 * 1000 },
    h6: { label: "6 ساعات", ms: 6 * 3600 * 1000 },
    h12: { label: "12 ساعة", ms: 12 * 3600 * 1000 },
    trial: { label: "تجربة — 24 ساعة", ms: 24 * 3600 * 1000 },
    d3: { label: "3 أيام", ms: 3 * 24 * 3600 * 1000 },
    week: { label: "أسبوع", ms: 7 * 24 * 3600 * 1000 },
    d15: { label: "15 يوم", ms: 15 * 24 * 3600 * 1000 },
    month: { label: "شهر واحد", ms: 30 * 24 * 3600 * 1000 },
    m2: { label: "شهرين", ms: 60 * 24 * 3600 * 1000 },
    m3: { label: "3 شهور", ms: 90 * 24 * 3600 * 1000 },
    m4: { label: "4 شهور", ms: 120 * 24 * 3600 * 1000 },
    m5: { label: "5 شهور", ms: 150 * 24 * 3600 * 1000 },
    m6: { label: "6 شهور", ms: 180 * 24 * 3600 * 1000 },
    m7: { label: "7 شهور", ms: 210 * 24 * 3600 * 1000 },
    m8: { label: "8 شهور", ms: 240 * 24 * 3600 * 1000 },
    m9: { label: "9 شهور", ms: 270 * 24 * 3600 * 1000 },
    m10: { label: "10 شهور", ms: 300 * 24 * 3600 * 1000 },
    m11: { label: "11 شهر", ms: 330 * 24 * 3600 * 1000 },
    year: { label: "سنة — 12 شهر", ms: 365 * 24 * 3600 * 1000 },
    d45: { label: "45 يوم", ms: 45 * 24 * 3600 * 1000 },
    d60: { label: "شهرين — 60 يوم", ms: 60 * 24 * 3600 * 1000 },
    term: { label: "ترم — 120 يوم", ms: 120 * 24 * 3600 * 1000 },
    d180: { label: "6 شهور", ms: 180 * 24 * 3600 * 1000 }
  }
};

const RUNTIME_PATH = path.join(__dirname, "data", "runtime.json");

const runtime = {
  firebaseUrl: CONFIG.FIREBASE,
  coursatkToken: CONFIG.COURSATK_TOKEN,
  siteName: "ثانوية World",
  packages: [
    { id: "h1", name: "ساعة واحدة", price: 0, days: 0, hours: 1, active: true },
    { id: "h6", name: "6 ساعات", price: 0, days: 0, hours: 6, active: true },
    { id: "h12", name: "12 ساعة", price: 0, days: 0, hours: 12, active: true },
    { id: "trial", name: "تجربة — 24 ساعة", price: 0, days: 0, hours: 24, active: true },
    { id: "d3", name: "3 أيام", price: 30, days: 3, hours: 0, active: true },
    { id: "week", name: "أسبوع", price: 50, days: 7, hours: 0, active: true },
    { id: "d15", name: "15 يوم", price: 80, days: 15, hours: 0, active: true },
    { id: "month", name: "شهر واحد", price: 150, days: 30, hours: 0, active: true },
    { id: "m2", name: "شهرين", price: 280, days: 60, hours: 0, active: true },
    { id: "m3", name: "3 شهور", price: 400, days: 90, hours: 0, active: true },
    { id: "m4", name: "4 شهور", price: 520, days: 120, hours: 0, active: true },
    { id: "m5", name: "5 شهور", price: 640, days: 150, hours: 0, active: true },
    { id: "m6", name: "6 شهور", price: 750, days: 180, hours: 0, active: true },
    { id: "m7", name: "7 شهور", price: 860, days: 210, hours: 0, active: true },
    { id: "m8", name: "8 شهور", price: 970, days: 240, hours: 0, active: true },
    { id: "m9", name: "9 شهور", price: 1080, days: 270, hours: 0, active: true },
    { id: "m10", name: "10 شهور", price: 1180, days: 300, hours: 0, active: true },
    { id: "m11", name: "11 شهر", price: 1280, days: 330, hours: 0, active: true },
    { id: "year", name: "سنة — 12 شهر", price: 1400, days: 365, hours: 0, active: true }
  ],
  agents: []
};

function ensureDataDir() { if (!fs.existsSync(path.dirname(RUNTIME_PATH))) fs.mkdirSync(path.dirname(RUNTIME_PATH), { recursive: true }); }

function loadRuntimeFile() {
  try {
    if (!fs.existsSync(RUNTIME_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
    if (raw.firebaseUrl) runtime.firebaseUrl = String(raw.firebaseUrl).replace(/\/$/, "");
    if (raw.coursatkToken) runtime.coursatkToken = String(raw.coursatkToken);
    if (raw.siteName) runtime.siteName = String(raw.siteName);
    if (Array.isArray(raw.packages) && raw.packages.length) {
      // ادمج الباقات المحفوظة مع الافتراضية (ما نمسح باقات المستخدم)
      const defaults = [
        { id: "h1", name: "ساعة واحدة", price: 0, days: 0, hours: 1, active: true },
        { id: "h6", name: "6 ساعات", price: 0, days: 0, hours: 6, active: true },
        { id: "h12", name: "12 ساعة", price: 0, days: 0, hours: 12, active: true },
        { id: "trial", name: "تجربة — 24 ساعة", price: 0, days: 0, hours: 24, active: true },
        { id: "d3", name: "3 أيام", price: 30, days: 3, hours: 0, active: true },
        { id: "week", name: "أسبوع", price: 50, days: 7, hours: 0, active: true },
        { id: "d15", name: "15 يوم", price: 80, days: 15, hours: 0, active: true },
        { id: "month", name: "شهر واحد", price: 150, days: 30, hours: 0, active: true },
        { id: "m2", name: "شهرين", price: 280, days: 60, hours: 0, active: true },
        { id: "m3", name: "3 شهور", price: 400, days: 90, hours: 0, active: true },
        { id: "m4", name: "4 شهور", price: 520, days: 120, hours: 0, active: true },
        { id: "m5", name: "5 شهور", price: 640, days: 150, hours: 0, active: true },
        { id: "m6", name: "6 شهور", price: 750, days: 180, hours: 0, active: true },
        { id: "m7", name: "7 شهور", price: 860, days: 210, hours: 0, active: true },
        { id: "m8", name: "8 شهور", price: 970, days: 240, hours: 0, active: true },
        { id: "m9", name: "9 شهور", price: 1080, days: 270, hours: 0, active: true },
        { id: "m10", name: "10 شهور", price: 1180, days: 300, hours: 0, active: true },
        { id: "m11", name: "11 شهر", price: 1280, days: 330, hours: 0, active: true },
        { id: "year", name: "سنة — 12 شهر", price: 1400, days: 365, hours: 0, active: true }
      ];
      const byId = new Map();
      defaults.forEach((p) => byId.set(p.id, { ...p }));
      raw.packages.forEach((p) => {
        if (!p || !p.id) return;
        byId.set(p.id, {
          id: String(p.id),
          name: String(p.name || p.id),
          price: Number(p.price) || 0,
          days: Math.max(0, Number(p.days) || 0),
          hours: Math.max(0, Number(p.hours) || 0),
          active: p.active !== false
        });
      });
      runtime.packages = Array.from(byId.values());
    }
    if (Array.isArray(raw.agents)) runtime.agents = raw.agents;
    if (raw.storageBucket) runtime.storageBucket = String(raw.storageBucket);
    if (raw.notify && typeof raw.notify === "object") runtime.notify = raw.notify;
    console.log("[API] runtime.json loaded");
  } catch (e) { console.warn("[API] runtime load:", e.message); }
}

function saveRuntimeFile() {
  ensureDataDir();
  const out = {
    firebaseUrl: runtime.firebaseUrl, coursatkToken: runtime.coursatkToken, siteName: runtime.siteName,
    packages: runtime.packages, agents: runtime.agents, notify: runtime.notify || null, updatedAt: Date.now()
  };
  fs.writeFileSync(RUNTIME_PATH, JSON.stringify(out, null, 2), "utf8");
}

function getFirebaseUrl() {
  // الترتيب: runtime (لو اتظبط من الأدمن) → ENV → الافتراضي الأصلي
  const url = (runtime.firebaseUrl || process.env.FIREBASE_URL || CONFIG.FIREBASE || "https://plus-f09b5-default-rtdb.firebaseio.com").replace(/\/$/, "");
  return url;
}

function getCoursatkTokenSync() {
  return runtime.coursatkToken || process.env.COURSATK_TOKEN || CONFIG.COURSATK_TOKEN || "";
}

loadRuntimeFile();
// لو مفيش رابط Firebase متظبط → استخدم الفايربيز الأصلي
if (!runtime.firebaseUrl) {
  runtime.firebaseUrl = (process.env.FIREBASE_URL || CONFIG.FIREBASE || "https://plus-f09b5-default-rtdb.firebaseio.com").replace(/\/$/, "");
}

// تحميل كوكيز taleb.pro من Firebase عند الـ startup
(async () => {
  try {
    const talebCookies = await fbGet("config/taleb_cookies");
    if (talebCookies && talebCookies.device && talebCookies.session) {
      process.env.TALEB_DEVICE = talebCookies.device;
      process.env.TALEB_SESSION = talebCookies.session;
      console.log("[taleb] cookies loaded from Firebase");
    }
  } catch (e) {
    console.warn("[taleb] couldn't load cookies from Firebase:", e.message);
  }
})();

const maintenance = { mode: "off", message: "السيرفر في وضع الصيانة حاليًا. حاول لاحقًا.", updatedAt: 0, updatedBy: null };

function loadMaintenanceFromRuntime(raw) {
  if (!raw || !raw.maintenance) return;
  const m = raw.maintenance;
  if (m.mode === "off" || m.mode === "stream" || m.mode === "full") maintenance.mode = m.mode;
  if (m.message) maintenance.message = String(m.message).slice(0, 300);
  if (m.updatedAt) maintenance.updatedAt = Number(m.updatedAt) || 0;
  if (m.updatedBy) maintenance.updatedBy = String(m.updatedBy);
}

async function loadMaintenanceFromFirebase() {
  try {
    if (!getFirebaseUrl()) return;
    const remote = await fbGet("config/maintenance");
    if (remote && (remote.mode === "off" || remote.mode === "stream" || remote.mode === "full")) {
      maintenance.mode = remote.mode;
      if (remote.message) maintenance.message = String(remote.message).slice(0, 300);
      maintenance.updatedAt = Number(remote.updatedAt) || Date.now();
      maintenance.updatedBy = remote.updatedBy || null;
    }
  } catch (e) { console.warn("[maintenance] firebase load:", e.message); }
}

async function saveMaintenance(mode, message, by) {
  maintenance.mode = mode;
  if (message) maintenance.message = String(message).slice(0, 300);
  maintenance.updatedAt = Date.now();
  maintenance.updatedBy = by || null;
  try {
    ensureDataDir();
    let raw = {};
    if (fs.existsSync(RUNTIME_PATH)) { try { raw = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8")); } catch {} }
    raw.maintenance = { mode: maintenance.mode, message: maintenance.message, updatedAt: maintenance.updatedAt, updatedBy: maintenance.updatedBy };
    saveRuntimeFile();
    try { const cur = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8")); cur.maintenance = raw.maintenance; fs.writeFileSync(RUNTIME_PATH, JSON.stringify(cur, null, 2), "utf8"); } catch {}
  } catch (e) { console.warn("[maintenance] file save:", e.message); }
  try {
    if (getFirebaseUrl()) await fbSet("config/maintenance", { mode: maintenance.mode, message: maintenance.message, updatedAt: maintenance.updatedAt, updatedBy: maintenance.updatedBy });
  } catch (e) { console.warn("[maintenance] firebase save:", e.message); }
  if (mode === "stream" || mode === "full") streamSessions.clear();
}

function maintenanceBlocksStream() { return maintenance.mode === "stream" || maintenance.mode === "full"; }
function maintenanceBlocksApi() { return maintenance.mode === "full"; }

function maintenanceMiddleware(req, res, next) {
  const path = req.path || "";
  if (path === "/health" || path.startsWith("/api/admin") || path === "/api/auth/login") {
    if (maintenanceBlocksApi() && path === "/api/auth/login") return res.status(503).json({ success: false, maintenance: true, mode: maintenance.mode, message: maintenance.message || "السيرفر متوقف للصيانة" });
    return next();
  }
  if (maintenanceBlocksApi()) return res.status(503).json({ success: false, maintenance: true, mode: "full", message: maintenance.message || "السيرفر متوقف للصيانة" });
  if (maintenanceBlocksStream()) {
    const streamPaths = path.startsWith("/api/play") || path.startsWith("/api/hls") || path.startsWith("/api/stream");
    if (streamPaths) return res.status(503).json({ success: false, maintenance: true, mode: "stream", message: maintenance.message || "البث متوقف مؤقتًا للصيانة" });
  }
  next();
}

try { if (fs.existsSync(RUNTIME_PATH)) { const raw = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8")); loadMaintenanceFromRuntime(raw); } } catch {}
app.use(maintenanceMiddleware);

CONFIG.COURSATK_TOKEN = getCoursatkTokenSync();
CONFIG.FIREBASE = getFirebaseUrl();
console.log("[API] Firebase:", getFirebaseUrl() ? "configured" : "NOT set");
console.log("[API] Firebase secret:", getFirebaseSecret() ? "set" : "NOT set");
console.log("[API] Token:", getCoursatkTokenSync() ? "set" : "missing");

function packageDurationMs(pkg) {
  if (!pkg) return 0;
  const days = Number(pkg.days || 0);
  const hours = Number(pkg.hours || 0);
  return (days * 24 + hours) * 3600 * 1000;
}

const SECTION_CATALOG = {
  scientific_sciences: { name: "علمي علوم", yearId: 4, subjectIds: [57, 58, 59, 60, 61] },
  scientific_math: { name: "علمي رياضة", yearId: 4, subjectIds: [57, 58, 59, 60, 65] },
  literary: { name: "أدبي", yearId: 4, subjectIds: [57, 58, 62, 63, 64] },
  "بكالوريا": { name: "بكالوريا", yearId: 5, subjectIds: [66, 67, 68, 69, 70, 71, 72, 75, 76, 77] },
  azhari: { name: "ازهر", yearId: 4, subjectIds: [73, 58, 59, 60, 61, 65, 74] }
};

const YEAR_2026_SUBJECTS = {
  scientific_sciences: [40, 41, 42, 43, 44],
  scientific_math: [40, 41, 42, 43],
  literary: [40, 41, 52, 56],
  "بكالوريا": [40, 41, 52, 56],
  azhari: [40, 41, 42, 43, 44]
};

function resolveYearId(raw) {
  if (raw == null || raw === "") return CONFIG.DEFAULT_YEAR_ID;
  const s = String(raw).trim().replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
  const n = Number(s);
  if (n === 3 || n === 4 || n === 5) return n;
  if (n === 26 || n === 2026) return 3;
  if (n === 27 || n === 2027) return 4;
  if (s.includes("2026")) return 3;
  if (s.includes("2027")) return 4;
  return CONFIG.DEFAULT_YEAR_ID;
}

function normalizeSection(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!s) return null;
  const lower = s.toLowerCase().replace(/\s+/g, "_");
  const map = {
    scientific_sciences: "scientific_sciences", scientific_math: "scientific_math", literary: "literary",
    "علمي_علوم": "scientific_sciences", "علمي_رياضة": "scientific_math", "علمي_رياضه": "scientific_math",
    "ادبي": "literary", "أدبي": "literary", "باكلوريا": "بكالوريا", "بكالوريا": "بكالوريا",
    bakaloria: "بكالوريا", baccalaureate: "بكالوريا", "أزهري": "azhari", azhari: "azhari",
    sciences: "scientific_sciences", math: "scientific_math", science: "scientific_sciences"
  };
  if (map[s]) return map[s];
  if (map[lower]) return map[lower];
  if (s.includes("علوم") && !s.includes("رياض")) return "scientific_sciences";
  if (s.includes("رياض")) return "scientific_math";
  if (s.includes("أدب") || s.includes("ادب")) return "literary";
  return s;
}

async function resolveSection(sectionRaw, yearOverride = null) {
  const id = normalizeSection(sectionRaw);
  if (!id) return null;
  const wantYear = yearOverride != null ? resolveYearId(yearOverride) : null;
  if (wantYear === 3) {
    const ids = YEAR_2026_SUBJECTS[id] || [];
    const name = (SECTION_CATALOG[id] && SECTION_CATALOG[id].name) || id;
    return { id, name, yearId: 3, subjectIds: [...ids] };
  }
  try {
    if (getFirebaseUrl()) {
      const sec = await fbGetCached(`sections/${id}`, 10 * 60_000);
      if (sec && Array.isArray(sec.subjectIds) && sec.subjectIds.length) {
        return { id, name: sec.name || (SECTION_CATALOG[id] && SECTION_CATALOG[id].name) || id, yearId: Number(sec.yearId) || (SECTION_CATALOG[id] && SECTION_CATALOG[id].yearId) || CONFIG.DEFAULT_YEAR_ID, subjectIds: sec.subjectIds.map(Number).filter((n) => !Number.isNaN(n)) };
      }
    }
  } catch (e) { console.warn("[section]", e.message); }
  const def = SECTION_CATALOG[id];
  if (def) return { id, name: def.name, yearId: def.yearId, subjectIds: [...def.subjectIds] };
  return { id, name: id, yearId: CONFIG.DEFAULT_YEAR_ID, subjectIds: [] };
}

function resolveDurationMs(body) {
  const days = body?.days != null && body.days !== "" ? Number(body.days) : 0;
  const hours = body?.hours != null && body.hours !== "" ? Number(body.hours) : 0;
  // أيام + ساعات معًا (مخصص من اللوحة)
  if ((!Number.isNaN(days) && days > 0) || (!Number.isNaN(hours) && hours > 0)) {
    const d = !Number.isNaN(days) && days > 0 ? Math.min(3650, days) : 0;
    const h = !Number.isNaN(hours) && hours > 0 ? Math.min(24 * 3650, hours) : 0;
    const ms = (d * 24 + h) * 3600 * 1000;
    if (ms > 0) return Math.round(ms);
  }
  const type = String(body?.type || "month");
  const pkg = (runtime.packages || []).find((p) => p.id === type);
  if (pkg) {
    const ms = packageDurationMs(pkg);
    if (ms > 0) return ms;
  }
  if (CONFIG.CODE_TYPES[type]) return CONFIG.CODE_TYPES[type].ms;
  return CONFIG.CODE_TYPES.month.ms;
}

const memCache = new Map();
function cacheGet(key) {
  const e = memCache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { memCache.delete(key); return null; }
  return e.val;
}
function cacheSet(key, val, ttlMs = 30_000) { memCache.set(key, { val, exp: Date.now() + ttlMs }); return val; }
function cacheDel(prefix) { for (const k of memCache.keys()) if (k === prefix || k.startsWith(prefix)) memCache.delete(k); }
setInterval(() => { const t = Date.now(); for (const [k, e] of memCache) if (t > e.exp) memCache.delete(k); }, 60_000).unref();

function scryptHash(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function scryptVerify(password, stored) {
  try {
    if (stored.startsWith("scrypt$")) {
      const parts = stored.split("$");
      const salt = parts[4]; const expect = parts[5];
      const hash = crypto.scryptSync(password, Buffer.from(salt, "hex"), 32, { N: 16384, r: 8, p: 1 });
      return crypto.timingSafeEqual(Buffer.from(expect, "hex"), hash);
    }
    return password === stored;
  } catch { return false; }
}
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("base64url"); }

// سر توقيع JWT الطلاب
const STUDENT_JWT_SECRET =
  process.env.STUDENT_JWT_SECRET ||
  process.env.JWT_SECRET ||
  process.env.SESSION_SECRET ||
  crypto.createHash("sha256").update("thanawya-student-jwt|" + (process.env.FIREBASE_DATABASE_URL || "local")).digest("hex");

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** توكن طالب بشكل JWT: header.payload.signature */
function makeStudentJwt({ code, deviceId, name, expiresAt }) {
  const header = { alg: "HS256", typ: "JWT" };
  const uuid = crypto.randomBytes(16).toString("hex");
  const payload = {
    user_id: Number(String(code).replace(/\D/g, "")) || code,
    role: "student",
    uuid,
    code: String(code),
    deviceId: String(deviceId || ""),
    name: name ? String(name).slice(0, 80) : undefined,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor((expiresAt || Date.now() + CONFIG.STUDENT_SESSION_MS) / 1000)
  };
  const h = b64urlJson(header);
  const p = b64urlJson(payload);
  const sig = crypto.createHmac("sha256", STUDENT_JWT_SECRET).update(h + "." + p).digest("base64url");
  return `${h}.${p}.${sig}`;
}

// مفتاح تخزين الجلسة في Firebase (JWT فيه نقط ومش مسموح في المسار)
function sessionStoreKey(token) {
  const t = String(token || "");
  if (!t) return "";
  if (t.includes(".")) return crypto.createHash("sha256").update(t).digest("hex");
  return t;
}

function dropStudentSessionEntry(storeKey, sess) {
  if (sess && sess.token) studentSessions.delete(sess.token);
  if (storeKey) studentSessions.delete(storeKey);
  return fbDelete(`sessions/${storeKey}`).catch(() => {});
}

// كود طالب 9 أرقام (مثل المنصات الأخرى)
function randomCode9() {
  let s = "";
  for (let i = 0; i < 9; i++) s += String(Math.floor(Math.random() * 10));
  if (s[0] === "0") s = String(1 + Math.floor(Math.random() * 9)) + s.slice(1);
  return s;
}
function now() { return Date.now(); }

// تحديث lastSeen بشكل مخفّف (كل دقيقتين كحد أقصى لكل طالب)
const lastSeenTouch = new Map();
function touchStudentSeen(code, deviceId) {
  const key = String(code || "");
  if (!key) return;
  const t = Date.now();
  const prev = lastSeenTouch.get(key) || 0;
  if (t - prev < 120_000) return;
  lastSeenTouch.set(key, t);
  const patch = { lastSeen: t };
  const tasks = [fbPatch(`students/${key}`, patch).catch(() => {})];
  if (deviceId) {
    tasks.push(
      fbPatch(`students/${key}/devices/${deviceId}`, { lastSeen: t }).catch(() => {})
    );
  }
  Promise.all(tasks).then(() => { try { cacheDel("stu:" + key); } catch {} }).catch(() => {});
}

// Firebase helpers
async function fbGetCached(p, ttlMs = 20_000) {
  const key = "fb:" + p;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  return coalesce(key, async () => { const val = await fbGet(p); cacheSet(key, val, ttlMs); return val; });
}

const authCache = new Map();
function fbInvalidate(p) {
  const parts = String(p).split("/").filter(Boolean);
  let acc = "";
  for (const part of parts) { acc += (acc ? "/" : "") + part; memCache.delete("fb:" + acc); }
  cacheDel("fb:" + parts.join("/"));
  if (parts[0] === "students") { if (parts[1]) authCache.delete(parts[1]); else authCache.clear(); }
}

function getFirebaseSecret() {
  return (process.env.FIREBASE_SECRET || process.env.FIREBASE_DATABASE_SECRET || process.env.FB_SECRET || runtime.firebaseSecret || "").trim();
}

function fbUrl(p) {
  const base = getFirebaseUrl();
  if (!base) throw new Error("Firebase غير مضبوط");
  const path = String(p || "").replace(/^\/+/, "").replace(/\/+$/, "");
  let url = `${base}/${path}.json`;
  const secret = getFirebaseSecret();
  if (secret) url += (url.includes("?") ? "&" : "?") + "auth=" + encodeURIComponent(secret);
  return url;
}

function fbAuthHint(status, msg) {
  if (status === 401 || status === 403 || /permission|Unauthorized/i.test(String(msg || ""))) {
    if (!getFirebaseSecret()) return " — القواعد مقفولة ومفيش FIREBASE_SECRET.";
    return " — تأكد إن FIREBASE_SECRET صحيح";
  }
  return "";
}

async function fbGet(p) {
  const r = await fetchT(fbUrl(p), { headers: { Accept: "application/json" }, cache: "no-store" }, { timeout: 12_000, retries: 1 });
  const text = await r.text();
  if (text.trim().startsWith("<")) throw new Error("رابط Firebase غلط أو قاعدة Realtime Database مش متإنشاءة.");
  if (!r.ok) { let msg = text.slice(0, 200); try { msg = JSON.parse(text).error || msg; } catch {} throw new Error("Firebase GET فشل: " + msg + fbAuthHint(r.status, msg)); }
  if (!text || text === "null") return null;
  try { return JSON.parse(text); } catch { throw new Error("Firebase رجّع رد مش JSON"); }
}

async function fbSet(p, data) {
  const r = await fetchT(fbUrl(p), { method: "PUT", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(data) }, { timeout: 15_000, retries: 1 });
  const text = await r.text();
  fbInvalidate(p);
  if (text.trim().startsWith("<")) throw new Error("قاعدة Realtime Database مش جاهزة");
  if (!r.ok) { let msg = text.slice(0, 200); try { msg = JSON.parse(text).error || msg; } catch {} throw new Error("Firebase SET فشل: " + msg + fbAuthHint(r.status, msg)); }
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function fbPatch(p, data) {
  const r = await fetchT(fbUrl(p), { method: "PATCH", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(data) }, { timeout: 15_000, retries: 1 });
  const text = await r.text();
  fbInvalidate(p);
  if (text.trim().startsWith("<")) throw new Error("Realtime Database مش جاهزة");
  if (!r.ok) { let msg = text.slice(0, 200); try { msg = JSON.parse(text).error || msg; } catch {} throw new Error("Firebase PATCH فشل: " + msg + fbAuthHint(r.status, msg)); }
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function fbDelete(p) {
  const r = await fetchT(fbUrl(p), { method: "DELETE" }, { timeout: 15_000, retries: 1 });
  fbInvalidate(p);
  if (!r.ok) { let msg = ""; try { msg = await r.text(); } catch {} throw new Error(`Firebase DELETE ${p} → ${r.status}` + fbAuthHint(r.status, msg)); }
  return true;
}

let cachedCoursatkToken = null;
let cachedTokenAt = 0;
async function getStorageBucket() {
  if (runtime.storageBucket) return String(runtime.storageBucket).trim();
  if (process.env.FIREBASE_STORAGE_BUCKET) return process.env.FIREBASE_STORAGE_BUCKET.trim();
  return "";
}

function getCoursatkToken() { if (runtime.coursatkToken) return runtime.coursatkToken; return process.env.COURSATK_TOKEN || CONFIG.COURSATK_TOKEN || ""; }

async function refreshCoursatkTokenFromFb() {
  try { const remote = await fbGet("config/coursatkToken"); if (typeof remote === "string" && remote.length > 20) { runtime.coursatkToken = remote; CONFIG.COURSATK_TOKEN = remote; return remote; } } catch {}
  return getCoursatkToken();
}

const studentSessions = new Map();
const adminSessions = new Map();
const streamSessions = new Map();

const msgSubs = new Map();
function msgSubKey(kind, code) {
  if (kind === "admin-inbox") return "admin:inbox";
  if (kind === "admin") return "admin:" + String(code);
  return "student:" + String(code);
}

const SSE_MAX_PER_KEY = 3;
const SSE_MAX_ADMIN_INBOX = 5;
const SSE_MAX_TOTAL = 400;
let sseTotal = 0;

function subscribeMessages(key, res, meta = {}) {
  if (sseTotal >= SSE_MAX_TOTAL) { const e = new Error("السيرفر مشغول — حاول بعد شوية"); e.status = 503; throw e; }
  if (!msgSubs.has(key)) msgSubs.set(key, new Set());
  const set = msgSubs.get(key);
  const max = key === "admin:inbox" ? SSE_MAX_ADMIN_INBOX : SSE_MAX_PER_KEY;
  while (set.size >= max) { const oldest = set.values().next().value; if (!oldest) break; try { oldest.res.end(); } catch {} set.delete(oldest); sseTotal = Math.max(0, sseTotal - 1); }
  const entry = { res, ...meta, at: Date.now() };
  set.add(entry); sseTotal += 1;
  const onClose = () => { const s = msgSubs.get(key); if (!s) return; if (s.has(entry)) { s.delete(entry); sseTotal = Math.max(0, sseTotal - 1); } if (!s.size) msgSubs.delete(key); };
  res.on("close", onClose); res.on("error", onClose);
  return entry;
}

function pushMessageEvent(keys, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) {
    const set = msgSubs.get(key);
    if (!set || !set.size) continue;
    for (const entry of [...set]) { try { entry.res.write(payload); } catch { set.delete(entry); } }
    if (!set.size) msgSubs.delete(key);
  }
}

function notifyThread(code, event, data) {
  const c = String(code);
  pushMessageEvent([msgSubKey("student", c), msgSubKey("admin", c), msgSubKey("admin-inbox")], event, { code: c, ...data });
}

function openSse(req, res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, t: Date.now() })}\n\n`);
  const hb = setInterval(() => { try { res.write(`: ping ${Date.now()}\n\n`); } catch { clearInterval(hb); } }, 25_000);
  res.on("close", () => clearInterval(hb));
  res.on("error", () => clearInterval(hb));
}

function jsonError(res, status, message) { return res.status(status).json({ success: false, message }); }

function getBearer(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  const xt = req.headers["x-session-token"];
  if (xt) return String(xt).trim();
  if (req.query && req.query.token) return String(req.query.token).trim();
  const cookie = String(req.headers.cookie || "");
  const m = cookie.match(/(?:^|;\s*)ds_session=([^;]+)/);
  if (m) { try { return decodeURIComponent(m[1].trim()); } catch { return m[1].trim(); } }
  return "";
}

const AUTH_TTL_MS = 120_000;
const badTokens = new Map();

async function getStudentCached(code) {
  const c = authCache.get(code);
  const t = Date.now();
  if (c && t < c.exp) return c.student;
  const student = await coalesce("stu:" + code, () => fbGet(`students/${code}`));
  authCache.set(code, { student, exp: Date.now() + AUTH_TTL_MS });
  return student;
}

async function requireStudent(req, res, next) {
  try {
    const token = getBearer(req);
    if (!token) return jsonError(res, 401, "مطلوب تسجيل الدخول");
    let sess = studentSessions.get(token);
    if (!sess) {
      const bad = badTokens.get(token);
      if (bad && bad > Date.now()) return jsonError(res, 401, "جلسة غير صالحة");
      const sk = sessionStoreKey(token);
      const remote = await coalesce("sess:" + sk, () => fbGet(`sessions/${sk}`));
      if (!remote) { badTokens.set(token, Date.now() + 20_000); return jsonError(res, 401, "جلسة غير صالحة"); }
      sess = remote; studentSessions.set(token, sess);
    }
    if (sess.expiresAt && now() > sess.expiresAt) { studentSessions.delete(token); try { await fbDelete(`sessions/${sessionStoreKey(token)}`); } catch {} return jsonError(res, 401, "انتهت صلاحية الجلسة"); }
    const student = await getStudentCached(String(sess.code));
    if (!student || student.active === false) { studentSessions.delete(token); return jsonError(res, 401, "الحساب غير موجود أو موقوف"); }
    if (student.expiresAt && now() > student.expiresAt) return jsonError(res, 403, "انتهت صلاحية كود الاشتراك");
    const devices = student.devices || {};
    if (sess.deviceId && !devices[sess.deviceId]) {
      const bannedMap = student.bannedDevices || {};
      if (bannedMap[sess.deviceId]) { studentSessions.delete(token); try { await fbDelete(`sessions/${sessionStoreKey(token)}`); } catch {} return jsonError(res, 401, "هذا الجهاز محظور على هذا الكود"); }
      try {
        const maxDevices = Number(student.maxDevices || 1);
        const activeCount = Object.keys(devices).length;
        if (activeCount < maxDevices) { await fbSet(`students/${sess.code}/devices/${sess.deviceId}`, { name: "Restored device", addedAt: now(), lastSeen: now(), autoRestored: true }); cacheDel("stu:" + sess.code); }
      } catch (e) { console.warn("[auth] device restore:", e.message); }
    }
    req.student = { ...student, code: String(sess.code) };
    req.session = sess; req.sessionToken = token;
    // حدّث آخر ظهور مع أي نشاط للطالب (مخفّف)
    try { touchStudentSeen(sess.code, sess.deviceId); } catch {}
    next();
  } catch (e) { console.error("[auth student]", e.message); return jsonError(res, 500, "خطأ في التحقق من الجلسة"); }
}

function requireAdmin(permission) {
  return async (req, res, next) => {
    try {
      const token = getBearer(req);
      if (!token) return jsonError(res, 401, "مطلوب دخول الأدمن");
      let sess = adminSessions.get(token);
      if (!sess) {
        if (getFirebaseUrl()) { try { const remote = await fbGet(`admin_sessions/${token}`); if (remote) { sess = remote; adminSessions.set(token, sess); } } catch (err) { console.warn("[requireAdmin] fb session:", err.message); } }
        if (!sess) return jsonError(res, 401, "جلسة أدمن غير صالحة");
      }
      if (sess.expiresAt && now() > sess.expiresAt) { adminSessions.delete(token); try { await fbDelete(`admin_sessions/${token}`); } catch {} return jsonError(res, 401, "انتهت جلسة الأدمن"); }
      let admin = null;
      if (sess.username === CONFIG.BOOTSTRAP_ADMIN.username) { admin = { username: CONFIG.BOOTSTRAP_ADMIN.username, permissions: CONFIG.BOOTSTRAP_ADMIN.permissions, bootstrap: true }; }
      else { admin = await fbGet(`admins/${sess.adminId}`); if (!admin || admin.active === false) return jsonError(res, 401, "حساب الأدمن غير موجود"); }
      if (permission) { const perms = admin.permissions || {}; if (!perms[permission] && !perms.all) return jsonError(res, 403, `لا تملك صلاحية: ${permission}`); }
      req.admin = admin; req.adminSession = sess; req.adminToken = token;
      next();
    } catch (e) { console.error("[auth admin]", e.message); return jsonError(res, 500, "خطأ في تحقق الأدمن"); }
  };
}

function requireBootstrap(req, res, next) {
  const u = req.admin && req.admin.username;
  const isBoot = (req.admin && req.admin.bootstrap === true) || u === CONFIG.BOOTSTRAP_ADMIN.username;
  if (!isBoot) return jsonError(res, 403, "متاح للأدمن الأساسي فقط");
  next();
}

// Decrypt utils
let decryptPlaybackKeyFn = null;

async function loadDecryptionUtils() {
  const cachePath = path.join(__dirname, "player.stream-weave.cache.js");
  let source = null;
  try { if (fs.existsSync(cachePath)) source = fs.readFileSync(cachePath, "utf8"); } catch {}
  // نظّف أي سطر هيدر مش JS (زي رابط الملف)
  if (source) {
    const lines = source.split(/\r?\n/);
    let i = 0;
    while (i < lines.length && lines[i] && !/^\s*(function|\(function|!function|var |const |let |\/\*|\/\/)/.test(lines[i])) i++;
    if (i > 0) source = lines.slice(i).join("\n");
    const cssIdx = source.indexOf("/* streamweave:embedded-css");
    if (cssIdx > 0) source = source.slice(0, cssIdx);
  }
  if (!source || source.length < 1000) {
    const r = await fetch(CONFIG.PLAYER_JS, { headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`player.js HTTP ${r.status}`);
    source = await r.text();
    try { fs.writeFileSync(cachePath, source); } catch {}
  }
  const { webcrypto } = crypto;
  const sandbox = {
    window: {}, self: {}, globalThis: {}, global: {},
    console: { log() {}, warn() {}, error() {}, info() {} },
    crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, DataView,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Error, TypeError, Object, Array, String, Number, Boolean, Math, JSON, Date, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect, Function, RegExp, parseInt, parseFloat, isNaN, Infinity, NaN, undefined,
    document: {
      createElement: () => ({ style: {}, setAttribute() {}, getAttribute() { return null; }, appendChild() {}, remove() {}, classList: { add() {}, remove() {} }, addEventListener() {}, removeEventListener() {} }),
      head: { appendChild() {} }, body: { appendChild() {} }, documentElement: { style: {} },
      querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, addEventListener() {}, cookie: "", readyState: "complete"
    },
    navigator: { userAgent: "Mozilla/5.0", language: "en", mediaDevices: {} },
    location: { href: "https://coursatk.online/", hostname: "coursatk.online", protocol: "https:", origin: "https://coursatk.online", pathname: "/", search: "", hash: "" },
    HTMLElement: class {}, HTMLVideoElement: class {}, MediaSource: class { static isTypeSupported() { return true; } },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {}, canParse: () => true },
    Blob: class { constructor(p) { this.p = p; } },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) }),
    XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    performance: { now: () => Date.now() },
    EventTarget: class { addEventListener() {} removeEventListener() {} dispatchEvent() { return true; } },
    Event: class { constructor(t) { this.type = t; } },
    CustomEvent: class {},
    Worker: class {},
    WebAssembly
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox; sandbox.global = sandbox;
  sandbox.top = sandbox; sandbox.parent = sandbox;
  try {
    vm.runInNewContext(source, sandbox, { timeout: 12_000 });
  } catch (e) {
    console.warn("[crypto] player.js vm partial/fail:", e && e.message ? e.message : e);
  }
  // ابحث عن DecryptionUtils بأي اسم
  let du = sandbox.DecryptionUtils || sandbox.decryptionUtils || null;
  if (!du?.decryptPlaybackKey) {
    for (const k of Object.getOwnPropertyNames(sandbox)) {
      try {
        const v = sandbox[k];
        if (v && typeof v === "object" && typeof v.decryptPlaybackKey === "function") { du = v; break; }
        if (v && typeof v === "function" && k.toLowerCase().includes("decrypt") && v.length >= 1) {
          // function itself
        }
      } catch {}
    }
  }
  if (du?.decryptPlaybackKey) {
    decryptPlaybackKeyFn = du.decryptPlaybackKey.bind(du);
    console.log("[crypto] ready (DecryptionUtils)");
  } else {
    decryptPlaybackKeyFn = null;
    console.warn("[crypto] DecryptionUtils غير متاح في player.js الجديد — استخدام fallback keys (plain/CDN)");
  }
}

async function unwrapKey(wrappedBuf, videoId) {
  const wrapped = Buffer.isBuffer(wrappedBuf) ? Buffer.from(wrappedBuf) : Buffer.from(wrappedBuf);
  if (wrapped.length === 16) return wrapped;
  // 1) stream-weave decryptPlaybackKey لو اتحمل
  if (decryptPlaybackKeyFn) {
    try {
      const result = await decryptPlaybackKeyFn(new Uint8Array(wrapped), String(videoId));
      const key = result?.key;
      if (key) {
        const aes = Buffer.isBuffer(key) ? key : key instanceof ArrayBuffer ? Buffer.from(key) : Buffer.from(key.buffer || key, key.byteOffset || 0, key.byteLength || key.length);
        if (aes.length === 16) return aes;
      }
    } catch (e) {
      console.warn("[unwrapKey] decryptPlaybackKey failed:", e.message);
    }
  }
  // 2) CDN-style blob (pbkdf2 + aes-gcm)
  try {
    return await unwrapCdnKey(wrapped);
  } catch (e) {
    console.warn("[unwrapKey] CDN unwrap failed:", e.message);
  }
  // 3) لو المفتاح hex نصّي 32 حرف
  try {
    const s = wrapped.toString("utf8").trim();
    if (/^[0-9a-fA-F]{32}$/.test(s)) return Buffer.from(s, "hex");
  } catch {}
  throw new Error("فشل فك مفتاح التشغيل — حدّث player.stream-weave.cache.js أو جرّب فيديو تاني");
}

const CDN_KEY_PASSWORD = "pQDKIpCkQxsulP";
async function unwrapCdnKey(wrappedBuf) {
  const buf = Buffer.isBuffer(wrappedBuf) ? wrappedBuf : Buffer.from(wrappedBuf);
  if (buf.length === 16) return buf;
  if (buf.length < 60) throw new Error("CDN key blob قصير");
  const salt = buf.subarray(0, 16); const iv = buf.subarray(16, 28); const data = buf.subarray(28);
  const derived = crypto.pbkdf2Sync(CDN_KEY_PASSWORD, salt, 100, 32, "sha256");
  const tag = data.subarray(data.length - 16); const ciphertext = data.subarray(0, data.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", derived, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const hexKey = plain.toString("utf8").trim().slice(0, 32);
  if (!/^[0-9a-fA-F]{32}$/.test(hexKey)) throw new Error("CDN key format غير متوقع");
  return Buffer.from(hexKey, "hex");
}

function decryptSegment(encrypted, key, iv) { const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv); return Buffer.concat([decipher.update(encrypted), decipher.final()]); }
function parseIvHex(hex) { const h = String(hex || "").replace(/^0x/i, "").trim(); if (!/^[0-9a-fA-F]{32}$/.test(h)) return null; return Buffer.from(h, "hex"); }
function ivFromMediaSequence(seq) { const iv = Buffer.alloc(16, 0); iv.writeUInt32BE(Number(seq) >>> 0, 12); return iv; }

function decodeKeySeed(seed) {
  if (!seed) return null;
  const s = String(seed).trim();
  for (const enc of ["base64url", "base64"]) {
    try {
      const b = Buffer.from(s, enc);
      if (b.length >= 8) return b;
    } catch {}
  }
  try { return Buffer.from(s, "utf8"); } catch { return null; }
}

/** مرشّحات مفتاح AES-128 لـ stream-weave key_version=3 (من تحليل player.js: PBKDF2 iterations=1337) */
function weaveV3KeyCandidates(keyBin, keySeed, extraTicket) {
  const out = [];
  const push = (buf, tag) => {
    if (!buf || buf.length < 16) return;
    const k = Buffer.from(buf.subarray(0, 16));
    const hex = k.toString("hex");
    if (out.some((x) => x.hex === hex)) return;
    out.push({ key: k, tag, hex });
  };
  const bin = Buffer.isBuffer(keyBin) ? keyBin : Buffer.from(keyBin || []);
  if (bin.length === 16) push(bin, "bin16");
  if (bin.length === 32) {
    push(bin.subarray(0, 16), "bin32-hi");
    push(bin.subarray(16, 32), "bin32-lo");
  }
  const seed = decodeKeySeed(keySeed);
  let ticketBuf = null;
  if (extraTicket) {
    try {
      ticketBuf = Buffer.from(String(extraTicket), "base64url");
    } catch {
      try { ticketBuf = Buffer.from(String(extraTicket), "base64"); } catch {}
    }
  }

  const pbkdf = (password, salt, iter, tag) => {
    try {
      const derived = crypto.pbkdf2Sync(password, salt, iter, 32, "sha256");
      push(derived, tag + "-hi");
      push(derived.subarray(16), tag + "-lo");
    } catch {}
  };

  if (seed) {
    push(seed, "seed16");
    if (seed.length >= 32) push(seed.subarray(16, 32), "seed32-lo");
    const sh = crypto.createHash("sha256").update(seed).digest();
    push(sh, "sha256(seed)");
    if (bin.length >= 16) {
      const b16 = bin.subarray(0, 16);
      const x = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) x[i] = b16[i] ^ seed[i % seed.length];
      push(x, "bin16-xor-seed");
      const x2 = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) x2[i] = b16[i] ^ sh[i];
      push(x2, "bin16-xor-sha256seed");
      push(crypto.createHash("sha256").update(Buffer.concat([b16, seed])).digest(), "sha256(bin||seed)");
      push(crypto.createHash("sha256").update(Buffer.concat([seed, b16])).digest(), "sha256(seed||bin)");
      try {
        push(crypto.createHmac("sha256", seed).update(b16).digest(), "hmac(seed,bin)");
        push(crypto.createHmac("sha256", b16).update(seed).digest(), "hmac(bin,seed)");
      } catch {}

      // player.js: deriveBits / PBKDF2 iterations = 1337
      for (const iter of [1337, 1000, 1, 100, 10000]) {
        pbkdf(seed, b16, iter, `pbkdf2(seed,bin,${iter})`);
        pbkdf(b16, seed, iter, `pbkdf2(bin,seed,${iter})`);
        pbkdf(seed, Buffer.concat([b16, seed]), iter, `pbkdf2(seed,bin||seed,${iter})`);
      }
      // HKDF-SHA256 style expand
      try {
        const prk = crypto.createHmac("sha256", b16).update(seed).digest();
        const okm = crypto.createHmac("sha256", prk).update(Buffer.concat([Buffer.from([1])])).digest();
        push(okm, "hkdf-ish(bin,seed)");
        const prk2 = crypto.createHmac("sha256", seed).update(b16).digest();
        push(crypto.createHmac("sha256", prk2).update(Buffer.concat([Buffer.from([1])])).digest(), "hkdf-ish(seed,bin)");
      } catch {}

      // AES-ECB "unwrap" of bin using seed as key (and reverse)
      try {
        if (seed.length >= 16) {
          const d1 = crypto.createDecipheriv("aes-128-ecb", seed.subarray(0, 16), null);
          d1.setAutoPadding(false);
          push(Buffer.concat([d1.update(b16), d1.final()]), "aes-ecb-dec(seed,bin)");
          const e1 = crypto.createCipheriv("aes-128-ecb", seed.subarray(0, 16), null);
          e1.setAutoPadding(false);
          push(Buffer.concat([e1.update(b16), e1.final()]), "aes-ecb-enc(seed,bin)");
        }
        const d2 = crypto.createDecipheriv("aes-128-ecb", b16, null);
        d2.setAutoPadding(false);
        if (seed.length >= 16) push(Buffer.concat([d2.update(seed.subarray(0, 16)), d2.final()]), "aes-ecb-dec(bin,seed)");
      } catch {}
    }
  }

  if (ticketBuf && ticketBuf.length >= 16) {
    push(ticketBuf, "ticket16");
    if (bin.length >= 16) {
      const x = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) x[i] = bin[i] ^ ticketBuf[i];
      push(x, "bin-xor-ticket");
      if (seed) {
        pbkdf(seed, ticketBuf.subarray(0, 16), 1337, "pbkdf2(seed,ticket,1337)");
        pbkdf(ticketBuf.subarray(0, 16), bin.subarray(0, 16), 1337, "pbkdf2(ticket,bin,1337)");
      }
    }
  }

  try {
    const t = bin.toString("utf8").trim();
    if (/^[0-9a-fA-F]{32}$/.test(t)) push(Buffer.from(t, "hex"), "hex-text");
  } catch {}
  return out;
}

function looksLikeMpegTs(buf, strict = false) {
  if (!buf || buf.length < 188) return false;
  // fMP4 / CMAF
  try {
    const head = buf.slice(4, 8).toString("ascii");
    if (head === "ftyp" || head === "moof" || head === "mdat" || head === "sidx" || head === "styp") return true;
  } catch {}
  const need = strict ? 8 : 5;
  let hits = 0;
  const limit = Math.min(buf.length, 188 * 12);
  for (let off = 0; off + 188 <= limit; off += 188) {
    if (buf[off] === 0x47) hits++;
  }
  if (hits >= need) return true;
  // scan for alignment
  for (let i = 0; i < Math.min(188, buf.length - 188 * 3); i++) {
    let h = 0;
    for (let k = 0; k < 4; k++) if (buf[i + k * 188] === 0x47) h++;
    if (h >= 4) return true;
  }
  return false;
}

function decryptSegmentCtr(encrypted, key, iv) {
  const decipher = crypto.createDecipheriv("aes-128-ctr", key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * جرّب مرشّحات المفتاح مع IV من الـ playlist على أول مقطع — يرجع المفتاح الصالح أو null
 */
async function resolveWeaveV3PlainKey({ keyBuf, keySeed, iv, sampleEncrypted, ticket, logTag = "weave-v3" }) {
  if (keyBuf && Buffer.isBuffer(keyBuf) && keyBuf.length === 16) {
    console.log(`[${logTag}] raw 16-byte key detected`);
    const rawKey = Buffer.from(keyBuf);
    const ivs = [];
    if (iv && Buffer.isBuffer(iv) && iv.length === 16) ivs.push({ iv, tag: "playlist" });
    for (let s = 0; s < 4; s++) ivs.push({ iv: ivFromMediaSequence(s), tag: `seq${s}` });
    ivs.push({ iv: Buffer.alloc(16, 0), tag: "zero" });
    if (!sampleEncrypted || sampleEncrypted.length < 32) return { key: rawKey, mode: "cbc", ivMode: "playlist", tag: "raw-16" };
    for (const { iv: ti, tag: it } of ivs) {
      try { if (looksLikeMpegTs(decryptSegment(sampleEncrypted, rawKey, ti), true)) return { key: rawKey, mode: "cbc", ivMode: it.startsWith("seq") ? "seq" : "playlist", tag: "raw-16" }; } catch {}
    }
    for (const { iv: ti, tag: it } of ivs) {
      try { if (looksLikeMpegTs(decryptSegmentCtr(sampleEncrypted, rawKey, ti), true)) return { key: rawKey, mode: "ctr", ivMode: it.startsWith("seq") ? "seq" : "playlist", tag: "raw-16" }; } catch {}
    }
    return { key: rawKey, mode: "cbc", ivMode: "playlist", tag: "raw-16-fallback" };
  }
  const cands = weaveV3KeyCandidates(keyBuf, keySeed, ticket);
  if (!cands.length) {
    console.warn(`[${logTag}] no key candidates (binLen=${keyBuf?.length || 0} seed=${keySeed ? "yes" : "no"})`);
    return null;
  }
  const ivs = [];
  if (iv && Buffer.isBuffer(iv) && iv.length === 16) ivs.push({ iv, tag: "playlist" });
  for (let s = 0; s < 4; s++) ivs.push({ iv: ivFromMediaSequence(s), tag: `seq${s}` });
  // zero IV
  ivs.push({ iv: Buffer.alloc(16, 0), tag: "zero" });

  if (!sampleEncrypted || sampleEncrypted.length < 32) {
    const prefer = cands.find((c) => c.tag === "bin16") || cands[0];
    console.warn(`[${logTag}] no sample segment — using candidate ${prefer.tag} without TS validate`);
    return { key: prefer.key, mode: "cbc", ivMode: "playlist", tag: prefer.tag };
  }

  console.log(`[${logTag}] testing ${cands.length} keys × ${ivs.length} IVs on sample len=${sampleEncrypted.length}`);

  let ctrFallback = null;

  // 1) فضّل CBC أولاً (HLS AES-128 القياسي + player.html)
  for (const cand of cands) {
    for (const { iv: testIv, tag: ivTag } of ivs) {
      try {
        const plain = decryptSegment(sampleEncrypted, cand.key, testIv);
        if (looksLikeMpegTs(plain, true)) {
          console.log(`[${logTag}] plainKey OK via ${cand.tag} CBC iv=${ivTag}`);
          return { key: cand.key, mode: "cbc", ivMode: ivTag.startsWith("seq") ? "seq" : "playlist", tag: cand.tag, ivTag };
        }
      } catch {}
      try {
        const d = crypto.createDecipheriv("aes-128-cbc", cand.key, testIv);
        d.setAutoPadding(false);
        const aligned = sampleEncrypted.subarray(0, sampleEncrypted.length - (sampleEncrypted.length % 16));
        if (aligned.length >= 188) {
          const plain = Buffer.concat([d.update(aligned), d.final()]);
          if (looksLikeMpegTs(plain, true)) {
            console.log(`[${logTag}] plainKey OK via ${cand.tag} CBC-nopad iv=${ivTag}`);
            return { key: cand.key, mode: "cbc-nopad", ivMode: ivTag.startsWith("seq") ? "seq" : "playlist", tag: cand.tag, ivTag };
          }
        }
      } catch {}
    }
  }

  // 2) CTR — قبول فقط مع تحقق صارم (تقليل false positive)
  for (const cand of cands) {
    for (const { iv: testIv, tag: ivTag } of ivs) {
      try {
        const plain = decryptSegmentCtr(sampleEncrypted, cand.key, testIv);
        if (looksLikeMpegTs(plain, true)) {
          console.log(`[${logTag}] plainKey OK via ${cand.tag} CTR iv=${ivTag}`);
          const hit = { key: cand.key, mode: "ctr", ivMode: ivTag.startsWith("seq") ? "seq" : "playlist", tag: cand.tag, ivTag };
          // لو playlist IV مع CTR نفضّله؛ seq CTR نخزّنه كـ fallback
          if (ivTag === "playlist") return hit;
          if (!ctrFallback) ctrFallback = hit;
        }
      } catch {}
    }
  }
  if (ctrFallback) {
    console.log(`[${logTag}] using CTR fallback ${ctrFallback.tag} iv=${ctrFallback.ivTag}`);
    return ctrFallback;
  }

  console.warn(`[${logTag}] reject key candidates all IVs failed (tried ${cands.length} keys × ${ivs.length} IVs)`);
  try {
    console.warn(`[${logTag}] debug bin16=${Buffer.from(keyBuf).subarray(0, 16).toString("hex")} seedPrefix=${String(keySeed || "").slice(0, 12)}`);
  } catch {}
  // player.js Vd: 16-byte key payload returns as raw AES key — keep it for per-segment recovery
  const prefer = cands.find((c) => c.tag === "bin16") || cands[0];
  if (prefer) {
    console.warn(`[${logTag}] soft-accept ${prefer.tag} without sample TS match (player.js treats bin16 as plain key)`);
    return { key: prefer.key, mode: "cbc", ivMode: "playlist", tag: prefer.tag + "-soft" };
  }
  return null;
}

/** x-sw-proof — جرّب عدة صيغ (الـ player.js الحقيقي معقّد) */
function makeSwProof({ keySeed, sessionId, token, path, ticket }) {
  const seed = decodeKeySeed(keySeed) || Buffer.from(String(keySeed || ""), "utf8");
  const sid = String(sessionId || "");
  const pathStr = String(path || `/playback/session/${sid}/key`);
  const tokTail = String(token || "").slice(-16);
  const ticketStr = String(ticket || "");
  const ticketBuf = (() => { try { return Buffer.from(ticketStr, "base64url"); } catch { return Buffer.from(ticketStr); } })();

  const msgs = [
    [sid, pathStr, tokTail].join("|"),
    [sid, "/key", tokTail].join("|"),
    [sid, pathStr].join("|"),
    sid + pathStr,
    pathStr,
    ticketStr,
    [sid, ticketStr].join("|"),
    [ticketStr, sid].join("|"),
    Buffer.concat([seed.slice(0, 16), Buffer.from(sid)]),
    Buffer.concat([ticketBuf.length === 32 ? ticketBuf : Buffer.alloc(0), Buffer.from(sid)]),
  ];

  // أول مرشّح (للتوافق مع الكود القديم)
  const primary = crypto.createHmac("sha256", seed.length ? seed : Buffer.from("sw")).update(Buffer.from(String(msgs[0]))).digest();
  return primary.toString("base64url").replace(/=+$/, "");
}

/** قائمة proofs للتجربة المتتالية */
function makeSwProofCandidates({ keySeed, sessionId, token, path, ticket }) {
  const seed = decodeKeySeed(keySeed) || Buffer.from(String(keySeed || ""), "utf8");
  const sid = String(sessionId || "");
  const pathStr = String(path || `/playback/session/${sid}/key`);
  const tokTail = String(token || "").slice(-16);
  const ticketStr = String(ticket || "");
  let ticketBuf = Buffer.alloc(0);
  try { ticketBuf = Buffer.from(ticketStr, "base64url"); } catch {}

  const out = new Set();
  const add = (buf) => { if (buf && buf.length) out.add(Buffer.from(buf).toString("base64url").replace(/=+$/, "")); };

  const msgList = [
    [sid, pathStr, tokTail].join("|"),
    [sid, "/key", tokTail].join("|"),
    [sid, pathStr].join("|"),
    sid + "|" + pathStr,
    pathStr,
    "/key",
    ticketStr,
    sid + "|" + ticketStr,
    ticketStr + "|" + sid,
    sid + ticketStr,
    ticketStr + sid,
    [sid, ticketStr, "/key"].join("|"),
  ];

  for (const msg of msgList) {
    add(crypto.createHmac("sha256", seed.length ? seed : Buffer.from("sw")).update(String(msg)).digest());
    if (ticketBuf.length) add(crypto.createHmac("sha256", ticketBuf).update(String(msg)).digest());
    add(crypto.createHash("sha256").update(Buffer.concat([seed, Buffer.from(String(msg))])).digest());
  }
  if (ticketBuf.length === 32) {
    const xored = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) xored[i] = seed[i % seed.length] ^ ticketBuf[i];
    add(xored);
    add(crypto.createHash("sha256").update(xored).digest());
    add(crypto.createHmac("sha256", seed).update(ticketBuf).digest());
    add(crypto.createHmac("sha256", ticketBuf).update(seed).digest());
  }
  // proof معروف من جلسة ناجحة (للاختبار فقط — مش عام)
  return [...out];
}

// Upstream helpers
async function upstreamHeaders(extra = {}, profileIdx = 0) {
  const tok = await getCoursatkToken();
  const profile = UA_PROFILES[profileIdx % UA_PROFILES.length];
  return {
    Authorization: `Bearer ${tok}`,
    Accept: "application/json",
    ...profile,
    ...extra
  };
}

async function upstreamJsonRaw(apiPath, options = {}) {
  const isGet = !options.method || String(options.method).toUpperCase() === "GET";
  const url = `${CONFIG.COURSATK_API}${apiPath}`;
  let lastErr = null;

  for (let p = 0; p < UA_PROFILES.length; p++) {
    try {
      const headers = await upstreamHeaders(options.headers || {}, p);
      const r = await upstreamSlot(() =>
        fetchT(url, { ...options, headers }, { timeout: 22_000, retries: UPSTREAM_FETCH_RETRIES, retryOn: [429, 502, 503, 504, 408, 500] })
      );
      const text = await r.text();
      if (isCloudflareBlock(r.status, text)) {
        lastErr = new Error("Cloudflare حاجب IP السيرفر على Coursatk — استخدم UPSTREAM_PROXY أو UPSTREAM_RELAY_URL");
        console.warn("[upstream] CF block", apiPath, "profile", p);
        if (p < UA_PROFILES.length - 1) continue;
        throw lastErr;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        lastErr = new Error(`Upstream non-JSON (${r.status})`);
        if (r.status === 403 || r.status === 401) {
          if (p < UA_PROFILES.length - 1) continue;
        }
        throw lastErr;
      }
      if (!r.ok) {
        const msg = data?.error || data?.message || `Upstream HTTP ${r.status}`;
        if (/اشتراك|انته|expired|token/i.test(String(msg))) throw new Error(msg);
        lastErr = new Error(msg);
        if (r.status === 403 && p < UA_PROFILES.length - 1) continue;
        throw lastErr;
      }
      return data;
    } catch (e) {
      lastErr = e;
      if (p < UA_PROFILES.length - 1 && /non-JSON|403|Cloudflare|Hajeb|حاجب/i.test(String(e.message || ""))) {
        await delay(150 + Math.random() * 200);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("Upstream failed");
}

const upCache = new Map();
const UP_STALE_MS = 6 * 60 * 60_000; // 6 ساعات stale-while-revalidate
function upTtl(apiPath) {
  const p = String(apiPath || "");
  if (/\/lectures\/[^/]+\/content/.test(p)) return 3 * 60_000;       // محتوى محاضرة: 3 دقائق
  if (/\/chapters\/[^/]+\/lectures/.test(p)) return 10 * 60_000;    // قائمة محاضرات: 10 دقائق
  if (/\/teachers\/[^/]+\/chapters/.test(p)) return 15 * 60_000;    // فصول: 15 دقيقة
  if (/\/subjects\/.+\/teachers/.test(p)) return 20 * 60_000;       // مدرسين: 20 دقيقة
  if (/\/user\/subjects\//.test(p)) return 30 * 60_000;             // مواد: 30 دقيقة
  return 10 * 60_000;
}
async function upstreamJson(apiPath, options = {}) {
  const isGet = !options.method || String(options.method).toUpperCase() === "GET";
  if (!isGet) return upstreamJsonRaw(apiPath, options);
  const hit = upCache.get(apiPath);
  if (hit && Date.now() < hit.exp) return hit.data;
  try {
    const data = await coalesce("up:" + apiPath, () => upstreamJsonRaw(apiPath, options));
    const t = Date.now();
    upCache.set(apiPath, { data, exp: t + upTtl(apiPath), stale: t + UP_STALE_MS });
    return data;
  } catch (e) {
    if (hit && Date.now() < hit.stale) {
      console.warn("[upstream] served stale:", apiPath, e.message);
      return hit.data;
    }
    throw e;
  }
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
  const isBunny = session && (session.mode === "bunny" || session.mode === "hossam");
  const isTaleb = session && session.mode === "taleb";
  let headers;
  if (isTaleb) {
    // taleb.pro: كوكيز بدل Bearer
    const device = process.env.TALEB_DEVICE || "";
    const sess = process.env.TALEB_SESSION || "";
    headers = {
      Accept: "*/*",
      "Cache-Control": "no-cache",
      Origin: "https://talep.pro",
      Referer: "https://talep.pro/",
      "User-Agent": ch["user-agent"] || "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
      "accept-language": "ar-AE,ar;q=0.9,en-US;q=0.8,en;q=0.7",
      "cookie": `taleb-device=${device}; taleb-session=${sess}`
    };
  } else if (isBunny) {
    // فك حماية Bunny: Referer من iframe.mediadelivery.net مطلوب
    headers = {
      Accept: "*/*",
      "Cache-Control": "no-cache",
      Origin: CONFIG.BUNNY_ORIGIN || "https://iframe.mediadelivery.net",
      Referer: CONFIG.BUNNY_REFERER || "https://iframe.mediadelivery.net/",
      "User-Agent": ch["user-agent"] || CONFIG.STREAM_UA
    };
  } else {
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch {}
    const isFloravon = /floravon\./i.test(host) || /\.floravon\./i.test(host);
    const isSw = /stream-weave\.com$/i.test(host) || host.endsWith(".stream-weave.com");
    headers = {
      Accept: "*/*",
      "Cache-Control": "no-cache",
      Origin: CONFIG.STREAM_ORIGIN,
      Referer: CONFIG.STREAM_REFERER,
      "User-Agent": ch["user-agent"] || CONFIG.STREAM_UA
    };
    // floravon CDN موقّع بـ token في الـ query — متبعتش Bearer (أحيانًا يبوّظ)
    if (!isFloravon && session.token) {
      headers.Authorization = `Bearer ${session.token}`;
      headers["X-Requested-With"] = CONFIG.STREAM_X_REQUESTED_WITH;
    }
    // stream-weave key_version=3
    if (isSw) {
      const kv = Number(session.keyVersion || session.key_version || 0);
      if (kv > 0) headers["x-sw-key-version"] = String(kv);
      if (session.swTicket) headers["x-sw-ticket"] = String(session.swTicket);
      if (session.swProof) headers["x-sw-proof"] = String(session.swProof);
    }
  }
  for (const name of ["sec-ch-ua-platform", "sec-ch-ua", "sec-ch-ua-mobile", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "accept-language"]) {
    if (ch[name]) headers[name] = ch[name];
  }
  for (const [k, v] of Object.entries(extra || {})) { if (v != null && v !== "") headers[k] = v; }
  const hasRange = Boolean(headers.Range || headers.range);
  return upstreamSlot(() => fetchT(url, { headers, cache: "no-store" }, { timeout: 30_000, retries: hasRange ? 2 : UPSTREAM_FETCH_RETRIES }));
}

app.use(rateLimit({ max: 1500, windowMs: 60_000, scope: "global", skip: (req) => req.path.startsWith("/api/stream/") || req.path.startsWith("/api/hls/") || req.path === "/health" }));
app.use("/api/stream/", rateLimit({ max: 1500, windowMs: 60_000, scope: "stream", keyFn: (req) => "t:" + (getBearer(req) || clientIp(req)) }));
// حد المقاطع: يمنع سحب المحاضرة كاملة بسرعة من سكربت/منصة تانية
app.use("/api/hls/", rateLimit({ max: Number(process.env.HLS_RATE_MAX || 420), windowMs: 60_000, scope: "hls-seg", keyFn: (req) => "t:" + (getBearer(req) || clientIp(req)), message: "طلبات بث كثيرة — هدّي شوية" }));
app.use("/api/play/", rateLimit({ max: Number(process.env.PLAY_RATE_MAX || 30), windowMs: 60_000, scope: "play-api", keyFn: (req) => "t:" + (getBearer(req) || clientIp(req)), message: "طلبات تشغيل كثيرة" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "thanawya-world-api",
    cryptoReady: Boolean(decryptPlaybackKeyFn),
    decryptSegments: true,
    directSegments: process.env.HLS_DIRECT_SEGMENTS !== "0",
    bunnyEnabled: CONFIG.BUNNY_ENABLED !== false,
    bunnyCdn: CONFIG.BUNNY_CDN_HOST || null,
    version: APP_VERSION,
    upstreamProxy: Boolean(proxyAgent),
    upstreamRelay: Boolean(UPSTREAM_RELAY_URL),
    tokenConfigured: Boolean(getCoursatkTokenSync()),
    cache: {
      segments: segCache.size,
      segmentMB: Math.round(segCacheBytes / 1048576),
      sources: sourceCache.size,
      streamSessions: streamSessions.size,
      upstream: upstreamSlot.stats()
    },
    now: new Date().toISOString()
  });
});

app.get("/api/public/code-types", (_req, res) => {
  const types = {};
  for (const [k, v] of Object.entries(CONFIG.CODE_TYPES)) types[k] = { label: v.label, durationMs: v.ms };
  for (const pkg of runtime.packages || []) {
    if (!pkg.active && pkg.active !== undefined) continue;
    types[pkg.id] = { label: pkg.name || pkg.id, durationMs: packageDurationMs(pkg), price: pkg.price ?? null, days: pkg.days || 0 };
  }
  res.json({ success: true, data: types });
});

app.get("/api/public/site", rateLimit({ max: 120, windowMs: 60_000, scope: "public-site" }), (_req, res) => {
  const packages = (runtime.packages || []).filter((p) => p.active !== false).map((p) => ({ id: p.id, name: p.name, price: p.price ?? 0, days: p.days || 0, hours: p.hours || 0 }));
  const agents = (runtime.agents || []).filter((a) => a.active !== false).map((a) => ({ id: a.id, name: a.name, telegram: a.telegram || "" }));
  res.json({ success: true, data: { siteName: runtime.siteName || "ثانوية World", packages, agents, firebaseConfigured: Boolean(getFirebaseUrl()), tokenConfigured: Boolean(getCoursatkTokenSync()) } });
});

// ==================== تتبع فتح الموقع للطالب ====================
app.post("/api/auth/track", requireStudent, async (req, res) => {
  try {
    const code = req.session.code;
    const deviceId = req.session.deviceId;
    const nowTime = now();
    const student = await fbGet(`students/${code}`);
    if (!student) return jsonError(res, 404, "الطالب غير موجود");

    const visitCount = (Number(student.visitCount) || 0) + 1;
    const patch = { lastSeen: nowTime, visitCount };
    await fbPatch(`students/${code}`, patch);
    if (deviceId) {
      try { await fbPatch(`students/${code}/devices/${deviceId}`, { lastSeen: nowTime }); } catch {}
    }
    try { cacheDel("stu:" + code); } catch {}
    lastSeenTouch.set(String(code), nowTime);
    try {
      const ip = clientIp(req);
      rememberIpStudent(ip, code, student.name || (req.session && req.session.name) || "", deviceId);
      const tok = getBearer(req);
      if (tok && studentSessions.has(tok)) {
        const s = studentSessions.get(tok);
        s.lastIp = ip;
        s.lastSeen = nowTime;
      }
    } catch (e) {}

    res.json({ success: true, visitCount, lastSeen: nowTime });
  } catch (e) {
    console.warn("[track-student-visit]", e.message);
    res.json({ success: false });
  }
});

// ==================== تسجيل الزوار (مُحسَّن) ====================
function parseDeviceInfo(ua) {
  const s = String(ua || "");
  let os = "غير معروف";
  let osVersion = "";
  let deviceType = "كمبيوتر";
  let deviceBrand = "";
  let deviceModel = "";
  let browser = "غير معروف";
  let browserVersion = "";

  if (/android/i.test(s)) {
    os = "أندرويد";
    const m = s.match(/Android\s+([\d.]+)/i);
    if (m) osVersion = m[1];
    deviceType = /tablet|nexus\s?(7|9|10)|sm-t|sm-x|pad/i.test(s) && !/mobile/i.test(s) ? "تابلت" : (/mobile/i.test(s) ? "موبايل" : "تابلت");
    // محاولات متعددة لاستخراج الموديل من الـ UA
    const patterns = [
      /Android\s[\d.]+;\s*([^);]+?)(?:\s+Build|[);])/i,
      /;\s*((?:SM|GT|SC|SGH|SCH|SHV|LG|Lenovo|HTC|Pixel|Redmi|Mi|POCO|RMX|CPH|V\d{4}|Infinix|TECNO|ITE|Nokia|Moto)[^);/]{0,40})/i,
      /\b((?:SM|RMX|CPH|V\d{4})-[A-Z0-9]+)\b/i,
      /\b(SM-[A-Z0-9]+)\b/i
    ];
    for (const re of patterns) {
      const modelMatch = s.match(re);
      if (modelMatch) {
        let raw = modelMatch[1].trim();
        raw = raw.replace(/\s*Build\/.*$/i, "").replace(/\/.*$/, "").trim();
        // تجاهل القيم المختزلة زي "K" أو "U"
        if (raw && raw.length > 1 && !/^(wv|Linux|U|K|arm|aarch64?|en-|ar-|zh-|es-|fr-|de-|it-|ru-|tr-|pt-)$/i.test(raw) && raw.length < 50) {
          deviceModel = raw;
          break;
        }
      }
    }
    // تابلت Samsung غالبًا SM-X / SM-T
    if (deviceModel && /^SM-[XT]/i.test(deviceModel)) deviceType = "تابلت";
  } else if (/iphone/i.test(s)) {
    os = "iOS";
    const m = s.match(/OS\s+([\d_]+)/i);
    if (m) osVersion = m[1].replace(/_/g, ".");
    deviceType = "موبايل";
    deviceBrand = "Apple";
    deviceModel = "iPhone";
  } else if (/ipad/i.test(s)) {
    os = "iPadOS";
    const m = s.match(/OS\s+([\d_]+)/i);
    if (m) osVersion = m[1].replace(/_/g, ".");
    deviceType = "تابلت";
    deviceBrand = "Apple";
    deviceModel = "iPad";
  } else if (/windows nt 10/i.test(s)) {
    os = "ويندوز 10/11";
    deviceType = "كمبيوتر";
  } else if (/windows nt 6\.3/i.test(s)) {
    os = "ويندوز 8.1";
    deviceType = "كمبيوتر";
  } else if (/windows nt 6\.1/i.test(s)) {
    os = "ويندوز 7";
    deviceType = "كمبيوتر";
  } else if (/windows/i.test(s)) {
    os = "ويندوز";
    deviceType = "كمبيوتر";
  } else if (/macintosh|mac os x/i.test(s)) {
    os = "ماك";
    const m = s.match(/Mac OS X\s+([\d_]+)/i);
    if (m) osVersion = m[1].replace(/_/g, ".");
    deviceType = "كمبيوتر";
    deviceBrand = "Apple";
  } else if (/cros/i.test(s)) {
    os = "Chrome OS";
    deviceType = "كمبيوتر";
  } else if (/linux/i.test(s)) {
    os = "لينكس";
    deviceType = "كمبيوتر";
  }

  const brandRules = [
    [/samsung|sm-|gt-|galaxy/i, "Samsung"],
    [/xiaomi|redmi|mi\s|poco/i, "Xiaomi"],
    [/huawei|honor|hwa-|hwi-/i, "Huawei"],
    [/oppo|cph|realme|rmx/i, "OPPO"],
    [/vivo|v\d{4}/i, "Vivo"],
    [/pixel/i, "Google"],
    [/oneplus|one\s*plus/i, "OnePlus"],
    [/nokia|ta-/i, "Nokia"],
    [/motorola|moto\s/i, "Motorola"],
    [/infinix|tecno|itel/i, "Infinix/Tecno"],
    [/lenovo/i, "Lenovo"],
    [/sony|xperia/i, "Sony"],
    [/lg-|lm-/i, "LG"]
  ];
  if (!deviceBrand) {
    for (const [re, name] of brandRules) {
      if (re.test(s) || (deviceModel && re.test(deviceModel))) {
        deviceBrand = name;
        break;
      }
    }
  }

  if (/edg(?:e|a|ios)?\//i.test(s)) {
    browser = "Edge";
    const m = s.match(/Edg(?:e|a|iOS)?\/([\d.]+)/i);
    if (m) browserVersion = m[1];
  } else if (/opr\/|opera/i.test(s)) {
    browser = "Opera";
    const m = s.match(/(?:OPR|Opera)\/([\d.]+)/i);
    if (m) browserVersion = m[1];
  } else if (/firefox|fxios/i.test(s)) {
    browser = "Firefox";
    const m = s.match(/(?:Firefox|FxiOS)\/([\d.]+)/i);
    if (m) browserVersion = m[1];
  } else if (/samsungbrowser/i.test(s)) {
    browser = "Samsung Internet";
    const m = s.match(/SamsungBrowser\/([\d.]+)/i);
    if (m) browserVersion = m[1];
  } else if (/chrome|crios|crmo/i.test(s) && !/edg/i.test(s)) {
    browser = "Chrome";
    const m = s.match(/(?:Chrome|CriOS|CrMo)\/([\d.]+)/i);
    if (m) browserVersion = m[1];
  } else if (/safari/i.test(s) && !/chrome|crios|chromium/i.test(s)) {
    browser = "Safari";
    const m = s.match(/Version\/([\d.]+)/i);
    if (m) browserVersion = m[1];
  }

  const isMobile = deviceType === "موبايل" || deviceType === "تابلت";
  return { os, osVersion, deviceType, deviceBrand, deviceModel, browser, browserVersion, isMobile };
}

/** كشف بوت / زاحف من الـ UA والهيدرز وشكل الـ payload */
function detectBot(ua, req, body) {
  const s = String(ua || "");
  const rules = [
    [/googlebot|adsbot-google|mediapartners-google|google-inspectiontool/i, "Googlebot"],
    [/bingbot|bingpreview|msnbot/i, "Bingbot"],
    [/yandex(bot|images|accessibility)/i, "Yandex"],
    [/baiduspider/i, "Baidu"],
    [/duckduckbot/i, "DuckDuckBot"],
    [/facebookexternalhit|facebot|meta-externalagent/i, "Facebook"],
    [/twitterbot|xbot/i, "Twitter/X"],
    [/linkedinbot/i, "LinkedIn"],
    [/slackbot|slack-img/i, "Slack"],
    [/discordbot/i, "Discord"],
    [/telegrambot/i, "Telegram"],
    [/whatsapp/i, "WhatsApp"],
    [/applebot/i, "Applebot"],
    [/semrushbot|ahrefsbot|mj12bot|dotbot|petalbot|bytespider|gptbot|chatgpt|claudebot|anthropic|ccbot|dataforseo|screaming frog|siteaudit|serpstat|majestic/i, "SEO/Crawler"],
    [/curl\/|wget\/|python-requests|python-urllib|go-http-client|java\/|scrapy|httpclient|okhttp|libwww|php\//i, "Script/Client"],
    [/headlesschrome|phantomjs|slimerjs|selenium|puppeteer|playwright/i, "Headless"],
    [/\bbot\b|\bcrawl\b|\bspider\b|\bslurp\b/i, "Bot"]
  ];
  for (const [re, name] of rules) {
    if (re.test(s)) return { isBot: true, botName: name, confidence: "high" };
  }

  let score = 0;
  const reasons = [];
  if (!s || s === "Unknown" || s.length < 12) { score += 3; reasons.push("ua-empty"); }
  if (!req?.headers?.["accept-language"] && !(body && body.language)) { score += 1; reasons.push("no-lang"); }
  const hasClientSignals = Boolean(
    body && (body.screen || body.timezone || body.guestId || body.model || body.gpu || body.cores != null)
  );
  if (!hasClientSignals) { score += 1; reasons.push("no-client-signals"); }
  if (/chrome\//i.test(s) && !req?.headers?.["sec-ch-ua"] && !hasClientSignals) { score += 1; reasons.push("no-ch"); }

  if (score >= 3) return { isBot: true, botName: "Suspected bot", confidence: "medium", reasons };
  if (score >= 2) return { isBot: false, botName: null, confidence: "low-suspect", reasons };
  return { isBot: false, botName: null, confidence: "human", reasons };
}

/** اسم ودي للموديل (Samsung / Xiaomi / …) عشان يظهر في لوحة الأدمن بوضوح */
function friendlyDeviceName(brand, model) {
  const b = String(brand || "").trim();
  const m = String(model || "").trim();
  if (!m && !b) return null;
  const up = m.toUpperCase().replace(/\s+/g, " ");
  const sam = {
    "SM-S918": "Galaxy S23 Ultra", "SM-S916": "Galaxy S23+", "SM-S911": "Galaxy S23",
    "SM-S928": "Galaxy S24 Ultra", "SM-S926": "Galaxy S24+", "SM-S921": "Galaxy S24",
    "SM-S938": "Galaxy S25 Ultra", "SM-S936": "Galaxy S25+", "SM-S931": "Galaxy S25",
    "SM-A556": "Galaxy A55", "SM-A546": "Galaxy A54", "SM-A536": "Galaxy A53",
    "SM-A356": "Galaxy A35", "SM-A346": "Galaxy A34", "SM-A256": "Galaxy A25",
    "SM-A156": "Galaxy A15", "SM-A055": "Galaxy A05", "SM-A065": "Galaxy A06",
    "SM-A145": "Galaxy A14", "SM-A135": "Galaxy A13", "SM-A127": "Galaxy A12",
    "SM-M556": "Galaxy M55", "SM-M346": "Galaxy M34", "SM-M156": "Galaxy M15",
    "SM-G991": "Galaxy S21", "SM-G996": "Galaxy S21+", "SM-G998": "Galaxy S21 Ultra",
    "SM-G990": "Galaxy S21 FE", "SM-S901": "Galaxy S22", "SM-S906": "Galaxy S22+",
    "SM-S908": "Galaxy S22 Ultra", "SM-F731": "Galaxy Z Flip5", "SM-F741": "Galaxy Z Flip6",
    "SM-F946": "Galaxy Z Fold5", "SM-F956": "Galaxy Z Fold6", "SM-N986": "Galaxy Note20 Ultra",
    "SM-A525": "Galaxy A52", "SM-A515": "Galaxy A51", "SM-A325": "Galaxy A32",
    "SM-A225": "Galaxy A22", "SM-A042": "Galaxy A04e", "SM-A032": "Galaxy A03 Core",
    // تابلت Galaxy Tab
    "SM-X216": "Galaxy Tab A9", "SM-X210": "Galaxy Tab A9", "SM-X215": "Galaxy Tab A9",
    "SM-X110": "Galaxy Tab A9 Kids", "SM-X115": "Galaxy Tab A9 Kids",
    "SM-X200": "Galaxy Tab A8", "SM-X205": "Galaxy Tab A8",
    "SM-X700": "Galaxy Tab S7 FE", "SM-X706": "Galaxy Tab S7 FE",
    "SM-X800": "Galaxy Tab S8+", "SM-X806": "Galaxy Tab S8+",
    "SM-X900": "Galaxy Tab S8 Ultra", "SM-X906": "Galaxy Tab S8 Ultra",
    "SM-X710": "Galaxy Tab S9", "SM-X716": "Galaxy Tab S9",
    "SM-X810": "Galaxy Tab S9+", "SM-X816": "Galaxy Tab S9+",
    "SM-X910": "Galaxy Tab S9 Ultra", "SM-X916": "Galaxy Tab S9 Ultra",
    "SM-X510": "Galaxy Tab S9 FE", "SM-X516": "Galaxy Tab S9 FE",
    "SM-X610": "Galaxy Tab S9 FE+", "SM-X616": "Galaxy Tab S9 FE+",
    "SM-T225": "Galaxy Tab A7 Lite", "SM-T220": "Galaxy Tab A7 Lite",
    "SM-T509": "Galaxy Tab A7", "SM-T500": "Galaxy Tab A7",
    "SM-A057": "Galaxy A05s", "SM-A155": "Galaxy A15", "SM-A165": "Galaxy A16",
    "SM-A266": "Galaxy A26", "SM-A366": "Galaxy A36", "SM-A566": "Galaxy A56",
    "SM-S721": "Galaxy S24 FE", "SM-A146": "Galaxy A14 5G"
  };
  for (const [code, name] of Object.entries(sam)) {
    if (up.startsWith(code) || up.includes(code)) return (b || "Samsung") + " " + name + " (" + m + ")";
  }
  if (/^SM-/i.test(m)) return (b || "Samsung") + " " + m;
  if (/^RMX/i.test(m)) return (b || "Realme") + " " + m;
  if (/^CPH/i.test(m)) return (b || "OPPO") + " " + m;
  if (/REDMI|POCO|MI\s/i.test(m) || /xiaomi/i.test(b)) return (b || "Xiaomi") + " " + m;
  if (/iphone/i.test(m)) return "Apple " + m;
  if (/ipad/i.test(m)) return "Apple " + m;
  if (/pixel/i.test(m)) return "Google " + m;
  if (b && m) return b + " " + m;
  return m || b || null;
}

/** عكس إحداثيات GPS → حي/مدينة أدق (Nominatim) */
const revGeoCache = new Map();
async function reverseGeocode(lat, lon) {
  try {
    const key = Number(lat).toFixed(4) + "," + Number(lon).toFixed(4);
    const hit = revGeoCache.get(key);
    if (hit && Date.now() < hit.exp) return hit.data;
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&accept-language=ar&zoom=16&addressdetails=1`;
    const r = await fetchT(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "ThanawyaClub-VisitTracker/1.0 (admin analytics)"
      }
    }, { timeout: 3500, retries: 0 });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.address) return null;
    const a = j.address;
    const data = {
      district: a.suburb || a.neighbourhood || a.quarter || a.city_district || a.village || a.town || "",
      city: a.city || a.town || a.municipality || a.county || "",
      region: a.state || a.region || a.province || "",
      country: a.country || "",
      countryCode: (a.country_code || "").toUpperCase(),
      postal: a.postcode || "",
      road: a.road || a.pedestrian || "",
      display: j.display_name || ""
    };
    if (revGeoCache.size > 2000) {
      let n = 200;
      for (const k of revGeoCache.keys()) { revGeoCache.delete(k); if (--n <= 0) break; }
    }
    revGeoCache.set(key, { data, exp: Date.now() + 6 * 3600_000 });
    return data;
  } catch {
    return null;
  }
}

// ==================== Geo cache + lookup (صاروخي) ====================
const geoCache = new Map(); // ip -> { data, exp }
const GEO_CACHE_TTL = 12 * 3600 * 1000; // 12 ساعة
const GEO_CACHE_MAX = 8000;

function geoCacheGet(ip) {
  const e = geoCache.get(ip);
  if (!e) return null;
  if (Date.now() > e.exp) { geoCache.delete(ip); return null; }
  return e.data;
}
function geoCacheSet(ip, data) {
  if (!ip || !data) return;
  if (geoCache.size >= GEO_CACHE_MAX) {
    let n = Math.ceil(GEO_CACHE_MAX * 0.1);
    for (const k of geoCache.keys()) {
      geoCache.delete(k);
      if (--n <= 0) break;
    }
  }
  geoCache.set(ip, { data, exp: Date.now() + GEO_CACHE_TTL });
}

async function lookupGeo(ip) {
  try {
    const cleanIp = String(ip || "").replace(/^::ffff:/, "").trim();
    if (
      !cleanIp ||
      cleanIp === "unknown" ||
      cleanIp === "127.0.0.1" ||
      cleanIp === "::1" ||
      cleanIp.startsWith("192.168.") ||
      cleanIp.startsWith("10.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(cleanIp)
    ) {
      return {
        country: "محلي", countryCode: "", city: "", region: "", district: "",
        postal: "", timezone: "", isp: "", as: "", lat: null, lon: null,
        query: cleanIp, proxy: false, hosting: false, mobile: false
      };
    }

    const cached = geoCacheGet(cleanIp);
    if (cached) return cached;

    const normalize = (raw) => {
      if (!raw) return null;
      return {
        country: raw.country || "",
        countryCode: raw.countryCode || "",
        city: raw.city || "",
        region: raw.region || "",
        district: raw.district || raw.city || "",
        postal: raw.postal || "",
        timezone: raw.timezone || "",
        isp: raw.isp || "",
        as: raw.as || "",
        lat: raw.lat ?? null,
        lon: raw.lon ?? null,
        query: raw.query || cleanIp,
        proxy: Boolean(raw.proxy),
        hosting: Boolean(raw.hosting),
        mobile: Boolean(raw.mobile)
      };
    };

    const race = async (fn) => {
      try { return await fn(); } catch { return null; }
    };

    const p1 = race(async () => {
      const r = await fetchT(`https://ipwho.is/${encodeURIComponent(cleanIp)}`, { headers: { Accept: "application/json" } }, { timeout: 2800, retries: 0 });
      if (!r.ok) return null;
      const j = await r.json();
      if (!j || j.success === false || !(j.country || j.city)) return null;
      return normalize({
        country: j.country || "",
        countryCode: j.country_code || "",
        city: j.city || "",
        region: j.region || j.region_code || "",
        district: j.district || j.city || "",
        postal: j.postal || j.zip || "",
        timezone: (j.timezone && (j.timezone.id || j.timezone)) || "",
        isp: (j.connection && (j.connection.isp || j.connection.org)) || j.isp || j.org || "",
        as: (j.connection && j.connection.asn != null) ? String(j.connection.asn) : (j.asn || ""),
        lat: j.latitude ?? null,
        lon: j.longitude ?? null,
        query: j.ip || cleanIp,
        proxy: Boolean(j.security && (j.security.vpn || j.security.proxy || j.security.tor)),
        hosting: Boolean(j.security && j.security.hosting),
        mobile: Boolean(j.connection && j.connection.mobile)
      });
    });

    const p2 = race(async () => {
      const r = await fetchT(`https://ipapi.co/${encodeURIComponent(cleanIp)}/json/`, { headers: { Accept: "application/json" } }, { timeout: 2800, retries: 0 });
      if (!r.ok) return null;
      const j = await r.json();
      if (!j || j.error || !(j.country_name || j.country)) return null;
      return normalize({
        country: j.country_name || j.country || "",
        countryCode: j.country_code || "",
        city: j.city || "",
        region: j.region || j.region_code || "",
        district: j.city || "",
        postal: j.postal || "",
        timezone: j.timezone || "",
        isp: j.org || j.asn || "",
        as: j.asn || "",
        lat: j.latitude ?? null,
        lon: j.longitude ?? null,
        query: j.ip || cleanIp,
        proxy: false,
        hosting: false,
        mobile: false
      });
    });

    const p3 = race(async () => {
      const r = await fetchT(
        `http://ip-api.com/json/${encodeURIComponent(cleanIp)}?fields=status,message,country,countryCode,regionName,city,district,zip,lat,lon,timezone,isp,org,as,query,proxy,hosting,mobile&lang=ar`,
        { headers: { Accept: "application/json" } },
        { timeout: 2800, retries: 0 }
      );
      if (!r.ok) return null;
      const j = await r.json();
      if (!j || j.status !== "success") return null;
      return normalize({
        country: j.country || "",
        countryCode: j.countryCode || "",
        city: j.city || "",
        region: j.regionName || "",
        district: j.district || j.city || "",
        postal: j.zip || "",
        timezone: j.timezone || "",
        isp: j.isp || j.org || "",
        as: j.as || "",
        lat: j.lat ?? null,
        lon: j.lon ?? null,
        query: j.query || cleanIp,
        proxy: Boolean(j.proxy),
        hosting: Boolean(j.hosting),
        mobile: Boolean(j.mobile)
      });
    });

    const result = await Promise.any([
      p1.then(v => v || Promise.reject()),
      p2.then(v => v || Promise.reject()),
      p3.then(v => v || Promise.reject())
    ]).catch(() => null);

    if (result) {
      geoCacheSet(cleanIp, result);
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

/** يحاول يربط الزيارة بطالب مسجّل (توكن أو جلسة نشطة بنفس الـ IP) */
function resolveStudentFromVisit(req, ip) {
  try {
    const auth = String(req.headers.authorization || "").trim();
    let token = "";
    if (auth.toLowerCase().startsWith("bearer ")) token = auth.slice(7).trim();
    if (!token) token = String(req.headers["x-student-token"] || (req.query && req.query.token) || "").trim();
    if (token) {
      const sess = studentSessions.get(token);
      if (sess && (!sess.expiresAt || sess.expiresAt > Date.now())) {
        return {
          studentCode: String(sess.code || ""),
          studentName: String(sess.name || ""),
          deviceId: String(sess.deviceId || ""),
          matchedBy: "token"
        };
      }
    }

    const nowT = Date.now();
    let best = null;
    for (const sess of studentSessions.values()) {
      if (!sess || !sess.code) continue;
      if (sess.expiresAt && sess.expiresAt < nowT) continue;
      if (sess.lastIp && sess.lastIp === ip) {
        if (!best || (sess.lastSeen || 0) > (best.lastSeen || 0)) {
          best = Object.assign({}, sess, { matchedBy: "session-ip" });
        }
      }
    }
    if (best) {
      return {
        studentCode: String(best.code || ""),
        studentName: String(best.name || ""),
        deviceId: String(best.deviceId || ""),
        matchedBy: best.matchedBy || "session-ip"
      };
    }
  } catch (e) {}
  return null;
}

// خريطة IP → آخر طالب (تتحدّث من تسجيل الدخول والـ heartbeat)
const ipToStudent = new Map(); // ip -> { code, name, deviceId, at }
const IP_STUDENT_TTL = 45 * 60 * 1000;

function rememberIpStudent(ip, code, name, deviceId) {
  if (!ip || !code) return;
  ipToStudent.set(ip, { code: String(code), name: String(name || ""), deviceId: String(deviceId || ""), at: Date.now() });
  if (ipToStudent.size > 15000) {
    const cutoff = Date.now() - IP_STUDENT_TTL;
    for (const [k, v] of ipToStudent) if (v.at < cutoff) ipToStudent.delete(k);
  }
}

// ===== بافر زيارات: تجميع كتابات Firebase كل 4 ثواني (خفّة + سرعة) =====
const visitWriteQueue = [];
let visitFlushTimer = null;
const VISIT_FLUSH_MS = 800;
const VISIT_QUEUE_MAX = 80;

async function flushVisitQueue() {
  visitFlushTimer = null;
  if (!visitWriteQueue.length) return;
  const batch = visitWriteQueue.splice(0, VISIT_QUEUE_MAX);
  await Promise.allSettled(batch.map(({ key, record }) => fbSet(key, record).catch((e) => {
    console.warn("[visit-flush]", e && e.message);
  })));
  // لو لسه فيه طابور، كمّل
  if (visitWriteQueue.length) scheduleVisitFlush(500);
}
function scheduleVisitFlush(ms = VISIT_FLUSH_MS) {
  if (visitFlushTimer) return;
  // لا تستخدم unref — كان بيسمح للعملية تتقفل قبل ما الزيارات تتكتب
  visitFlushTimer = setTimeout(() => { flushVisitQueue().catch(() => {}); }, ms);
}
function enqueueVisit(key, record) {
  visitWriteQueue.push({ key, record });
  if (visitWriteQueue.length >= VISIT_QUEUE_MAX) {
    flushVisitQueue().catch(() => {});
  } else {
    scheduleVisitFlush();
  }
}

app.post("/api/track-visit", async (req, res) => {
  // مهم: لازم نكمّل الكتابة قبل الرد — الرد المبكر + طابور unref كان بيضيع الزيارات
  // (خصوصًا على serverless أو لو العملية اتقفلت قبل الـ flush)
  try {
    const ip = clientIp(req);
    const body = req.body || {};
    // لو العميل بعت ua من المتصفح استخدمه (أدق من هيدر مخفف أحيانًا)
    const ua = String(body.ua || req.headers["user-agent"] || "Unknown").slice(0, 500);
    const nowTime = now();

    const device = parseDeviceInfo(ua);

    const chModel = String(req.headers["sec-ch-ua-model"] || "").replace(/"/g, "").trim();
    const chPlatform = String(req.headers["sec-ch-ua-platform"] || "").replace(/"/g, "").trim();
    const chPlatformVer = String(req.headers["sec-ch-ua-platform-version"] || "").replace(/"/g, "").trim();
    const chMobile = String(req.headers["sec-ch-ua-mobile"] || "").replace(/"/g, "").trim();
    const chUa = String(req.headers["sec-ch-ua"] || "").slice(0, 200);

    const screen = body.screen ? String(body.screen).slice(0, 40) : null;
    const timezoneBody = body.timezone ? String(body.timezone).slice(0, 60) : null;
    const language = body.language
      ? String(body.language).slice(0, 20)
      : String(req.headers["accept-language"] || "").split(",")[0].trim().slice(0, 20) || null;
    const page = body.page ? String(body.page).slice(0, 200) : null;
    const connection = body.connection ? String(body.connection).slice(0, 60) : null;
    const referer = String(req.headers["referer"] || req.headers["referrer"] || body.referrer || "").slice(0, 400);
    const clientModel = body.model ? String(body.model).slice(0, 80) : "";
    const clientBrand = body.brand ? String(body.brand).slice(0, 40) : "";
    const platform = body.platform ? String(body.platform).slice(0, 40) : (chPlatform || null);
    const cores = body.cores != null ? Number(body.cores) || null : null;
    const touchPoints = body.touchPoints != null ? Number(body.touchPoints) || null : null;
    const gpu = body.gpu ? String(body.gpu).slice(0, 120) : null;
    const vendor = body.vendor ? String(body.vendor).slice(0, 60) : null;
    const platformVersion = body.platformVersion ? String(body.platformVersion).slice(0, 30) : (chPlatformVer || null);

    const cleanModel = (m) => {
      const x = String(m || "").trim();
      if (!x || x === "?0" || x === "?1" || /^[KU]$/i.test(x)) return "";
      return x;
    };

    let deviceModel = cleanModel(clientModel) || cleanModel(chModel) || cleanModel(device.deviceModel) || "";
    let deviceBrand = clientBrand || device.deviceBrand || "";
    if (!deviceBrand && deviceModel) {
      if (/iphone|ipad|mac/i.test(deviceModel)) deviceBrand = "Apple";
      else if (/sm-|galaxy|samsung/i.test(deviceModel)) deviceBrand = "Samsung";
      else if (/redmi|xiaomi|poco|mi\s/i.test(deviceModel)) deviceBrand = "Xiaomi";
      else if (/rmx|cph|oppo|realme/i.test(deviceModel)) deviceBrand = "OPPO/Realme";
      else if (/infinix|tecno|itel/i.test(deviceModel)) deviceBrand = "Infinix/Tecno";
      else if (/pixel/i.test(deviceModel)) deviceBrand = "Google";
      else if (/vivo|v\d{4}/i.test(deviceModel)) deviceBrand = "Vivo";
      else if (/huawei|honor|ane-|lya-|clt-/i.test(deviceModel)) deviceBrand = "Huawei";
    }
    if (chMobile === "?1" && device.deviceType === "كمبيوتر") {
      device.deviceType = "موبايل";
      device.isMobile = true;
    }
    if (chPlatformVer && !device.osVersion) {
      device.osVersion = String(chPlatformVer).replace(/_/g, ".").slice(0, 20);
    }

    let studentLink = resolveStudentFromVisit(req, ip);
    if (!studentLink) {
      const mem = ipToStudent.get(ip);
      if (mem && (Date.now() - mem.at) < IP_STUDENT_TTL) {
        studentLink = {
          studentCode: mem.code,
          studentName: mem.name,
          deviceId: mem.deviceId,
          matchedBy: "ip-memory"
        };
      }
    }

    if (!studentLink && body.studentCode) {
      const sc = String(body.studentCode).replace(/\D/g, "").slice(0, 12);
      if (sc.length >= 6) {
        studentLink = {
          studentCode: sc,
          studentName: String(body.studentName || "").slice(0, 80),
          deviceId: String(body.deviceId || "").slice(0, 80),
          matchedBy: "client"
        };
      }
    }

    let studentPhone = null;
    let studentEmail = null;
    let studentSection = null;
    let studentGov = null;
    if (studentLink && studentLink.studentCode) {
      try {
        const st = await fbGetCached("students/" + studentLink.studentCode, 60_000);
        if (st) {
          if (!studentLink.studentName && st.name) studentLink.studentName = st.name;
          studentPhone = st.phone || st.mobile || st.tel || st.whatsapp || null;
          studentEmail = st.email || st.mail || st.gmail || null;
          studentSection = st.section || null;
          studentGov = st.governorate || st.gov || null;
          // لو مفيش موديل من المتصفح — خده من أجهزة الطالب المسجّلة (لو الاسم فيه كود موديل)
          if (!deviceModel && st.devices && typeof st.devices === "object") {
            const devs = Object.values(st.devices);
            const prefer = studentLink.deviceId && st.devices[studentLink.deviceId]
              ? [st.devices[studentLink.deviceId], ...devs]
              : devs;
            for (const d of prefer) {
              const nm = String((d && (d.name || d.model || d.deviceModel)) || "");
              if (/\b(SM-[A-Z0-9]+|RMX[0-9]+|CPH[0-9]+|Pixel\s?\d+|iPhone|iPad|Redmi|POCO|Infinix|TECNO)\b/i.test(nm)) {
                deviceModel = nm.replace(/^.*?\b((?:SM-[A-Z0-9]+|RMX[0-9]+|CPH[0-9]+))\b.*$/i, "$1") || nm;
                if (!deviceBrand) {
                  if (/SM-/i.test(nm)) deviceBrand = "Samsung";
                  else if (/RMX|CPH|OPPO|Realme/i.test(nm)) deviceBrand = "OPPO/Realme";
                  else if (/Redmi|POCO|Xiaomi|Mi\s/i.test(nm)) deviceBrand = "Xiaomi";
                  else if (/iPhone|iPad/i.test(nm)) deviceBrand = "Apple";
                }
                break;
              }
            }
          }
        }
      } catch (e) {}
    }

    let geo = null;
    try { geo = await lookupGeo(ip); } catch (e) {}

    let preciseLat = null;
    let preciseLon = null;
    let preciseAcc = null;
    try {
      if (body.lat != null && body.lon != null) {
        const la = Number(body.lat);
        const lo = Number(body.lon);
        if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
          preciseLat = la;
          preciseLon = lo;
          preciseAcc = body.accuracy != null ? Number(body.accuracy) || null : null;
        }
      }
    } catch (e) {}

    // لو فيه GPS → عكس الإحداثيات لحي/شارع أدق
    let road = null;
    let placeDisplay = null;
    if (preciseLat != null && preciseLon != null) {
      try {
        const rev = await reverseGeocode(preciseLat, preciseLon);
        if (rev) {
          if (rev.district) { if (geo) geo.district = rev.district; else geo = Object.assign({}, geo || {}, { district: rev.district }); }
          if (rev.city) { if (geo) geo.city = rev.city; else geo = Object.assign({}, geo || {}, { city: rev.city }); }
          if (rev.region) { if (geo) geo.region = rev.region; else geo = Object.assign({}, geo || {}, { region: rev.region }); }
          if (rev.country && geo) geo.country = rev.country;
          if (rev.countryCode && geo) geo.countryCode = rev.countryCode;
          if (rev.postal && geo) geo.postal = rev.postal;
          road = rev.road || null;
          placeDisplay = rev.display || null;
        }
      } catch (e) {}
    }

    const deviceLabel = friendlyDeviceName(deviceBrand, deviceModel) ||
      [deviceBrand, deviceModel].filter(Boolean).join(" ") ||
      // لو مفيش موديل من المتصفح — نخزن وصف مفيد بدل فاضي
      [device.deviceType || (device.isMobile ? "موبايل" : "كمبيوتر"), device.os, device.osVersion || platformVersion || "", device.browser, device.browserVersion]
        .filter(Boolean).join(" · ") || null;

    // بصمة مختصرة تساعد على تمييز نفس الجهاز حتى بدون تسجيل
    const deviceFingerprint = [
      deviceLabel || deviceModel || "",
      screen || "",
      (gpu || "").slice(0, 40),
      timezoneBody || "",
      (cores != null ? cores + "c" : ""),
      (body.deviceMemory != null ? body.deviceMemory + "GB" : "")
    ].filter(Boolean).join("|").slice(0, 180) || null;

    const botInfo = detectBot(ua, req, body);
    const isStudentVisit = Boolean(studentLink && studentLink.studentCode);
    const visitorKind = botInfo.isBot ? "bot" : (isStudentVisit ? "student" : "human");

    const record = {
      ip,
      os: device.os,
      osVersion: device.osVersion || platformVersion || null,
      deviceType: device.deviceType,
      deviceBrand: deviceBrand || null,
      deviceModel: deviceModel || null,
      deviceLabel: deviceLabel,
      browser: device.browser,
      browserVersion: device.browserVersion || null,
      isMobile: device.isMobile,
      isBot: Boolean(botInfo.isBot),
      botName: botInfo.botName || null,
      botConfidence: botInfo.confidence || null,
      visitorKind,
      language: language || null,
      referer: referer || null,
      screen: screen || null,
      timezone: timezoneBody || (geo && geo.timezone) || null,
      page: page || null,
      connection: connection || null,
      platform: platform || null,
      platformVersion: platformVersion || null,
      cores: cores,
      touchPoints: touchPoints,
      gpu: gpu || null,
      vendor: vendor || null,
      country: (geo && geo.country) || null,
      countryCode: (geo && geo.countryCode) || null,
      city: (geo && geo.city) || null,
      region: (geo && geo.region) || null,
      district: (geo && geo.district) || null,
      road: road || null,
      placeDisplay: placeDisplay || null,
      postal: (geo && geo.postal) || null,
      isp: (geo && geo.isp) || null,
      as: (geo && geo.as) || null,
      lat: geo ? geo.lat : null,
      lon: geo ? geo.lon : null,
      preciseLat: preciseLat,
      preciseLon: preciseLon,
      preciseAcc: preciseAcc,
      locationSource: preciseLat != null ? "gps" : (geo && geo.lat != null ? "ip" : null),
      proxy: geo ? geo.proxy : null,
      hosting: geo ? geo.hosting : null,
      mobileNet: geo ? geo.mobile : null,
      // زائر غير مسجّل يتسجل برضه — isStudent=false و guestId موجود
      isStudent: Boolean(studentLink && studentLink.studentCode),
      guestId: body.guestId ? String(body.guestId).replace(/[^a-zA-Z0-9_\-]/g, "").slice(0, 64) || null : null,
      deviceFingerprint: deviceFingerprint,
      studentCode: (studentLink && studentLink.studentCode) || null,
      studentName: (studentLink && studentLink.studentName) || null,
      studentDeviceId: (studentLink && studentLink.deviceId) || null,
      studentPhone: studentPhone || null,
      studentEmail: studentEmail || null,
      studentSection: studentSection || null,
      studentGov: studentGov || null,
      matchedBy: (studentLink && studentLink.matchedBy) || null,
      chUa: chUa || null,
      acceptLang: String(req.headers["accept-language"] || "").slice(0, 80) || null,
      deviceMemory: body.deviceMemory != null ? Number(body.deviceMemory) || null : null,
      downlink: body.downlink != null ? Number(body.downlink) || null : null,
      effectiveType: body.effectiveType ? String(body.effectiveType).slice(0, 20) : null,
      saveData: body.saveData === true || body.saveData === "true",
      hardwareConcurrency: cores,
      colorDepth: body.colorDepth != null ? Number(body.colorDepth) || null : null,
      orientation: body.orientation ? String(body.orientation).slice(0, 20) : null,
      userAgent: ua,
      // time دايمًا مللي ثانية Unix (رقم) — العرض في الأدمن بيتحسب من هنا بتوقيت القاهرة
      time: Number(nowTime) || Date.now(),
      timeISO: new Date(Number(nowTime) || Date.now()).toISOString(),
      timeCairo: (() => {
        try {
          const t = Number(nowTime) || Date.now();
          // صيغة واضحة: YYYY-MM-DD HH:mm:ss (توقيت مصر)
          const parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Africa/Cairo",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            hour12: false
          }).formatToParts(new Date(t));
          const get = (type) => (parts.find(p => p.type === type) || {}).value || "";
          return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
        } catch {
          return new Date(Number(nowTime) || Date.now()).toISOString();
        }
      })()
    };

    const visitKey = "visits/" + nowTime + "_" + Math.random().toString(36).slice(2, 8);
    // كتابة مباشرة ومتزامنة — مفيش تأخير setTimeout يضيع الزيارة
    try {
      await fbSet(visitKey, record);
      try { fbInvalidate("visits"); } catch {}
    } catch (writeErr) {
      console.warn("[track-visit] write:", writeErr && writeErr.message);
      try { enqueueVisit(visitKey, record); } catch {}
    }
  } catch (e) {
    console.warn("[track-visit]", e && e.message);
  }
  if (!res.headersSent) res.json({ success: true });
});

app.get("/api/admin/visits/summary", requireAdmin("students_view"), async (_req, res) => {
  try {
    const visits = (await fbGetCached("visits", 15_000)) || {};
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const dayStart = d0.getTime();
    let today = 0, mobileToday = 0, studentsToday = 0, guestsToday = 0;
    const ips = new Set();
    const ipsToday = new Set();
    for (const v of Object.values(visits)) {
      if (!v) continue;
      const t = Number(v.time) || 0;
      if (v.ip) ips.add(v.ip);
      if (t >= dayStart) {
        today++;
        if (v.ip) ipsToday.add(v.ip);
        if (v.isMobile) mobileToday++;
        if (v.isStudent || v.studentCode) studentsToday++;
        else guestsToday++;
      }
    }
    res.json({
      success: true,
      data: {
        total: Object.keys(visits).length,
        uniqueIps: ips.size,
        today,
        uniqueToday: ipsToday.size,
        mobileToday,
        studentsToday,
        guestsToday
      }
    });
  } catch (e) {
    jsonError(res, 500, e.message);
  }
});

app.get("/api/admin/visits", requireAdmin("students_view"), async (req, res) => {
  try {
    const limit = Math.min(1000, Math.max(50, Number(req.query.limit) || 400));
    const onlyStudents = String(req.query.students || "") === "1";
    const visits = (await fbGet("visits")) || {};
    let list = Object.entries(visits).map(([id, v]) => ({ id, ...v }));
    list.sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
    if (onlyStudents) list = list.filter((v) => v.isStudent || v.studentCode);
    const total = list.length;
    list = list.slice(0, limit);

    // إثراء بيانات الطالب (إيميل/تليفون/اسم) من السجل الحي — حتى لو الزيارة القديمة ناقصة
    const codes = [...new Set(list.map((v) => v.studentCode).filter(Boolean))];
    const studentMap = new Map();
    await Promise.all(codes.slice(0, 120).map(async (code) => {
      try {
        const st = await fbGetCached("students/" + code, 60_000);
        if (st) studentMap.set(String(code), st);
      } catch {}
    }));

    // فهرس lastIp من كل الطلاب (مرة واحدة) لربط الزيارات حتى بعد ريستارت
    let ipIndex = null;
    async function ensureIpIndex() {
      if (ipIndex) return ipIndex;
      ipIndex = new Map();
      try {
        const all = (await fbGetCached("students", 30_000)) || {};
        for (const [code, st] of Object.entries(all)) {
          if (!st || typeof st !== "object") continue;
          studentMap.set(String(code), st);
          if (st.lastIp) ipIndex.set(String(st.lastIp), { code: String(code), name: st.name || "", at: Number(st.lastIpAt) || 0 });
        }
      } catch {}
      // الذاكرة الحية لها أولوية
      for (const [ip, mem] of ipToStudent.entries()) {
        ipIndex.set(ip, { code: mem.code, name: mem.name || "", at: mem.at || Date.now() });
      }
      return ipIndex;
    }

    const needIp = list.some((v) => !v.studentCode && v.ip);
    if (needIp) await ensureIpIndex();

    for (const v of list) {
      if (!v.studentCode && v.ip) {
        const mem = (ipIndex && ipIndex.get(v.ip)) || ipToStudent.get(v.ip);
        if (mem && mem.code) {
          v.studentCode = mem.code;
          v.studentName = v.studentName || mem.name || null;
          v.isStudent = true;
          v.matchedBy = v.matchedBy || "student-lastIp";
        }
      }
    }

    list = list.map((v) => {
      const st = v.studentCode ? studentMap.get(String(v.studentCode)) : null;
      if (st) {
        const phone = st.phone || st.mobile || st.tel || st.whatsapp || null;
        const email = st.email || st.mail || st.gmail || null;
        v.isStudent = true;
        v.studentName = v.studentName || st.name || null;
        v.studentPhone = v.studentPhone || phone || null;
        v.studentEmail = v.studentEmail || email || null;
        v.studentSection = v.studentSection || st.section || null;
        v.studentGov = v.studentGov || st.governorate || st.gov || null;
        v.studentType = st.type || null;
        v.studentExpiresAt = st.expiresAt || null;
        v.studentActive = st.active !== false;
        v.studentVisitCount = st.visitCount || null;
        v.studentMaxDevices = st.maxDevices || null;
        v.studentDevicesCount = st.devices ? Object.keys(st.devices).length : (typeof st.devices === "number" ? st.devices : null);
        v.studentLastSeen = st.lastSeen || null;
        v.studentLastIp = st.lastIp || null;
      }
      return v;
    });

    res.json({ success: true, data: list, total, limited: total > list.length });
  } catch (e) {
    jsonError(res, 500, e.message);
  }
});

// ==================== سجل المشاهدة (مُحسَّن) ====================
app.post("/api/track-video", requireStudent, async (req, res) => {
  try {
    const { videoId, videoTitle, lectureId, lectureName, currentTime, duration, percent } = req.body;
    if (!videoId) return res.status(400).json({ success: false });
    
    const code = req.student.code;
    const nowTime = now();
    
    const existing = await fbGet(`history/${code}/${videoId}`);
    const curTime = Number(currentTime) || 0;
    const dur = Number(duration) || 0;
    const pct = Number(percent) || (dur > 0 ? Math.round(curTime / dur * 100) : 0);
    
    const record = {
      code: code,
      name: req.student.name,
      videoId: String(videoId),
      videoTitle: videoTitle || "فيديو",
      lectureId: lectureId || null,
      lectureName: lectureName || null,
      firstViewedAt: existing?.firstViewedAt || nowTime,
      lastViewedAt: nowTime,
      viewCount: (Number(existing?.viewCount) || 0) + 1,
      maxPercent: Math.max(Number(existing?.maxPercent) || 0, pct),
      lastCurrentTime: curTime,
      duration: dur || Number(existing?.duration) || 0,
      completed: (Math.max(Number(existing?.maxPercent) || 0, pct) >= 90)
    };
    
    await fbSet(`history/${code}/${videoId}`, record);
    res.json({ success: true });
  } catch (e) {
    console.warn("[track-video]", e.message);
    res.json({ success: false });
  }
});

app.get("/api/admin/history", requireAdmin("students_view"), async (_req, res) => {
  try {
    const history = (await fbGet("history")) || {};
    let list = [];
    for (const [code, videos] of Object.entries(history)) {
      for (const [videoId, v] of Object.entries(videos || {})) {
        list.push({ 
          id: `${code}_${videoId}`, 
          code, 
          ...v,
          time: v.lastViewedAt || v.time || 0
        });
      }
    }
    list.sort((a, b) => (b.time || 0) - (a.time || 0));
    res.json({ success: true, data: list });
  } catch (e) {
    jsonError(res, 500, e.message);
  }
});

app.get("/api/admin/history/:code", requireAdmin("students_view"), async (req, res) => {
  try {
    const code = req.params.code;
    const history = (await fbGet(`history/${code}`)) || {};
    const list = Object.entries(history).map(([videoId, v]) => ({ 
      id: videoId, 
      ...v,
      time: v.lastViewedAt || v.time || 0
    })).sort((a, b) => (b.time || 0) - (a.time || 0));
    res.json({ success: true, data: list });
  } catch (e) {
    jsonError(res, 500, e.message);
  }
});

app.post("/api/auth/login", rateLimit({ max: 12, windowMs: 60_000, scope: "student-login", banAfter: 3, banMs: 15 * 60_000 }), async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim();
    const deviceId = String(req.body?.deviceId || "").trim();
    const deviceName = String(req.body?.deviceName || "Unknown").slice(0, 80);
    const ip = clientIp(req);

    if (!/^\d{9}$/.test(code)) return jsonError(res, 400, "الكود يجب أن يكون 9 أرقام");
    if (!deviceId || deviceId.length < 8) return jsonError(res, 400, "deviceId مطلوب");

    const lock = checkLoginLockAny("student", deviceId, ip, code);
    if (lock && lock.locked) { res.setHeader("Retry-After", String(lock.sec)); return jsonError(res, 429, `الموبايل اتقفل مؤقتًا بعد محاولات غلط — جرّب بعد ${Math.ceil(lock.sec / 60)} دقيقة`); }

    const student = await fbGet(`students/${code}`);
    if (!student || student.active === false) {
      const fail = recordLoginFailBoth("student", deviceId, ip, code);
      if (fail.locked) { res.setHeader("Retry-After", String(fail.sec)); return jsonError(res, 429, `محاولات خاطئة كثيرة — حاول بعد 15 دقيقة`); }
      return jsonError(res, 401, `كود غير صحيح أو موقوف (متبقي ${fail.remaining} محاولات)`);
    }

    if (!student.activatedAt) {
      const duration = Number(student.durationMs) > 0 ? Number(student.durationMs) : resolveDurationMs({ type: student.type, days: student.days });
      if (!duration || duration <= 0) return jsonError(res, 400, "مدة الاشتراك غير محددة لهذا الكود");
      const activatedAt = now();
      const expiresAt = activatedAt + duration;
      await fbPatch(`students/${code}`, { activatedAt, expiresAt, durationMs: duration });
      student.activatedAt = activatedAt; student.expiresAt = expiresAt; student.durationMs = duration;
      console.log("[auth] activated code", code, "until", new Date(expiresAt).toISOString());
    }

    if (student.expiresAt && now() > student.expiresAt) return jsonError(res, 403, "انتهت صلاحية الاشتراك");

    const devices = student.devices || {};
    const bannedMap = student.bannedDevices || {};
    if (deviceId && bannedMap[deviceId]) return jsonError(res, 403, "هذا الجهاز محظور على هذا الكود");

    const maxDevices = Number(student.maxDevices || 1);
    if (!devices[deviceId]) {
      if (Object.keys(devices).length >= maxDevices) return jsonError(res, 403, `تم بلوغ الحد الأقصى للأجهزة (${maxDevices}). اطلب من الأدمن حذف جهاز.`);
      devices[deviceId] = { name: deviceName, addedAt: now(), lastSeen: now() };
      await fbSet(`students/${code}/devices`, devices);
    } else {
      devices[deviceId].lastSeen = now();
      devices[deviceId].name = deviceName || devices[deviceId].name;
      await fbSet(`students/${code}/devices/${deviceId}`, devices[deviceId]);
    }

    try { await fbPatch(`students/${code}`, { lastSeen: now() }); } catch (e) {}

    const sessionTtl = Math.min(CONFIG.STUDENT_SESSION_MS, Math.max(60_000, (student.expiresAt || now() + CONFIG.STUDENT_SESSION_MS) - now()));
    const expiresAt = now() + sessionTtl;
    // توكن JWT طويل بنفس شكل المنصات الأخرى
    const token = makeStudentJwt({ code, deviceId, name: student.name, expiresAt });
    const sess = { token, code, deviceId, name: student.name, section: student.section || null, createdAt: now(), expiresAt, lastIp: ip, lastSeen: now() };
    studentSessions.set(token, sess);
    try { await fbSet(`sessions/${sessionStoreKey(token)}`, sess); } catch (e) { console.warn("[login] session fb:", e.message); }
    try { rememberIpStudent(ip, code, student.name, deviceId); } catch (e) {}
    try {
      // نحفظ آخر IP على الطالب عشان ربط الزيارات يبقى دقيق حتى بعد ريستارت السيرفر
      fbPatch(`students/${code}`, { lastIp: ip, lastIpAt: now() }).catch(() => {});
    } catch (e) {}
    clearLoginFailBoth("student", deviceId, ip, code);

    let subjectIds = [];
    let yearId = CONFIG.DEFAULT_YEAR_ID;
    const secInfo = await resolveSection(student.section);
    if (secInfo) {
      subjectIds = secInfo.subjectIds || [];
      yearId = secInfo.yearId || yearId;
      if (secInfo.id && student.section !== secInfo.id) { try { await fbPatch(`students/${code}`, { section: secInfo.id }); } catch {} student.section = secInfo.id; }
    }

    const profile = studentProfileInfo(student);
    res.json({
      success: true,
      data: {
        token, expiresAt: sess.expiresAt,
        student: {
          name: student.name,
          code,
          section: student.section || null,
          expiresAt: student.expiresAt,
          maxDevices,
          deviceId,
          email: student.email || null,
          phone: student.phone || null,
          governorate: student.governorate || null
        },
        yearId,
        subjectIds,
        needsProfile: profile.needsProfile,
        missingFields: profile.missingFields
      }
    });
  } catch (e) { console.error("[login]", e.message); jsonError(res, 500, e.message); }
});

app.post("/api/auth/logout", requireStudent, async (req, res) => {
  try { studentSessions.delete(req.sessionToken); await fbDelete(`sessions/${sessionStoreKey(req.sessionToken)}`); res.json({ success: true }); } catch (e) { jsonError(res, 500, e.message); }
});

function studentProfileInfo(s) {
  const email = String(s?.email || "").trim();
  const phone = String(s?.phone || "").replace(/\D/g, "");
  const missingFields = [];
  if (!phone || phone.length < 10) missingFields.push("phone");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) missingFields.push("email");
  return {
    needsProfile: missingFields.length > 0,
    missingFields,
    email: email || null,
    phone: s?.phone ? String(s.phone).trim() : null,
    governorate: s?.governorate ? String(s.governorate).trim() : null
  };
}

function normalizePhone(raw) {
  let p = String(raw || "").trim().replace(/[^\d+]/g, "");
  if (!p) return "";
  // مصر: حول 01xxxxxxxxx → +201xxxxxxxxx
  if (/^01\d{9}$/.test(p)) p = "+20" + p.slice(1);
  else if (/^201\d{9}$/.test(p)) p = "+" + p;
  return p.slice(0, 20);
}

app.get("/api/auth/me", requireStudent, async (req, res) => {
  try {
    const s = req.student;
    let subjectIds = []; let yearId = CONFIG.DEFAULT_YEAR_ID;
    const secInfo = await resolveSection(s.section);
    if (secInfo) { subjectIds = secInfo.subjectIds || []; yearId = secInfo.yearId || yearId; if (secInfo.id) s.section = secInfo.id; }
    const profile = studentProfileInfo(s);
    res.json({
      success: true,
      data: {
        name: s.name,
        code: req.session.code,
        section: s.section || null,
        expiresAt: s.expiresAt,
        maxDevices: s.maxDevices || 1,
        devices: Object.keys(s.devices || {}).length,
        deviceId: req.session.deviceId,
        yearId,
        subjectIds,
        sessionExpiresAt: req.session.expiresAt,
        email: profile.email,
        phone: profile.phone,
        governorate: profile.governorate,
        needsProfile: profile.needsProfile,
        missingFields: profile.missingFields,
        visitCount: Number(s.visitCount) || 0,
        lastSeen: s.lastSeen || null
      }
    });
  } catch (e) { jsonError(res, 500, e.message); }
});

// استكمال / تحديث بيانات الطالب بعد الدخول
app.patch("/api/auth/profile", requireStudent, rateLimit({ max: 20, windowMs: 60_000, scope: "student-profile" }), async (req, res) => {
  try {
    const code = String(req.session.code);
    const body = req.body || {};
    const patch = {};

    if (body.name != null) {
      const name = String(body.name).trim().slice(0, 120);
      if (name.length < 2) return jsonError(res, 400, "الاسم قصير جدًا");
      patch.name = name;
    }
    if (body.email != null) {
      const email = String(body.email).trim().toLowerCase().slice(0, 120);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError(res, 400, "الإيميل غير صالح");
      patch.email = email || null;
    }
    if (body.phone != null) {
      const phone = normalizePhone(body.phone);
      if (phone && phone.replace(/\D/g, "").length < 10) return jsonError(res, 400, "رقم الموبايل غير صالح");
      patch.phone = phone || null;
    }
    if (body.governorate != null) {
      patch.governorate = String(body.governorate).trim().slice(0, 60) || null;
    }

    if (!Object.keys(patch).length) return jsonError(res, 400, "مفيش بيانات للتحديث");

    patch.profileUpdatedAt = now();
    await fbPatch(`students/${code}`, patch);
    try { authCache.delete(code); } catch {}

    const student = await fbGet(`students/${code}`);
    const profile = studentProfileInfo(student || {});
    res.json({
      success: true,
      message: "تم حفظ البيانات",
      data: {
        name: student?.name || null,
        email: profile.email,
        phone: profile.phone,
        governorate: profile.governorate,
        needsProfile: profile.needsProfile,
        missingFields: profile.missingFields
      }
    });
  } catch (e) {
    jsonError(res, 500, e.message);
  }
});

app.get("/api/config", requireStudent, async (req, res) => {
  const yearOverride = req.query.year != null ? req.query.year : null;
  let yearId = yearOverride != null ? resolveYearId(yearOverride) : CONFIG.DEFAULT_YEAR_ID;
  let subjectIds = [];
  const secInfo = await resolveSection(req.student.section, yearOverride);
  if (secInfo) { yearId = secInfo.yearId || yearId; subjectIds = secInfo.subjectIds || []; }
  res.json({ success: true, yearId, subjectIds, cryptoReady: Boolean(decryptPlaybackKeyFn), decryptSegments: true });
});

const THANAWICA_ALLOWED_SECTIONS = new Set(["scientific_sciences", "scientific_math", "azhari"]);
function studentAllowsThanawica(student) { const sec = normalizeSection(student && student.section); return THANAWICA_ALLOWED_SECTIONS.has(sec || ""); }

app.get("/api/subjects/:id", requireStudent, async (req, res) => {
  try {
    const yearId = resolveYearId(req.query.year || req.params.id || CONFIG.DEFAULT_YEAR_ID);
    const secInfo = await resolveSection(req.student.section, yearId);
    let wantedIds = [];
    if (secInfo && Array.isArray(secInfo.subjectIds) && secInfo.subjectIds.length) wantedIds = secInfo.subjectIds.map(Number).filter((n) => !Number.isNaN(n));

    const cacheKey = `subjects:year:${yearId}`;
    let yearList = cacheGet(cacheKey);
    let yearData = { success: true, message: "Success", data: yearList };
    if (!yearList) {
      yearData = await coalesce("up:subjects:" + yearId, () => upstreamJson(`/user/subjects/${encodeURIComponent(yearId)}`));
      yearList = Array.isArray(yearData.data) ? yearData.data : [];
      cacheSet(cacheKey, yearList, 15 * 60_000);
    }
    const byId = new Map(yearList.map((s) => [Number(s.id), s]));
    if (!wantedIds.length) return res.json({ ...yearData, data: yearList });

    async function resolveOne(sid) {
      if (byId.has(sid)) return byId.get(sid);
      const ck = `subj:meta:${sid}`;
      const hit = cacheGet(ck);
      if (hit) return hit;
      try {
        const t = await upstreamJson(`/user/subjects/${sid}/teachers`);
        const d = t?.data;
        const item = { id: Number(d?.id) || sid, name: d?.name || `مادة ${sid}`, image_url: d?.image_url || null, year_id: yearId, is_published: true };
        cacheSet(ck, item, 20 * 60_000);
        return item;
      } catch (err) { console.warn(`[subjects] resolve ${sid}:`, err.message); return { id: sid, name: `مادة ${sid}`, image_url: null, year_id: yearId, is_published: true }; }
    }

    let results = await Promise.all(wantedIds.map((sid, idx) => resolveOne(sid).then((s) => ({ ...s, order_index: idx + 1 }))));

    // الرياضة من كورساتك فقط — مش بنستبدلها بمادة ثانويكا
    // لو حابب ترجع الاستبدال: THANAWICA_REPLACE_MATH=1
    if (CONFIG.THANAWICA_ENABLED && process.env.THANAWICA_REPLACE_MATH === "1" && studentAllowsThanawica(req.student)) {
      try {
        const thList = await thSubjectsForYear(yearId);
        const thMath = thList.find((s) => s._kind === "math") || null;
        if (thMath) {
          const filtered = [];
          let replacedMath = false;
          for (const s of results) {
            const kind = chemMathKind(s.name);
            if (kind === "math" && !replacedMath) { filtered.push({ ...thMath, order_index: s.order_index, name: thMath.name || s.name, image_url: s.image_url || thMath.image_url || null }); replacedMath = true; }
            else if (kind === "math" && replacedMath) continue;
            else filtered.push(s);
          }
          if (!replacedMath) filtered.push({ ...thMath, order_index: filtered.length + 1 });
          results = filtered;
        }
      } catch (e) { console.warn("[subjects] thanawica hybrid skip:", e.message); }
    }

    // حقن مادة أحياء — د. حسام عيسى (Bunny)
    results.push({
      id: HOSSAM_SUBJECT_ID,
      name: "أحياء — د. حسام عيسى",
      image_url: null,
      year_id: yearId,
      is_published: true,
      order_index: results.length + 1,
      _source: "hossam"
    });

    res.json({ success: true, message: "Success", data: results });
  } catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/subjects/:id/teachers", requireStudent, async (req, res) => {
  res.setHeader("Cache-Control", "private, max-age=60");
  try {
    if (String(req.params.id) === String(HOSSAM_SUBJECT_ID) || String(req.params.id) === "hos_biology") {
      return res.json({
        success: true,
        message: "Success",
        data: {
          id: HOSSAM_SUBJECT_ID,
          name: "أحياء — د. حسام عيسى",
          image_url: null,
          teachers: [{ id: HOSSAM_TEACHER_ID, name: "د. حسام عيسى", image_url: null, chapter_count: (HOSSAM_CATALOG.courses || []).length }]
        }
      });
    }
    if (CONFIG.THANAWICA_ENABLED && isThId(req.params.id) && studentAllowsThanawica(req.student)) {
      const data = await thTeachers(req.params.id);
      return res.json({ success: true, message: "Success", data });
    }
    res.json(await upstreamJson(`/user/subjects/${encodeURIComponent(req.params.id)}/teachers`));
  } catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/teachers/:id/chapters", requireStudent, async (req, res) => {
  res.setHeader("Cache-Control", "private, max-age=60");
  try {
    if (String(req.params.id) === String(HOSSAM_TEACHER_ID) || String(req.params.id) === "hos_teacher") {
      const chapters = (HOSSAM_CATALOG.courses || []).map((c, i) => ({
        id: HOSSAM_CHAPTER_BASE + i,
        name: c.name,
        image_url: null,
        teacher_name: HOSSAM_CATALOG.teacher,
        subject_name: HOSSAM_CATALOG.subject,
        lecture_count: (c.lessons || []).length,
        _source: "hossam",
        _courseId: c.id
      }));
      return res.json({ success: true, message: "Success", data: chapters });
    }
    if (CONFIG.THANAWICA_ENABLED && isThId(req.params.id) && studentAllowsThanawica(req.student)) {
      const data = await thChapters(req.params.id);
      return res.json({ success: true, message: "Success", data });
    }
    res.json(await upstreamJson(`/user/teachers/${encodeURIComponent(req.params.id)}/chapters`));
  } catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/chapters/:id/lectures", requireStudent, async (req, res) => {
  res.setHeader("Cache-Control", "private, max-age=60");
  try {
    const cid = Number(req.params.id);
    if (Number.isFinite(cid) && cid >= HOSSAM_CHAPTER_BASE && cid < HOSSAM_CHAPTER_BASE + 100) {
      const idx = cid - HOSSAM_CHAPTER_BASE;
      const course = (HOSSAM_CATALOG.courses || [])[idx];
      if (!course) return jsonError(res, 404, "فصل حسام غير موجود");
      const lectures = (course.lessons || []).map((l) => ({
        id: HOSSAM_LECTURE_BASE + Number(l.lessonId),
        name: l.title || (`درس ${l.lessonId}`),
        image_url: null,
        chapter_name: course.name,
        teacher_name: HOSSAM_CATALOG.teacher,
        subject_name: HOSSAM_CATALOG.subject,
        video_count: l.videoId ? 1 : 0,
        pdf_count: 0,
        exam_count: 0,
        _source: "hossam",
        _videoId: l.videoId || null
      }));
      return res.json({ success: true, message: "Success", data: lectures });
    }
    if (CONFIG.THANAWICA_ENABLED && isThId(req.params.id) && studentAllowsThanawica(req.student)) {
      const data = await thLectures(req.params.id);
      return res.json({ success: true, message: "Success", data });
    }
    res.json(await upstreamJson(`/user/chapters/${encodeURIComponent(req.params.id)}/lectures`));
  } catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/lectures/:id/content", requireStudent, async (req, res) => {
  try {
    const lid = Number(req.params.id);
    if (Number.isFinite(lid) && lid >= HOSSAM_LECTURE_BASE) {
      const lessonId = lid - HOSSAM_LECTURE_BASE;
      let found = null; let courseName = "";
      for (const c of HOSSAM_CATALOG.courses || []) {
        for (const l of c.lessons || []) {
          if (Number(l.lessonId) === lessonId) { found = l; courseName = c.name; break; }
        }
        if (found) break;
      }
      if (!found) return jsonError(res, 404, "درس حسام غير موجود — حدّث الكتالوج بعد resolve-lesson");
      return res.json({
        success: true,
        message: "Success",
        data: {
          lecture_id: lid,
          lecture_name: found.title || (`درس ${lessonId}`),
          videos: found.videoId ? [{ id: found.videoId, title: found.title || found.videoId, duration: 0, _source: "hossam" }] : [],
          pdfs: [],
          exams: []
        }
      });
    }
    if (CONFIG.THANAWICA_ENABLED && isThId(req.params.id) && studentAllowsThanawica(req.student)) return res.json(await thLectureContent(req.params.id));
    res.json(await upstreamJson(`/user/lectures/${encodeURIComponent(req.params.id)}/content`));
  } catch (e) { jsonError(res, 502, e.message); }
});


// ==================== Bunny Stream (د. حسام عيسى) — فك حماية iframe/Referer + AES-128 ====================
// كتالوج أولي — د. حسام عيسى (Bunny). أضف guids بعد resolve-lesson
const HOSSAM_SUBJECT_ID = 900001;
const HOSSAM_TEACHER_ID = 900001;
const HOSSAM_CHAPTER_BASE = 900100;
const HOSSAM_LECTURE_BASE = 910000;
const HOSSAM_CATALOG = {
  teacher: "د. حسام عيسى",
  subject: "أحياء",
  platform: "drhossamissa.com",
  libraryId: "396717",
  courses: [
    {
      id: "hormones-workshop",
      name: "ورشة الهرمونات",
      courseId: 9,
      lessons: [
        { lessonId: 120, title: "ورشة الهرمونات — الدرس المتاح", videoId: "bn_1e836766-fc56-46cf-a702-e245d193cfbb", guid: "1e836766-fc56-46cf-a702-e245d193cfbb" },
        { lessonId: 121, title: "الدرس الاول", videoId: null, guid: null },
        { lessonId: 122, title: "الدرس الثاني", videoId: null, guid: null },
        { lessonId: 123, title: "حل الدرس الاول", videoId: null, guid: null },
        { lessonId: 124, title: "حل الدرس الثاني", videoId: null, guid: null },
        { lessonId: 125, title: "حل كتاب المرشد", videoId: null, guid: null },
        { lessonId: 126, title: "مقدمة الهرمونات في النبات والإنسان", videoId: null, guid: null },
        { lessonId: 127, title: "الغدة النخامية", videoId: null, guid: null },
        { lessonId: 128, title: "الغدة الدرقية والجارات درقية", videoId: null, guid: null },
        { lessonId: 129, title: "الهرمونات — تكملة", videoId: null, guid: null },
        { lessonId: 130, title: "الهرمونات — مراجعة", videoId: null, guid: null }
      ]
    }
  ]
};

function isBunnyVideoId(id) {
  return /^(?:bn|hos|hossam)_/i.test(String(id || ""));
}
function parseBunnyGuid(videoId) {
  const raw = String(videoId || "");
  const m = raw.match(/^(?:bn|hos|hossam)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1].toLowerCase() : null;
}
async function bunnyFetch(url, extraHeaders = {}) {
  const headers = {
    Accept: "*/*",
    "Cache-Control": "no-cache",
    Origin: CONFIG.BUNNY_ORIGIN || "https://iframe.mediadelivery.net",
    Referer: CONFIG.BUNNY_REFERER || "https://iframe.mediadelivery.net/",
    "User-Agent": CONFIG.STREAM_UA || "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/153.0.0.0 Mobile Safari/537.36",
    ...extraHeaders
  };
  return upstreamSlot(() => fetchT(url, { headers, cache: "no-store" }, { timeout: 30_000, retries: 2 }));
}
function pickBunnyVariant(masterText, prefer = ["720p", "480p", "1080p", "360p", "240p"]) {
  const lines = String(masterText || "").split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith("#EXT-X-STREAM-INF")) continue;
    const next = (lines[i + 1] || "").trim();
    if (!next || next.startsWith("#")) continue;
    const bw = Number((t.match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
    const res = ((t.match(/RESOLUTION=(\d+x\d+)/) || [])[1] || "");
    variants.push({ line: next, bw, res, raw: t });
  }
  if (!variants.length) return null;
  for (const p of prefer) {
    const hit = variants.find((v) => v.line.includes(p) || (p === "720p" && v.res.startsWith("1280")) || (p === "1080p" && v.res.startsWith("1920")) || (p === "480p" && v.res.startsWith("854")) || (p === "360p" && v.res.startsWith("640")));
    if (hit) return hit.line;
  }
  variants.sort((a, b) => b.bw - a.bw);
  return variants[0].line;
}
async function buildBunnySource(guid, clientHeaders) {
  const host = CONFIG.BUNNY_CDN_HOST || "vz-878412bf-692.b-cdn.net";
  const base = `https://${host}/${guid}`;
  const masterUrl = `${base}/playlist.m3u8`;
  const masterRes = await bunnyFetch(masterUrl);
  if (!masterRes.ok) {
    const e = new Error(`Bunny master HTTP ${masterRes.status}`);
    e.status = masterRes.status === 403 ? 403 : 502;
    throw e;
  }
  const masterText = await masterRes.text();
  if (!masterText.includes("#EXTM3U")) throw new Error("Bunny playlist غير صالح");

  let variantRel = pickBunnyVariant(masterText) || "720p/video.m3u8";
  let variantUrl;
  try { variantUrl = new URL(variantRel, masterUrl).href; } catch { variantUrl = `${base}/${variantRel.replace(/^\//, "")}`; }

  const varRes = await bunnyFetch(variantUrl);
  if (!varRes.ok) throw new Error(`Bunny variant HTTP ${varRes.status}`);
  const varText = await varRes.text();
  if (!varText.includes("#EXTM3U")) throw new Error("Bunny variant غير صالح");

  const allowedHosts = new Set([
    ...CONFIG.STREAM_HOSTS,
    host,
    "b-cdn.net",
    "mediadelivery.net",
    "iframe.mediadelivery.net"
  ]);
  try { allowedHosts.add(new URL(variantUrl).hostname); } catch {}

  const src = {
    reqVideoId: "bn_" + guid,
    videoId: guid,
    mode: "bunny",
    token: "bunny",
    streamUrl: masterUrl,
    allowedHosts,
    plainKey: null,
    defaultIv: null,
    mediaSeq: 0,
    segs: [],
    playlist: "",
    targetDuration: 4,
    createdAt: now()
  };

  const lines = varText.split(/\r?\n/);
  const out = [];
  const segs = [];
  let mediaSeq = 0;
  let currentIv = null;
  let keyFetched = false;
  let segIndex = 0;
  let targetDuration = 4;

  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("#EXT-X-MEDIA-SEQUENCE:")) mediaSeq = Number(t.split(":")[1]) || 0;
    if (t.startsWith("#EXT-X-TARGETDURATION:")) targetDuration = Number(t.split(":")[1]) || targetDuration;
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-KEY:")) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      const ivHex = line.match(/IV=(0x[0-9a-fA-F]+|[0-9a-fA-F]{32})/i)?.[1];
      if (ivHex) currentIv = parseIvHex(ivHex);
      if (uri && !keyFetched) {
        const keyUrl = new URL(uri, variantUrl).href;
        try { allowedHosts.add(new URL(keyUrl).hostname); } catch {}
        const keyRes = await bunnyFetch(keyUrl);
        if (!keyRes.ok) throw new Error(`Bunny key HTTP ${keyRes.status}`);
        const keyBuf = Buffer.from(await keyRes.arrayBuffer());
        if (keyBuf.length !== 16) throw new Error(`Bunny key len ${keyBuf.length}`);
        // مفتاح AES-128 صريح — بدون unwrap stream-weave
        src.plainKey = keyBuf;
        src.defaultIv = currentIv;
        keyFetched = true;
        console.log(`[key] bunny for ${guid}`);
      }
      continue; // السيرفر يفك التشفير قبل الإرسال
    }
    if (line.startsWith("#EXTINF:")) {
      out.push(raw);
      const dur = Number(line.slice(8).split(",")[0]) || targetDuration;
      // duration stored with next seg
      src._lastDur = dur;
      continue;
    }
    if (line && !line.startsWith("#")) {
      const segmentUrl = new URL(line, variantUrl).href;
      try { allowedHosts.add(new URL(segmentUrl).hostname); } catch {}
      const seq = mediaSeq + segIndex;
      const iv = currentIv || ivFromMediaSequence(seq);
      segs.push({ u: segmentUrl, iv: iv.toString("hex"), s: seq, i: segIndex, dur: src._lastDur || targetDuration });
      out.push(`/api/hls/${SID_TOKEN}/seg/${segIndex}`);
      segIndex++;
      continue;
    }
    if (line.startsWith("#EXT-X-ENDLIST") || line.startsWith("#EXTM3U") || line.startsWith("#EXT-X-VERSION") || line.startsWith("#EXT-X-TARGETDURATION") || line.startsWith("#EXT-X-MEDIA-SEQUENCE") || line.startsWith("#EXT-X-PLAYLIST-TYPE")) {
      out.push(raw);
      continue;
    }
    if (line.startsWith("#")) {
      out.push(raw);
      continue;
    }
  }

  if (!src.plainKey) throw new Error("فشل جلب مفتاح Bunny");
  if (!segs.length) throw new Error("مفيش مقاطع في قائمة Bunny");
  src.mediaSeq = mediaSeq;
  src.segs = segs;
  src.targetDuration = targetDuration;
  src.playlist = out.join("\n");
  src.allowedHosts = allowedHosts;
  return src;
}

const SOURCE_TTL_MS = Number(process.env.SOURCE_TTL_MS || 15 * 60_000);
const sourceCache = new Map();
const SID_TOKEN = "{{SID}}";

async function buildPlaylist(src, masterText, clientHeaders) {
  if (masterText == null) {
    const m = await streamFetch(src, src.streamUrl, {}, clientHeaders);
    masterText = await m.text();
    if (!masterText.includes("#EXTM3U")) throw new Error(`Stream master HTTP ${m.status}`);
  }
  let text = masterText;
  let baseUrl = src.streamUrl;

  // لو عندنا media playlist من key-ticket (فيه EXTINF + floravon) استخدمه مباشرة
  if (src.mediaPlaylistText && /#EXTINF/i.test(src.mediaPlaylistText) && /#EXTM3U/i.test(src.mediaPlaylistText)) {
    text = src.mediaPlaylistText;
    baseUrl = src.streamUrl || `https://api.stream-weave.com/api/v1/videos/${src.videoId}/stream/600/playlist.m3u8`;
    console.log("[weave-v3] buildPlaylist using mediaPlaylistText from key-ticket");
  } else {
    const mLines = masterText.split(/\r?\n/);
    let variant = null;
    for (let i = 0; i < mLines.length; i++) {
      if (mLines[i].trim().startsWith("#EXT-X-STREAM-INF")) {
        const next = mLines[i + 1]?.trim();
        if (next && !next.startsWith("#")) {
          // data: URL من تلفيف سابق؟
          if (next.startsWith("data:")) continue;
          variant = new URL(next, src.streamUrl).href;
          break;
        }
      }
    }
    if (variant) {
      const v = await streamFetch(src, variant, {}, clientHeaders);
      text = await v.text();
      if (!text.includes("#EXTM3U")) throw new Error(`Variant HTTP ${v.status}`);
      baseUrl = variant;
    }
    // لو الـ media لسة مفيش EXTINF وkey-ticket موجود
    if (!/#EXTINF/i.test(text) && src.mediaPlaylistText && /#EXTINF/i.test(src.mediaPlaylistText)) {
      text = src.mediaPlaylistText;
      console.log("[weave-v3] fallback to key-ticket media after empty variant");
    }
  }
  try { src.allowedHosts.add(new URL(baseUrl).hostname); } catch {}
  const lines = text.split(/\r?\n/);
  const out = [];
  const segs = [];
  let mediaSeq = 0;
  let currentIv = null;
  let keyFetched = false;
  let keyIvAttr = "";
  for (const raw of lines) { const t = raw.trim(); if (t.startsWith("#EXT-X-MEDIA-SEQUENCE:")) mediaSeq = Number(t.split(":")[1]) || 0; }

  src.directSegments = false;

  function toWeaveSegUrl(absUrl, fallbackVideoId) {
    try {
      const u = new URL(absUrl);
      // احتفظ بروابط floravon/CDN اللي فيها token/expires — متكسرش التوقيع
      if (/floravon\.(online|shop)$/i.test(u.hostname) || /\.floravon\./i.test(u.hostname)) {
        return u.href;
      }
      if (/b-cdn\.net$/i.test(u.hostname) || /mediadelivery\.net$/i.test(u.hostname)) {
        return u.href;
      }
      if (/stream-weave\.com$/i.test(u.hostname) || u.hostname.endsWith(".stream-weave.com")) {
        // للإبقاء على sid لو موجود
        return u.href;
      }
      const parts = u.pathname.split("/").filter(Boolean);
      const vi = parts.indexOf("videos");
      if (vi >= 0 && parts.length >= vi + 3) {
        const vid = parts[vi + 1];
        const quality = parts[vi + 2];
        const fname = (parts[vi + 3] || "").split("?")[0];
        if (vid && quality && fname) {
          // مرّر عبر stream-weave API مع الـ Bearer بدل token الـ CDN
          return `https://api.stream-weave.com/api/v1/videos/${vid}/stream/${quality}/${fname}`;
        }
      }
      if (fallbackVideoId && /\.(ts|m4s|woff2|cmfv|cmfa)(\?|$)/i.test(u.pathname)) {
        const fname = parts[parts.length - 1].split("?")[0];
        const quality = parts[parts.length - 2] || "600";
        return `https://api.stream-weave.com/api/v1/videos/${fallbackVideoId}/stream/${quality}/${fname}`;
      }
    } catch {}
    return absUrl;
  }

  // اقرأ kv من الـ playlist لو موجود
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("#EXT-X-SW-KV:")) {
      const n = Number(t.split(":")[1]);
      if (Number.isFinite(n) && n > 0) src.keyVersion = n;
    }
  }

  // weave v3: اجلب المفتاح من /session/{sid}/key مع ticket + proofs متعددة
  if (src.mode === "weave" && src.sessionId && src.token && Number(src.keyVersion || 0) >= 3) {
    try {
      src.allowedHosts.add("api.stream-weave.com");
      const sessKeyUrl = `https://api.stream-weave.com/api/v1/playback/session/${src.sessionId}/key`;
      const pathForProof = `/playback/session/${src.sessionId}/key`;
      const proofs = makeSwProofCandidates({
        keySeed: src.keySeed,
        sessionId: src.sessionId,
        token: src.token,
        path: pathForProof,
        ticket: src.swTicket
      });
      // حط أول proof كافتراضي
      if (proofs.length) src.swProof = proofs[0];

      let gotKeyBuf = null;
      for (let pi = 0; pi < Math.min(proofs.length, 12); pi++) {
        src.swProof = proofs[pi];
        try {
          const skRes = await streamFetch(src, sessKeyUrl, { Accept: "application/octet-stream, application/json, */*" }, clientHeaders);
          const skBuf = Buffer.from(await skRes.arrayBuffer());
          console.log(`[weave-v3] sess /key try#${pi} status=${skRes.status} len=${skBuf.length} proof=${String(proofs[pi]).slice(0, 14)}`);
          if (skRes.status === 401) {
            const body = skBuf.toString("utf8").slice(0, 100);
            if (body.includes("invalid key proof") || body.includes("proof")) continue;
          }
          if (skRes.ok && skBuf.length >= 16) {
            // JSON ticket refresh؟
            if (skBuf.length < 200 && skBuf[0] === 0x7b) {
              try {
                const sk = JSON.parse(skBuf.toString("utf8"));
                if (sk.ticket) src.swTicket = sk.ticket;
                if (sk.key_version) src.keyVersion = Number(sk.key_version) || src.keyVersion;
                console.log(`[weave-v3] sess /key JSON ticket refresh`);
                continue;
              } catch {}
            }
            gotKeyBuf = skBuf;
            console.log(`[weave-v3] sess /key OK len=${skBuf.length} via proof#${pi}`);
            break;
          }
        } catch (e) {
          console.warn(`[weave-v3] sess /key try#${pi} err:`, e.message);
        }
      }
      if (gotKeyBuf) {
        src._pendingKeyBuf = gotKeyBuf;
        src._keyFromSession = true;
      }
    } catch (e) {
      console.warn("[weave-v3] sess key skip:", e.message);
    }
  }

  let segIndex = 0;
  let firstSegUrl = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-KEY:")) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      const ivHex = line.match(/IV=(0x[0-9a-fA-F]+|[0-9a-fA-F]{32})/i)?.[1];
      if (ivHex) {
        currentIv = parseIvHex(ivHex);
        keyIvAttr = `IV=${ivHex.startsWith("0x") || ivHex.startsWith("0X") ? ivHex : ("0x" + ivHex)}`;
      }
      if (uri && !keyFetched) {
        src.defaultIv = currentIv;
        src._pendingKeyUri = uri;

        // لو جبنا المفتاح من /session/.../key خلاص
        if (src._pendingKeyBuf && src._pendingKeyBuf.length >= 16) {
          console.log(`[weave-v3] using session /key buf len=${src._pendingKeyBuf.length}`);
          keyFetched = true;
          continue;
        }

        let keyUrl = new URL(uri, baseUrl).href;
        try {
          const ku = new URL(keyUrl);
          if (!/stream-weave\.com/i.test(ku.hostname) && src.videoId) {
            const sidQ = src.sessionId ? `?sid=${encodeURIComponent(src.sessionId)}` : "";
            // استخدم نفس الـ quality من الـ URI لو موجود (360/600...)
            const quality = (uri.match(/\/stream\/(\d+)\//) || [])[1] || "360";
            keyUrl = `https://api.stream-weave.com/api/v1/videos/${src.videoId}/stream/${quality}/key.bin${sidQ}`;
          } else if (src.sessionId && !ku.searchParams.get("sid")) {
            ku.searchParams.set("sid", src.sessionId);
            keyUrl = ku.href;
          }
        } catch {}
        try { src.allowedHosts.add(new URL(keyUrl).hostname); } catch {}
        src.allowedHosts.add("api.stream-weave.com");
        const keyRes = await streamFetch(src, keyUrl, {}, clientHeaders);
        const wrapped = Buffer.from(await keyRes.arrayBuffer());
        console.log(`[weave-v3] key.bin status ${keyRes.status} len ${wrapped.length}`);
        if (!wrapped.length) throw new Error(`Key HTTP ${keyRes.status} — empty`);

        src._pendingKeyBuf = wrapped;
        keyFetched = true;
      }
      continue;
    }
    if (line && !line.startsWith("#")) {
      const rawSeg = new URL(line, baseUrl).href;
      const segmentUrl = toWeaveSegUrl(rawSeg, src.videoId);
      try { src.allowedHosts.add(new URL(segmentUrl).hostname); } catch {}
      src.allowedHosts.add("api.stream-weave.com");
      const seq = mediaSeq + segIndex;
      const iv = currentIv || ivFromMediaSequence(seq);
      const ivHexOut = iv.toString("hex");
      segs.push({ u: segmentUrl, iv: ivHexOut, s: seq, i: segIndex });
      if (!firstSegUrl) firstSegUrl = segmentUrl;
      out.push(`/api/hls/${SID_TOKEN}/seg/${segIndex}`);
      segIndex++;
      continue;
    }
    out.push(raw);
  }

  // —— فك/اختيار المفتاح بعد ما نعرف أول مقطع ——
  if (src._pendingKeyBuf) {
    const wrapped = src._pendingKeyBuf;
    src._lastKeyBuf = Buffer.from(wrapped); // للاستخدام لو decrypt فشل لاحقًا
    delete src._pendingKeyBuf;
    const uri = src._pendingKeyUri || "";
    delete src._pendingKeyUri;

    let sampleEncrypted = null;
    if (firstSegUrl && src.mode === "weave") {
      try {
        const segRes = await streamFetch(src, firstSegUrl, {}, clientHeaders);
        if (segRes.ok) {
          sampleEncrypted = Buffer.from(await segRes.arrayBuffer());
          console.log(`[weave-v3] sample seg len=${sampleEncrypted.length}`);
        } else {
          console.warn(`[weave-v3] sample seg HTTP ${segRes.status}`);
        }
      } catch (e) {
        console.warn("[weave-v3] sample seg fetch:", e.message);
      }
    }

    const isCdnStyle = src.mode === "cdn" || String(uri).includes("/user/auth/");
    if (isCdnStyle) {
      try {
        src.plainKey = await unwrapCdnKey(wrapped);
      } catch (ke) {
        try { src.plainKey = await unwrapKey(wrapped, src.videoId); } catch {
          throw new Error(`Key unwrap failed: ${ke.message}`);
        }
      }
    } else {
      // weave / key_version 3: جرّب مرشّحات + تحقق TS
      const resolved = await resolveWeaveV3PlainKey({
        keyBuf: wrapped,
        keySeed: src.keySeed,
        iv: src.defaultIv || currentIv,
        sampleEncrypted,
        ticket: src.swTicket || null,
        logTag: "weave-v3"
      });
      if (resolved && resolved.key) {
        src.plainKey = resolved.key;
        src.cipherMode = resolved.mode || "cbc";
        src.ivMode = resolved.ivMode || "playlist";
        console.log(`[weave-v3] cipherMode=${src.cipherMode} ivMode=${src.ivMode} tag=${resolved.tag || "?"}`);
      } else if (resolved && Buffer.isBuffer(resolved)) {
        src.plainKey = resolved;
        src.cipherMode = "cbc";
        src.ivMode = "playlist";
      } else {
        // kv>=3: مفيش قبول raw key.bin من غير تحقق TS — بيسبب bad decrypt
        // جرّب decryptPlaybackKey من player.js بصيغ متعددة
        let got = null;
        if (decryptPlaybackKeyFn) {
          const attempts = [
            () => decryptPlaybackKeyFn(new Uint8Array(wrapped), String(src.videoId)),
            () => decryptPlaybackKeyFn(new Uint8Array(wrapped), String(src.videoId), src.keySeed),
            () => decryptPlaybackKeyFn(new Uint8Array(wrapped), String(src.videoId), src.keySeed, src.sessionId),
            () => decryptPlaybackKeyFn(new Uint8Array(wrapped), { videoId: src.videoId, keySeed: src.keySeed, sessionId: src.sessionId, ticket: src.swTicket }),
          ];
          for (const fn of attempts) {
            try {
              const result = await fn();
              const key = result?.key || result;
              if (!key) continue;
              const aes = Buffer.isBuffer(key) ? key : key instanceof ArrayBuffer ? Buffer.from(key) : Buffer.from(key.buffer || key, key.byteOffset || 0, key.byteLength || key.length);
              if (aes.length === 16) {
                // validate against sample if available
                if (sampleEncrypted && sampleEncrypted.length >= 32) {
                  let ok = false;
                  for (const testIv of [src.defaultIv, currentIv, ivFromMediaSequence(0)].filter(Boolean)) {
                    try {
                      const plain = decryptSegment(sampleEncrypted, aes, testIv);
                      if (looksLikeMpegTs(plain, true)) { ok = true; break; }
                    } catch {}
                    try {
                      const plain = decryptSegmentCtr(sampleEncrypted, aes, testIv);
                      if (looksLikeMpegTs(plain, true)) { ok = true; src.cipherMode = "ctr"; break; }
                    } catch {}
                  }
                  if (!ok) continue;
                }
                got = aes;
                console.log("[weave-v3] decryptPlaybackKeyFn produced valid key");
                break;
              }
            } catch (e) {
              console.warn("[weave-v3] decryptPlaybackKey attempt:", e.message);
            }
          }
        }
        if (got) {
          src.plainKey = got;
          src.cipherMode = src.cipherMode || "cbc";
          src.ivMode = "playlist";
        } else {
          // soft fallback: pass-through كامل → hls.js يفك على المتصفح
          console.warn("[weave-v3] plainKey not validated — pass-through encrypt (client hls.js decrypt)");
          // لو الرد 86 بايت (مفتاح مغلف)، خذ أول/آخر 16 أو XOR مع seed
          let k16 = null;
          if (wrapped.length === 16) {
            k16 = Buffer.from(wrapped);
          } else if (wrapped.length >= 16) {
            // جرّب صيغ شائعة للمفتاح المغلف
            const seedBuf = decodeKeySeed(src.keySeed);
            const tries = [
              wrapped.subarray(0, 16),
              wrapped.subarray(wrapped.length - 16),
              wrapped.subarray(16, 32),
            ];
            if (seedBuf && seedBuf.length >= 16) {
              const x = Buffer.alloc(16);
              for (let i = 0; i < 16; i++) x[i] = wrapped[i] ^ seedBuf[i];
              tries.push(x);
              const x2 = Buffer.alloc(16);
              for (let i = 0; i < 16; i++) x2[i] = wrapped[wrapped.length - 16 + i] ^ seedBuf[i];
              tries.push(x2);
            }
            k16 = Buffer.from(tries[0]);
            // لو عندنا sample، اختبر أي مرشّح يطلع TS
            if (sampleEncrypted && sampleEncrypted.length >= 32) {
              for (const cand of tries) {
                try {
                  const plain = decryptSegment(sampleEncrypted, cand, src.defaultIv || currentIv || ivFromMediaSequence(0));
                  if (looksLikeMpegTs(plain, true)) { k16 = Buffer.from(cand); console.log("[weave-v3] unwrapped key matched TS"); break; }
                } catch {}
              }
            }
          } else {
            k16 = Buffer.alloc(16);
          }
          src.plainKey = k16;
          src.cipherMode = "cbc";
          src.ivMode = "playlist";
          src._keyUnverified = true;
          src.passThroughEncrypt = true;
          src._lastKeyBuf = Buffer.from(wrapped);
        }
        // weave v3: دايمًا pass-through لو مفيش تحقق TS صارم — أضمن للتشغيل
        if (Number(src.keyVersion || 0) >= 3 && !src.passThroughEncrypt) {
          // حتى لو لقينا key، لو مش متأكدين 100% خلّي الخيار مفتوح
        }
      }
    }
    console.log(`[key] ${src.mode || "weave"} for ${src.videoId} len=${src.plainKey?.length} kv=${src.keyVersion || 0} mode=${src.cipherMode || "cbc"}`);
  }

  if (!src.plainKey) throw new Error("فشل تجهيز مفتاح التشفير");
  // weave-v3: مرّر المقاطع مشفرة + المفتاح للعميل (hls.js) — أضمن من فك السيرفر الغلط
  if (src.mode === "weave" && Number(src.keyVersion || 0) >= 3) {
    src.passThroughEncrypt = true;
  }
  console.log(`[weave] v3 ready segs=${segs.length} key=${src.plainKey?.length || 0} cipher=${src.cipherMode || "cbc"} passThrough=${!!src.passThroughEncrypt}`);
  if (src.passThroughEncrypt && src.plainKey) {
    // playlist للعميل: خليه يفك AES عبر hls.js
    const keyLine = `#EXT-X-KEY:METHOD=AES-128,URI="/api/hls/${SID_TOKEN}/key"${keyIvAttr ? "," + keyIvAttr : ""}`;
    // حط KEY بعد الهيدر وقبل أول EXTINF
    const rebuilt = [];
    let keyInserted = false;
    for (const L of out) {
      if (!keyInserted && L.startsWith("#EXTINF")) {
        rebuilt.push(keyLine);
        keyInserted = true;
      }
      // لو كان فيه KEY قديم امسحه
      if (L.startsWith("#EXT-X-KEY:")) continue;
      rebuilt.push(L);
    }
    if (!keyInserted) rebuilt.splice(1, 0, keyLine);
    out.length = 0;
    out.push(...rebuilt);
  }
  src.mediaSeq = mediaSeq; src.segs = segs; src.playlist = out.join("\n");
}

function extractYoutubeFromPayload(obj, depth = 0) {
  if (!obj || depth > 4) return null;
  if (typeof obj === "string") {
    const m = obj.match(/(?:youtube\.com\/watch\?[^\s]*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{6,})/i);
    if (m) return "https://www.youtube.com/watch?v=" + m[1];
    if (/^[A-Za-z0-9_-]{11}$/.test(obj) && depth > 0) return null;
    return null;
  }
  if (typeof obj !== "object") return null;
  const keys = ["youtube_url", "youtubeUrl", "youtube", "yt_url", "url", "video_url", "link", "external_url", "embed_url", "watch_url", "player_url", "source"];
  for (const k of keys) { if (obj[k]) { const u = extractYoutubeFromPayload(String(obj[k]), depth + 1); if (u) return u; } }
  for (const v of Object.values(obj)) { if (v && typeof v === "object") { const u = extractYoutubeFromPayload(v, depth + 1); if (u) return u; } }
  return null;
}

async function tryResolveYoutube(videoId) {
  try {
    const data = await upstreamJson(`/video/${encodeURIComponent(videoId)}/platforms`);
    const platforms = (data && data.data && data.data.platforms) || (data && data.platforms) || [];
    if (Array.isArray(platforms)) {
      for (const p of platforms) {
        const name = String((p && p.name) || "").toLowerCase();
        const rawUrl = (p && (p.url || p.link || p.youtube_url)) || "";
        if (name.includes("youtube") || /youtu\.be|youtube\.com/i.test(String(rawUrl))) { const u = extractYoutubeFromPayload(rawUrl) || extractYoutubeFromPayload(p); if (u) return u; }
      }
      for (const p of platforms) { const u = extractYoutubeFromPayload(p); if (u) return u; }
    }
    const u2 = extractYoutubeFromPayload(data);
    if (u2) return u2;
  } catch {}
  const paths = [`/video/${encodeURIComponent(videoId)}`, `/user/videos/${encodeURIComponent(videoId)}`, `/videos/${encodeURIComponent(videoId)}`];
  for (const path of paths) { try { const data = await upstreamJson(path); const u = extractYoutubeFromPayload(data); if (u) return u; } catch {} }
  return null;
}


/** جلب playlist مع تعدد محاولات (H1.1 / Accept / بدون auth أحيانًا) */

/** بناء مصدر تشغيل من playlist جلبها المتصفح (تجاوز حظر Cloudflare على IP السيرفر) */
async function buildSrcFromClientPlaylists(videoId, { masterText, mediaText, keyBase64, keyUrl, variantUrl }) {
  const master = String(masterText || "");
  let media = String(mediaText || "");
  let baseUrl = String(variantUrl || `${CONFIG.COURSATK_API}/video/stream/${encodeURIComponent(videoId)}/`);
  if (!media.includes("#EXTM3U") && master.includes("#EXTM3U")) {
    // اختار أعلى variant من الماستر
    const lines = master.split(/\r?\n/);
    let best = null; let bestBw = -1; let pending = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const bw = Number((line.match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
        pending = bw;
      } else if (line && !line.startsWith("#") && pending != null) {
        if (pending >= bestBw) { bestBw = pending; best = line; }
        pending = null;
      }
    }
    if (!best) throw new Error("الماستر مفيهوش جودة");
    // المتصفح لازم يبعت mediaText — لو مش موجود نفشل بوضوح
    throw new Error("ابعت mediaPlaylist مع الـ hydrate (نص الـ variant)");
  }
  if (!media.includes("#EXTM3U")) throw new Error("media playlist غير صالح");

  let keyBuf = null;
  if (keyBase64) {
    keyBuf = Buffer.from(String(keyBase64), "base64");
  }
  const upstreamTok = await getCoursatkToken();
  const allowedHosts = new Set(CONFIG.STREAM_HOSTS);
  allowedHosts.add("floravon.shop");
  allowedHosts.add("floravon.online");
  allowedHosts.add("api.coursatk.online");
  allowedHosts.add("api.stream-weave.com");
  try { allowedHosts.add(new URL(baseUrl).hostname); } catch {}

  const src = {
    reqVideoId: videoId,
    videoId: String(videoId),
    mode: "cdn",
    token: upstreamTok || "client",
    streamUrl: baseUrl,
    allowedHosts,
    plainKey: null,
    defaultIv: null,
    mediaSeq: 0,
    segs: [],
    playlist: "",
    createdAt: now()
  };

  // parse media playlist similar to buildPlaylist
  const lines = media.split(/\r?\n/);
  let mediaSeq = 0;
  const msm = media.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
  if (msm) mediaSeq = Number(msm[1]) || 0;
  src.mediaSeq = mediaSeq;
  const tdm = media.match(/#EXT-X-TARGETDURATION:([\d.]+)/);
  src.targetDuration = tdm ? Number(tdm[1]) : 6;

  let currentIv = null;
  let keyIvAttr = null;
  let segIndex = 0;
  const segs = [];
  const out = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(src.targetDuration || 6))}`, "#EXT-X-PLAYLIST-TYPE:VOD", `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`];

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-KEY:")) {
      const uri = (line.match(/URI="([^"]+)"/) || [])[1];
      const ivHex = (line.match(/IV=(0x[0-9a-fA-F]+|[0-9a-fA-F]{32})/i) || [])[1];
      if (ivHex) {
        currentIv = parseIvHex(ivHex);
        keyIvAttr = `IV=${ivHex.startsWith("0x") || ivHex.startsWith("0X") ? ivHex : ("0x" + ivHex)}`;
      }
      if (!keyBuf && uri) {
        // حاول جلب المفتاح من السيرفر كمحاولة أخيرة
        try {
          const keyUrlAbs = new URL(uri, baseUrl).href;
          const keyRes = await streamFetch(src, keyUrlAbs, {}, null);
          keyBuf = Buffer.from(await keyRes.arrayBuffer());
        } catch (e) {
          console.warn("[hydrate] server key fetch failed", e.message);
        }
      }
      if (keyBuf && keyBuf.length) {
        try {
          if (keyBuf.length === 16) src.plainKey = keyBuf;
          else if (String(uri || keyUrl || "").includes("/user/auth/") || src.mode === "cdn") src.plainKey = await unwrapCdnKey(keyBuf);
          else src.plainKey = await unwrapKey(keyBuf, src.videoId);
        } catch (e1) {
          try { src.plainKey = await unwrapCdnKey(keyBuf); } catch (e2) {
            try { src.plainKey = await unwrapKey(keyBuf, src.videoId); } catch (e3) {
              throw new Error("فشل فك مفتاح التشغيل من العميل: " + e1.message);
            }
          }
        }
        src.defaultIv = currentIv;
      }
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      // duration handled with next uri line
      continue;
    }
    if (line && !line.startsWith("#")) {
      // find preceding EXTINF duration
      let dur = src.targetDuration || 6;
      // scan previous non-empty in original - approximate
      const segUrl = new URL(line, baseUrl).href;
      try { src.allowedHosts.add(new URL(segUrl).hostname); } catch {}
      const seq = mediaSeq + segIndex;
      const iv = currentIv || ivFromMediaSequence(seq);
      segs.push({ u: segUrl, iv: iv.toString("hex"), s: seq, i: segIndex, dur });
      out.push(`#EXTINF:${Number(dur).toFixed(5)},`);
      out.push(`/api/hls/${SID_TOKEN}/seg/${segIndex}`);
      segIndex++;
    }
  }
  // better duration parse
  segs.length = 0; out.length = 0;
  out.push("#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(src.targetDuration || 6))}`, "#EXT-X-PLAYLIST-TYPE:VOD", `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`);
  let pendingDur = src.targetDuration || 6;
  segIndex = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      const d = Number((line.match(/#EXTINF:([\d.]+)/) || [])[1]);
      if (Number.isFinite(d) && d > 0) pendingDur = d;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) continue;
    if (line && !line.startsWith("#")) {
      const segUrl = new URL(line, baseUrl).href;
      try { src.allowedHosts.add(new URL(segUrl).hostname); } catch {}
      const seq = mediaSeq + segIndex;
      const iv = currentIv || ivFromMediaSequence(seq);
      segs.push({ u: segUrl, iv: iv.toString("hex"), s: seq, i: segIndex, dur: pendingDur });
      out.push(`#EXTINF:${Number(pendingDur).toFixed(5)},`);
      out.push(`/api/hls/${SID_TOKEN}/seg/${segIndex}`);
      segIndex++;
    }
  }
  if (!segs.length) throw new Error("مفيش مقاطع في الـ playlist");
  if (!src.plainKey) throw new Error("مفيش مفتاح تشغيل — ابعت keyBase64 في الـ hydrate");
  src.segs = segs;
  src.playlist = out.join("\n");
  src.directSegments = false;
  return src;
}

function clientFetchPayload(videoId, upstreamTok) {
  return {
    type: "client_fetch",
    videoId: String(videoId),
    reason: "upstream_blocked",
    message: "سيرفر الاستضافة محظور من Cloudflare/كورساتك — المشغّل هيجلب القائمة من جهازك",
    playlistUrl: `${CONFIG.COURSATK_API}/video/stream/${encodeURIComponent(videoId)}/playlist.m3u8`,
    headers: {
      Authorization: `Bearer ${upstreamTok}`,
      Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
      Origin: CONFIG.STREAM_ORIGIN,
      Referer: CONFIG.STREAM_REFERER,
      "User-Agent": CONFIG.STREAM_UA,
      "X-Requested-With": CONFIG.STREAM_X_REQUESTED_WITH || "com.mycompany.app.soulbrowser"
    },
    hydratePath: `/api/play/${encodeURIComponent(videoId)}/hydrate`
  };
}

async function fetchPlaylistSmart(url, token, label = "pl") {
  const accepts = [
    "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
    "*/*",
    "application/json, text/plain, */*"
  ];
  let last = { status: 0, text: "" };
  for (let pi = 0; pi < UA_PROFILES.length; pi++) {
    for (const accept of accepts) {
      try {
        const headers = {
          ...UA_PROFILES[pi],
          Accept: accept,
          "Cache-Control": "no-cache",
          Pragma: "no-cache"
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        // stream-weave غالبًا يطلب x-sw-key-version مع الماستر
        if (String(label).includes("weave") || /stream-weave\.com/i.test(String(url))) {
          headers["x-sw-key-version"] = "3";
        }
        const probe = await upstreamSlot(() =>
          fetchT(url, { headers, cache: "no-store" }, { timeout: 20_000, retries: 1, retryOn: [429, 502, 503, 504, 408] })
        );
        const masterText = await probe.text();
        last = { status: probe.status, text: masterText };
        if (masterText.includes("#EXTM3U")) {
          console.log(`[${label}] ok status=${probe.status} profile=${pi}`);
          return { status: probe.status, text: masterText };
        }
        console.warn(`[${label}] status=${probe.status} no-m3u profile=${pi}`, masterText.slice(0, 60).replace(/\n/g, " "));
      } catch (e) {
        last = { status: 0, text: "", error: e.message };
        console.warn(`[${label}] err profile=${pi}`, e.message);
      }
    }
  }
  // محاولة أخيرة بدون بعض الهيدر
  try {
    const probe = await fetchT(url, {
      headers: {
        Authorization: token ? `Bearer ${token}` : undefined,
        Accept: "*/*",
        "User-Agent": CONFIG.STREAM_UA
      },
      cache: "no-store"
    }, { timeout: 20_000, retries: 0 });
    const masterText = await probe.text();
    if (masterText.includes("#EXTM3U")) return { status: probe.status, text: masterText };
    last = { status: probe.status, text: masterText };
  } catch (e) {
    last.error = e.message;
  }
  const err = new Error(`${label} ${last.status || ""} — playlist غير صالح`.trim());
  err.detail = (last.text || "").slice(0, 120);
  throw err;
}

async function buildVideoSource(videoId, clientHeaders) {
  const upstreamTok = await getCoursatkToken();
  if (!upstreamTok) { const e = new Error("توكن كورساتك غير مضبوط"); e.status = 503; throw e; }

  try {
    const ytUrl = await tryResolveYoutube(videoId);
    if (ytUrl) return { reqVideoId: videoId, videoId: String(videoId), mode: "coursatk-youtube", youtubeUrl: ytUrl, streamUrl: ytUrl, plainKey: Buffer.from("youtube"), segs: [], playlist: "", mediaSeq: 0, allowedHosts: new Set(), createdAt: now() };
  } catch (e) { console.warn("[platforms youtube]", e.message); }

  // اقرأ المنصات المتاحة — لو CDN فقط نتخطى weave
  let platformNames = [];
  try {
    const pdata = await upstreamJson(`/video/${encodeURIComponent(videoId)}/platforms`);
    const plats = (pdata && pdata.data && pdata.data.platforms) || pdata.platforms || [];
    platformNames = (Array.isArray(plats) ? plats : []).map((p) => String(p?.name || p || "").toLowerCase());
  } catch (e) { console.warn("[platforms]", e.message); }
  const preferCdn = platformNames.includes("cdn") && !platformNames.includes("stream-weave") && !platformNames.includes("weave");
  const preferYoutube = platformNames.includes("youtube") && !platformNames.includes("cdn") && !platformNames.includes("stream-weave");
  const onlyRutube = platformNames.length && platformNames.every((n) => n === "rutube" || n === "youtube") && !platformNames.includes("cdn") && !platformNames.includes("stream-weave") && !platformNames.includes("weave");
  if (onlyRutube && !platformNames.includes("youtube")) {
    const err = new Error("الفيديو على منصة Rutube فقط — مش مدعوم حاليًا. جرّب فيديو CDN أو يوتيوب.");
    err.status = 501;
    throw err;
  }

  let mode = null; let streamUrl = null; let sessionToken = null; let resolvedVideoId = videoId; let probeText = null;
  const errors = [];

  async function tryCdn() {
    const masterUrl = `${CONFIG.COURSATK_API}/video/stream/${encodeURIComponent(videoId)}/playlist.m3u8`;
    const got = await fetchPlaylistSmart(masterUrl, upstreamTok, "cdn");
    return { mode: "cdn", streamUrl: masterUrl, sessionToken: upstreamTok, probeText: got.text, resolvedVideoId: String(videoId) };
  }

  async function tryWeave() {
    let lastWeaveErr = null;
    for (let attempt = 1; attempt <= UPSTREAM_FETCH_RETRIES; attempt++) {
      try {
        const data = await upstreamJson(`/video/${encodeURIComponent(videoId)}/stream-weave/play`, { method: "POST", headers: { Accept: "application/json" } });
        if (!data?.success || !data?.data?.token || !data?.data?.stream_url) throw new Error("Weave response ناقص");
        const wToken = data.data.token;
        const wUrl = data.data.stream_url;
        const wVid = String(data.data.video_id || videoId);
        const wSid = data.data.session_id || data.data.sessionId || null;
        const wSeed = data.data.key_seed || data.data.keySeed || null;
        const wKv = Number(data.data.key_version || data.data.keyVersion || 0) || 0;
        const wHb = data.data.heartbeat_url || data.data.heartbeatUrl || null;
        console.log(`[weave] play ok vid=${wVid} sid=${wSid || "-"} kv=${wKv} seed=${wSeed ? "yes" : "no"}`);

        // —— v3: POST key-ticket → غالبًا JSON {ticket, key_version, expires_in}
        let mediaFromTicket = null;
        let swTicket = null;
        if (wSid && wKv >= 3) {
          try {
            const ktUrl = `https://api.stream-weave.com/api/v1/playback/session/${wSid}/key-ticket`;
            const ktRes = await upstreamSlot(() =>
              fetchT(
                ktUrl,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${wToken}`,
                    Accept: "application/json, application/vnd.apple.mpegurl, */*",
                    Origin: CONFIG.STREAM_ORIGIN,
                    Referer: CONFIG.STREAM_REFERER,
                    "User-Agent": CONFIG.STREAM_UA,
                    "x-sw-key-version": String(wKv || 3),
                    "Content-Length": "0"
                  },
                  body: ""
                },
                { timeout: 20_000, retries: 2 }
              )
            );
            const ktText = await ktRes.text();
            console.log(`[weave-v3] key-ticket status=${ktRes.status} len=${ktText.length} head=${ktText.slice(0, 60).replace(/\n/g, " ")}`);
            if (ktRes.ok && ktText.includes("#EXTM3U") && /#EXTINF/i.test(ktText)) {
              mediaFromTicket = ktText;
            } else if (ktRes.ok) {
              try {
                const j = JSON.parse(ktText);
                if (j.ticket) swTicket = String(j.ticket);
                if (j.key_version) wKv = Number(j.key_version) || wKv;
                const maybe = j.playlist || j.media || j.data?.playlist || j.data?.media;
                if (typeof maybe === "string" && maybe.includes("#EXTM3U")) mediaFromTicket = maybe;
                console.log(`[weave-v3] key-ticket ticket=${swTicket ? "yes" : "no"} kv=${wKv}`);
              } catch {}
            }
          } catch (kte) {
            console.warn("[weave-v3] key-ticket fail:", kte.message);
          }
        }

        // اجلب الماستر — لو 426 جرّب مسارات بديلة
        let probeText = null;
        let streamUrlUsed = wUrl;
        const candidates = [wUrl];
        try {
          const u = new URL(wUrl);
          candidates.push(`https://api.stream-weave.com/api/v1/videos/${wVid}/stream/master.m3u8`);
          candidates.push(`https://api.stream-weave.com/api/v1/videos/${wVid}/stream/playlist.m3u8`);
          if (!/master\.m3u8|playlist\.m3u8/i.test(u.pathname)) {
            candidates.push(wUrl.replace(/\/?$/, "/playlist.m3u8"));
            candidates.push(wUrl.replace(/\/?$/, "/master.m3u8"));
          }
        } catch {}
        let lastPlErr = null;
        for (const cand of [...new Set(candidates)]) {
          try {
            const got = await fetchPlaylistSmart(cand, wToken, "weave");
            probeText = got.text;
            streamUrlUsed = cand;
            break;
          } catch (pe) {
            lastPlErr = pe;
            console.warn("[weave] playlist candidate fail", cand.slice(0, 80), pe.message);
          }
        }

        // لو key-ticket رجّع media playlist كامل، فضّله (فيه روابط floravon الموقّعة)
        if (mediaFromTicket) {
          // لو الماستر فيه variants فقط، اعتبر ticket هو الـ media مباشرة
          const masterIsVariantOnly =
            probeText &&
            /#EXT-X-STREAM-INF/i.test(probeText) &&
            !/#EXTINF/i.test(probeText);
          if (!probeText || masterIsVariantOnly || !/#EXTINF/i.test(probeText)) {
            // لفّه كـ master بسيط → media
            probeText =
              "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1800000\n" +
              "data:application/vnd.apple.mpegurl;base64," +
              Buffer.from(mediaFromTicket).toString("base64");
            // أبسط: مرّر media كـ probe مع علامة
            probeText = mediaFromTicket;
            streamUrlUsed = `https://api.stream-weave.com/api/v1/videos/${wVid}/stream/600/playlist.m3u8`;
            console.log("[weave-v3] using key-ticket media playlist as probe");
          } else {
            // احتفظ بالماستر، ومرّر media منفصل عبر حقل إضافي
          }
        }

        if (!probeText) throw lastPlErr || new Error("Weave playlist failed");

        return {
          mode: "weave",
          sessionToken: wToken,
          streamUrl: streamUrlUsed,
          resolvedVideoId: wVid,
          probeText,
          mediaPlaylistText: mediaFromTicket || null,
          sessionId: wSid,
          keySeed: wSeed,
          keyVersion: wKv,
          heartbeatUrl: wHb,
          swTicket: swTicket || null
        };
      } catch (e) {
        lastWeaveErr = e;
        console.warn(`[weave] play attempt ${attempt}/${UPSTREAM_FETCH_RETRIES}:`, e.message);
        if (attempt < UPSTREAM_FETCH_RETRIES) await delay(250 * attempt + Math.random() * 200);
      }
    }
    throw lastWeaveErr || new Error("weave failed");
  }

  // ترتيب المحاولة: لو مفيش stream-weave في المنصات نتخطاه (يقلل 426 الفارغة)
  const hasWeave = platformNames.some((n) => n.includes("weave") || n.includes("stream-weave"));
  const order = preferCdn || !hasWeave ? ["cdn", "weave"] : ["weave", "cdn"];
  if (!hasWeave) console.log(`[play] video ${videoId} platforms=${platformNames.join(",")||"?"} → prefer CDN`);
  for (const which of order) {
    try {
      const got = which === "cdn" ? await tryCdn() : await tryWeave();
      mode = got.mode; streamUrl = got.streamUrl; sessionToken = got.sessionToken;
      resolvedVideoId = got.resolvedVideoId; probeText = got.probeText;
      // جهّز الـ playlist — لو فشل (426 وغيره) جرّب المنصة التالية
      const allowedHosts = new Set(CONFIG.STREAM_HOSTS);
      try { allowedHosts.add(new URL(streamUrl).hostname); } catch {}
      allowedHosts.add("floravon.shop");
      allowedHosts.add("floravon.online");
      allowedHosts.add("suo2.floravon.online");
      allowedHosts.add("api.stream-weave.com");
      const src = {
        reqVideoId: videoId,
        videoId: resolvedVideoId,
        mode,
        token: sessionToken,
        streamUrl,
        allowedHosts,
        plainKey: null,
        defaultIv: null,
        mediaSeq: 0,
        segs: [],
        playlist: "",
        createdAt: now(),
        sessionId: got.sessionId || null,
        keySeed: got.keySeed || null,
        keyVersion: got.keyVersion || 0,
        heartbeatUrl: got.heartbeatUrl || null,
        mediaPlaylistText: got.mediaPlaylistText || null,
        swTicket: got.swTicket || null,
        swProof: null
      };
      try {
        await buildPlaylist(src, probeText, clientHeaders);
        return src;
      } catch (bpErr) {
        console.warn(`[${mode}] buildPlaylist failed:`, bpErr.message);
        errors.push(`${mode}: ${bpErr.message}`);
        mode = null; streamUrl = null; sessionToken = null; probeText = null;
      }
    } catch (e) {
      errors.push(`${which}: ${e.message}`);
    }
  }

  throw new Error(errors.join(" | ") || "مفيش منصة تشغيل");
}

function getVideoSource(videoId, clientHeaders) {
  const hit = sourceCache.get(videoId);
  if (hit && now() < hit.exp) return Promise.resolve(hit.src);
  return coalesce("src:" + videoId, async () => {
    // —— Bunny / د. حسام عيسى (drhossamissa.com iframe protect bypass)
    // ===== taleb.pro: taleb_{partId} =====
    if (String(videoId).startsWith("taleb_")) {
      const partId = String(videoId).slice(6); // بعد "taleb_"
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(partId)) {
        const e = new Error("معرّف فيديو taleb غير صالح — استخدم taleb_{uuid}");
        e.status = 400;
        throw e;
      }
      const src = await buildTalebSource(partId);
      sourceCache.set(videoId, { src, exp: now() + SOURCE_TTL_MS });
      return src;
    }

    if (CONFIG.BUNNY_ENABLED !== false && isBunnyVideoId(videoId)) {
      const guid = parseBunnyGuid(videoId);
      if (!guid) {
        const e = new Error("معرّف فيديو Bunny غير صالح — استخدم bn_<guid>");
        e.status = 400;
        throw e;
      }
      const src = await buildBunnySource(guid, clientHeaders);
      src.reqVideoId = String(videoId);
      sourceCache.set(videoId, { src, exp: now() + SOURCE_TTL_MS });
      return src;
    }
    if (CONFIG.THANAWICA_ENABLED && /^th[pvmy]_/i.test(String(videoId))) {
      const raw = String(videoId);
      if (/^thy_/i.test(raw)) {
        const youtubeId = raw.slice(4);
        const ytUrl = "https://www.youtube.com/watch?v=" + youtubeId;
        const src = { reqVideoId: videoId, videoId: youtubeId, mode: "thanawica-youtube", youtubeUrl: ytUrl, streamUrl: ytUrl, plainKey: Buffer.from("youtube"), segs: [], playlist: "", mediaSeq: 0, allowedHosts: new Set(), createdAt: now() };
        sourceCache.set(videoId, { src, exp: now() + SOURCE_TTL_MS });
        return src;
      }
      if (/^thm_/i.test(raw)) {
        const mp4Id = raw.slice(4);
        const mp4Url = await thResolveMp4Url(mp4Id);
        const src = { reqVideoId: videoId, videoId: mp4Id, mode: "thanawica-mp4", streamUrl: mp4Url, plainKey: Buffer.from("mp4"), segs: [], playlist: "", mediaSeq: 0, allowedHosts: new Set(["thanawica.com", "www.thanawica.com", "video.thanawica.com"]), mp4Url, createdAt: now() };
        sourceCache.set(videoId, { src, exp: now() + SOURCE_TTL_MS });
        return src;
      }
      let hash = null;
      if (/^thp_/i.test(raw)) hash = raw.slice(4);
      else {
        const rest = raw.slice(4);
        if (/^[a-f0-9]{16,}$/i.test(rest)) hash = rest;
        else if (/^\d+$/.test(rest)) { const e = new Error("فيديو ثناويكا: افتح المحاضرة من جديد"); e.status = 400; throw e; }
        else { const e = new Error("فيديو ثناويكا غير صالح"); e.status = 400; throw e; }
      }
      if (!hash) { const e = new Error("فيديو ثناويكا يحتاج playlist hash"); e.status = 400; throw e; }
      const src = await thGetVideoSource(hash, { sidToken: SID_TOKEN });
      src.reqVideoId = videoId;
      sourceCache.set(videoId, { src, exp: now() + SOURCE_TTL_MS });
      return src;
    }
    const src = await buildVideoSource(videoId, clientHeaders);
    sourceCache.set(videoId, { src, exp: now() + SOURCE_TTL_MS });
    return src;
  });
}

async function refreshSource(session, force = false) {
  try {
    const id = session.src?.reqVideoId;
    if (!id) return null;
    if (!force) {
      const cur = sourceCache.get(id);
      if (cur && cur.src !== session.src && now() < cur.exp) {
        session.src = cur.src;
        return cur.src;
      }
    }
    sourceCache.delete(id);
    console.log("[source refresh] rebuilding source for", id, force ? "(forced)" : "");
    const fresh = await getVideoSource(id, null);
    if (fresh) {
      session.src = fresh;
      if (session.id) {
        streamSessions.set(session.id, session);
        if (session.shared) touchSharedPlay(session);
        else persistStreamSession(session).catch(() => {});
      }
      return fresh;
    }
  } catch (e) {
    console.warn("[source refresh]", e.message);
  }
  return null;
}

// جلسات تشغيل مشتركة: نفس فيديو كورساتك → نفس جلسة HLS في الذاكرة لكل الطلاب
const sharedPlayByVideo = new Map();

function touchSharedPlay(session) {
  if (!session) return;
  session.lastUsed = now();
  streamSessions.set(session.id, session);
  const keys = new Set([String(session.videoId || "")]);
  if (session.src?.reqVideoId) keys.add(String(session.src.reqVideoId));
  if (session.src?.videoId) keys.add(String(session.src.videoId));
  for (const k of keys) if (k) sharedPlayByVideo.set(k, session);
}

function getSharedPlay(videoId) {
  const key = String(videoId || "");
  if (!key) return null;
  const s = sharedPlayByVideo.get(key);
  if (!s) return null;
  const t = now();
  if (t - (s.lastUsed || 0) > CONFIG.STREAM_IDLE_MS || t - (s.createdAt || 0) > CONFIG.STREAM_MAX_MS) {
    sharedPlayByVideo.delete(key);
    try { streamSessions.delete(s.id); } catch {}
    return null;
  }
  // لازم تكون لسه في streamSessions
  if (!streamSessions.has(s.id)) {
    streamSessions.set(s.id, s);
  }
  return s;
}


// حماية من السحب: السماح بتشغيل الـ HLS من دومينات موقعك فقط (أو بدون Origin مثل بعض مشغّلات الموبايل)
function assertPlayerOrigin(req) {
  // PLAYER_ORIGIN_STRICT=0 يلغي الفحص بالكامل
  const strict = process.env.PLAYER_ORIGIN_STRICT !== "0";
  if (!strict) return true;
  const origin = String(req.headers.origin || "").replace(/\/$/, "");
  const referer = String(req.headers.referer || "");
  if (!origin && !referer) return true;

  // اسمح بنفس هوست السيرفر (Railway/Vercel/أي deploy)
  let reqOrigin = "";
  try {
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim() || "https";
    if (host) reqOrigin = (proto + "://" + host).replace(/\/$/, "");
  } catch {}

  const allowed = new Set(ALLOWED_ORIGINS);
  if (reqOrigin) allowed.add(reqOrigin);
  // أي *.up.railway.app / *.vercel.app
  function isDeployHost(o) {
    try {
      const h = new URL(o).hostname;
      return /\.up\.railway\.app$/i.test(h) || /\.railway\.app$/i.test(h) || /\.vercel\.app$/i.test(h);
    } catch { return false; }
  }

  if (origin && (allowed.has(origin) || isDeployHost(origin))) return true;
  if (referer) {
    try {
      const h = new URL(referer).origin;
      if (allowed.has(h) || isDeployHost(h)) return true;
    } catch {}
  }
  const e = new Error("غير مصرح — التشغيل من هذا الموقع غير مسموح");
  e.status = 403;
  throw e;
}

function assertStreamOwner(session, req) {
  if (!session) { const e = new Error("انتهت صلاحية التشغيل"); e.status = 404; throw e; }
  const sk = req.query.sk || req.headers["x-stream-key"];
  if (session.streamKey) {
    if (!sk || sk !== session.streamKey) {
      const e = new Error("غير مصرح — مفتاح التشغيل غير صالح");
      e.status = 403;
      throw e;
    }
  }
  // لازم تسجيل دخول + نفس صاحب الجلسة (يمنع مشاركة لينك التشغيل بين منصات/حسابات)
  const code = req.session && req.session.code;
  const token = req.sessionToken;
  if (!code || !token) {
    const e = new Error("مطلوب تسجيل الدخول");
    e.status = 401;
    throw e;
  }
  if (session.ownerCode && session.ownerCode !== code) {
    const e = new Error("غير مصرح — الرابط ده مش لحسابك");
    e.status = 403;
    throw e;
  }
  if (session.ownerToken && session.ownerToken !== token) {
    const e = new Error("غير مصرح — افتح الفيديو من جديد");
    e.status = 403;
    throw e;
  }
  session.lastUsed = now();
  return true;
}

function revokeOtherSessions(ownerCode, videoId, keepId) {
  // الجلسات المشتركة متتشالش — بس جلسات المستخدم الخاصة لنفس الفيديو
  for (const [id, s] of streamSessions) {
    if (id === keepId) continue;
    if (s.shared) continue;
    if (s.ownerCode === ownerCode && String(s.videoId) === String(videoId)) streamSessions.delete(id);
  }
}

async function persistStreamSession(session) {
  try {
    if (!getFirebaseUrl() || !session || !session.id) return;
    const src = session.src;
    const slim = {
      id: session.id,
      videoId: session.videoId,
      ownerCode: session.ownerCode,
      ownerToken: session.ownerToken,
      ownerDeviceId: session.ownerDeviceId || null,
      streamKey: session.streamKey,
      createdAt: session.createdAt,
      lastUsed: session.lastUsed,
      src: src
        ? {
            mode: src.mode,
            videoId: src.videoId,
            reqVideoId: src.reqVideoId || null,
            plainKey: src.plainKey
              ? Buffer.isBuffer(src.plainKey)
                ? src.plainKey.toString("base64")
                : src.plainKey
              : null,
            defaultIv: src.defaultIv
              ? Buffer.isBuffer(src.defaultIv)
                ? src.defaultIv.toString("hex")
                : src.defaultIv
              : null,
            mediaSeq: src.mediaSeq || 0,
            targetDuration: src.targetDuration || 6,
            segs: src.segs || [],
            mp4Url: src.mp4Url || null,
            directSegments: src.directSegments !== false,
            playlist: typeof src.playlist === "string" ? src.playlist : null,
            streamUrl: src.streamUrl || null,
            token: src.token || null
          }
        : null
    };
    await fbSet(`stream_sessions/${session.id}`, slim);
  } catch (e) {
    console.warn("[stream] persist:", e.message);
  }
}

function reviveStreamSrc(src) {
  if (!src) return src;
  const out = { ...src };
  if (out.plainKey && typeof out.plainKey === "string") {
    try {
      out.plainKey = Buffer.from(out.plainKey, "base64");
    } catch {}
  }
  if (out.defaultIv && typeof out.defaultIv === "string") {
    try {
      out.defaultIv = Buffer.from(out.defaultIv, "hex");
    } catch {}
  }
  if (out.directSegments == null) {
    const sample = Array.isArray(out.segs) && out.segs[0] && out.segs[0].u;
    out.directSegments = typeof sample === "string" && /^https?:\/\//i.test(sample);
  }
  return out;
}

async function getStreamSession(id, touch = true) {
  let s = streamSessions.get(id);
  if (!s) {
    try { const remote = await fbGet(`stream_sessions/${id}`); if (remote && remote.id) { s = { ...remote, src: reviveStreamSrc(remote.src) }; streamSessions.set(id, s); } } catch (e) { console.warn("[stream] load remote:", e.message); }
  }
  if (!s) return null;
  const t = now();
  if (t - s.lastUsed > CONFIG.STREAM_IDLE_MS || t - s.createdAt > CONFIG.STREAM_MAX_MS) { streamSessions.delete(id); try { await fbDelete(`stream_sessions/${id}`); } catch {} return null; }
  if (touch) {
    s.lastUsed = t;
    if (!s._lastPersist || t - s._lastPersist > 60_000) { s._lastPersist = t; persistStreamSession(s).catch(() => {}); }
  }
  return s;
}

// ليميت الفيديوهات: كل توكن طالب = 4 فيديوهات في الدقيقة
const playLimiter = rateLimit({
  max: 4,
  windowMs: 60_000,
  scope: "video-play",
  keyFn: (req) => "tok:" + (req.sessionToken || getBearer(req) || clientIp(req)),
  message: "وصلت للحد الأقصى: 4 فيديوهات في الدقيقة — استنى شوية وجرّب تاني"
});

// حماية من السحب الجماعي: أكتر من N فيديو مختلف في 10 دقايق → إيقاف مؤقت
// (من غير تبطئة سرعة المشاهدة العادية)
const PLAY_BURST_WINDOW_MS = Number(process.env.PLAY_BURST_WINDOW_MS || 10 * 60_000);
const PLAY_BURST_MAX = Number(process.env.PLAY_BURST_MAX || 8);
const PLAY_BURST_BAN_MS = Number(process.env.PLAY_BURST_BAN_MS || 15 * 60_000);
const playBurst = new Map(); // code -> { ids: Map<videoId,ts>, bannedUntil }

function checkPlayBurst(code, videoId) {
  const c = String(code || "unknown");
  const vid = String(videoId || "");
  const t = Date.now();
  let row = playBurst.get(c);
  if (!row) {
    row = { ids: new Map(), bannedUntil: 0 };
    playBurst.set(c, row);
  }
  if (row.bannedUntil > t) {
    const sec = Math.ceil((row.bannedUntil - t) / 1000);
    const e = new Error(`تم إيقاف التشغيل مؤقتًا بسبب طلبات كثيرة — حاول بعد ${sec} ثانية`);
    e.status = 429;
    throw e;
  }
  for (const [id, ts] of [...row.ids.entries()]) {
    if (t - ts > PLAY_BURST_WINDOW_MS) row.ids.delete(id);
  }
  if (!row.ids.has(vid)) {
    if (row.ids.size >= PLAY_BURST_MAX) {
      row.bannedUntil = t + PLAY_BURST_BAN_MS;
      console.warn("[play-burst] ban", c, "videos", row.ids.size, "windowMs", PLAY_BURST_WINDOW_MS);
      const e = new Error("طلبت فيديوهات كتير في وقت قصير. التشغيل متوقف ربع ساعة لحماية المحتوى.");
      e.status = 429;
      throw e;
    }
    row.ids.set(vid, t);
  } else {
    row.ids.set(vid, t);
  }
}

async function logPlayEvent(req, videoId) {
  try {
    const code = (req.session && req.session.code) || "unknown";
    const entry = {
      code: String(code),
      videoId: String(videoId || ""),
      ip: clientIp(req),
      deviceId: (req.session && req.session.deviceId) || null,
      ua: String(req.headers["user-agent"] || "").slice(0, 180),
      at: Date.now()
    };
    console.log("[play-log]", entry.code, entry.videoId, entry.ip);
    if (getFirebaseUrl()) {
      const safeVid = String(videoId || "x").replace(/[^\w-]/g, "").slice(0, 48) || "x";
      await fbSet(`play_logs/${entry.code}/${entry.at}_${safeVid}`, entry);
    }
  } catch (e) {
    console.warn("[play-log]", e.message);
  }
}



// حل صفحة درس drhossamissa → bn_<guid> (يحتاج كوكيز الجلسة من المنصة)
app.get("/api/bunny/catalog", requireStudent, (_req, res) => {
  res.json({ success: true, data: HOSSAM_CATALOG });
});

app.get("/api/public/hossam", rateLimit({ max: 60, windowMs: 60_000, scope: "hossam-pub" }), (_req, res) => {
  res.json({
    success: true,
    data: {
      teacher: HOSSAM_CATALOG.teacher,
      subject: HOSSAM_CATALOG.subject,
      courses: (HOSSAM_CATALOG.courses || []).map((c) => ({
        id: c.id,
        name: c.name,
        lessons: (c.lessons || []).map((l) => ({ lessonId: l.lessonId, title: l.title, videoId: l.videoId }))
      }))
    }
  });
});


// استيراد كل دروس كورس حسام دفعة واحدة (يحتاج cookies صالحة من المتصفح)
app.post("/api/bunny/import-course", requireStudent, rateLimit({ max: 5, windowMs: 300_000, scope: "bunny-import" }), async (req, res) => {
  try {
    const cookies = String(req.body?.cookies || process.env.HOSSAM_COOKIES || "").trim();
    if (!cookies) return jsonError(res, 400, "ابعت cookies من جلسة drhossamissa.com");
    const courseSlug = String(req.body?.courseSlug || "ورشة-الهرمونات-9").trim();
    const start = Math.max(1, Number(req.body?.start || 100) || 100);
    const end = Math.min(start + 80, Number(req.body?.end || start + 40) || start + 40);
    const found = [];
    for (let lessonId = start; lessonId <= end; lessonId++) {
      try {
        const pageUrl = `https://drhossamissa.com/play-course/${encodeURIComponent(courseSlug)}/${lessonId}`;
        const r = await fetch(pageUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
            Accept: "text/html",
            Cookie: cookies,
            Referer: "https://drhossamissa.com/my-courses"
          },
          redirect: "follow",
          signal: AbortSignal.timeout(20_000)
        });
        const html = await r.text();
        if (r.status === 401 || r.status === 403 || /login|تسجيل الدخول/i.test(html.slice(0, 2000)) && !/mediadelivery|iframe/i.test(html)) {
          if (lessonId === start) return jsonError(res, 401, "الكوكيز منتهية — جدّدها من المتصفح");
          continue;
        }
        const guidM = html.match(/mediadelivery\.net\/embed\/\d+\/([a-f0-9-]{36})/i)
          || html.match(/vz-[a-z0-9-]+\.b-cdn\.net\/([a-f0-9-]{36})\//i)
          || html.match(/["']([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})["']/i);
        if (!guidM) continue;
        const guid = guidM[1];
        const titleM = html.match(/<title>([^<]+)<\/title>/i);
        const title = (titleM && titleM[1] ? titleM[1].replace(/\s*\|\s*.*$/, "").trim() : `درس ${lessonId}`);
        const videoId = "bn_" + guid;
        found.push({ lessonId, title, videoId, guid });
        // حدّث الكتالوج في الذاكرة
        const course = HOSSAM_CATALOG.courses[0];
        if (course) {
          const existing = (course.lessons || []).find((l) => Number(l.lessonId) === lessonId);
          if (existing) { existing.videoId = videoId; existing.guid = guid; if (title) existing.title = title; }
          else (course.lessons || (course.lessons = [])).push({ lessonId, title, videoId, guid });
        }
        console.log("[bunny-import] lesson", lessonId, videoId);
      } catch (e) {
        console.warn("[bunny-import]", lessonId, e.message);
      }
    }
    res.json({ success: true, imported: found.length, lessons: found, catalog: HOSSAM_CATALOG.courses[0] });
  } catch (e) {
    jsonError(res, 500, e.message);
  }
});

app.post("/api/bunny/resolve-lesson", requireStudent, rateLimit({ max: 20, windowMs: 60_000, scope: "bunny-resolve" }), async (req, res) => {
  try {
    if (CONFIG.BUNNY_ENABLED === false) return jsonError(res, 503, "Bunny معطّل");
    const lessonUrl = String(req.body?.url || req.body?.lessonUrl || "").trim();
    const lessonId = String(req.body?.lessonId || "").replace(/\D/g, "");
    const cookies = String(req.body?.cookies || process.env.DRHOSSAM_COOKIES || "").trim();
    let target = lessonUrl;
    if (!target && lessonId) {
      target = `https://drhossamissa.com/play-course/x/${lessonId}`;
    }
    if (!target) return jsonError(res, 400, "url أو lessonId مطلوب");
    if (!/^https:\/\/(?:www\.)?drhossamissa\.com\//i.test(target)) return jsonError(res, 400, "رابط غير مدعوم");
    const headers = {
      "User-Agent": CONFIG.STREAM_UA,
      Accept: "text/html,application/xhtml+xml",
      Referer: "https://drhossamissa.com/my-courses",
      "Accept-Language": "ar,en;q=0.9"
    };
    if (cookies) headers.Cookie = cookies;
    const r = await upstreamSlot(() => fetchT(target, { headers, redirect: "follow" }, { timeout: 25_000, retries: 1 }));
    const html = await r.text();
    if (!r.ok) return jsonError(res, 502, `صفحة الدرس HTTP ${r.status}`);
    if (/\/login/i.test(String(r.url || "")) || /سجل دخولك|تسجيل الدخول/i.test(html.slice(0, 2000))) {
      return jsonError(res, 401, "الكوكيز منتهية أو غير صالحة — ابعت cookies من المتصفح");
    }
    const m = html.match(/iframe\.mediadelivery\.net\/embed\/(\d+)\/([0-9a-f-]{36})\?[^"']*token=([a-f0-9]+)(?:&|&amp;)expires=(\d+)/i)
      || html.match(/iframe\.mediadelivery\.net\/embed\/(\d+)\/([0-9a-f-]{36})/i);
    if (!m) return jsonError(res, 404, "مفيش iframe Bunny في الصفحة");
    const libraryId = m[1];
    const guid = m[2].toLowerCase();
    const token = m[3] || null;
    const expires = m[4] ? Number(m[4]) : null;
    // اكتشاف CDN zone من thumbnail لو موجود
    const cdnM = html.match(/https:\/\/(vz-[a-z0-9-]+\.b-cdn\.net)\//i);
    if (cdnM && cdnM[1] && cdnM[1] !== CONFIG.BUNNY_CDN_HOST) {
      console.log("[bunny] detected CDN host", cdnM[1]);
    }
    const videoId = "bn_" + guid;
    res.json({
      success: true,
      data: {
        videoId,
        guid,
        libraryId,
        token,
        expires,
        cdnHost: (cdnM && cdnM[1]) || CONFIG.BUNNY_CDN_HOST,
        playHint: `POST /api/play/${videoId}`
      }
    });
  } catch (e) {
    console.error("[bunny resolve]", e.message);
    jsonError(res, 502, e.message);
  }
});


app.get("/api/debug/stream-probe/:videoId", requireStudent, rateLimit({ max: 10, windowMs: 60_000, scope: "dbg-stream" }), async (req, res) => {
  try {
    const videoId = String(req.params.videoId || "");
    const tok = await getCoursatkToken();
    const out = { videoId, tokenConfigured: Boolean(tok), platforms: null, weave: null, cdn: null };
    try {
      out.platforms = await upstreamJson(`/video/${encodeURIComponent(videoId)}/platforms`);
    } catch (e) { out.platforms = { error: e.message }; }
    try {
      out.weave = await upstreamJson(`/video/${encodeURIComponent(videoId)}/stream-weave/play`, { method: "POST", headers: { Accept: "application/json" } });
    } catch (e) { out.weave = { error: e.message }; }
    try {
      const masterUrl = `${CONFIG.COURSATK_API}/video/stream/${encodeURIComponent(videoId)}/playlist.m3u8`;
      const got = await fetchPlaylistSmart(masterUrl, tok, "dbg-cdn");
      out.cdn = { status: got.status, hasM3U: got.text.includes("#EXTM3U"), head: got.text.slice(0, 200) };
    } catch (e) { out.cdn = { error: e.message, detail: e.detail || null }; }
    res.json({ success: true, data: out, version: APP_VERSION });
  } catch (e) {
    jsonError(res, 500, e.message);
  }
});


app.post("/api/play/:videoId/hydrate", requireStudent, playLimiter, async (req, res) => {
  try {
    const videoId = String(req.params.videoId || "");
    if (!videoId) return jsonError(res, 400, "videoId مطلوب");
    if (/^bn_/i.test(videoId) || /^th/i.test(videoId)) return jsonError(res, 400, "hydrate لكورساتك فقط");
    const body = req.body || {};
    const masterText = body.masterPlaylist || body.master || body.playlist || "";
    const mediaText = body.mediaPlaylist || body.media || body.variant || "";
    const keyBase64 = body.keyBase64 || body.key || null;
    const keyUrl = body.keyUrl || null;
    const variantUrl = body.variantUrl || body.mediaUrl || null;
    if (!mediaText && !masterText) return jsonError(res, 400, "ابعت masterPlaylist أو mediaPlaylist");

    const src = await buildSrcFromClientPlaylists(videoId, {
      masterText,
      mediaText: mediaText || masterText,
      keyBase64,
      keyUrl,
      variantUrl: variantUrl || `${CONFIG.COURSATK_API}/video/stream/${encodeURIComponent(videoId)}/480.m3u8`
    });
    // cache source briefly
    sourceCache.set(videoId, { src, exp: now() + 10 * 60_000 });

    const id = crypto.randomBytes(12).toString("hex");
    const streamKey = crypto.randomBytes(18).toString("base64url");
    const deviceId = (req.session && req.session.deviceId) || null;
    const sessionRow = {
      id,
      src,
      ownerCode: req.session && req.session.code,
      ownerToken: req.sessionToken,
      ownerDeviceId: deviceId,
      streamKey,
      createdAt: now(),
      lastUsed: now()
    };
    streamSessions.set(id, sessionRow);
    try {
      const secure = (req.secure || req.headers["x-forwarded-proto"] === "https") ? "; Secure" : "";
      res.setHeader("Set-Cookie", `ds_session=${encodeURIComponent(req.sessionToken)}; Path=/; HttpOnly; SameSite=None${secure}; Max-Age=${7 * 24 * 3600}`);
    } catch {}
    const hlsPath = `/api/hls/${id}/master.m3u8?sk=${streamKey}`;
    res.json({ success: true, data: { play_url: hlsPath, manifest_url: hlsPath, mode: "client_hydrated", segs: (src.segs || []).length } });
  } catch (e) {
    console.error("[hydrate]", e.message);
    jsonError(res, 502, e.message);
  }
});

app.post("/api/play/:videoId", requireStudent, playLimiter, async (req, res) => {
  try {
    let videoId = String(req.params.videoId);
    if (CONFIG.THANAWICA_ENABLED && /^thv_\d+$/i.test(videoId)) {
      const pageId = videoId.slice(4);
      const lecRaw = req.body?.lectureId ?? req.query?.lectureId ?? req.body?.lecture ?? req.query?.lecture;
      let lec = lecRaw != null ? Number(lecRaw) : null;
      if (lec != null && lec >= 9_000_000) lec = lec - 9_000_000;
      if (lec != null && Number.isFinite(lec) && lec > 0) {
        try {
          const resolved = await thResolveVideo(lec, pageId);
          if (resolved.kind === "youtube") videoId = "thy_" + resolved.youtubeId;
          else if (resolved.kind === "hls") videoId = "thp_" + resolved.hash;
          else if (resolved.kind === "mp4") videoId = "thm_" + resolved.id;
          else return jsonError(res, 502, "مصدر فيديو ثناويكا غير معروف");
        } catch (e) { return jsonError(res, 502, e.message || "تعذر جلب فيديو ثناويكا"); }
      }
    }
    if (/^th[pvmy]_/i.test(videoId) && !studentAllowsThanawica(req.student)) return jsonError(res, 403, "المصدر غير متاح لشعبتك");
    try {
      checkPlayBurst(req.session && req.session.code, videoId);
    } catch (be) {
      return jsonError(res, be.status || 429, be.message || "طلبات كثيرة");
    }
    logPlayEvent(req, videoId).catch(() => {});
    const src = await getVideoSource(videoId, req.headers);

    try {
      const secure = (req.secure || req.headers["x-forwarded-proto"] === "https") ? "; Secure" : "";
      res.setHeader("Set-Cookie", `ds_session=${encodeURIComponent(req.sessionToken)}; Path=/; HttpOnly; SameSite=None${secure}; Max-Age=${7 * 24 * 3600}`);
    } catch {}

    if ((src.mode === "thanawica-youtube" || src.mode === "coursatk-youtube") && src.youtubeUrl) return res.json({ success: true, data: { type: "youtube", youtube_url: src.youtubeUrl, url: src.youtubeUrl } });
    if (src.youtubeUrl) return res.json({ success: true, data: { type: "youtube", youtube_url: src.youtubeUrl, url: src.youtubeUrl } });
    if (src.mode === "thanawica-mp4" && src.mp4Url) return res.json({ success: true, data: { type: "mp4", play_url: src.mp4Url, mp4_url: src.mp4Url } });

    // مصدر كورساتك مشترك في الذاكرة (sourceCache) — لكن جلسة HLS خاصة بكل طالب
    // عشان لينك التشغيل ومتفتاح sk ميترموش بين منصات تانية
    assertPlayerOrigin(req);

    const id = crypto.randomUUID().replace(/-/g, "");
    const streamKey = crypto.randomBytes(16).toString("hex");
    const deviceId = (req.session && req.session.deviceId) || (req.student && req.student.deviceId) || null;
    revokeOtherSessions(req.session.code, src.videoId, id);

    const sessionRow = {
      id,
      src,
      videoId: src.videoId,
      shared: false,
      ownerCode: req.session.code,
      ownerToken: req.sessionToken,
      ownerDeviceId: deviceId,
      streamKey,
      createdAt: now(),
      lastUsed: now()
    };
    streamSessions.set(id, sessionRow);
    // بدون persist Firebase لتقليل التسريب والكتابة — الجلسة في الذاكرة فقط
    const hlsPath = `/api/hls/${id}/master.m3u8?sk=${streamKey}`;
    res.json({ success: true, data: { play_url: hlsPath, manifest_url: hlsPath, shared: false } });
  } catch (e) {
    try { const yt = await tryResolveYoutube(String(req.params.videoId || "")); if (yt) return res.json({ success: true, data: { type: "youtube", youtube_url: yt, url: yt } }); } catch {}
    console.error("[play]", e.message);
    const msg = String(e && e.message || "");
    const blocked = /CDN|weave|playlist|403|500|426|cloudflare|blocked|غير صالح|fetch failed|UPSTREAM/i.test(msg);
    if (blocked && !/^bn_/i.test(String(req.params.videoId || "")) && !/^th/i.test(String(req.params.videoId || ""))) {
      try {
        const tok = await getCoursatkToken();
        if (tok) {
          console.warn("[play] falling back to client_fetch for", req.params.videoId, msg);
          return res.json({ success: true, data: clientFetchPayload(String(req.params.videoId), tok) });
        }
      } catch (e2) { console.warn("[play] client_fetch payload failed", e2.message); }
    }
    jsonError(res, e.status || 502, e.message);
  }
});

function playlistBodyFromSession(session) {
  const src = session && session.src;
  if (!src) return null;
  let body = null;
  if (src.playlist && typeof src.playlist === "string") {
    body = src.playlist.split(SID_TOKEN).join(session.id);
  } else if (Array.isArray(src.segs) && src.segs.length) {
    const td = Number(src.targetDuration) || 6;
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(td))}`, "#EXT-X-PLAYLIST-TYPE:VOD", `#EXT-X-MEDIA-SEQUENCE:${Number(src.mediaSeq) || 0}`];
    if (src.directSegments && src.plainKey) {
      const ivHex = src.defaultIv ? ("0x" + Buffer.from(src.defaultIv).toString("hex")) : "0x00000000000000000000000000000000";
      lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="/api/hls/${session.id}/key",IV=${ivHex}`);
    }
    for (let i = 0; i < src.segs.length; i++) {
      const dur = Number(src.segs[i].dur) || td;
      lines.push(`#EXTINF:${Number(dur).toFixed(5)},`);
      if (src.directSegments && src.segs[i].u) lines.push(src.segs[i].u);
      else lines.push(`/api/hls/${session.id}/seg/${i}`);
    }
    lines.push("#EXT-X-ENDLIST");
    body = lines.join("\n");
  }
  if (!body) return null;
  if (session.streamKey) {
    body = body.split("\n").map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#EXT-X-KEY:") && t.includes("/api/hls/")) {
        return t.replace(/URI="([^"]+)"/, (_, uri) => {
          const u = uri.includes("?") ? `${uri}&sk=${session.streamKey}` : `${uri}?sk=${session.streamKey}`;
          return `URI="${u}"`;
        });
      }
      if (!t.startsWith("#") && t.includes("/api/hls/")) {
        return t.includes("?") ? `${t}&sk=${session.streamKey}` : `${t}?sk=${session.streamKey}`;
      }
      return line;
    }).join("\n");
  }
  return body;
}

app.get("/api/hls/:pid/key", requireStudent, async (req, res) => {
  try {
    assertPlayerOrigin(req);
    const session = await getStreamSession(req.params.pid);
    assertStreamOwner(session, req);
    const key = session.src && session.src.plainKey;
    if (!key || !Buffer.isBuffer(key) || key.length !== 16) {
      return jsonError(res, 404, "مفتاح التشفير غير متاح");
    }
    const allowOrigin = (req.headers.origin && ALLOWED_ORIGINS.has(String(req.headers.origin).replace(/\/$/, ""))) ? req.headers.origin : (ALLOWED_ORIGINS.values().next().value || "https://www.durosakplus.com");
    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Length": "16",
      "Cache-Control": "no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin"
    });
    res.status(200).send(key);
  } catch (e) {
    console.warn("[hls key]", e.message);
    return jsonError(res, e.status || 403, e.message || "غير مصرح");
  }
});

app.get("/api/hls/:pid/master.m3u8", requireStudent, async (req, res) => {
  try {
    assertPlayerOrigin(req);
    const session = await getStreamSession(req.params.pid);
    assertStreamOwner(session, req);
    if (!session.src) return jsonError(res, 410, "جلسة التشغيل ناقصة — افتح الفيديو من جديد");
    let body = playlistBodyFromSession(session);
    if (!body) {
      try { const fresh = await refreshSource(session); if (fresh) { session.src = fresh; streamSessions.set(session.id, session); persistStreamSession(session).catch(() => {}); body = playlistBodyFromSession(session); } } catch (err) { console.warn("[hls master] refresh:", err.message); }
    }
    if (!body) return jsonError(res, 410, "انتهت بيانات التشغيل — افتح الفيديو من جديد");
    res.set({ "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.send(body);
  } catch (e) { console.warn("[hls master]", e.message); return jsonError(res, e.status || 403, e.message || "غير مصرح"); }
});

async function getSegmentPlain(session, meta, url, iv, headers) {
  const key = url + "|" + (meta.iv || "");
  const hit = segGet(key);
  if (hit) return hit;
  return coalesce("seg:" + key, async () => {
    const hit2 = segGet(key);
    if (hit2) return hit2;

    if (session.src.mode === "thanawica" && typeof session.src._thDecrypt === "function") {
      const encrypted = await thMintAndFetchSegment(meta);
      if (encrypted.length > CONFIG.MAX_PROXY_BYTES) {
        const e = new Error("المقطع كبير");
        e.status = 413;
        throw e;
      }
      const ivHex = meta.iv || (iv ? Buffer.from(iv).toString("hex") : null);
      const plain = await session.src._thDecrypt(encrypted, ivHex);
      segSet(key, plain);
      return plain;
    }

    let up = await streamFetch(session.src, url, {}, headers);
    let usedSrc = session.src;
    let usedUrl = url;
    let usedIv = iv;

    if ((up.status === 401 || up.status === 403) && Number.isFinite(meta.s)) {
      console.warn("[seg] upstream", up.status, "→ force refresh", usedUrl.slice(0, 80));
      try { await up.arrayBuffer(); } catch {}
      const fresh = await refreshSource(session, true);
      if (fresh && Array.isArray(fresh.segs) && fresh.segs.length) {
        let fu = fresh.segs[meta.i];
        if (!fu && Number.isFinite(meta.s)) {
          fu = fresh.segs.find((s) => s.s === meta.s) || fresh.segs[meta.s - (fresh.mediaSeq || 0)];
        }
        if (!fu && Number.isFinite(meta.i)) fu = fresh.segs[meta.i];
        if (fu) {
          usedSrc = fresh;
          usedUrl = fu.u;
          usedIv = parseIvHex(fu.iv) || fresh.defaultIv || ivFromMediaSequence(fu.s || meta.s || 0);
          up = await streamFetch(fresh, fu.u, {}, headers);
          console.log("[seg] retry after refresh →", up.status);
        }
      }
    }

    if (!up.ok) {
      if (up.status === 401 || up.status === 403) {
        console.warn("[seg] still", up.status, "after refresh — giving up");
      }
      throw new Error(`Segment HTTP ${up.status}`);
    }

    const encrypted = Buffer.from(await up.arrayBuffer());
    if (encrypted.length > CONFIG.MAX_PROXY_BYTES) {
      const e = new Error("المقطع كبير");
      e.status = 413;
      throw e;
    }

    let plain;
    const mode = (usedSrc.cipherMode || "cbc").toLowerCase();
    // لو ivMode=seq استخدم media sequence لكل مقطع
    if (usedSrc.ivMode === "seq" && Number.isFinite(meta.s)) {
      usedIv = ivFromMediaSequence(meta.s);
    }
    try {
      if (mode === "ctr") {
        plain = decryptSegmentCtr(encrypted, usedSrc.plainKey, usedIv);
      } else if (mode === "cbc-nopad") {
        const d = crypto.createDecipheriv("aes-128-cbc", usedSrc.plainKey, usedIv);
        d.setAutoPadding(false);
        const aligned = encrypted.subarray(0, encrypted.length - (encrypted.length % 16));
        plain = Buffer.concat([d.update(aligned), d.final()]);
      } else {
        plain = decryptSegment(encrypted, usedSrc.plainKey, usedIv);
      }
      if (usedSrc.mode === "weave" && !looksLikeMpegTs(plain)) {
        throw new Error("not mpeg-ts after decrypt");
      }
    } catch (decErr) {
      let recovered = null;
      if (usedSrc.mode === "weave" && encrypted.length >= 32) {
        try {
          const raw = usedSrc._lastKeyBuf || usedSrc.plainKey;
          const cands = weaveV3KeyCandidates(raw, usedSrc.keySeed, usedSrc.swTicket);
          // player.js: len===16 → raw AES key as-is (Vd early return)
          if (raw && raw.length >= 16) {
            const bin16 = Buffer.from(raw.subarray(0, 16));
            if (!cands.some((c) => c.hex === bin16.toString("hex"))) {
              cands.unshift({ key: bin16, tag: "bin16-raw", hex: bin16.toString("hex") });
            }
          }
          const ivs = [];
          for (const x of [usedIv, usedSrc.defaultIv, meta && meta.iv ? parseIvHex(meta.iv) : null]) {
            if (x && Buffer.isBuffer(x) && x.length === 16) ivs.push(x);
          }
          const seqBase = Number.isFinite(meta.s) ? meta.s : 0;
          for (let s = Math.max(0, seqBase - 2); s <= seqBase + 5; s++) ivs.push(ivFromMediaSequence(s));
          ivs.push(Buffer.alloc(16, 0));
          for (const cand of cands) {
            for (const testIv of ivs) {
              for (const m of ["cbc", "ctr", "cbc-nopad"]) {
                try {
                  let p;
                  if (m === "ctr") p = decryptSegmentCtr(encrypted, cand.key, testIv);
                  else if (m === "cbc-nopad") {
                    const d = crypto.createDecipheriv("aes-128-cbc", cand.key, testIv);
                    d.setAutoPadding(false);
                    const aligned = encrypted.subarray(0, encrypted.length - (encrypted.length % 16));
                    p = Buffer.concat([d.update(aligned), d.final()]);
                  } else {
                    p = decryptSegment(encrypted, cand.key, testIv);
                  }
                  if (looksLikeMpegTs(p, true)) {
                    recovered = p;
                    usedSrc.plainKey = cand.key;
                    usedSrc.cipherMode = m;
                    console.log(`[seg] recovered plainKey via ${cand.tag} ${m}`);
                    break;
                  }
                } catch {}
              }
              if (recovered) break;
            }
            if (recovered) break;
          }
        } catch {}
      }
      if (recovered) {
        plain = recovered;
      } else {
        console.warn("[seg] decrypt failed, serving raw:", decErr.message);
        plain = encrypted;
      }
    }

    segSet(key, plain);
    if (usedUrl !== url) segSet(usedUrl + "|" + (meta.iv || ""), plain);
    return plain;
  });
}

function prefetchAhead(session, meta, headers) {
  if (!PREFETCH_AHEAD || !Number.isFinite(meta.s)) return;
  if (upstreamSlot.stats().queued > 8) return;
  const src = session.src;
  const idx = meta.s - src.mediaSeq;
  if (!(idx >= 0)) return;
  for (let k = 1; k <= PREFETCH_AHEAD; k++) {
    const sg = src.segs[idx + k];
    if (!sg) break;
    const key = sg.u + "|" + sg.iv;
    if (segCache.has(key) || inflight.has("seg:" + key)) continue;
    const iv = parseIvHex(sg.iv) || src.defaultIv || ivFromMediaSequence(sg.s);
    getSegmentPlain(session, { ...sg, s: sg.s, iv: sg.iv }, sg.u, iv, headers).catch(() => {});
  }
}

app.get("/api/hls/:pid/seg/:idx", requireStudent, async (req, res) => {
  let session;
  try { assertPlayerOrigin(req); session = await getStreamSession(req.params.pid); assertStreamOwner(session, req); } catch (e) { return jsonError(res, e.status || 403, e.message || "غير مصرح"); }
  if (!session.src?.plainKey && session.src?.mode !== "thanawica") return jsonError(res, 404, "غير متاح");
  const idx = Number(req.params.idx);
  if (!Number.isFinite(idx) || idx < 0) return jsonError(res, 400, "طلب غير صالح");
  const segs = session.src.segs || [];
  const sg = segs[idx];
  if (!sg) return jsonError(res, 404, "المقطع غير موجود");
  const url = sg.u;
  const isTh = session.src?.mode === "thanawica";
  const isBunny = session.src?.mode === "bunny" || session.src?.mode === "hossam";
  const isTaleb2 = session.src?.mode === "taleb";
  if (!url || (!isTh && !isBunny && !isTaleb2 && !allowedStreamUrl(url, session.src))) return jsonError(res, 403, "غير مصرح");
  if (isTh && url && !/thanawica\.com/i.test(String(url))) return jsonError(res, 403, "غير مصرح");
  if (isBunny && url && !/b-cdn\.net|mediadelivery\.net/i.test(String(url))) return jsonError(res, 403, "غير مصرح");
  if (isTaleb2 && url && !/video\.talep\.pro/i.test(String(url))) return jsonError(res, 403, "غير مصرح");
  const meta = { ...sg, u: url, iv: sg.iv, s: sg.s, i: idx };
  const iv = parseIvHex(sg.iv) || session.src.defaultIv || ivFromMediaSequence(sg.s || 0);
  try {
    // pass-through: رجّع المقطع مشفّر وخلي hls.js يفك بمفتاح /key
    if (session.src.passThroughEncrypt) {
      const up = await streamFetch(session.src, url, {}, req.headers);
      if (!up.ok) throw Object.assign(new Error(`Segment HTTP ${up.status}`), { status: up.status });
      const buf = Buffer.from(await up.arrayBuffer());
      res.status(200);
      res.set({ "Content-Type": "video/mp2t", "Content-Length": String(buf.length), "Cache-Control": "no-store", "Accept-Ranges": "bytes" });
      return res.send(buf);
    }
    const plain = await getSegmentPlain(session, meta, url, iv, req.headers);
    res.status(200);
    res.set({ "Content-Type": "video/mp2t", "Content-Length": String(plain.length), "Cache-Control": "no-store", "Accept-Ranges": "bytes" });
    res.send(plain);
    if (!req.headers.range) prefetchAhead(session, meta, req.headers);
  } catch (e) {
    console.warn("[hls seg]", idx, e.message);
    if (!res.headersSent) jsonError(res, e.status || 502, e.message);
    else res.end();
  }
});

app.get("/api/stream/manifest/:sessionId", (_req, res) => jsonError(res, 410, "المسار لم يعد متاحًا"));
app.get("/api/stream/segment/:sessionId/:encoded", (_req, res) => jsonError(res, 410, "المسار لم يعد متاحًا"));

app.post("/api/admin/login", rateLimit({ max: 10, windowMs: 60_000, scope: "admin-login", banAfter: 3, banMs: 15 * 60_000 }), async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const ip = clientIp(req);
    if (!username || !password) return jsonError(res, 400, "يوزر وباسورد مطلوبين");

    const adminDevice = String(req.body?.deviceId || req.headers["x-device-id"] || "").trim();
    const lock = checkLoginLockAny("admin", adminDevice || null, ip, username);
    if (lock && lock.locked) { res.setHeader("Retry-After", String(lock.sec)); return jsonError(res, 429, `اتقفل الدخول مؤقتًا بعد محاولات غلط — جرّب بعد ${Math.ceil(lock.sec / 60)} دقيقة`); }

    let adminId = null; let admin = null; let perms = null;

    function failAuth() {
      const fail = recordLoginFailBoth("admin", adminDevice, ip, username);
      if (fail.locked) { res.setHeader("Retry-After", String(fail.sec)); return jsonError(res, 429, "محاولات خاطئة كثيرة — حاول بعد 15 دقيقة"); }
      return jsonError(res, 401, `بيانات الدخول خطأ (متبقي ${fail.remaining} محاولات)`);
    }

    if (username === CONFIG.BOOTSTRAP_ADMIN.username) {
      const ok = scryptVerify(password, CONFIG.BOOTSTRAP_ADMIN.passwordHash) || password === CONFIG.BOOTSTRAP_ADMIN.passwordPlain;
      if (!ok) return failAuth();
      adminId = "bootstrap"; perms = CONFIG.BOOTSTRAP_ADMIN.permissions;
      admin = { username, permissions: perms, bootstrap: true };
    } else {
      const all = (await fbGet("admins")) || {};
      for (const [id, a] of Object.entries(all)) {
        if (a && a.username === username && a.active !== false) {
          if (!scryptVerify(password, a.passwordHash)) return failAuth();
          adminId = id; admin = a; perms = a.permissions || {};
          break;
        }
      }
      if (!adminId) return failAuth();
    }
    clearLoginFailBoth("admin", adminDevice, ip, username);

    const token = randomToken(32);
    const sess = { token, adminId, username, createdAt: now(), expiresAt: now() + CONFIG.ADMIN_SESSION_MS, bootstrap: adminId === "bootstrap" };
    adminSessions.set(token, sess);
    if (getFirebaseUrl()) { try { await fbSet(`admin_sessions/${token}`, sess); } catch (err) { console.warn("[admin login] session fb skip:", err.message); } }

    res.json({ success: true, data: { token, expiresAt: sess.expiresAt, username, permissions: perms, isOwner: false, needsSetup: !getFirebaseUrl() } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/admin/logout", requireAdmin(null), async (req, res) => {
  adminSessions.delete(req.adminToken);
  try { await fbDelete(`admin_sessions/${req.adminToken}`); } catch {}
  res.json({ success: true });
});

app.get("/api/admin/me", requireAdmin(null), (req, res) => {
  res.json({ success: true, data: { username: req.admin.username, permissions: req.admin.permissions || {}, bootstrap: !!req.admin.bootstrap, isOwner: false } });
});

app.get("/api/admin/maintenance", requireAdmin(null), requireBootstrap, async (_req, res) => {
  res.json({ success: true, data: { mode: maintenance.mode, message: maintenance.message, updatedAt: maintenance.updatedAt, updatedBy: maintenance.updatedBy } });
});

app.put("/api/admin/maintenance", requireAdmin(null), requireBootstrap, async (req, res) => {
  try {
    const mode = String(req.body?.mode || "").trim();
    if (!["off", "stream", "full"].includes(mode)) return jsonError(res, 400, "mode لازم: off أو stream أو full");
    const message = req.body?.message != null ? String(req.body.message) : maintenance.message;
    const by = (req.admin && (req.admin.username || req.admin.name)) || "admin";
    await saveMaintenance(mode, message, by);
    res.json({ success: true, message: mode === "off" ? "تم إلغاء الصيانة" : mode === "stream" ? "تم إيقاف البث فقط" : "تم إيقاف السيرفر بالكامل", data: { mode: maintenance.mode, message: maintenance.message, updatedAt: maintenance.updatedAt, updatedBy: maintenance.updatedBy } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/admin/config", requireAdmin("sections_manage"), async (_req, res) => {
  try {
    const remote = await fbGet("config");
    const token = await getCoursatkToken();
    const masked = token ? token.slice(0, 12) + "…" + token.slice(-8) : null;
    res.json({ success: true, data: { coursatkTokenSet: Boolean(token), coursatkTokenMasked: masked, defaultYearId: CONFIG.DEFAULT_YEAR_ID, codeTypes: Object.fromEntries(Object.entries(CONFIG.CODE_TYPES).map(([k, v]) => [k, { label: v.label, ms: v.ms }])), firebase: remote || {} } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.put("/api/admin/config/token", requireAdmin("admins_manage"), async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    if (token.length < 20) return jsonError(res, 400, "توكن غير صالح");
    await fbSet("config/coursatkToken", token);
    cachedCoursatkToken = token; cachedTokenAt = Date.now();
    res.json({ success: true, message: "تم تحديث توكن كورساتك" });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/admin/students", requireAdmin("students_view"), async (_req, res) => {
  try {
    const all = (await fbGet("students")) || {};
    const list = Object.entries(all).map(([code, s]) => ({
      code, 
      name: s.name, 
      section: s.section || null, 
      type: s.type || null, 
      days: s.days || null, 
      durationMs: s.durationMs || null, 
      activatedAt: s.activatedAt || null, 
      expiresAt: s.expiresAt || null, 
      maxDevices: s.maxDevices || 1, 
      devices: Object.keys(s.devices || {}).length, 
      active: s.active !== false, 
      createdAt: s.createdAt || null, 
      lastSeen: s.lastSeen || null, 
      visitCount: s.visitCount || 0,
      email: s.email || null,
      phone: s.phone || null,
      governorate: s.governorate || null,
      profileComplete: !studentProfileInfo(s).needsProfile,
      status: !s.activatedAt ? "لم يبدأ" : (s.expiresAt && Date.now() > s.expiresAt ? "منتهي" : "نشط")
    }));
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ success: true, data: list });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/admin/students/:code", requireAdmin("students_view"), async (req, res) => {
  try {
    const code = req.params.code;
    const s = await fbGet(`students/${code}`);
    if (!s) return jsonError(res, 404, "الطالب غير موجود");
    res.json({ success: true, data: { code, ...s, deviceList: Object.entries(s.devices || {}).map(([id, d]) => ({ deviceId: id, ...d })) } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/admin/students/import", requireAdmin("students_create"), async (req, res) => {
  try {
    const list = Array.isArray(req.body?.students) ? req.body.students : [];
    if (!list.length) return jsonError(res, 400, "لا توجد بيانات للاستيراد");
    if (list.length > 5000) return jsonError(res, 400, "الحد الأقصى 5000 كود في المرة");
    let created = 0, updated = 0, failed = 0;
    const errors = []; const t = now(); const DAY = 24 * 3600 * 1000;
    for (const row of list) {
      try {
        let code = String(row.code || row["الكود"] || "").replace(/\D/g, "");
        if (code.length < 7) { failed++; errors.push({ code: row.code || row["الكود"], error: "كود غير صالح" }); continue; }
        if (code.length < 9) code = code.padStart(9, "0");
        const name = String(row.name || row["الاسم"] || "بدون اسم").trim().slice(0, 120);
        const sectionRaw = row.section || row["الشعبة"] || "";
        const section = normalizeSection(sectionRaw) || String(sectionRaw).trim() || null;
        let active = row.active !== false && row.active !== 0 && row.active !== "0";
        if (row["الحالة"] != null) active = String(row["الحالة"]).trim() === "فعال";
        const remainingText = String(row["المتبقي"] || row.remaining || "").trim();
        let pending = row.pendingActivation === true || row.pendingActivation === 1 || row.pendingActivation === "1";
        if (remainingText === "غير محددة" || remainingText === "غير محدد") pending = true;
        let days = row.days != null ? Number(row.days) : null;
        if (days == null && remainingText) { if (remainingText === "انتهى" || remainingText === "منتهي") days = 0; else { const m = remainingText.match(/(\d+)\s*يوم/); if (m) days = Number(m[1]); } }
        if (remainingText === "انتهى" || remainingText === "منتهي") { active = false; row.expired = true; }
        const durationMs = Number(row.durationMs) > 0 ? Number(row.durationMs) : days != null && days >= 0 ? Math.round(days * DAY) : resolveDurationMs({ type: row.type || "month", days });
        const existing = await fbGet(`students/${code}`);
        const record = { name, section, type: String(row.type || (pending ? "month" : "custom")), days: days, durationMs: durationMs || null, maxDevices: Math.max(1, Math.min(10, Number(row.maxDevices || existing?.maxDevices || 1))), devices: existing?.devices || {}, bannedDevices: existing?.bannedDevices || {}, active, createdAt: existing?.createdAt || t, createdBy: req.admin.username, importedAt: t };
        if (pending || (!existing && (days == null || row.expiresAt == null) && !row.expired)) { if (pending || row.expiresAt == null) { record.activatedAt = null; record.expiresAt = null; if (!record.durationMs) record.durationMs = 30 * DAY; } }
        if (row.expired === true || (days != null && days <= 0 && !pending)) { record.activatedAt = existing?.activatedAt || t - DAY; record.expiresAt = t - 1000; record.active = false; }
        else if (!pending && days != null && days > 0) { record.activatedAt = existing?.activatedAt || t; record.expiresAt = t + Math.round(days * DAY); record.durationMs = record.durationMs || Math.round(days * DAY); }
        else if (!pending && Number(row.expiresAt) > 0) { record.expiresAt = Number(row.expiresAt); record.activatedAt = Number(row.activatedAt) || existing?.activatedAt || t; }
        await fbSet(`students/${code}`, { ...(existing || {}), ...record });
        if (existing) updated++; else created++;
      } catch (e) { failed++; errors.push({ code: row.code, error: e.message }); }
    }
    res.json({ success: true, data: { created, updated, failed, total: list.length, errors: errors.slice(0, 50) } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/admin/students", requireAdmin("students_create"), async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const section = normalizeSection(req.body?.section) || String(req.body?.section || "").trim() || null;
    const type = String(req.body?.type || "custom");
    const maxDevices = Math.max(1, Math.min(10, Number(req.body?.maxDevices || 1)));
    let code = String(req.body?.code || "").trim();
    if (!name) return jsonError(res, 400, "اسم الطالب مطلوب");
    const duration = resolveDurationMs(req.body);
    if (!duration || duration <= 0) return jsonError(res, 400, "حدد نوع الباقة أو عدد الأيام");
    if (code) { if (!/^\d{9}$/.test(code)) return jsonError(res, 400, "الكود يجب 9 أرقام"); const exists = await fbGet(`students/${code}`); if (exists) return jsonError(res, 409, "الكود مستخدم بالفعل"); }
    else { for (let i = 0; i < 30; i++) { code = randomCode9(); const exists = await fbGet(`students/${code}`); if (!exists) break; } }
    const email = req.body?.email != null ? String(req.body.email).trim().toLowerCase().slice(0, 120) : "";
    const phone = req.body?.phone != null ? normalizePhone(req.body.phone) : "";
    const governorate = req.body?.governorate != null ? String(req.body.governorate).trim().slice(0, 60) : "";
    const record = {
      name,
      section: section || null,
      type: req.body?.days != null ? "custom" : type,
      days: req.body?.days != null ? Number(req.body.days) : null,
      durationMs: duration,
      maxDevices,
      devices: {},
      bannedDevices: {},
      active: true,
      createdAt: now(),
      activatedAt: null,
      expiresAt: null,
      createdBy: req.admin.username,
      email: email || null,
      phone: phone || null,
      governorate: governorate || null
    };
    await fbSet(`students/${code}`, record);
    res.json({ success: true, data: { code, ...record } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.patch("/api/admin/students/:code", requireAdmin("students_edit"), async (req, res) => {
  try {
    const code = req.params.code;
    const s = await fbGet(`students/${code}`);
    if (!s) return jsonError(res, 404, "غير موجود");
    const patch = {};
    if (req.body.name != null) patch.name = String(req.body.name).trim();
    if (req.body.section != null) patch.section = normalizeSection(req.body.section) || String(req.body.section).trim() || null;
    if (req.body.maxDevices != null) patch.maxDevices = Math.max(1, Math.min(10, Number(req.body.maxDevices)));
    if (req.body.active != null) patch.active = Boolean(req.body.active);
    if (req.body.email != null) {
      const email = String(req.body.email).trim().toLowerCase().slice(0, 120);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError(res, 400, "الإيميل غير صالح");
      patch.email = email || null;
    }
    if (req.body.phone != null) {
      const phone = normalizePhone(req.body.phone);
      if (phone && phone.replace(/\D/g, "").length < 10) return jsonError(res, 400, "رقم الموبايل غير صالح");
      patch.phone = phone || null;
    }
    if (req.body.governorate != null) patch.governorate = String(req.body.governorate).trim().slice(0, 60) || null;
    if (req.body.type && (CONFIG.CODE_TYPES[req.body.type] || (runtime.packages || []).some((p) => p.id === req.body.type))) {
      patch.type = req.body.type;
      const dur = resolveDurationMs({ type: req.body.type });
      patch.durationMs = dur;
      if (req.body.renew) { patch.activatedAt = now(); patch.expiresAt = now() + dur; }
      else if (req.body.resetTimer) { patch.activatedAt = null; patch.expiresAt = null; }
    }
    if ((req.body.days != null && Number(req.body.days) > 0) || (req.body.hours != null && Number(req.body.hours) > 0)) {
      patch.type = "custom";
      if (req.body.days != null) patch.days = Number(req.body.days) || 0;
      if (req.body.hours != null) patch.hours = Number(req.body.hours) || 0;
      const dur = resolveDurationMs({ days: req.body.days, hours: req.body.hours });
      patch.durationMs = dur;
      if (req.body.renew) { patch.activatedAt = now(); patch.expiresAt = now() + dur; }
      else if (req.body.resetTimer || req.body.renew === false) { patch.activatedAt = null; patch.expiresAt = null; }
    }
    if (req.body.resetTimer === true) { patch.activatedAt = null; patch.expiresAt = null; }
    // تمديد: أيام و/أو مللي ثانية فوق تاريخ الانتهاء الحالي
    let extendBase = null;
    if (req.body.extendMs || req.body.extendDays != null) {
      extendBase = Math.max(Number(s.expiresAt) || now(), now());
      if (req.body.extendDays != null) extendBase += Number(req.body.extendDays) * 24 * 3600 * 1000;
      if (req.body.extendMs) extendBase += Number(req.body.extendMs);
      patch.expiresAt = extendBase;
    }
    await fbPatch(`students/${code}`, patch);
    if (req.body.forceLogout) {
      const sessions = (await fbGet("sessions")) || {};
      for (const [tok, sess] of Object.entries(sessions)) {
        if (sess && sess.code === code) await dropStudentSessionEntry(tok, sess);
      }
    }
    res.json({ success: true, data: { code, ...s, ...patch } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.delete("/api/admin/students/:code", requireAdmin("students_delete"), async (req, res) => {
  try {
    const code = req.params.code;
    const sessions = (await fbGet("sessions")) || {};
    for (const [tok, sess] of Object.entries(sessions)) {
      if (sess && sess.code === code) await dropStudentSessionEntry(tok, sess);
    }
    await fbDelete(`students/${code}`);
    res.json({ success: true });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/admin/students/:code/logout-all", requireAdmin("devices_kick"), async (req, res) => {
  try {
    const code = req.params.code;
    const s = await fbGet(`students/${code}`);
    if (!s) return jsonError(res, 404, "غير موجود");
    const sessions = (await fbGet("sessions")) || {};
    let n = 0;
    for (const [tok, sess] of Object.entries(sessions)) {
      if (sess && sess.code === code) { await dropStudentSessionEntry(tok, sess); n++; }
    }
    if (req.body?.clearDevices) await fbPatch(`students/${code}`, { devices: {} });
    res.json({ success: true, message: `تم تسجيل الخروج من ${n} جلسة`, killed: n });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/admin/students/:code/devices/:deviceId/ban", requireAdmin("devices_kick"), async (req, res) => {
  try {
    const code = req.params.code; const deviceId = String(req.params.deviceId);
    const s = await fbGet(`students/${code}`);
    if (!s) return jsonError(res, 404, "غير موجود");
    const banned = { ...(s.bannedDevices || {}) };
    banned[deviceId] = { bannedAt: now(), by: req.admin.username, reason: String(req.body?.reason || "") };
    const devices = { ...(s.devices || {}) }; delete devices[deviceId];
    await fbPatch(`students/${code}`, { bannedDevices: banned, devices });
    const sessions = (await fbGet("sessions")) || {};
    for (const [tok, sess] of Object.entries(sessions)) {
      if (sess && sess.code === code && sess.deviceId === deviceId) await dropStudentSessionEntry(tok, sess);
    }
    res.json({ success: true, message: "تم حظر الجهاز" });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.delete("/api/admin/students/:code/devices/:deviceId/ban", requireAdmin("devices_kick"), async (req, res) => {
  try {
    const code = req.params.code; const deviceId = String(req.params.deviceId);
    const s = await fbGet(`students/${code}`);
    if (!s) return jsonError(res, 404, "غير موجود");
    const banned = { ...(s.bannedDevices || {}) }; delete banned[deviceId];
    await fbPatch(`students/${code}`, { bannedDevices: banned });
    res.json({ success: true, message: "تم رفع الحظر" });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.delete("/api/admin/students/:code/devices/:deviceId", requireAdmin("devices_kick"), async (req, res) => {
  try {
    const { code, deviceId } = req.params;
    const s = await fbGet(`students/${code}`);
    if (!s) return jsonError(res, 404, "غير موجود");
    const devices = { ...(s.devices || {}) }; delete devices[deviceId];
    await fbSet(`students/${code}/devices`, devices);
    const sessions = (await fbGet("sessions")) || {};
    for (const [tok, sess] of Object.entries(sessions)) {
      if (sess && sess.code === code && sess.deviceId === deviceId) await dropStudentSessionEntry(tok, sess);
    }
    res.json({ success: true, message: "تم تسجيل خروج الجهاز" });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/admin/runtime", requireAdmin("admins_manage"), async (_req, res) => {
  res.json({ success: true, data: { firebaseUrl: runtime.firebaseUrl || "", storageBucket: runtime.storageBucket || getStorageBucket(), firebaseConfigured: Boolean(getFirebaseUrl()), coursatkTokenSet: Boolean(getCoursatkTokenSync()), coursatkTokenMasked: getCoursatkTokenSync() ? getCoursatkTokenSync().slice(0, 12) + "…" + getCoursatkTokenSync().slice(-6) : "", siteName: runtime.siteName, packages: runtime.packages || [], agents: runtime.agents || [] } });
});

app.put("/api/admin/runtime", requireAdmin("admins_manage"), async (req, res) => {
  try {
    const b = req.body || {};
    if (b.firebaseUrl != null) { const url = String(b.firebaseUrl).trim().replace(/\/$/, ""); if (url && !url.startsWith("https://")) return jsonError(res, 400, "رابط Firebase يجب أن يبدأ بـ https://"); runtime.firebaseUrl = url; CONFIG.FIREBASE = url; }
    if (b.coursatkToken != null && String(b.coursatkToken).trim()) { runtime.coursatkToken = String(b.coursatkToken).trim(); CONFIG.COURSATK_TOKEN = runtime.coursatkToken; try { if (getFirebaseUrl()) await fbSet("config/coursatkToken", runtime.coursatkToken); } catch {} }
    if (b.siteName != null) runtime.siteName = String(b.siteName).trim() || "ثانوية World";
    if (Array.isArray(b.packages)) runtime.packages = b.packages.map((p) => ({ id: String(p.id || "").trim() || ("pkg_" + Date.now()), name: String(p.name || "").trim() || "باقة", price: Number(p.price) || 0, days: Math.max(0, Number(p.days) || 0), hours: Math.max(0, Number(p.hours) || 0), active: p.active !== false }));
    if (Array.isArray(b.agents)) runtime.agents = b.agents.map((a) => ({ id: String(a.id || ("ag_" + Math.random().toString(36).slice(2, 8))), name: String(a.name || "").trim(), telegram: String(a.telegram || "").trim().replace(/^@/, ""), active: a.active !== false })).filter((a) => a.name);
    saveRuntimeFile(); cacheDel("fb:site"); cacheDel("subjects:");
    try { if (getFirebaseUrl()) { await fbSet("site/packages", runtime.packages); await fbSet("site/agents", runtime.agents); await fbSet("site/name", runtime.siteName); } } catch (e) { console.warn("[runtime] fb mirror:", e.message); }
    res.json({ success: true, message: "تم حفظ الإعدادات", data: { firebaseConfigured: Boolean(getFirebaseUrl()) } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.put("/api/admin/packages", requireAdmin("sections_manage"), async (req, res) => {
  try {
    if (!Array.isArray(req.body?.packages)) return jsonError(res, 400, "packages array required");
    runtime.packages = req.body.packages.map((p) => ({ id: String(p.id || "").trim() || ("pkg_" + Date.now()), name: String(p.name || "").trim() || "باقة", price: Number(p.price) || 0, days: Math.max(0, Number(p.days) || 0), hours: Math.max(0, Number(p.hours) || 0), active: p.active !== false }));
    saveRuntimeFile(); try { if (getFirebaseUrl()) await fbSet("site/packages", runtime.packages); } catch {}
    res.json({ success: true, data: runtime.packages });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.put("/api/admin/agents", requireAdmin("sections_manage"), async (req, res) => {
  try {
    if (!Array.isArray(req.body?.agents)) return jsonError(res, 400, "agents array required");
    runtime.agents = req.body.agents.map((a) => ({ id: String(a.id || ("ag_" + Math.random().toString(36).slice(2, 8))), name: String(a.name || "").trim(), telegram: String(a.telegram || "").trim().replace(/^@/, ""), active: a.active !== false })).filter((a) => a.name);
    saveRuntimeFile(); try { if (getFirebaseUrl()) await fbSet("site/agents", runtime.agents); } catch {}
    res.json({ success: true, data: runtime.agents });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/admin/sections", requireAdmin("sections_manage"), async (_req, res) => {
  try { const all = (await fbGet("sections")) || {}; const list = Object.entries(all).map(([id, s]) => ({ id, ...s })); res.json({ success: true, data: list }); } catch (e) { jsonError(res, 500, e.message); }
});

app.put("/api/admin/sections/:id", requireAdmin("sections_manage"), async (req, res) => {
  try {
    const id = String(req.params.id).trim().replace(/[^\w\u0600-\u06FF\-]/g, "_");
    const name = String(req.body?.name || id).trim();
    const yearId = Number(req.body?.yearId || CONFIG.DEFAULT_YEAR_ID);
    const subjectIds = Array.isArray(req.body?.subjectIds) ? req.body.subjectIds.map(Number).filter((n) => !Number.isNaN(n)) : [];
    const record = { name, yearId, subjectIds, updatedAt: now() };
    await fbSet(`sections/${id}`, record);
    res.json({ success: true, data: { id, ...record } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.delete("/api/admin/sections/:id", requireAdmin("sections_manage"), async (req, res) => {
  try { await fbDelete(`sections/${req.params.id}`); res.json({ success: true }); } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/admin/admins", requireAdmin("admins_manage"), async (_req, res) => {
  try {
    const all = (await fbGet("admins")) || {};
    const list = Object.entries(all).map(([id, a]) => ({ id, username: a.username, permissions: a.permissions || {}, active: a.active !== false, createdAt: a.createdAt || null }));
    res.json({ success: true, data: [{ id: "bootstrap", username: CONFIG.BOOTSTRAP_ADMIN.username, permissions: CONFIG.BOOTSTRAP_ADMIN.permissions, active: true, bootstrap: true }, ...list] });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/admin/admins", requireAdmin("admins_manage"), async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (!username || username.length < 3) return jsonError(res, 400, "يوزر غير صالح");
    if (!password || password.length < 6) return jsonError(res, 400, "باسورد قصير");
    if (username === CONFIG.BOOTSTRAP_ADMIN.username) return jsonError(res, 409, "اسم محجوز");
    const all = (await fbGet("admins")) || {};
    for (const a of Object.values(all)) { if (a && a.username === username) return jsonError(res, 409, "اليوزر موجود"); }
    const permissions = { students_view: !!req.body?.permissions?.students_view, students_create: !!req.body?.permissions?.students_create, students_edit: !!req.body?.permissions?.students_edit, students_delete: !!req.body?.permissions?.students_delete, devices_kick: !!req.body?.permissions?.devices_kick, sections_manage: !!req.body?.permissions?.sections_manage, admins_manage: !!req.body?.permissions?.admins_manage };
    const id = crypto.randomUUID();
    const record = { username, passwordHash: scryptHash(password), permissions, active: true, createdAt: now(), createdBy: req.admin.username };
    await fbSet(`admins/${id}`, record);
    res.json({ success: true, data: { id, username, permissions, active: true } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.patch("/api/admin/admins/:id", requireAdmin("admins_manage"), async (req, res) => {
  try {
    if (req.params.id === "bootstrap") return jsonError(res, 400, "لا يمكن تعديل الأدمن الأساسي من هنا");
    const a = await fbGet(`admins/${req.params.id}`);
    if (!a) return jsonError(res, 404, "غير موجود");
    const patch = {};
    if (req.body.password) patch.passwordHash = scryptHash(String(req.body.password));
    if (req.body.permissions) patch.permissions = { students_view: !!req.body.permissions.students_view, students_create: !!req.body.permissions.students_create, students_edit: !!req.body.permissions.students_edit, students_delete: !!req.body.permissions.students_delete, devices_kick: !!req.body.permissions.devices_kick, sections_manage: !!req.body.permissions.sections_manage, admins_manage: !!req.body.permissions.admins_manage };
    if (req.body.active != null) patch.active = Boolean(req.body.active);
    await fbPatch(`admins/${req.params.id}`, patch);
    res.json({ success: true });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.delete("/api/admin/admins/:id", requireAdmin("admins_manage"), async (req, res) => {
  try { if (req.params.id === "bootstrap") return jsonError(res, 400, "لا يمكن حذف الأدمن الأساسي"); await fbDelete(`admins/${req.params.id}`); res.json({ success: true }); } catch (e) { jsonError(res, 500, e.message); }
});

function makeMsgId() { return "m_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8); }
function studentCode(req) { const c = String(req.student?.code || req.session?.code || "").trim(); if (!/^\d{7,12}$/.test(c)) return null; return c; }

const MEDIA_MAX_BYTES = 12 * 1024 * 1024;
const MEDIA_ALLOWED = { image: new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]), audio: new Set(["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/aac", "audio/mp3"]) };
function detectMediaKind(mime) { const m = String(mime || "").toLowerCase().split(";")[0].trim(); if (MEDIA_ALLOWED.image.has(m) || m.startsWith("image/")) return "image"; if (MEDIA_ALLOWED.audio.has(m) || m.startsWith("audio/")) return "audio"; return null; }
function extFromMime(mime) { const m = String(mime || "").toLowerCase().split(";")[0].trim(); const map = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "audio/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "audio/x-wav": "wav", "audio/aac": "aac" }; return map[m] || "bin"; }

function saveMediaFile(code, msgId, media) {
  if (!media) return null;
  let mime = String(media.mime || media.type || "").toLowerCase();
  let b64 = media.data || media.base64 || "";
  if (typeof b64 !== "string" || !b64) return null;
  const dataUrl = b64.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrl) { mime = dataUrl[1].toLowerCase(); b64 = dataUrl[2]; }
  b64 = b64.replace(/\s/g, "");
  const kind = detectMediaKind(mime);
  if (!kind) throw new Error("نوع الملف غير مدعوم (صور: jpg/png/webp — صوت: webm/ogg/mp3/wav)");
  let buf;
  try { buf = Buffer.from(b64, "base64"); } catch { throw new Error("بيانات الملف غير صالحة"); }
  if (!buf.length) throw new Error("الملف فاضي");
  if (buf.length > MEDIA_MAX_BYTES) throw new Error("حجم الملف كبير (الحد 12 ميجا)");
  const mimeClean = mime.split(";")[0].trim();
  const dir = path.join(MEDIA_DIR, String(code));
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${msgId}.${extFromMime(mimeClean)}`;
  const full = path.join(dir, fileName);
  fs.writeFileSync(full, buf);
  return { kind, mime: mimeClean, size: buf.length, fileName, url: `/api/media/${encodeURIComponent(code)}/${encodeURIComponent(fileName)}`, storage: "local", duration: media.duration != null ? Number(media.duration) : null };
}

function deleteMediaFile(code, fileName) {
  if (!code || !fileName) return;
  const safe = path.basename(String(fileName));
  const full = path.join(MEDIA_DIR, String(code), safe);
  try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch {}
}

function guestThreadKey(guestId) { const id = String(guestId || "").replace(/[^a-zA-Z0-9_\-]/g, "").slice(0, 64); if (id.length < 8) return null; return "guest_" + id; }

app.post("/api/public/contact", rateLimit({ max: 12, windowMs: 60_000, scope: "public-contact" }), async (req, res) => {
  try {
    const guestId = String(req.body?.guestId || "").trim();
    const key = guestThreadKey(guestId);
    if (!key) return jsonError(res, 400, "guestId مطلوب (8 أحرف على الأقل)");
    const name = String(req.body?.name || "زائر").trim().slice(0, 80) || "زائر";
    const phone = String(req.body?.phone || "").trim().slice(0, 30);
    const text = String(req.body?.text || "").trim().slice(0, 2000);
    const id = makeMsgId();
    let mediaMeta = null;
    if (req.body?.media) { try { mediaMeta = saveMediaFile(key, id, req.body.media); } catch (e) { return jsonError(res, 400, e.message); } }
    if (!text && !mediaMeta) return jsonError(res, 400, "اكتب رسالة أو أرسل صورة/تسجيل");
    const msg = { from: "guest", type: mediaMeta ? mediaMeta.kind : "text", text: text || (mediaMeta?.kind === "image" ? "📷 صورة" : mediaMeta?.kind === "audio" ? "🎤 رسالة صوتية" : ""), name, phone: phone || null, ownerCode: key, guest: true, createdAt: now(), read: false };
    if (mediaMeta) { msg.mediaUrl = mediaMeta.url; msg.mime = mediaMeta.mime; msg.size = mediaMeta.size; msg.fileName = mediaMeta.fileName; msg.storage = mediaMeta.storage || "local"; if (mediaMeta.duration) msg.duration = mediaMeta.duration; }
    await fbSet(`messages/${key}/messages/${id}`, msg);
    const cur = (await fbGet(`messages/${key}`)) || {};
    await fbPatch(`messages/${key}`, { updatedAt: now(), studentName: name, section: "guest", ownerCode: key, guest: true, phone: phone || cur.phone || null, unreadAdmin: Number(cur.unreadAdmin || 0) + 1, unreadStudent: 0 });
    res.json({ success: true, data: { id, guestId, threadKey: key, ...msg } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.patch("/api/public/contact/:guestId/messages/:msgId", rateLimit({ max: 30, windowMs: 60_000, scope: "public-contact-edit" }), async (req, res) => {
  try {
    const key = guestThreadKey(req.params.guestId);
    const msgId = String(req.params.msgId || "").trim();
    if (!key || !msgId) return jsonError(res, 400, "طلب غير صالح");
    const text = String(req.body?.text || "").trim().slice(0, 2000);
    const msg = await fbGet(`messages/${key}/messages/${msgId}`);
    if (!msg) return jsonError(res, 404, "الرسالة غير موجودة");
    if (msg.from !== "guest" && msg.from !== "student") return jsonError(res, 403, "تقدر تعدّل رسائلك أنت بس");
    const ty = msg.type || "text";
    if (ty === "text" && !text) return jsonError(res, 400, "الرسالة مينفعش تبقى فاضية");
    const editedAt = now();
    const patch = { text: text || (ty === "image" ? "📷 صورة" : ty === "audio" ? "🎤 رسالة صوتية" : msg.text || ""), editedAt };
    await fbPatch(`messages/${key}/messages/${msgId}`, patch);
    const updated = { ...msg, id: msgId, ...patch };
    notifyThread(key, "message", { message: updated });
    res.json({ success: true, data: updated });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/public/contact/:guestId", rateLimit({ max: 40, windowMs: 60_000, scope: "public-contact-get" }), async (req, res) => {
  try {
    const key = guestThreadKey(req.params.guestId);
    if (!key) return jsonError(res, 400, "guestId غير صالح");
    const thread = (await fbGet(`messages/${key}`)) || { messages: {} };
    const list = Object.entries(thread.messages || {}).map(([id, m]) => ({ id, ...m })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    try { await fbPatch(`messages/${key}`, { unreadStudent: 0 }); } catch {}
    res.json({ success: true, data: { guestId: String(req.params.guestId), threadKey: key, name: thread.studentName || "زائر", messages: list, unread: Number(thread.unreadStudent || 0) } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/messages", requireStudent, async (req, res) => {
  try {
    const code = studentCode(req);
    if (!code) return jsonError(res, 401, "كود الجلسة غير صالح");
    const thread = (await fbGet(`messages/${code}`)) || { messages: {}, updatedAt: 0 };
    const list = Object.entries(thread.messages || {}).map(([id, m]) => ({ id, ...m })).filter((m) => !m.ownerCode || m.ownerCode === code).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    res.json({ success: true, data: { code, messages: list, unreadStudent: Number(thread.unreadStudent || 0), unreadAdmin: Number(thread.unreadAdmin || 0) } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/messages/stream", requireStudent, rateLimit({ max: 20, windowMs: 60_000, scope: "sse-student" }), async (req, res) => {
  try {
    const code = studentCode(req);
    if (!code) return jsonError(res, 401, "كود الجلسة غير صالح");
    openSse(req, res);
    try { subscribeMessages(msgSubKey("student", code), res, { role: "student", code }); } catch (e) { return res.status(e.status || 503).end(); }
    try { const thread = (await fbGet(`messages/${code}`)) || {}; res.write(`event: snapshot\ndata: ${JSON.stringify({ code, unreadStudent: Number(thread.unreadStudent || 0), unreadAdmin: Number(thread.unreadAdmin || 0), updatedAt: thread.updatedAt || 0 })}\n\n`); } catch {}
  } catch (e) { if (!res.headersSent) jsonError(res, 500, e.message); }
});

app.post("/api/messages", requireStudent, rateLimit({ max: 60, windowMs: 60_000, scope: "msg-student" }), async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim().slice(0, 2000);
    const code = studentCode(req);
    if (!code) return jsonError(res, 401, "كود الجلسة غير صالح");
    const id = makeMsgId();
    let mediaMeta = null;
    if (req.body?.media) { try { mediaMeta = saveMediaFile(code, id, req.body.media); } catch (e) { return jsonError(res, 400, e.message); } }
    if (!text && !mediaMeta) return jsonError(res, 400, "اكتب رسالة أو أرسل صورة/تسجيل");
    const msg = { from: "student", type: mediaMeta ? mediaMeta.kind : "text", text: text || (mediaMeta?.kind === "image" ? "📷 صورة" : mediaMeta?.kind === "audio" ? "🎤 رسالة صوتية" : ""), name: req.student.name || code, ownerCode: code, createdAt: now(), read: false };
    if (mediaMeta) { msg.mediaUrl = mediaMeta.url; msg.mime = mediaMeta.mime; msg.size = mediaMeta.size; msg.fileName = mediaMeta.fileName; msg.storage = mediaMeta.storage || "local"; if (mediaMeta.duration) msg.duration = mediaMeta.duration; }
    await fbSet(`messages/${code}/messages/${id}`, msg);
    const cur = (await fbGet(`messages/${code}`)) || {};
    await fbPatch(`messages/${code}`, { updatedAt: now(), studentName: req.student.name || code, section: req.student.section || null, ownerCode: code, unreadAdmin: Number(cur.unreadAdmin || 0) + 1, unreadStudent: 0 });
    const out = { id, ...msg };
    notifyThread(code, "message", { message: out });
    res.json({ success: true, data: out });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/messages/:msgId/react", requireStudent, rateLimit({ max: 120, windowMs: 60_000, scope: "msg-react" }), async (req, res) => {
  try {
    const code = studentCode(req);
    if (!code) return jsonError(res, 401, "كود الجلسة غير صالح");
    const msgId = String(req.params.msgId);
    const emoji = String(req.body?.emoji || "").trim().slice(0, 8);
    if (!emoji) return jsonError(res, 400, "emoji مطلوب");
    const msg = await fbGet(`messages/${code}/messages/${msgId}`);
    if (!msg) return jsonError(res, 404, "الرسالة غير موجودة");
    const reactions = Object.assign({}, msg.reactions || {});
    const who = "s:" + code;
    if (reactions[who] === emoji) delete reactions[who]; else reactions[who] = emoji;
    await fbSet(`messages/${code}/messages/${msgId}/reactions`, reactions);
    const updated = { ...msg, id: msgId, reactions };
    notifyThread(code, "reaction", { messageId: msgId, reactions });
    res.json({ success: true, data: { id: msgId, reactions } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/admin/messages/:code/:msgId/react", requireAdmin("students_view"), rateLimit({ max: 200, windowMs: 60_000, scope: "msg-react-a" }), async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    const msgId = String(req.params.msgId);
    const emoji = String(req.body?.emoji || "").trim().slice(0, 8);
    if (!code || !emoji) return jsonError(res, 400, "بيانات ناقصة");
    const msg = await fbGet(`messages/${code}/messages/${msgId}`);
    if (!msg) return jsonError(res, 404, "الرسالة غير موجودة");
    const reactions = Object.assign({}, msg.reactions || {});
    const who = "a:" + ((req.admin && req.admin.username) || "admin");
    if (reactions[who] === emoji) delete reactions[who]; else reactions[who] = emoji;
    await fbSet(`messages/${code}/messages/${msgId}/reactions`, reactions);
    notifyThread(code, "reaction", { messageId: msgId, reactions });
    res.json({ success: true, data: { id: msgId, reactions } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.patch("/api/messages/:msgId", requireStudent, rateLimit({ max: 60, windowMs: 60_000, scope: "msg-edit" }), async (req, res) => {
  try {
    const code = studentCode(req);
    if (!code) return jsonError(res, 401, "كود الجلسة غير صالح");
    const msgId = String(req.params.msgId || "").trim();
    if (!msgId) return jsonError(res, 400, "معرّف الرسالة مطلوب");
    const text = String(req.body?.text || "").trim().slice(0, 2000);
    const msg = await fbGet(`messages/${code}/messages/${msgId}`);
    if (!msg) return jsonError(res, 404, "الرسالة غير موجودة");
    if (msg.from && msg.from !== "student" && msg.from !== "guest") return jsonError(res, 403, "تقدر تعدّل رسائلك أنت بس");
    if (msg.ownerCode && msg.ownerCode !== code) return jsonError(res, 403, "غير مصرح");
    const ty = msg.type || "text";
    if (ty === "text" && !text) return jsonError(res, 400, "الرسالة مينفعش تبقى فاضية");
    const editedAt = now();
    const patch = { text: text || (ty === "image" ? "📷 صورة" : ty === "audio" ? "🎤 رسالة صوتية" : msg.text || ""), editedAt };
    await fbPatch(`messages/${code}/messages/${msgId}`, patch);
    const updated = { ...msg, id: msgId, ...patch };
    notifyThread(code, "message", { message: updated });
    res.json({ success: true, data: updated });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.patch("/api/admin/messages/:code/:msgId", requireAdmin("students_view"), rateLimit({ max: 80, windowMs: 60_000, scope: "msg-edit-a" }), async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    const msgId = String(req.params.msgId || "").trim();
    const text = String(req.body?.text || "").trim().slice(0, 2000);
    if (!code || !msgId) return jsonError(res, 400, "بيانات ناقصة");
    const msg = await fbGet(`messages/${code}/messages/${msgId}`);
    if (!msg) return jsonError(res, 404, "الرسالة غير موجودة");
    if (msg.from !== "admin") return jsonError(res, 403, "تعدّل رسائل الأدمن فقط من هنا");
    if (!text && (msg.type || "text") === "text") return jsonError(res, 400, "الرسالة مينفعش تبقى فاضية");
    const editedAt = now();
    const patch = { text: text || msg.text, editedAt };
    await fbPatch(`messages/${code}/messages/${msgId}`, patch);
    const updated = { ...msg, id: msgId, ...patch };
    notifyThread(code, "message", { message: updated });
    res.json({ success: true, data: updated });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/messages/read", requireStudent, async (req, res) => {
  try { const code = studentCode(req); if (!code) return jsonError(res, 401, "كود الجلسة غير صالح"); await fbPatch(`messages/${code}`, { unreadStudent: 0 }); notifyThread(code, "read", { by: "student" }); res.json({ success: true }); } catch (e) { jsonError(res, 500, e.message); }
});

app.delete("/api/messages/:msgId", requireStudent, async (req, res) => {
  try {
    const code = studentCode(req);
    if (!code) return jsonError(res, 401, "كود الجلسة غير صالح");
    const msgId = String(req.params.msgId);
    const msg = await fbGet(`messages/${code}/messages/${msgId}`);
    if (!msg) return jsonError(res, 404, "الرسالة غير موجودة");
    if (msg.fileName) deleteMediaFile(code, msg.fileName);
    await fbDelete(`messages/${code}/messages/${msgId}`);
    notifyThread(code, "deleted", { id: msgId });
    res.json({ success: true, message: "تم حذف الرسالة" });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.delete("/api/messages", requireStudent, async (req, res) => {
  try { const code = studentCode(req); if (!code) return jsonError(res, 401, "كود الجلسة غير صالح"); await fbDelete(`messages/${code}`); notifyThread(code, "cleared", {}); res.json({ success: true, message: "تم مسح المحادثة" }); } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/admin/messages/:code/stream", requireAdmin("students_view"), rateLimit({ max: 30, windowMs: 60_000, scope: "sse-admin-th" }), async (req, res) => {
  try { const code = String(req.params.code || "").trim(); if (!code) return jsonError(res, 400, "كود غير صالح"); openSse(req, res); subscribeMessages(msgSubKey("admin", code), res, { role: "admin", code }); } catch (e) { if (!res.headersSent) jsonError(res, 500, e.message); }
});

app.get("/api/admin/messages/stream", requireAdmin("students_view"), rateLimit({ max: 20, windowMs: 60_000, scope: "sse-admin-inbox" }), async (req, res) => {
  try { openSse(req, res); subscribeMessages(msgSubKey("admin-inbox"), res, { role: "admin-inbox" }); } catch (e) { if (!res.headersSent) jsonError(res, 500, e.message); }
});

app.get("/api/admin/messages", requireAdmin("students_view"), async (_req, res) => {
  try {
    const all = (await fbGet("messages")) || {};
    const threads = Object.entries(all).filter(([code]) => { if (!code || code === "undefined") return false; if (/^\d{7,12}$/.test(String(code))) return true; if (String(code).startsWith("guest_")) return true; return false; }).map(([code, t]) => {
      const msgs = Object.values(t.messages || {});
      const last = msgs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
      return { code, studentName: t.studentName || code, section: t.section || null, updatedAt: t.updatedAt || last?.createdAt || 0, unreadAdmin: Number(t.unreadAdmin || 0), lastMessage: last ? { text: last.text, type: last.type || 'text', from: last.from, createdAt: last.createdAt, mediaUrl: last.mediaUrl || null } : null, count: msgs.length };
    }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json({ success: true, data: threads });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/admin/messages/:code", requireAdmin("students_view"), async (req, res) => {
  try {
    const code = String(req.params.code);
    const thread = (await fbGet(`messages/${code}`)) || { messages: {} };
    const list = Object.entries(thread.messages || {}).map(([id, m]) => ({ id, ...m })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    await fbPatch(`messages/${code}`, { unreadAdmin: 0 });
    res.json({ success: true, data: { code, studentName: thread.studentName || code, messages: list } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/admin/messages/:code", requireAdmin("students_view"), rateLimit({ max: 120, windowMs: 60_000, scope: "msg-admin" }), async (req, res) => {
  try {
    const rawCode = String(req.params.code || "");
    const code = rawCode.startsWith("guest_") ? guestThreadKey(rawCode.slice(6)) : rawCode.replace(/\D/g, "");
    if (!code) return jsonError(res, 400, "كود غير صالح");
    const text = String(req.body?.text || "").trim().slice(0, 2000);
    const id = makeMsgId();
    let mediaMeta = null;
    if (req.body?.media) { try { mediaMeta = saveMediaFile(code, id, req.body.media); } catch (e) { return jsonError(res, 400, e.message); } }
    if (!text && !mediaMeta) return jsonError(res, 400, "اكتب رد أو أرسل صورة/تسجيل");
    const msg = { from: "admin", type: mediaMeta ? mediaMeta.kind : "text", text: text || (mediaMeta?.kind === "image" ? "📷 صورة" : mediaMeta?.kind === "audio" ? "🎤 رسالة صوتية" : ""), name: req.admin.username || "أدمن", ownerCode: code, createdAt: now(), read: false };
    if (mediaMeta) { msg.mediaUrl = mediaMeta.url; msg.mime = mediaMeta.mime; msg.size = mediaMeta.size; msg.fileName = mediaMeta.fileName; msg.storage = mediaMeta.storage || "local"; if (mediaMeta.duration) msg.duration = mediaMeta.duration; }
    await fbSet(`messages/${code}/messages/${id}`, msg);
    const cur = (await fbGet(`messages/${code}`)) || {};
    await fbPatch(`messages/${code}`, { updatedAt: now(), unreadStudent: Number(cur.unreadStudent || 0) + 1, unreadAdmin: 0, studentName: cur.studentName || code });
    const out = { id, ...msg };
    notifyThread(code, "message", { message: out });
    res.json({ success: true, data: out });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.delete("/api/admin/messages/:code/:msgId", requireAdmin("students_view"), async (req, res) => {
  try {
    const code = String(req.params.code).trim();
    const msgId = String(req.params.msgId);
    const msg = await fbGet(`messages/${code}/messages/${msgId}`);
    if (msg?.fileName) deleteMediaFile(code, msg.fileName);
    await fbDelete(`messages/${code}/messages/${msgId}`);
    notifyThread(code, "deleted", { id: msgId });
    res.json({ success: true, message: "تم حذف الرسالة" });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.delete("/api/admin/messages/:code", requireAdmin("students_view"), async (req, res) => {
  try { const code = String(req.params.code).trim(); await fbDelete(`messages/${code}`); notifyThread(code, "cleared", {}); res.json({ success: true, message: "تم حذف المحادثة" }); } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/media/:code/:file", async (req, res) => {
  try {
    let code = String(req.params.code || "");
    if (code.startsWith("guest_")) code = code.replace(/[^a-zA-Z0-9_\-]/g, "");
    else code = code.replace(/\D/g, "");
    const file = path.basename(String(req.params.file || ""));
    if (!code || !file || file.includes("..")) return jsonError(res, 400, "طلب غير صالح");
    const token = getBearer(req) || String(req.query.token || "").trim();
    const isGuestPath = code.startsWith("guest_");
    let allowed = false;
    if (isGuestPath) { const gid = String(req.query.guestId || "").replace(/[^a-zA-Z0-9_\-]/g, ""); if (gid && ("guest_" + gid) === code) allowed = true; }
    if (token) {
      const stu = studentSessions.get(token);
      if (stu && String(stu.code) === code) allowed = true;
      if (!allowed && adminSessions.get(token)) allowed = true;
      if (!allowed) { try { const remote = await fbGet(`sessions/${sessionStoreKey(token)}`); if (remote && String(remote.code) === code) allowed = true; } catch {} }
    }
    if (!allowed) return jsonError(res, 403, "غير مصرح");
    const full = path.join(MEDIA_DIR, code, file);
    if (!fs.existsSync(full)) return jsonError(res, 404, "الملف غير موجود");
    const ext = path.extname(file).toLowerCase();
    const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".webm": "audio/webm", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".aac": "audio/aac" };
    res.setHeader("Content-Type", mimeMap[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Content-Disposition", `inline; filename="${file}"`);
    fs.createReadStream(full).pipe(res);
  } catch (e) { jsonError(res, 500, e.message); }
});

const SW = "https://api.stream-weave.com";

function b64urlEncode(value) {
  var buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlDecode(value) {
  var s = String(value).replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString("utf8");
}
function joinRel(base, rel) {
  var q = ""; var relPath = String(rel);
  var qi = relPath.indexOf("?");
  if (qi !== -1) { q = relPath.slice(qi); relPath = relPath.slice(0, qi); }
  var stack = String(base || "").split("/");
  if (stack.length && stack[stack.length - 1] !== "" && /\.[a-z0-9]+$/i.test(stack[stack.length - 1])) stack.pop();
  if (stack.length && stack[stack.length - 1] === "") stack.pop();
  relPath.split("/").forEach(function (part) {
    if (!part || part === ".") return;
    if (part === "..") stack.pop(); else stack.push(part);
  });
  return stack.join("/") + q;
}
async function fetchFollow(url, hdrs, left) {
  if (left == null) left = 5;
  var res = await fetch(url, { headers: hdrs, redirect: "manual" });
  if ([301, 302, 303, 307, 308].indexOf(res.status) !== -1 && left > 0) {
    var loc = res.headers.get("location");
    if (!loc) return res;
    try { if (res.body && res.body.cancel) await res.body.cancel(); else await res.arrayBuffer(); } catch (e) {}
    var next = new URL(loc, url).href;
    var nextHeaders = Object.assign({}, hdrs);
    if (new URL(next).host !== new URL(url).host) delete nextHeaders.Authorization;
    return fetchFollow(next, nextHeaders, left - 1);
  }
  return res;
}
function pipeUpstream(res, upstream, buf) {
  var ct = upstream.headers.get("content-type") || "application/octet-stream";
  res.set("Content-Type", ct);
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");
  var cr = upstream.headers.get("content-range");
  if (cr) res.set("Content-Range", cr);
  res.status(upstream.status).send(buf);
}

app.get("/api/cdn", async function (req, res) {
  try {
    var target = req.query.url || "";
    if (req.query.u) target = b64urlDecode(String(req.query.u));
    if (!target) return res.status(400).send("missing url");
    var hdrs = {
      Origin: "https://coursatk.online",
      Referer: "https://coursatk.online/",
      Accept: "*/*",
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
    };
    if (req.headers.range) hdrs.Range = req.headers.range;
    var upstream = await fetchFollow(target, hdrs);
    var buf = Buffer.from(await upstream.arrayBuffer());
    res.set("Cache-Control", "public, max-age=30");
    pipeUpstream(res, upstream, buf);
  } catch (e) { res.status(502).send("cdn error: " + e.message); }
});

app.get("/api/stream", async function (req, res) {
  try {
    var swPath = (req.query.path || "").replace(/^\/+/, "");
    var token = req.query.t;
    if (!token || !swPath) return res.status(400).json({ error: "missing path or token" });

    var url = SW + "/api/v1/" + swPath;
    var hdrs = {
      Origin: "https://coursatk.online",
      Referer: "https://coursatk.online/",
      Accept: "*/*",
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      Authorization: "Bearer " + token
    };
    if (req.headers.range) hdrs.Range = req.headers.range;
    var upstream = await fetchFollow(url, hdrs);

    var ct = upstream.headers.get("content-type") || "application/octet-stream";
    var isM3u8 = ct.indexOf("mpegurl") !== -1 || ct.indexOf("m3u8") !== -1 || swPath.indexOf(".m3u8") !== -1;

    if (isM3u8) {
      var text = await upstream.text();
      var base = swPath.indexOf("/") !== -1 ? swPath.substring(0, swPath.lastIndexOf("/") + 1) : "";
      text = text.split("\n").map(function (line) {
        var s = line.trim();
        if (!s) return line;
        if (s.charAt(0) === "#") {
          return s.replace(/URI="([^"]+)"/g, function (_m, uri) {
            if (uri.indexOf("http") === 0) return 'URI="/api/cdn?u=' + b64urlEncode(uri) + '"';
            var clean = uri.charAt(0) === "/" ? uri.slice(1) : uri;
            clean = clean.replace(/^api\/v1\//, "");
            if (clean.indexOf("videos/") !== 0) clean = joinRel(base, clean);
            return 'URI="/api/stream?path=' + encodeURIComponent(clean) + "&t=" + encodeURIComponent(token) + '"';
          });
        }
        if (s.indexOf("http") === 0) {
          try {
            var pu = new URL(s);
            var parts = pu.pathname.split("/").filter(Boolean);
            var vi = parts.indexOf("videos");
            if (vi >= 0 && parts.length >= vi + 3) {
              var vid = parts[vi + 1]; var quality = parts[vi + 2]; var fname = (parts[vi + 3] || "").split("?")[0];
              if (vid && quality && fname) return "/api/stream?path=" + encodeURIComponent("videos/" + vid + "/stream/" + quality + "/" + fname) + "&t=" + encodeURIComponent(token);
            }
          } catch (e) {}
          return "/api/cdn?u=" + b64urlEncode(s);
        }
        return "/api/stream?path=" + encodeURIComponent(joinRel(base, s)) + "&t=" + encodeURIComponent(token);
      }).join("\n");

      res.set("Content-Type", "application/vnd.apple.mpegurl");
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "no-store");
      return res.status(upstream.status).send(text);
    }

    var buf = Buffer.from(await upstream.arrayBuffer());
    res.set("Cache-Control", "no-store");
    pipeUpstream(res, upstream, buf);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post("/api/video/:id/play", async function (req, res) {
  const r = await upstreamJson(`/video/${req.params.id}/stream-weave/play`, {
    method: "POST",
    headers: { "Content-Length": "0" },
    body: "",
  });
  res.status(200).json(r);
});

// ==================== taleb.pro endpoints ====================

/** جلب المدرسين من taleb.pro */
app.get("/api/taleb/teachers", requireStudent, async (req, res) => {
  try {
    const teachers = await getTalebTeachers();
    res.json({ success: true, data: teachers });
  } catch (e) {
    console.error("[taleb teachers]", e.message);
    jsonError(res, 502, "فشل جلب المدرسين من taleb.pro: " + e.message);
  }
});

/** جلب playlist لـ partId مباشرة */
app.get("/api/taleb/playlist/:partId", requireStudent, async (req, res) => {
  try {
    const partId = String(req.params.partId || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(partId)) return jsonError(res, 400, "partId غير صالح");
    const text = await getTalebPlaylist(partId);
    res.type("application/vnd.apple.mpegurl").send(text);
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

/** تشغيل فيديو taleb مباشرة بـ partId (بدون حاجة لـ /api/play/taleb_{uuid}) */
app.post("/api/taleb/play/:partId", requireStudent, playLimiter, async (req, res) => {
  try {
    const partId = String(req.params.partId || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(partId)) return jsonError(res, 400, "partId (UUID) غير صالح");

    const videoId = `taleb_${partId}`;
    checkPlayBurst(req.session && req.session.code, videoId);
    logPlayEvent(req, videoId).catch(() => {});

    assertPlayerOrigin(req);
    const src = await getVideoSource(videoId, req.headers);

    try {
      const secure = (req.secure || req.headers["x-forwarded-proto"] === "https") ? "; Secure" : "";
      res.setHeader("Set-Cookie", `ds_session=${encodeURIComponent(req.sessionToken)}; Path=/; HttpOnly; SameSite=None${secure}; Max-Age=${7 * 24 * 3600}`);
    } catch {}

    const id = crypto.randomUUID().replace(/-/g, "");
    const streamKey = crypto.randomBytes(16).toString("hex");
    const deviceId = (req.session && req.session.deviceId) || null;
    revokeOtherSessions(req.session.code, src.videoId, id);

    const sessionRow = {
      id, src,
      videoId: src.videoId,
      shared: false,
      ownerCode: req.session.code,
      ownerToken: req.sessionToken,
      ownerDeviceId: deviceId,
      streamKey,
      createdAt: now(),
      lastUsed: now()
    };
    streamSessions.set(id, sessionRow);
    const hlsPath = `/api/hls/${id}/master.m3u8?sk=${streamKey}`;
    res.json({ success: true, data: { play_url: hlsPath, manifest_url: hlsPath, shared: false, partId, videoId } });
  } catch (be) {
    jsonError(res, be.status || 502, be.message);
  }
});

/** تحديث كوكيز taleb.pro من لوحة الأدمن */
app.put("/api/admin/taleb/cookies", requireAdmin("admins_manage"), async (req, res) => {
  try {
    const device = String(req.body?.device || "").trim();
    const session = String(req.body?.session || "").trim();
    if (!device || !session) return jsonError(res, 400, "device و session مطلوبان");
    updateTalebCookies(device, session);
    // احفظهم في Firebase للاستمرارية
    try {
      await fbSet("config/taleb_cookies", { device, session, updatedAt: now(), updatedBy: req.admin.username });
    } catch (e) { console.warn("[taleb cookies] fb save:", e.message); }
    res.json({ success: true, message: "تم تحديث كوكيز taleb.pro" });
  } catch (e) { jsonError(res, 500, e.message); }
});

/** جلب حالة كوكيز taleb */
app.get("/api/admin/taleb/status", requireAdmin(null), async (_req, res) => {
  try {
    const device = process.env.TALEB_DEVICE || "";
    const session = process.env.TALEB_SESSION || "";
    // اختبر بطلب notifications
    let alive = false;
    let error = null;
    try {
      const r = await fetch("https://talep.pro/api/notifications", {
        headers: {
          "user-agent": "Mozilla/5.0",
          "cookie": `taleb-device=${device}; taleb-session=${session}`,
          "accept": "*/*"
        },
        signal: AbortSignal.timeout(8000)
      });
      alive = r.ok;
      if (!r.ok) error = `HTTP ${r.status}`;
    } catch (e) { error = e.message; }
    res.json({
      success: true,
      data: {
        deviceSet: Boolean(device),
        sessionSet: Boolean(session),
        devicePrefix: device ? device.slice(0, 12) + "…" : null,
        sessionPrefix: session ? session.slice(0, 20) + "…" : null,
        alive,
        error
      }
    });
  } catch (e) { jsonError(res, 500, e.message); }
});

// ===== END taleb.pro endpoints =====

app.post("/api/heartbeat", async function (req, res) {
  try {
    var url = req.body && req.body.url;
    var token = req.body && req.body.token;
    if (!url || !token) return res.status(400).json({ error: "url+token required" });
    var upstream = await fetch(url, {
      method: "POST",
      headers: {
        Origin: "https://coursatk.online",
        Referer: "https://coursatk.online/",
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: "{}",
    });
    var text = await upstream.text();
    res.status(upstream.status).type("json").send(text);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ==================== بروكسي الملفات ====================
// دالة مساعدة: استخراج fileId من رابط Google Drive
function extractDriveFileId(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (!host.includes("drive.google.com") && !host.includes("docs.google.com")) return null;
    const m1 = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
    if (m1) return m1[1];
    const idParam = u.searchParams.get("id");
    if (idParam && /^[a-zA-Z0-9_-]{10,}$/.test(idParam)) return idParam;
    return null;
  } catch { return null; }
}

app.get(["/api/file-proxy", "/api/file-proxy/:filename"], async (req, res) => {
  try {
    let targetUrl = req.query.url;
    if (!targetUrl || typeof targetUrl !== "string") {
      return res.status(400).type("html").send(
        `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>خطأ</title></head>
        <body style="background:#111;color:#eee;text-align:center;padding:40px;font-family:sans-serif"><h1>رابط الملف ناقص</h1></body></html>`
      );
    }
    try { if (targetUrl.includes("%")) targetUrl = decodeURIComponent(targetUrl); } catch {}

    let parsed;
    try {
      parsed = new URL(targetUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return res.status(400).type("html").send(`<html dir="rtl"><body style="background:#111;color:#eee;text-align:center;padding:40px;font-family:sans-serif"><h1>رابط غير صالح</h1></body></html>`);
      }
    } catch {
      return res.status(400).type("html").send(`<html dir="rtl"><body style="background:#111;color:#eee;text-align:center;padding:40px;font-family:sans-serif"><h1>رابط غير صالح</h1></body></html>`);
    }

    // ✅ لو الرابط Google Drive، استخدم رابط المعاينة المباشر
    const driveFileId = extractDriveFileId(targetUrl);
    if (driveFileId) targetUrl = `https://drive.google.com/uc?export=view&id=${driveFileId}`;

    const host = (parsed.hostname || "").toLowerCase();
    const isDrive = Boolean(driveFileId) || host.includes("drive.google.com") || host.includes("docs.google.com");
    const needsCoursatkAuth = !isDrive && (
      host.includes("coursatk") || host.includes("stream-weave") || host.includes("floravon") ||
      host.includes("c-cdn") || host.includes("thanawica") ||
      CONFIG.STREAM_HOSTS.some((h) => host === h || host.endsWith("." + h))
    );
    const tok = needsCoursatkAuth ? await getCoursatkToken() : "";

    const baseHeaders = {
      "User-Agent": CONFIG.STREAM_UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": isDrive ? "https://drive.google.com/" : (CONFIG.STREAM_REFERER || "https://coursatk.online/"),
      "Origin": isDrive ? "https://drive.google.com" : (CONFIG.STREAM_ORIGIN || "https://coursatk.online"),
      "Accept": "application/pdf,application/octet-stream,image/*,*/*;q=0.8",
      "Accept-Language": "ar,en;q=0.9"
    };
    if (tok) baseHeaders.Authorization = `Bearer ${tok}`;
    if (req.headers.range) baseHeaders.Range = req.headers.range;

    let upstream;
    try {
      upstream = await upstreamSlot(() =>
        fetchT(targetUrl, { headers: baseHeaders, redirect: "follow" }, { timeout: 50_000, retries: 1 })
      );
    } catch (fetchErr) {
      console.error("[file-proxy] fetch failed:", fetchErr.message);
      return res.status(502).type("html").send(`<html dir="rtl"><body style="background:#111;color:#eee;text-align:center;padding:40px;font-family:sans-serif"><h1>فشل الاتصال بالمصدر</h1><p>${String(fetchErr.message || "network").replace(/[<>&]/g, "")}</p></body></html>`);
    }

    if (!upstream.ok) {
      if (tok && (upstream.status === 401 || upstream.status === 403)) {
        try { await upstream.arrayBuffer(); } catch {}
        const noAuthHeaders = { ...baseHeaders };
        delete noAuthHeaders.Authorization;
        try { upstream = await upstreamSlot(() => fetchT(targetUrl, { headers: noAuthHeaders, redirect: "follow" }, { timeout: 40_000, retries: 0 })); } catch {}
      }
    }

    if (!upstream.ok) {
      const code = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
      return res.status(code).type("html").send(`<html dir="rtl"><body style="background:#111;color:#eee;text-align:center;padding:40px;font-family:sans-serif"><h1>تعذر جلب الملف</h1><p>كود الخطأ: ${code}</p></body></html>`);
    }

    // ✅ مهم: Drive بيرجع HTML (تحذير فيروسات) للملفات الكبيرة — نحاول نتخطاه
    const rawBuffer = Buffer.from(await upstream.arrayBuffer());
    const headPreview = rawBuffer.slice(0, 2048).toString("utf8").toLowerCase();

    if (isDrive && (headPreview.includes("<!doctype") || headPreview.includes("<html"))) {
      const tokenMatch = rawBuffer.toString("utf8").match(/confirm=([0-9A-Za-z_-]+)/);
      const uuidMatch = rawBuffer.toString("utf8").match(/uuid=([0-9A-Za-z_-]+)/);
      if (tokenMatch && driveFileId) {
        const confirmUrl = `https://drive.google.com/uc?export=download&confirm=${tokenMatch[1]}${uuidMatch ? "&uuid=" + uuidMatch[1] : ""}&id=${driveFileId}`;
        try {
          const retry = await upstreamSlot(() => fetchT(confirmUrl, { headers: baseHeaders, redirect: "follow" }, { timeout: 50_000, retries: 0 }));
          if (retry.ok) {
            const retryBuf = Buffer.from(await retry.arrayBuffer());
            const retryHead = retryBuf.slice(0, 2048).toString("utf8").toLowerCase();
            if (!retryHead.includes("<!doctype") && !retryHead.includes("<html")) {
              const ct = retryBuf.slice(0, 4).toString("latin1") === "%PDF" ? "application/pdf" : (retry.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
              res.status(200);
              res.setHeader("Content-Type", ct);
              res.setHeader("Content-Length", String(retryBuf.length));
              res.setHeader("Content-Disposition", ct === "application/pdf" ? 'inline; filename="document.pdf"' : "inline");
              res.setHeader("Accept-Ranges", "bytes");
              res.setHeader("Cache-Control", "no-store, no-transform");
              res.setHeader("X-Content-Type-Options", "nosniff");
              res.setHeader("Access-Control-Allow-Origin", "*");
              res.removeHeader("Content-Encoding");
              return res.end(retryBuf);
            }
          }
        } catch {}
      }
      return res.status(502).type("html").send(`<html dir="rtl"><body style="background:#111;color:#eee;text-align:center;padding:40px;font-family:sans-serif;line-height:1.7"><div style="background:#222;padding:24px;border-radius:12px;max-width:380px;display:inline-block;text-align:right"><h1 style="font-size:18px;color:#ffcc00;margin:0 0 12px">⚠️ الملف مش قابل للفتح مباشرة</h1><p>الملف على Google Drive محتاج صلاحية وصول، أو حجمه كبير.</p><p>اطلب من الأدمن يخلي الملف <b>Anyone with the link</b> ويجرب تاني.</p></div></body></html>`);
    }

    const buffer = rawBuffer;
    if (!buffer.length) {
      return res.status(502).type("html").send(`<html dir="rtl"><body style="background:#111;color:#eee;text-align:center;padding:40px;font-family:sans-serif"><h1>الملف فاضي</h1></body></html>`);
    }

    const headText = buffer.slice(0, 400).toString("utf8").toLowerCase();
    const looksLikeHtmlError =
      (headText.includes("<!doctype") || headText.includes("<html") || headText.includes("<head")) &&
      (headText.includes("cloudflare") || headText.includes("access denied") || headText.includes("forbidden") ||
       headText.includes("unauthorized") || headText.includes("error") || headText.includes("login") ||
       headText.includes("captcha") || buffer.length < 2000);

    if (looksLikeHtmlError) {
      return res.status(502).type("html").send(`<html dir="rtl"><body style="background:#111;color:#eee;text-align:center;padding:40px;font-family:sans-serif"><h1>المصدر رفض الطلب</h1><p>السيرفر المصدر رجّع صفحة خطأ بدل الملف</p></body></html>`);
    }

    let contentType = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const head = buffer.slice(0, 1024).toString("latin1");
    const urlLower = String(targetUrl).toLowerCase();
    const isReallyPdf = head.includes("%PDF-");

    if (isReallyPdf) contentType = "application/pdf";
    else if (urlLower.match(/\.(jpe?g)(\?|$)/) || head.startsWith("\xFF\xD8\xFF")) contentType = "image/jpeg";
    else if (urlLower.match(/\.png(\?|$)/) || head.startsWith("\x89PNG")) contentType = "image/png";
    else if (urlLower.match(/\.webp(\?|$)/) || head.startsWith("RIFF")) contentType = "image/webp";
    else if (urlLower.includes(".pdf") || contentType.includes("pdf")) contentType = "application/pdf";
    else if (!contentType || contentType === "application/octet-stream" || contentType.includes("text/")) contentType = "application/octet-stream";

    res.status(200);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Content-Disposition", contentType === "application/pdf" ? 'inline; filename="document.pdf"' : "inline");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.removeHeader("Content-Encoding");

    return res.end(buffer);
  } catch (e) {
    console.error("[file-proxy] error:", e.message);
    if (!res.headersSent) {
      res.status(502).type("html").send(`<html dir="rtl"><body style="background:#111;color:#eee;text-align:center;padding:40px;font-family:sans-serif;line-height:1.7"><div style="background:#222;padding:24px;border-radius:12px;max-width:380px;display:inline-block;text-align:right"><h1 style="font-size:18px;margin:0 0 12px">تعذر فتح الملف</h1><p>${String(e.message || "unknown").replace(/[<>&]/g, "")}</p><p style="margin-top:16px;font-size:12px;opacity:.5">جرّب تاني أو استخدم زر التحميل</p></div></body></html>`);
    } else res.end();
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((req, res) => {
  res.status(403).json({ success: false, message: "خطأ: يلزم مصادقة أو المسار غير موجود.", path: req.path });
});

app.use((err, req, res, _next) => {
  console.error("[express error]", req.method, req.path, (err && err.message) || err);
  if (res.headersSent) return res.end();
  const status = (err && (err.status || err.statusCode)) || 500;
  res.status(status >= 400 && status < 600 ? status : 500).json({ success: false, message: status === 400 ? "طلب غير صالح" : "حصل خطأ في السيرفر — جرّب تاني" });
});

setInterval(() => {
  const t = now();
  for (const [k, s] of studentSessions) if (s.expiresAt && t > s.expiresAt) studentSessions.delete(k);
  for (const [k, s] of adminSessions) if (s.expiresAt && t > s.expiresAt) adminSessions.delete(k);
  for (const [k, s] of streamSessions) if (t - s.lastUsed > CONFIG.STREAM_IDLE_MS || t - s.createdAt > CONFIG.STREAM_MAX_MS) streamSessions.delete(k);
  for (const [k, s] of sharedPlayByVideo) {
    if (!s || t - (s.lastUsed || 0) > CONFIG.STREAM_IDLE_MS || t - (s.createdAt || 0) > CONFIG.STREAM_MAX_MS || !streamSessions.has(s.id)) sharedPlayByVideo.delete(k);
  }
  for (const [k, row] of playBurst) {
    if (!row) { playBurst.delete(k); continue; }
    if (row.bannedUntil && t > row.bannedUntil + 60_000) { playBurst.delete(k); continue; }
    if (row.ids && row.ids.forEach) {
      for (const [vid, ts] of [...row.ids.entries()]) if (t - ts > PLAY_BURST_WINDOW_MS) row.ids.delete(vid);
      if (!row.ids.size && !(row.bannedUntil > t)) playBurst.delete(k);
    }
  }
  for (const [k, e] of sourceCache) if (t > e.exp + 60_000) sourceCache.delete(k);
  for (const [k, e] of upCache) if (t > e.stale) upCache.delete(k);
  for (const [k, e] of authCache) if (t > e.exp) authCache.delete(k);
  for (const [k, exp] of badTokens) if (t > exp) badTokens.delete(k);
  for (const k of [...segCache.keys()]) { const e = segCache.get(k); if (e && t > e.exp) segDel(k); }
}, 60_000).unref();

CONFIG.BOOTSTRAP_ADMIN.passwordHash = scryptHash(CONFIG.BOOTSTRAP_ADMIN.passwordPlain);
try {
  await loadDecryptionUtils();
} catch (e) {
  console.error("[crypto] failed to load DecryptionUtils — continuing without segment decrypt:", e && e.message ? e.message : e);
}
try {
  if (CONFIG.THANAWICA_ENABLED && CONFIG.THANAWICA_CODE) {
    await loadMaintenanceFromFirebase();
    await thanawicaLogin(CONFIG.THANAWICA_CODE);
    console.log("[API] Thanawica hybrid ON");
  }
} catch (e) { console.warn("[API] Thanawica login skipped:", e.message); }

try {
  if (getFirebaseUrl()) {
    const pkgs = await fbGet("site/packages");
    if (Array.isArray(pkgs) && pkgs.length) runtime.packages = pkgs;
    const ags = await fbGet("site/agents");
    if (Array.isArray(ags)) runtime.agents = ags;
    const sn = await fbGet("site/name");
    if (typeof sn === "string" && sn) runtime.siteName = sn;
    const tok = await fbGet("config/coursatkToken");
    if (typeof tok === "string" && tok.length > 20 && !runtime.coursatkToken) { runtime.coursatkToken = tok; CONFIG.COURSATK_TOKEN = tok; }
  }
} catch (e) { console.warn("[API] site load skip:", e.message); }

if (!getFirebaseUrl()) console.warn("[API] WARNING: Firebase URL not set");

try {
  if (!getFirebaseUrl()) throw new Error("no firebase");
  const existing = (await fbGet("sections")) || {};
  let created = 0;
  for (const [id, def] of Object.entries(SECTION_CATALOG)) {
    const cur = existing[id];
    if (cur && Array.isArray(cur.subjectIds) && cur.subjectIds.length) continue;
    await fbSet(`sections/${id}`, { ...def, updatedAt: Date.now() });
    created++;
  }
  console.log("[API] sections seed: created", created);
} catch (e) { console.warn("[API] section seed skip:", e.message); }

// ===== Vercel / local dual mode =====
// On Vercel we export the Express app (serverless). Locally we listen as usual.
export default app;

const isVercel = Boolean(process.env.VERCEL || process.env.NOW_REGION);
if (!isVercel) {
  // Railway / Docker / أي PaaS: لازم 0.0.0.0 وإلا البروكسي يشوف "Application failed to respond"
  const HOST = process.env.HOST || "0.0.0.0";
  const PORT = Number(process.env.PORT || CONFIG.PORT || 3000);
  const server = app.listen(PORT, HOST, () => {
    console.log(`[API ${APP_VERSION}] ${HOST}:${PORT} Thanawya World · segment-decrypt ON · segment-cache ${Math.round(SEG_CACHE_MAX / 1048576)}MB`);
    console.log(`[API] bootstrap admin ready (${CONFIG.BOOTSTRAP_ADMIN.username})`);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 0;
  process.on("SIGTERM", () => {
    console.log("[API] SIGTERM — closing");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
} else {
  console.log(`[API ${APP_VERSION}] Vercel serverless mode · segment-decrypt ON`);
}
