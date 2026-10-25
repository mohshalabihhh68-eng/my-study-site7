/**
 * Coursatk API — protected backend (NO LOGIN VERSION)
 * - Stream-Weave key unwrap + AES-128 segment decrypt (upstream token NEVER leaves server)
 * - Catalog + stream routes are OPEN (no student session required)
 * - Admin panel + student codes + sessions: REMOVED
 *
 * Style: CommonJS (require)
 */
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const fetch = require("node-fetch");

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "512kb" }));
app.use(compression());

// ═══════════════════════════════════════════════════════════
// Rate limit — ~50 req / minute / IP
// ═══════════════════════════════════════════════════════════
const rateBuckets = new Map();

function clientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

function rateLimit(options) {
  options = options || {};
  const windowMs = options.windowMs || 60_000;
  const max = options.max || 50;
  const keyFn =
    options.keyFn ||
    function (req) {
      return clientIp(req) + ":" + (options.scope || "global");
    };
  return function (req, res, next) {
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
        message: "طلبات كثيرة — حاول بعد دقيقة",
      });
    }
    next();
  };
}

setInterval(function () {
  const t = Date.now();
  for (const [k, b] of rateBuckets) {
    if (t > b.resetAt) rateBuckets.delete(k);
  }
}, 60_000).unref();

// ═══════════════════════════════════════════════════════════
// CONFIG (in-code)
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  COURSATK_API: "https://api.coursatk.online/api/v1",
  COURSATK_TOKEN:
    process.env.COURSATK_TOKEN ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxMDk1NTUsInJvbGUiOiJzdHVkZW50IiwidXVpZCI6IjU3OGIxNjBjMjgxZWVkY2Y1ZTY4MjViNDZmMWExNTY0In0.x9vV-N_13KcrGbx-y9owTgGdirKpKh_X0JXDpolYegs",
  DEFAULT_YEAR_ID: 4,
  STREAM_HOSTS: [
    "api.coursatk.online",
    "stream-weave.com",
    "floravon.online",
    "floravon.shop",
    "c-cdn.online",
  ],
  STREAM_ORIGIN: "https://coursatk.online",
  STREAM_REFERER: "https://coursatk.online/",
  STREAM_X_REQUESTED_WITH: "com.mycompany.app.soulbrowser",
  STREAM_UA:
    "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
  PLAYER_JS: "https://player.stream-weave.com/assets/player.js?v=1.1.1",
  FIREBASE: "https://english-73376-default-rtdb.firebaseio.com",
  STREAM_SESSION_MS: 15 * 60 * 1000,
  MAX_PROXY_BYTES: 12 * 1024 * 1024,
  CODE_TYPES: {
    trial: { label: "تجربة", ms: 1 * 3600 * 1000 },
    month: { label: "شهر", ms: 30 * 24 * 3600 * 1000 },
    term: { label: "ترم (6 شهور)", ms: 180 * 24 * 3600 * 1000 },
    year: { label: "سنة (12 شهر)", ms: 365 * 24 * 3600 * 1000 },
  },
};

function now() {
  return Date.now();
}

// ═══════════════════════════════════════════════════════════
// Firebase RTDB REST (used only for config token + sections seed)
// ═══════════════════════════════════════════════════════════
async function fbGet(p) {
  const r = await fetch(CONFIG.FIREBASE + "/" + p + ".json");
  if (!r.ok) throw new Error("Firebase GET " + p + " → " + r.status);
  return r.json();
}

