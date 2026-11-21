/**
 * Thanawya World API — Protected Backend
 * VERSION v1.7.21-BALANCED — Smooth playback + solid anti-detection
 * - Token pool + header randomization kept
 * - Concurrency / rate limits / delays tuned so videos actually play
 * - Shared play re-enabled for efficiency
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const TEMP_DIR = path.join(DATA_DIR, "temp_files");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch {}
const APP_VERSION = "v1.7.21-BALANCED";

// ==================== ANTI-DETECTION HARDENING ====================
const ANTI_DETECT = {
  // Balanced mode: videos work smoothly + still harder to detect than original
  REQUIRE_PROXY: process.env.REQUIRE_PROXY === "1",
  MAX_TOKENS: 12,
  MAX_UPSTREAM_CONCURRENT: Number(process.env.UPSTREAM_CONCURRENCY || 28), // was 7 — too low, broke playback
  PREFETCH_AHEAD: Number(process.env.PREFETCH_AHEAD || 2),                 // small prefetch helps startup
  HLS_RATE_MAX: Number(process.env.HLS_RATE_MAX || 180),
  PLAY_RATE_MAX: Number(process.env.PLAY_RATE_MAX || 20),
  GLOBAL_RATE_MAX: Number(process.env.GLOBAL_RATE_MAX || 800),
  SEG_DELAY_MIN: 0,   // remove forced delay — was breaking smooth playback
  SEG_DELAY_MAX: 40,  // tiny jitter only
  STREAM_IDLE_MS: 35 * 60 * 1000,
  STREAM_MAX_MS: 8 * 3600 * 1000,
  LOCK_HEALTH: process.env.LOCK_HEALTH === "1", // only if explicitly set
  DISABLE_SHARED_PLAY: false, // allow shared play again so same video is efficient
  TOKEN_FAIL_BAN_MS: 20 * 60 * 1000,
  TOKEN_HARD_BAN_MS: 3 * 3600 * 1000,
};

const tokenPool = {
  tokens: [],
  idx: 0,
};

function loadTokenPool() {
  const envTokens = String(process.env.COURSATK_TOKENS || "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 30);
  const single = (process.env.COURSATK_TOKEN || "").trim();

  // ممنوع نقرأ runtime هنا — بتتعلن بعدين ويحصل Temporal Dead Zone
  const all = [...new Set([
    ...(single ? [single] : []),
    ...envTokens
  ])];

  tokenPool.tokens = all.map((t) => ({
    token: t,
    lastUsed: 0,
    fails: 0,
    bannedUntil: 0,
  }));

  if (tokenPool.tokens.length) {
    console.log(`[ANTI] token pool loaded: ${tokenPool.tokens.length} token(s)`);
  } else {
    console.warn("[ANTI] WARNING: no tokens found in COURSATK_TOKEN / COURSATK_TOKENS — videos will fail");
  }
}

function getAliveToken() {
  const now = Date.now();
  let alive = tokenPool.tokens.filter((t) => t.bannedUntil < now);
  if (!alive.length) {
    // fallback من الـ env فقط (آمن في أي وقت)
    const fallback = (process.env.COURSATK_TOKEN || "").trim();
    if (fallback && fallback.length > 30) {
      tokenPool.tokens.push({ token: fallback, lastUsed: 0, fails: 0, bannedUntil: 0 });
      alive = tokenPool.tokens.filter((t) => t.bannedUntil < now);
    }
  }
  if (!alive.length) throw new Error("جميع التوكنات محظورة مؤقتًا أو غير متوفرة");
  alive.sort((a, b) => a.lastUsed - b.lastUsed);
  const chosen = alive[0];
  chosen.lastUsed = now;
  return chosen.token;
}

function markTokenFailed(token, hard = false) {
  const row = tokenPool.tokens.find((t) => t.token === token);
  if (!row) return;
  row.fails += 1;
  if (hard || row.fails >= 4) {
    row.bannedUntil = Date.now() + (hard ? ANTI_DETECT.TOKEN_HARD_BAN_MS : ANTI_DETECT.TOKEN_FAIL_BAN_MS);
    row.fails = 0;
    console.warn("[ANTI] token temporarily banned", hard ? "(hard)" : "(soft)");
  }
}

function markTokenSuccess(token) {
  const row = tokenPool.tokens.find((t) => t.token === token);
  if (row) row.fails = Math.max(0, row.fails - 1);
}

loadTokenPool();

// Expanded mobile UA pool for fingerprint reduction
const MOBILE_UAS = [
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Redmi Note 13 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; M2101K6G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-A556E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; V2330) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; 2201116SG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36",
];

function randomUpstreamHeaders(extra = {}, isStream = false) {
  const ua = MOBILE_UAS[Math.floor(Math.random() * MOBILE_UAS.length)];
  const isAndroid = /Android/i.test(ua);
  const headers = {
    "User-Agent": ua,
    Accept: isStream ? "*/*" : "application/json, text/plain, */*",
    "Accept-Language": Math.random() > 0.45 ? "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7" : "ar,en;q=0.9",
    Origin: "https://coursatk.online",
    Referer: "https://coursatk.online/",
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
  if (isAndroid) {
    headers["X-Requested-With"] = "com.mycompany.app.soulbrowser";
    headers["Sec-CH-UA-Mobile"] = "?1";
    headers["Sec-CH-UA-Platform"] = '"Android"';
  }
  let token = "";
  try {
    token = getAliveToken();
    headers.Authorization = `Bearer ${token}`;
  } catch (e) {
    // fallback later
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v != null && v !== "") headers[k] = v;
  }
  return { headers, token };
}

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
const upstreamSlot = makeLimiter(Number(process.env.UPSTREAM_CONCURRENCY || ANTI_DETECT.MAX_UPSTREAM_CONCURRENT));

const SEG_CACHE_MAX = Number(process.env.SEGMENT_CACHE_MB || 128) * 1024 * 1024;
const SEG_CACHE_TTL = 6 * 60_000;
const PREFETCH_AHEAD = ANTI_DETECT.PREFETCH_AHEAD;

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
    "vz-878412bf-692.b-cdn.net"
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
  PLAYER_JS: "https://player.stream-weave.com/player.js?v=4.2.4",
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
  STREAM_SESSION_MS: 12 * 60 * 1000,
  STREAM_IDLE_MS: ANTI_DETECT.STREAM_IDLE_MS,
  STREAM_MAX_MS: ANTI_DETECT.STREAM_MAX_MS,
  MAX_PROXY_BYTES: 8 * 1024 * 1024,

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
// reload token pool after runtime is available + add runtime token if present
try {
  loadTokenPool();
  if (runtime && runtime.coursatkToken && String(runtime.coursatkToken).length > 30) {
    const tok = String(runtime.coursatkToken).trim();
    if (!tokenPool.tokens.some(t => t.token === tok)) {
      tokenPool.tokens.push({ token: tok, lastUsed: 0, fails: 0, bannedUntil: 0 });
      console.log("[ANTI] added runtime.coursatkToken to pool, total:", tokenPool.tokens.length);
    }
  }
} catch (e) {
  console.warn("[ANTI] token pool reload:", e.message);
}
// لو مفيش رابط Firebase متظبط → استخدم الفايربيز الأصلي
if (!runtime.firebaseUrl) {
  runtime.firebaseUrl = (process.env.FIREBASE_URL || CONFIG.FIREBASE || "https://plus-f09b5-default-rtdb.firebaseio.com").replace(/\/$/, "");
}

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

function getCoursatkToken() {
  // Prefer live token from pool (supports rotation)
  try {
    if (tokenPool.tokens && tokenPool.tokens.length) {
      return getAliveToken();
    }
  } catch {}
  // Fallbacks
  if (runtime && runtime.coursatkToken) return runtime.coursatkToken;
  const envTok = (process.env.COURSATK_TOKEN || process.env.COURSATK_TOKENS || "").split(",")[0].trim();
  if (envTok) return envTok;
  return CONFIG.COURSATK_TOKEN || "";
}

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
  // استخرج الـ version المطلوب من CONFIG.PLAYER_JS لإلغاء كاش قديم
  const targetVersion = (() => { try { return new URL(CONFIG.PLAYER_JS).searchParams.get("v") || ""; } catch { return ""; } })();
  let source = null;
  try { if (fs.existsSync(cachePath)) source = fs.readFileSync(cachePath, "utf8"); } catch {}
  // بطّل الكاش لو مش فيه الـ version المطلوب
  if (source && targetVersion && !source.includes(targetVersion)) {
    console.log(`[crypto] cache version mismatch (want ${targetVersion}) — re-fetching player.js`);
    source = null;
    try { fs.unlinkSync(cachePath); } catch {}
  }
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
    queueMicrotask: (fn) => Promise.resolve().then(fn),
    structuredClone: (v) => JSON.parse(JSON.stringify(v)),
    Promise, Error, TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError, Object, Array, String, Number, Boolean, Math, JSON, Date, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect, Function, RegExp, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, Infinity, NaN, undefined,
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
  // ابحث عن DecryptionUtils بأي اسم — v4 ممكن يصدّرها تحت اسم obfuscated
  let du = sandbox.DecryptionUtils || sandbox.decryptionUtils || null;
  let standaloneDecryptFn = null;
  if (!du?.decryptPlaybackKey) {
    for (const k of Object.getOwnPropertyNames(sandbox)) {
      try {
        const v = sandbox[k];
        if (!v || k === "window" || k === "self" || k === "globalThis" || k === "global") continue;
        if (typeof v === "object" && typeof v.decryptPlaybackKey === "function") { du = v; break; }
        // v4: قد يصدّر object فيه decrypt / decryptKey / unwrap
        if (typeof v === "object") {
          for (const m of ["decryptPlaybackKey", "decrypt", "decryptKey", "unwrapKey", "unwrap"]) {
            if (typeof v[m] === "function") { du = { decryptPlaybackKey: v[m].bind(v) }; break; }
          }
          if (du) break;
        }
        // standalone function اسمها يحتوي decrypt أو unwrap
        if (typeof v === "function" && (k.toLowerCase().includes("decrypt") || k.toLowerCase().includes("unwrap")) && v.length >= 1) {
          standaloneDecryptFn = standaloneDecryptFn || v;
        }
      } catch {}
    }
  }
  if (!du && standaloneDecryptFn) {
    du = { decryptPlaybackKey: standaloneDecryptFn };
  }
  if (du?.decryptPlaybackKey) {
    decryptPlaybackKeyFn = du.decryptPlaybackKey.bind ? du.decryptPlaybackKey.bind(du) : du.decryptPlaybackKey;
    console.log("[crypto] ready (DecryptionUtils v4.2.4)");
  } else {
    decryptPlaybackKeyFn = null;
    console.warn("[crypto] DecryptionUtils غير متاح في player.js v4.2.4 — استخدام fallback keys (plain/CDN)");
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

// Upstream helpers (hardened)
async function upstreamHeaders(extra = {}, _profileIdx = 0) {
  const { headers, token } = randomUpstreamHeaders(extra, false);
  if (!headers.Authorization) {
    const tok = await getCoursatkToken().catch(() => getAliveToken());
    headers.Authorization = `Bearer ${tok}`;
  }
  return headers;
}

async function upstreamJsonRaw(apiPath, options = {}) {
  const isGet = !options.method || String(options.method).toUpperCase() === "GET";
  const url = `${CONFIG.COURSATK_API}${apiPath}`;
  let lastErr = null;
  const maxAttempts = Math.min(6, Math.max(3, tokenPool.tokens.length || 3));

  for (let p = 0; p < maxAttempts; p++) {
    let usedToken = "";
    try {
      const { headers, token } = randomUpstreamHeaders(options.headers || {}, false);
      usedToken = token;
      if (!headers.Authorization) {
        const tok = await getCoursatkToken().catch(() => getAliveToken());
        headers.Authorization = `Bearer ${tok}`;
        usedToken = tok;
      }
      const r = await upstreamSlot(() =>
        fetchT(url, { ...options, headers }, { timeout: 22_000, retries: UPSTREAM_FETCH_RETRIES, retryOn: [429, 502, 503, 504, 408, 500] })
      );
      const text = await r.text();
      if (isCloudflareBlock(r.status, text)) {
        lastErr = new Error("Cloudflare block — use UPSTREAM_PROXY or UPSTREAM_RELAY_URL");
        console.warn("[upstream] CF block", apiPath);
        if (usedToken) markTokenFailed(usedToken, false);
        if (p < maxAttempts - 1) continue;
        throw lastErr;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        lastErr = new Error(`Upstream non-JSON (${r.status})`);
        if ((r.status === 403 || r.status === 401) && p < maxAttempts - 1) {
          if (usedToken) markTokenFailed(usedToken, r.status === 401);
          continue;
        }
        throw lastErr;
      }
      if (!r.ok) {
        const msg = data?.error || data?.message || `Upstream HTTP ${r.status}`;
        if (/اشتراك|انته|expired|token/i.test(String(msg))) {
          if (usedToken) markTokenFailed(usedToken, true);
          throw new Error(msg);
        }
        lastErr = new Error(msg);
        if ((r.status === 403 || r.status === 401) && p < maxAttempts - 1) {
          if (usedToken) markTokenFailed(usedToken, r.status === 401);
          continue;
        }
        throw lastErr;
      }
      if (usedToken) markTokenSuccess(usedToken);
      return data;
    } catch (e) {
      lastErr = e;
      if (p < maxAttempts - 1 && /non-JSON|403|401|Cloudflare|block/i.test(String(e.message || ""))) {
        await delay(180 + Math.random() * 220);
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
  let headers;
  if (isBunny) {
    // Bunny: keep required referer, randomize UA
    const ua = MOBILE_UAS[Math.floor(Math.random() * MOBILE_UAS.length)];
    headers = {
      Accept: "*/*",
      "Cache-Control": "no-cache",
      Origin: CONFIG.BUNNY_ORIGIN || "https://iframe.mediadelivery.net",
      Referer: CONFIG.BUNNY_REFERER || "https://iframe.mediadelivery.net/",
      "User-Agent": ua
    };
  } else {
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch {}
    const isFloravon = /floravon\./i.test(host) || /\.floravon\./i.test(host);
    const isSw = /stream-weave\.com$/i.test(host) || host.endsWith(".stream-weave.com");
    const { headers: rnd } = randomUpstreamHeaders({}, true);
    headers = {
      Accept: "*/*",
      "Cache-Control": "no-cache",
      Origin: CONFIG.STREAM_ORIGIN,
      Referer: CONFIG.STREAM_REFERER,
      "User-Agent": rnd["User-Agent"] || CONFIG.STREAM_UA,
      "Accept-Language": rnd["Accept-Language"] || "ar,en;q=0.9",
    };
    // floravon CDN موقّع بـ token في الـ query — متبعتش Bearer
    if (!isFloravon && session.token) {
      headers.Authorization = `Bearer ${session.token}`;
      headers["X-Requested-With"] = "com.mycompany.app.soulbrowser";
    }
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
  return upstreamSlot(() => fetchT(url, { headers, cache: "no-store" }, { timeout: 30_000, retries: hasRange ? 2 : Math.min(3, UPSTREAM_FETCH_RETRIES) }));
}