async function fbSet(p, data) {
  const r = await fetch(CONFIG.FIREBASE + "/" + p + ".json", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error("Firebase PUT " + p + " → " + r.status);
  return r.json();
}

let cachedCoursatkToken = null;
let cachedTokenAt = 0;
async function getCoursatkToken() {
  const ttl = 30_000;
  if (cachedCoursatkToken && Date.now() - cachedTokenAt < ttl)
    return cachedCoursatkToken;
  try {
    const remote = await fbGet("config/coursatkToken");
    if (remote && typeof remote === "string" && remote.length > 20) {
      cachedCoursatkToken = remote;
      cachedTokenAt = Date.now();
      return remote;
    }
    if (remote && remote.token) {
      cachedCoursatkToken = remote.token;
      cachedTokenAt = Date.now();
      return remote.token;
    }
  } catch (e) {}
  cachedCoursatkToken = CONFIG.COURSATK_TOKEN;
  cachedTokenAt = Date.now();
  return CONFIG.COURSATK_TOKEN;
}

// ═══════════════════════════════════════════════════════════
// Stream sessions (in-memory only — no student ownership)
// ═══════════════════════════════════════════════════════════
const streamSessions = new Map();

function jsonError(res, status, message) {
  return res.status(status).json({ success: false, message: message });
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
  } catch (e) {}
  if (!source) {
    console.log("[crypto] fetching player.js…");
    const r = await fetch(CONFIG.PLAYER_JS, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
    });
    if (!r.ok) throw new Error("player.js HTTP " + r.status);
    source = await r.text();
    try {
      fs.writeFileSync(cachePath, source);
    } catch (e) {}
  }
  const webcrypto = crypto.webcrypto;
  const sandbox = {
    window: {},
    self: {},
    globalThis: {},
    global: {},
    console: {
      log: function () {},
      warn: function () {},
      error: function () {},
      info: function () {},
    },
    crypto: webcrypto,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    Uint8Array: Uint8Array,
    ArrayBuffer: ArrayBuffer,
    atob: function (s) {
      return Buffer.from(s, "base64").toString("binary");
    },
    btoa: function (s) {
      return Buffer.from(s, "binary").toString("base64");
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Promise: Promise,
    Error: Error,
    Object: Object,
    Array: Array,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Math: Math,
    JSON: JSON,
    Date: Date,
    Map: Map,
    Set: Set,
    WeakMap: WeakMap,
    Symbol: Symbol,
    Proxy: Proxy,
    Reflect: Reflect,
    document: {
      createElement: function () {
        return {
          style: {},
          setAttribute: function () {},
          appendChild: function () {},
          remove: function () {},
        };
      },
      head: { appendChild: function () {} },
      body: { appendChild: function () {} },
      querySelector: function () {
        return null;
      },
      addEventListener: function () {},
    },
    navigator: { userAgent: "Node" },
    location: { href: "https://coursatk.online/" },
    HTMLElement: function () {},
    HTMLVideoElement: function () {},
    MediaSource: function () {},
    URL: {
      createObjectURL: function () {
        return "blob:x";
      },
      revokeObjectURL: function () {},
    },
    Blob: function (p) {
      this.p = p;
    },
    fetch: async function () {
      return { ok: false };
    },
    XMLHttpRequest: function () {
      this.open = function () {};
      this.send = function () {};
      this.setRequestHeader = function () {};
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  vm.runInNewContext(source, sandbox, { timeout: 8000 });
  const du = sandbox.DecryptionUtils;
  if (!du || !du.decryptPlaybackKey)
    throw new Error("DecryptionUtils missing");
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
  const key = result && result.key;
  if (!key) throw new Error("empty key");
  const aes = Buffer.isBuffer(key)
    ? key
    : key instanceof ArrayBuffer
      ? Buffer.from(key)
      : Buffer.from(key.buffer || key, key.byteOffset || 0, key.byteLength || key.length);
  if (aes.length !== 16) throw new Error("key len " + aes.length);
  return aes;
}

function decryptSegment(encrypted, key, iv) {
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function parseIvHex(hex) {
  const h = String(hex || "")
    .replace(/^0x/i, "")
    .trim();
  if (!/^[0-9a-fA-F]{32}$/.test(h)) return null;
  return Buffer.from(h, "hex");
}

function ivFromMediaSequence(seq) {
  const iv = Buffer.alloc(16, 0);
  iv.writeUInt32BE(Number(seq) >>> 0, 12);
  return iv;
}

async function upstreamHeaders(extra) {
  extra = extra || {};
  const tok = await getCoursatkToken();
  return Object.assign(
    {
      Authorization: "Bearer " + tok,
      Accept: "application/json",
    },
    extra
  );
}

async function upstreamJson(apiPath, options) {
  options = options || {};
  const r = await fetch(CONFIG.COURSATK_API + apiPath, Object.assign({}, options, {
    headers: await upstreamHeaders(options.headers || {}),
  }));
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("Upstream non-JSON (" + r.status + ")");
  }
  if (!r.ok) throw new Error((data && data.message) || "Upstream HTTP " + r.status);
  return data;
}

function allowedStreamUrl(raw, session) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const hosts = new Set(CONFIG.STREAM_HOSTS);
    if (session && session.allowedHosts) {
      for (const h of session.allowedHosts) hosts.add(h);
    }
    if (session && session.streamUrl) {
      try {
        hosts.add(new URL(session.streamUrl).hostname);
      } catch (e) {}
    }
    return Array.from(hosts).some(function (h) {
      return u.hostname === h || u.hostname.endsWith("." + h);
    });
  } catch (e) {
    return false;
  }
}