app.use(rateLimit({ max: ANTI_DETECT.GLOBAL_RATE_MAX, windowMs: 60_000, scope: "global", skip: (req) => req.path.startsWith("/api/stream/") || req.path.startsWith("/api/hls/") || req.path === "/health" }));
app.use("/api/stream/", rateLimit({ max: 400, windowMs: 60_000, scope: "stream", keyFn: (req) => "t:" + (getBearer(req) || clientIp(req)) }));
// حد المقاطع صارم ضد bulk / detection
app.use("/api/hls/", rateLimit({ max: Number(process.env.HLS_RATE_MAX || ANTI_DETECT.HLS_RATE_MAX), windowMs: 60_000, scope: "hls-seg", keyFn: (req) => "t:" + (getBearer(req) || clientIp(req)), message: "طلبات كثيرة" }));
app.use("/api/play/", rateLimit({ max: Number(process.env.PLAY_RATE_MAX || ANTI_DETECT.PLAY_RATE_MAX), windowMs: 60_000, scope: "play-api", keyFn: (req) => "t:" + (getBearer(req) || clientIp(req)), message: "طلبات كثيرة" }));

app.get("/health", (_req, res) => {
  if (ANTI_DETECT.LOCK_HEALTH) {
    return res.status(404).end();
  }
  // minimal response only — no version, no cache stats, no token info
  res.json({ ok: true });
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
    if (up.startsWith(code) || up.includes(code)) return (b || "Samsung") + " " 