async function streamFetch(session, url, extra, clientHeaders) {
  if (!allowedStreamUrl(url, session))
    throw new Error("URL غير مسموح: " + url);
  const ch = clientHeaders || {};
  const headers = {
    Accept: "*/*",
    "Cache-Control": "no-cache",
    Origin: CONFIG.STREAM_ORIGIN,
    Referer: CONFIG.STREAM_REFERER,
    "X-Requested-With": CONFIG.STREAM_X_REQUESTED_WITH,
    "User-Agent": ch["user-agent"] || CONFIG.STREAM_UA,
  };

  const isMediaSegmentHost = /floravon\.(online|shop)|c-cdn\.online/i.test(url);
  if (!isMediaSegmentHost && session && session.token) {
    headers.Authorization = "Bearer " + session.token;
  }

  const names = [
    "sec-ch-ua-platform",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "accept-language",
  ];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (ch[name]) headers[name] = ch[name];
  }
  const extraObj = extra || {};
  for (const k of Object.keys(extraObj)) {
    const v = extraObj[k];
    if (v != null && v !== "") headers[k] = v;
  }
  return fetch(url, { headers: headers, cache: "no-store" });
}

// ═══════════════════════════════════════════════════════════
// PUBLIC
// ═══════════════════════════════════════════════════════════
const globalLimiter = rateLimit({ max: 50, windowMs: 60_000, scope: "global" });
app.use(function (req, res, next) {
  if (req.path.startsWith("/api/stream/")) return next();
  return globalLimiter(req, res, next);
});

app.get("/health", function (_req, res) {
  res.json({
    ok: true,
    service: "coursatk-protected-api",
    cryptoReady: Boolean(decryptPlaybackKeyFn),
    decryptSegments: true,
    now: new Date().toISOString(),
  });
});

app.get("/api/public/code-types", function (_req, res) {
  const types = {};
  for (const k of Object.keys(CONFIG.CODE_TYPES)) {
    const v = CONFIG.CODE_TYPES[k];
    types[k] = { label: v.label, durationMs: v.ms };
  }
  res.json({ success: true, data: types });
});

// ═══════════════════════════════════════════════════════════
// CATALOG (open — no login)
// ═══════════════════════════════════════════════════════════
app.get("/api/config", async function (req, res) {
  res.json({
    success: true,
    yearId: CONFIG.DEFAULT_YEAR_ID,
    subjectIds: [],
    cryptoReady: Boolean(decryptPlaybackKeyFn),
    decryptSegments: true,
  });
});

app.get("/api/subjects/:id", async function (req, res) {
  try {
    const yearId = Number(req.params.id) || CONFIG.DEFAULT_YEAR_ID;
    const yearData = await upstreamJson(
      "/user/subjects/" + encodeURIComponent(yearId)
    );
    const yearList = Array.isArray(yearData.data) ? yearData.data : [];
    res.json(Object.assign({}, yearData, { data: yearList }));
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.get("/api/subjects/:id/teachers", async function (req, res) {
  try {
    res.json(
      await upstreamJson(
        "/user/subjects/" + encodeURIComponent(req.params.id) + "/teachers"
      )
    );
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.get("/api/teachers/:id/chapters", async function (req, res) {
  try {
    res.json(
      await upstreamJson(
        "/user/teachers/" + encodeURIComponent(req.params.id) + "/chapters"
      )
    );
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.get("/api/chapters/:id/lectures", async function (req, res) {
  try {
    res.json(
      await upstreamJson(
        "/user/chapters/" + encodeURIComponent(req.params.id) + "/lectures"
      )
    );
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.get("/api/lectures/:id/content", async function (req, res) {
  try {
    res.json(
      await upstreamJson(
        "/user/lectures/" + encodeURIComponent(req.params.id) + "/content"
      )
    );
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

// ═══════════════════════════════════════════════════════════
// STREAM (open — no login)
// ═══════════════════════════════════════════════════════════
app.post("/api/play/:videoId", async function (req, res) {
  try {
    const data = await upstreamJson(
      "/video/" + encodeURIComponent(req.params.videoId) + "/stream-weave/play",
      { method: "POST", headers: { Accept: "application/json" } }
    );
    if (
      !data ||
      !data.success ||
      !data.data ||
      !data.data.token ||
      !data.data.stream_url ||
      !data.data.video_id
    ) {
      throw new Error("Playback response ناقص");
    }
    const id = crypto.randomUUID();
    streamSessions.set(id, {
      id: id,
      videoId: String(data.data.video_id),
      token: data.data.token,
      streamUrl: data.data.stream_url,
      playId: String(req.params.videoId),
      createdAt: now(),
      lastUsed: now(),
      plainKey: null,
      defaultIv: null,
      allowedHosts: new Set([new URL(data.data.stream_url).hostname]),
    });
    res.json({
      success: true,
      data: {
        session: id,
        video_id: data.data.video_id,
        manifest_url: "/api/stream/manifest/" + id,
      },
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

async function refreshPlayback(session) {
  const data = await upstreamJson(
    "/video/" + encodeURIComponent(session.playId) + "/stream-weave/play",
    { method: "POST", headers: { Accept: "application/json" } }
  );
  if (
    !data ||
    !data.success ||
    !data.data ||
    !data.data.token ||
    !data.data.stream_url
  ) {
    throw new Error("فشل تجديد التوكن");
  }
  session.token = data.data.token;
  session.streamUrl = data.data.stream_url;
  try {
    session.allowedHosts.add(new URL(session.streamUrl).hostname);
  } catch (e) {}
  session.lastUsed = now();
  console.log("[refresh] playback token renewed for " + session.videoId);
}

app.get("/api/stream/manifest/:sessionId", async function (req, res) {
  const session = getStreamSession(req.params.sessionId);
  if (!session) return jsonError(res, 404, "جلسة التشغيل منتهية");

  try {
    let master = await streamFetch(session, session.streamUrl, {}, req.headers);
    if (master.status === 401 && session.playId) {
      await refreshPlayback(session);
      master = await streamFetch(session, session.streamUrl, {}, req.headers);
    }
    if (!master.ok) throw new Error("Stream master HTTP " + master.status);
    const masterText = await master.text();
    const lines = masterText.split(/\r?\n/);

    let variant = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("#EXT-X-STREAM-INF")) {
        const next = lines[i + 1] && lines[i + 1].trim();
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
      if (!variantRes.ok) throw new Error("Variant HTTP " + variantRes.status);
      return rewritePlaylist(
        req.params.sessionId,
        session,
        await variantRes.text(),
        variant,
        res,
        req.headers
      );
    }
    return rewritePlaylist(
      req.params.sessionId,
      session,
      masterText,
      session.streamUrl,
      res,
      req.headers
    );
  } catch (e) {
    console.error("[manifest]", e.message);
    jsonError(res, 502, e.message);
  }
});

async function rewritePlaylist(
  sessionId,
  session,
  text,
  baseUrl,
  res,
  clientHeaders
) {
  try {
    session.allowedHosts.add(new URL(baseUrl).hostname);
  } catch (e) {}
  const lines = text.split(/\r?\n/);
  const out = [];
  let mediaSeq = 0;
  let currentIv = null;
  let keyFetched = false;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("#EXT-X-MEDIA-SEQUENCE:"))
      mediaSeq = Number(t.split(":")[1]) || 0;
  }

  let segIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line.startsWith("#EXT-X-KEY:")) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      const uri = uriMatch && uriMatch[1];
      const ivMatch = line.match(/IV=(0x[0-9a-fA-F]+|[0-9a-fA-F]{32})/i);
      const ivHex = ivMatch && ivMatch[1];
      if (ivHex) currentIv = parseIvHex(ivHex);
      if (uri && !keyFetched && session.plainKey) {
        session.defaultIv = currentIv;
        keyFetched = true;
      } else if (uri && !keyFetched) {
        const keyUrl = new URL(uri, baseUrl).href;
        try {
          session.allowedHosts.add(new URL(keyUrl).hostname);
        } catch (e) {}
        const keyRes = await streamFetch(session, keyUrl, {}, clientHeaders);
        if (!keyRes.ok) throw new Error("Key HTTP " + keyRes.status);
        const wrapped = Buffer.from(await keyRes.arrayBuffer());
        session.plainKey = await unwrapKey(wrapped, session.videoId);
        session.defaultIv = currentIv;
        keyFetched = true;
        console.log("[key] unwrapped for " + session.videoId);
      }
      continue;
    }
    if (line && !line.startsWith("#")) {
      const segmentUrl = new URL(line, baseUrl).href;
      try {
        session.allowedHosts.add(new URL(segmentUrl).hostname);
      } catch (e) {}
      const seq = mediaSeq + segIndex;
      const iv = currentIv || ivFromMediaSequence(seq);
      const payload = Buffer.from(
        JSON.stringify({
          u: segmentUrl,
          iv: iv.toString("hex"),
          s: seq,
        }),
        "utf8"
      ).toString("base64url");
      out.push("/api/stream/segment/" + sessionId + "/" + payload);
      segIndex++;
      continue;
    }
    out.push(raw);
  }
  if (!session.plainKey) throw new Error("فشل تجهيز مفتاح التشفير");

  res.set({
    "Content-Type": "application/vnd.apple.mpegurl",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.send(out.join("\n"));
}

app.get(
  "/api/stream/segment/:sessionId/:encoded",
  async function (req, res) {
    const session = getStreamSession(req.params.sessionId);
    if (!session) return jsonError(res, 404, "جلسة التشغيل منتهية");
    if (!session.plainKey) return jsonError(res, 404, "مفتاح غير متاح");

    let meta;
    try {
      meta = JSON.parse(
        Buffer.from(req.params.encoded, "base64url").toString("utf8")
      );
    } catch (e) {
      return jsonError(res, 400, "segment meta غير صالح");
    }
    const url = meta && meta.u;
    if (!url || !allowedStreamUrl(url, session))
      return jsonError(res, 403, "رابط غير مسموح");

    const iv =
      parseIvHex(meta.iv) ||
      session.defaultIv ||
      ivFromMediaSequence(meta.s || 0);
    try {
      const upstream = await streamFetch(
        session,
        url,
        {
          Range: req.headers.range || undefined,
        },
        req.headers
      );
      if (!upstream.ok && upstream.status !== 206) {
        let body = "";
        try {
          body = (await upstream.text()).slice(0, 300);
        } catch (e) {}
        console.error("[segment-fail]", {
          status: upstream.status,
          host: new URL(url).hostname,
          server: upstream.headers.get("server"),
          cfRay: upstream.headers.get("cf-ray"),
          ageSec: Math.round((now() - session.createdAt) / 1000),
          body: body,
        });
        throw new Error("Segment HTTP " + upstream.status);
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
          err: decErr.message,
        });
        plain = encrypted;
      }
      res.status(200);
      res.set({
        "Content-Type": "video/mp2t",
        "Content-Length": String(plain.length),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.send(plain);
    } catch (e) {
      if (!res.headersSent) jsonError(res, 502, e.message);
      else res.end();
    }
  }
);

// ═══════════════════════════════════════════════════════════
// Fallback
// ═══════════════════════════════════════════════════════════
app.get("/", function (_req, res) {
  res.json({
    success: true,
    service: "coursatk-protected-api",
    message: "API شغال — استخدم /api/config للبدء",
    endpoints: [
      "GET /health",
      "GET /api/config",
      "GET /api/subjects/:yearId",
      "GET /api/subjects/:id/teachers",
      "GET /api/teachers/:id/chapters",
      "GET /api/chapters/:id/lectures",
      "GET /api/lectures/:id/content",
      "POST /api/play/:videoId",
      "GET /api/stream/manifest/:sessionId",
      "GET /api/stream/segment/:sessionId/:encoded",
    ],
  });
});

app.use(function (req, res) {
  res.status(404).json({
    success: false,
    message: "المسار غير موجود",
    path: req.path,
  });
});

// Cleanup timer
setInterval(function () {
  const t = now();
  for (const [k, s] of streamSessions) {
    if (t - (s.lastUsed || s.createdAt) > CONFIG.STREAM_SESSION_MS)
      streamSessions.delete(k);
  }
}, 60_000).unref();

// Boot
async function boot() {
  await loadDecryptionUtils();

  try {
    const sectionDefaults = {
      scientific_sciences: {
        name: "علمي علوم",
        yearId: 4,
        subjectIds: [57, 58, 59, 60, 61],
        updatedAt: Date.now(),
      },
      scientific_math: {
        name: "علمي رياضة",
        yearId: 4,
        subjectIds: [57, 58, 59, 60, 65],
        updatedAt: Date.now(),
      },
      literary: {
        name: "أدبي",
        yearId: 4,
        subjectIds: [57, 58, 62, 63, 64],
        updatedAt: Date.now(),
      },
    };
    for (const id of Object.keys(sectionDefaults)) {
      await fbSet("sections/" + id, sectionDefaults[id]);
    }
    console.log("[API] sections subjectIds synced");
  } catch (e) {
    console.warn("[API] section seed skip:", e.message);
  }

  app.listen(CONFIG.PORT, function () {
    console.log("[API] :" + CONFIG.PORT + " open · segment-decrypt ON");
  });
}

boot().catch(function (e) {
  console.error("[boot] fatal:", e);
  process.exit(1);
});
