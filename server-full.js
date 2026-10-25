/**
 * Coursatk API — protected backend (CommonJS)
 * - Student codes (7-digit) + devices + sessions in Firebase RTDB
 * - Admin panel API (users, permissions, sections, subject IDs)
 * - Stream-Weave key unwrap + AES-128 segment decrypt (server-side)
 * - PLUS legacy proxy endpoints (years, profile, cdn, stream-proxy, heartbeat)
 * - Serves index.html + admin.html + static /public
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
app.use(express.static(path.join(__dirname, "public")));

// ═══════════════════════════════════════════════════════════
// Rate limit
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
// CONFIG
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
  BROWSER_UA:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  PLAYER_JS: "https://player.stream-weave.com/assets/player.js?v=1.1.1",
  SW_BASE: "https://api.stream-weave.com",
  FIREBASE:
    "https://my-platform-e46a6-default-rtdb.europe-west1.firebasedatabase.app",
  BOOTSTRAP_ADMIN: {
    username: "Shalaby",
    passwordHash: "",
    passwordPlain: "shalaby123",
    permissions: {
      students_create: true,
      students_edit: true,
      students_delete: true,
      students_view: true,
      devices_kick: true,
      sections_manage: true,
      admins_manage: true,
    },
  },
  STUDENT_SESSION_MS: 7 * 24 * 3600 * 1000,
  ADMIN_SESSION_MS: 12 * 3600 * 1000,
  STREAM_SESSION_MS: 15 * 60 * 1000,
  MAX_PROXY_BYTES: 12 * 1024 * 1024,
  CODE_TYPES: {
    trial: { label: "تجربة", ms: 1 * 3600 * 1000 },
    month: { label: "شهر", ms: 30 * 24 * 3600 * 1000 },
    term: { label: "ترم (6 شهور)", ms: 180 * 24 * 3600 * 1000 },
    year: { label: "سنة (12 شهر)", ms: 365 * 24 * 3600 * 1000 },
  },
};

// ═══════════════════════════════════════════════════════════
// Crypto helpers
// ═══════════════════════════════════════════════════════════
function scryptHash(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
  });
  return (
    "scrypt$16384$8$1$" + salt.toString("hex") + "$" + hash.toString("hex")
  );
}

function scryptVerify(password, stored) {
  try {
    if (stored.startsWith("scrypt$")) {
      const parts = stored.split("$");
      const salt = parts[4];
      const expect = parts[5];
      const hash = crypto.scryptSync(password, Buffer.from(salt, "hex"), 32, {
        N: 16384,
        r: 8,
        p: 1,
      });
      return crypto.timingSafeEqual(Buffer.from(expect, "hex"), hash);
    }
    return password === stored;
  } catch (e) {
    return false;
  }
}

function randomToken(bytes) {
  bytes = bytes || 32;
  return crypto.randomBytes(bytes).toString("base64url");
}

function randomCode7() {
  return String(Math.floor(1000000 + Math.random() * 9000000));
}

function now() {
  return Date.now();
}

// ── URL helpers (from legacy proxy) ──
function b64urlEncode(value) {
  var buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(value) {
  var s = String(value)
    .replace(/ /g, "+")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString("utf8");
}

function joinRel(base, rel) {
  var q = "";
  var relPath = String(rel);
  var qi = relPath.indexOf("?");
  if (qi !== -1) {
    q = relPath.slice(qi);
    relPath = relPath.slice(0, qi);
  }
  var stack = String(base || "").split("/");
  if (
    stack.length &&
    stack[stack.length - 1] !== "" &&
    /\.[a-z0-9]+$/i.test(stack[stack.length - 1])
  ) {
    stack.pop();
  }
  if (stack.length && stack[stack.length - 1] === "") stack.pop();
  relPath.split("/").forEach(function (part) {
    if (!part || part === ".") return;
    if (part === "..") stack.pop();
    else stack.push(part);
  });
  return stack.join("/") + q;
}

// ═══════════════════════════════════════════════════════════
// Firebase RTDB REST
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

async function fbPatch(p, data) {
  const r = await fetch(CONFIG.FIREBASE + "/" + p + ".json", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error("Firebase PATCH " + p + " → " + r.status);
  return r.json();
}

async function fbDelete(p) {
  const r = await fetch(CONFIG.FIREBASE + "/" + p + ".json", {
    method: "DELETE",
  });
  if (!r.ok) throw new Error("Firebase DELETE " + p + " → " + r.status);
  return true;
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
// In-memory session caches
// ═══════════════════════════════════════════════════════════
const studentSessions = new Map();
const adminSessions = new Map();
const streamSessions = new Map();

function jsonError(res, status, message) {
  return res.status(status).json({ success: false, message: message });
}

function getBearer(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  const xt = req.headers["x-session-token"];
  if (xt) return String(xt).trim();
  if (req.query && req.query.token) return String(req.query.token).trim();
  return "";
}

const studentCache = new Map();
async function getStudentCached(code) {
  const c = studentCache.get(code);
  if (c && Date.now() - c.at < 30_000) return c.student;
  let student;
  try {
    student = await fbGet("students/" + code);
  } catch (e) {
    await new Promise(function (r) {
      setTimeout(r, 300);
    });
    try {
      student = await fbGet("students/" + code);
    } catch (e2) {
      if (c) return c.student;
      throw e2;
    }
  }
  studentCache.set(code, { student: student, at: Date.now() });
  return student;
}
setInterval(function () {
  const t = Date.now();
  for (const [k, c] of studentCache) {
    if (t - c.at > 120_000) studentCache.delete(k);
  }
}, 60_000).unref();

// ── Student auth middleware ──
async function requireStudent(req, res, next) {
  try {
    const token = getBearer(req);
    if (!token) return jsonError(res, 401, "مطلوب تسجيل الدخول");

    let sess = studentSessions.get(token);
    if (!sess) {
      const remote = await fbGet("sessions/" + token);
      if (!remote) return jsonError(res, 401, "جلسة غير صالحة");
      sess = remote;
      studentSessions.set(token, sess);
    }

    if (sess.expiresAt && now() > sess.expiresAt) {
      studentSessions.delete(token);
      try {
        await fbDelete("sessions/" + token);
      } catch (e) {}
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
      try {
        await fbDelete("sessions/" + token);
      } catch (e) {}
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

function requireAdmin(permission) {
  return async function (req, res, next) {
    try {
      const token = getBearer(req);
      if (!token) return jsonError(res, 401, "مطلوب دخول الأدمن");

      let sess = adminSessions.get(token);
      if (!sess) {
        const remote = await fbGet("admin_sessions/" + token);
        if (!remote) return jsonError(res, 401, "جلسة أدمن غير صالحة");
        sess = remote;
        adminSessions.set(token, sess);
      }

      if (sess.expiresAt && now() > sess.expiresAt) {
        adminSessions.delete(token);
        try {
          await fbDelete("admin_sessions/" + token);
        } catch (e) {}
        return jsonError(res, 401, "انتهت جلسة الأدمن");
      }

      let admin = null;
      if (sess.username === CONFIG.BOOTSTRAP_ADMIN.username) {
        admin = {
          username: CONFIG.BOOTSTRAP_ADMIN.username,
          permissions: CONFIG.BOOTSTRAP_ADMIN.permissions,
          bootstrap: true,
        };
      } else {
        admin = await fbGet("admins/" + sess.adminId);
        if (!admin || admin.active === false) {
          return jsonError(res, 401, "حساب الأدمن غير موجود");
        }
      }

      if (permission) {
        const perms = admin.permissions || {};
        if (!perms[permission] && !perms.all) {
          return jsonError(res, 403, "لا تملك صلاحية: " + permission);
        }
      }

      req.admin = admin;
      req.adminSession = sess;
      req.adminToken = token;
      next();
    } catch (e) {
      console.error("[auth admin]", e.message);
      return jsonError(res, 500, "خطأ في تحقق الأدمن");
    }
  };
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
      : Buffer.from(
          key.buffer || key,
          key.byteOffset || 0,
          key.byteLength || key.length
        );
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

// ── Upstream helpers (legacy + main) ──
function browserHeaders(extra) {
  return Object.assign(
    {
      Origin: CONFIG.STREAM_ORIGIN,
      Referer: CONFIG.STREAM_REFERER,
      Accept: "*/*",
      "User-Agent": CONFIG.BROWSER_UA,
    },
    extra || {}
  );
}

async function fetchFollow(url, hdrs, left) {
  if (left == null) left = 5;
  var res = await fetch(url, { headers: hdrs, redirect: "manual" });
  if ([301, 302, 303, 307, 308].indexOf(res.status) !== -1 && left > 0) {
    var loc = res.headers.get("location");
    if (!loc) return res;
    try {
      if (res.body && res.body.cancel) await res.body.cancel();
      else await res.arrayBuffer();
    } catch (e) {}
    var next = new URL(loc, url).href;
    var nextHeaders = Object.assign({}, hdrs);
    if (new URL(next).host !== new URL(url).host)
      delete nextHeaders.Authorization;
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
  const r = await fetch(
    CONFIG.COURSATK_API + apiPath,
    Object.assign({}, options, {
      headers: await upstreamHeaders(options.headers || {}),
    })
  );
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("Upstream non-JSON (" + r.status + ")");
  }
  if (!r.ok)
    throw new Error((data && data.message) || "Upstream HTTP " + r.status);
  return data;
}

// ── Legacy proxyJson (uses runtime token) ──
async function proxyJson(url, opts) {
  opts = opts || {};
  const tok = await getCoursatkToken();
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: Object.assign(
      {
        Authorization: "Bearer " + tok,
        Accept: "application/json",
        Origin: CONFIG.STREAM_ORIGIN,
        Referer: CONFIG.STREAM_REFERER,
        "User-Agent": CONFIG.BROWSER_UA,
      },
      opts.headers || {}
    ),
    body: opts.body,
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch (e) {
    return { status: res.status, body: text };
  }
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
const globalLimiter = rateLimit({
  max: 50,
  windowMs: 60_000,
  scope: "global",
});
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
// LEGACY PROXY (no student auth — same as old proxy-server)
// ═══════════════════════════════════════════════════════════
app.get("/api/years", async function (_req, res) {
  const r = await proxyJson(CONFIG.COURSATK_API + "/user/years");
  res.status(r.status).json(r.body);
});

app.get("/api/profile", async function (_req, res) {
  const r = await proxyJson(CONFIG.COURSATK_API + "/user/profile");
  res.status(r.status).json(r.body);
});

app.post("/api/video/:id/play", async function (req, res) {
  const r = await proxyJson(
    CONFIG.COURSATK_API + "/video/" + req.params.id + "/stream-weave/play",
    {
      method: "POST",
      headers: { "Content-Length": "0" },
      body: "",
    }
  );
  res.status(r.status).json(r.body);
});

app.get("/api/cdn", async function (req, res) {
  try {
    var target = req.query.url || "";
    if (req.query.u) target = b64urlDecode(String(req.query.u));
    if (!target) return res.status(400).send("missing url");
    var hdrs = browserHeaders();
    if (req.headers.range) hdrs.Range = req.headers.range;
    var upstream = await fetchFollow(target, hdrs);
    var buf = Buffer.from(await upstream.arrayBuffer());
    res.set("Cache-Control", "public, max-age=30");
    pipeUpstream(res, upstream, buf);
  } catch (e) {
    res.status(502).send("cdn error: " + e.message);
  }
});

app.get("/api/stream-proxy", async function (req, res) {
  try {
    var swPath = (req.query.path || "").replace(/^\/+/, "");
    var token = req.query.t;
    if (!token || !swPath)
      return res.status(400).json({ error: "missing path or token" });

    var url = CONFIG.SW_BASE + "/api/v1/" + swPath;
    var hdrs = browserHeaders({ Authorization: "Bearer " + token });
    if (req.headers.range) hdrs.Range = req.headers.range;
    var upstream = await fetchFollow(url, hdrs);

    var ct = upstream.headers.get("content-type") || "application/octet-stream";
    var isM3u8 =
      ct.indexOf("mpegurl") !== -1 ||
      ct.indexOf("m3u8") !== -1 ||
      swPath.indexOf(".m3u8") !== -1;

    if (isM3u8) {
      var text = await upstream.text();
      var base =
        swPath.indexOf("/") !== -1
          ? swPath.substring(0, swPath.lastIndexOf("/") + 1)
          : "";

      text = text
        .split("\n")
        .map(function (line) {
          var s = line.trim();
          if (!s) return line;
          if (s.charAt(0) === "#") {
            return s.replace(/URI="([^"]+)"/g, function (_m, uri) {
              if (uri.indexOf("http") === 0) {
                return 'URI="/api/cdn?u=' + b64urlEncode(uri) + '"';
              }
              var clean = uri.charAt(0) === "/" ? uri.slice(1) : uri;
              clean = clean.replace(/^api\/v1\//, "");
              if (clean.indexOf("videos/") !== 0)
                clean = joinRel(base, clean);
              return (
                'URI="/api/stream-proxy?path=' +
                encodeURIComponent(clean) +
                "&t=" +
                encodeURIComponent(token) +
                '"'
              );
            });
          }
          if (s.indexOf("http") === 0) {
            try {
              var pu = new URL(s);
              var parts = pu.pathname.split("/").filter(Boolean);
              var vi = parts.indexOf("videos");
              if (vi >= 0 && parts.length >= vi + 3) {
                var vid = parts[vi + 1];
                var quality = parts[vi + 2];
                var fname = (parts[vi + 3] || "").split("?")[0];
                if (vid && quality && fname) {
                  var swPath2 =
                    "videos/" + vid + "/stream/" + quality + "/" + fname;
                  return (
                    "/api/stream-proxy?path=" +
                    encodeURIComponent(swPath2) +
                    "&t=" +
                    encodeURIComponent(token)
                  );
                }
              }
            } catch (e) {}
            return "/api/cdn?u=" + b64urlEncode(s);
          }
          return (
            "/api/stream-proxy?path=" +
            encodeURIComponent(joinRel(base, s)) +
            "&t=" +
            encodeURIComponent(token)
          );
        })
        .join("\n");

      res.set("Content-Type", "application/vnd.apple.mpegurl");
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "no-store");
      return res.status(upstream.status).send(text);
    }

    var buf = Buffer.from(await upstream.arrayBuffer());
    res.set("Cache-Control", "no-store");
    pipeUpstream(res, upstream, buf);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/heartbeat", async function (req, res) {
  try {
    var url = req.body && req.body.url;
    var token = req.body && req.body.token;
    if (!url || !token)
      return res.status(400).json({ error: "url+token required" });
    var upstream = await fetch(url, {
      method: "POST",
      headers: browserHeaders({
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      }),
      body: "{}",
    });
    var text = await upstream.text();
    res.status(upstream.status).type("json").send(text);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// STUDENT AUTH
// ═══════════════════════════════════════════════════════════
app.post(
  "/api/auth/login",
  rateLimit({ max: 15, windowMs: 60_000, scope: "login" }),
  async function (req, res) {
    try {
      const code = String((req.body && req.body.code) || "").trim();
      const deviceId = String((req.body && req.body.deviceId) || "").trim();
      const deviceName = String(
        (req.body && req.body.deviceName) || "Unknown"
      ).slice(0, 80);

      if (!/^\d{7}$/.test(code)) {
        return jsonError(res, 400, "الكود يجب أن يكون 7 أرقام");
      }
      if (!deviceId || deviceId.length < 8) {
        return jsonError(res, 400, "deviceId مطلوب");
      }

      const student = await fbGet("students/" + code);
      if (!student || student.active === false) {
        return jsonError(res, 401, "كود غير صحيح أو موقوف");
      }
      if (student.expiresAt && now() > student.expiresAt) {
        return jsonError(res, 403, "انتهت صلاحية الاشتراك");
      }

      const devices = student.devices || {};
      const maxDevices = Number(student.maxDevices || 1);

      if (!devices[deviceId]) {
        const activeCount = Object.keys(devices).length;
        if (activeCount >= maxDevices) {
          return jsonError(
            res,
            403,
            "تم بلوغ الحد الأقصى للأجهزة (" +
              maxDevices +
              "). اطلب من الأدمن حذف جهاز."
          );
        }
        devices[deviceId] = {
          name: deviceName,
          addedAt: now(),
          lastSeen: now(),
        };
        await fbSet("students/" + code + "/devices", devices);
      } else {
        devices[deviceId].lastSeen = now();
        devices[deviceId].name = deviceName || devices[deviceId].name;
        await fbSet(
          "students/" + code + "/devices/" + deviceId,
          devices[deviceId]
        );
      }

      const sessionTtl = Math.min(
        CONFIG.STUDENT_SESSION_MS,
        Math.max(
          60_000,
          (student.expiresAt || now() + CONFIG.STUDENT_SESSION_MS) - now()
        )
      );
      const token = randomToken(32);
      const sess = {
        token: token,
        code: code,
        deviceId: deviceId,
        name: student.name,
        section: student.section || null,
        createdAt: now(),
        expiresAt: now() + sessionTtl,
      };
      studentSessions.set(token, sess);
      await fbSet("sessions/" + token, sess);

      let subjectIds = [];
      let yearId = CONFIG.DEFAULT_YEAR_ID;
      if (student.section) {
        const sec = await fbGet("sections/" + student.section);
        if (sec) {
          subjectIds = sec.subjectIds || [];
          if (sec.yearId) yearId = sec.yearId;
        }
      }

      res.json({
        success: true,
        data: {
          token: token,
          expiresAt: sess.expiresAt,
          student: {
            name: student.name,
            code: code,
            section: student.section || null,
            expiresAt: student.expiresAt,
            maxDevices: maxDevices,
            deviceId: deviceId,
          },
          yearId: yearId,
          subjectIds: subjectIds,
        },
      });
    } catch (e) {
      console.error("[login]", e.message);
      jsonError(res, 500, e.message);
    }
  }
);

app.post("/api/auth/logout", requireStudent, async function (req, res) {
  try {
    studentSessions.delete(req.sessionToken);
    await fbDelete("sessions/" + req.sessionToken);
    res.json({ success: true });
  } catch (e) {
    jsonError(res, 500, e.message);
  }
});

app.get("/api/auth/me", requireStudent, async function (req, res) {
  try {
    const s = req.student;
    let subjectIds = [];
    let yearId = CONFIG.DEFAULT_YEAR_ID;
    if (s.section) {
      const sec = await fbGet("sections/" + s.section);
      if (sec) {
        subjectIds = sec.subjectIds || [];
        if (sec.yearId) yearId = sec.yearId;
      }
    }
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
        yearId: yearId,
        subjectIds: subjectIds,
        sessionExpiresAt: req.session.expiresAt,
      },
    });
  } catch (e) {
    jsonError(res, 500, e.message);
  }
});

// ═══════════════════════════════════════════════════════════
// CATALOG (student token required)
// ═══════════════════════════════════════════════════════════
app.get("/api/config", requireStudent, async function (req, res) {
  let yearId = CONFIG.DEFAULT_YEAR_ID;
  let subjectIds = [];
  if (req.student.section) {
    const sec = await fbGet("sections/" + req.student.section);
    if (sec) {
      if (sec.yearId) yearId = sec.yearId;
      subjectIds = sec.subjectIds || [];
    }
  }
  res.json({
    success: true,
    yearId: yearId,
    subjectIds: subjectIds,
    cryptoReady: Boolean(decryptPlaybackKeyFn),
    decryptSegments: true,
  });
});

app.get("/api/subjects/:id", requireStudent, async function (req, res) {
  try {
    let wantedIds = [];
    let yearId = Number(req.params.id) || CONFIG.DEFAULT_YEAR_ID;
    if (req.student.section) {
      const sec = await fbGet("sections/" + req.student.section);
      if (sec) {
        if (Array.isArray(sec.subjectIds) && sec.subjectIds.length) {
          wantedIds = sec.subjectIds
            .map(Number)
            .filter(function (n) {
              return !Number.isNaN(n);
            });
        }
        if (sec.yearId) yearId = Number(sec.yearId) || yearId;
      }
    }

    const yearData = await upstreamJson(
      "/user/subjects/" + encodeURIComponent(yearId)
    );
    let yearList = Array.isArray(yearData.data) ? yearData.data : [];
    const byId = new Map(
      yearList.map(function (s) {
        return [Number(s.id), s];
      })
    );

    if (!wantedIds.length) {
      return res.json(Object.assign({}, yearData, { data: yearList }));
    }

    const results = [];
    for (let i = 0; i < wantedIds.length; i++) {
      const sid = wantedIds[i];
      if (byId.has(sid)) {
        results.push(byId.get(sid));
        continue;
      }
      try {
        const t = await upstreamJson("/user/subjects/" + sid + "/teachers");
        const d = t && t.data;
        if (d && (d.id || d.name)) {
          results.push({
            id: Number(d.id) || sid,
            name: d.name || "مادة " + sid,
            image_url: d.image_url || null,
            year_id: yearId,
            is_published: true,
            order_index: results.length + 1,
          });
        } else {
          results.push({
            id: sid,
            name: "مادة " + sid,
            image_url: null,
            year_id: yearId,
            is_published: true,
            order_index: results.length + 1,
          });
        }
      } catch (err) {
        console.warn("[subjects] resolve " + sid + ":", err.message);
        results.push({
          id: sid,
          name: "مادة " + sid,
          image_url: null,
          year_id: yearId,
          is_published: true,
          order_index: results.length + 1,
        });
      }
    }

    res.json({
      success: true,
      message: "Success",
      data: results,
    });
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.get(
  "/api/subjects/:id/teachers",
  requireStudent,
  async function (req, res) {
    try {
      res.json(
        await upstreamJson(
          "/user/subjects/" + encodeURIComponent(req.params.id) + "/teachers"
        )
      );
    } catch (e) {
      jsonError(res, 502, e.message);
    }
  }
);

app.get(
  "/api/teachers/:id/chapters",
  requireStudent,
  async function (req, res) {
    try {
      res.json(
        await upstreamJson(
          "/user/teachers/" + encodeURIComponent(req.params.id) + "/chapters"
        )
      );
    } catch (e) {
      jsonError(res, 502, e.message);
    }
  }
);

app.get(
  "/api/chapters/:id/lectures",
  requireStudent,
  async function (req, res) {
    try {
      res.json(
        await upstreamJson(
          "/user/chapters/" + encodeURIComponent(req.params.id) + "/lectures"
        )
      );
    } catch (e) {
      jsonError(res, 502, e.message);
    }
  }
);

app.get(
  "/api/lectures/:id/content",
  requireStudent,
  async function (req, res) {
    try {
      res.json(
        await upstreamJson(
          "/user/lectures/" + encodeURIComponent(req.params.id) + "/content"
        )
      );
    } catch (e) {
      jsonError(res, 502, e.message);
    }
  }
);

// ═══════════════════════════════════════════════════════════
// STREAM (student token) — server-side decrypt
// ═══════════════════════════════════════════════════════════
app.post("/api/play/:videoId", requireStudent, async function (req, res) {
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
      ownerCode: req.session.code,
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

app.get(
  "/api/stream/manifest/:sessionId",
  requireStudent,
  async function (req, res) {
    const session = getStreamSession(req.params.sessionId);
    if (!session) return jsonError(res, 404, "جلسة التشغيل منتهية");
    if (session.ownerCode !== req.session.code) {
      return jsonError(res, 403, "جلسة تشغيل ليست لك");
    }

    try {
      let master = await streamFetch(
        session,
        session.streamUrl,
        {},
        req.headers
      );
      if (master.status === 401 && session.playId) {
        await refreshPlayback(session);
        master = await streamFetch(
          session,
          session.streamUrl,
          {},
          req.headers
        );
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
        if (!variantRes.ok)
          throw new Error("Variant HTTP " + variantRes.status);
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
  }
);

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
  requireStudent,
  async function (req, res) {
    const session = getStreamSession(req.params.sessionId);
    if (!session) return jsonError(res, 404, "جلسة التشغيل منتهية");
    if (session.ownerCode !== req.session.code)
      return jsonError(res, 403, "جلسة ليست لك");
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
// ADMIN AUTH
// ═══════════════════════════════════════════════════════════
app.post(
  "/api/admin/login",
  rateLimit({ max: 10, windowMs: 60_000, scope: "admin-login" }),
  async function (req, res) {
    try {
      const username = String((req.body && req.body.username) || "").trim();
      const password = String((req.body && req.body.password) || "");
      if (!username || !password)
        return jsonError(res, 400, "يوزر وباسورد مطلوبين");

      let adminId = null;
      let admin = null;
      let perms = null;

      if (username === CONFIG.BOOTSTRAP_ADMIN.username) {
        const ok =
          scryptVerify(password, CONFIG.BOOTSTRAP_ADMIN.passwordHash) ||
          password === CONFIG.BOOTSTRAP_ADMIN.passwordPlain;
        if (!ok) return jsonError(res, 401, "بيانات الدخول خطأ");
        adminId = "bootstrap";
        perms = CONFIG.BOOTSTRAP_ADMIN.permissions;
        admin = { username: username, permissions: perms, bootstrap: true };
      } else {
        const all = (await fbGet("admins")) || {};
        for (const id of Object.keys(all)) {
          const a = all[id];
          if (a && a.username === username && a.active !== false) {
            if (!scryptVerify(password, a.passwordHash)) {
              return jsonError(res, 401, "بيانات الدخول خطأ");
            }
            adminId = id;
            admin = a;
            perms = a.permissions || {};
            break;
          }
        }
        if (!adminId) return jsonError(res, 401, "بيانات الدخول خطأ");
      }

      const token = randomToken(32);
      const sess = {
        token: token,
        adminId: adminId,
        username: username,
        createdAt: now(),
        expiresAt: now() + CONFIG.ADMIN_SESSION_MS,
      };
      adminSessions.set(token, sess);
      await fbSet("admin_sessions/" + token, sess);

      res.json({
        success: true,
        data: {
          token: token,
          expiresAt: sess.expiresAt,
          username: username,
          permissions: perms,
        },
      });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

app.post("/api/admin/logout", requireAdmin(null), async function (req, res) {
  adminSessions.delete(req.adminToken);
  try {
    await fbDelete("admin_sessions/" + req.adminToken);
  } catch (e) {}
  res.json({ success: true });
});

app.get("/api/admin/me", requireAdmin(null), function (req, res) {
  res.json({
    success: true,
    data: {
      username: req.admin.username,
      permissions: req.admin.permissions || {},
      bootstrap: !!req.admin.bootstrap,
    },
  });
});

// ═══════════════════════════════════════════════════════════
// ADMIN — Config
// ═══════════════════════════════════════════════════════════
app.get(
  "/api/admin/config",
  requireAdmin("sections_manage"),
  async function (_req, res) {
    try {
      const remote = await fbGet("config");
      const token = await getCoursatkToken();
      const masked = token
        ? token.slice(0, 12) + "…" + token.slice(-8)
        : null;
      res.json({
        success: true,
        data: {
          coursatkTokenSet: Boolean(token),
          coursatkTokenMasked: masked,
          defaultYearId: CONFIG.DEFAULT_YEAR_ID,
          codeTypes: Object.fromEntries(
            Object.entries(CONFIG.CODE_TYPES).map(function (entry) {
              return [entry[0], { label: entry[1].label, ms: entry[1].ms }];
            })
          ),
          firebase: remote || {},
        },
      });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

app.put(
  "/api/admin/config/token",
  requireAdmin("admins_manage"),
  async function (req, res) {
    try {
      const token = String((req.body && req.body.token) || "").trim();
      if (token.length < 20) return jsonError(res, 400, "توكن غير صالح");
      await fbSet("config/coursatkToken", token);
      cachedCoursatkToken = token;
      cachedTokenAt = Date.now();
      res.json({ success: true, message: "تم تحديث توكن كورساتك" });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

// ═══════════════════════════════════════════════════════════
// ADMIN — Students
// ═══════════════════════════════════════════════════════════
app.get(
  "/api/admin/students",
  requireAdmin("students_view"),
  async function (_req, res) {
    try {
      const all = (await fbGet("students")) || {};
      const list = Object.entries(all).map(function (entry) {
        const code = entry[0];
        const s = entry[1];
        return {
          code: code,
          name: s.name,
          section: s.section || null,
          type: s.type || null,
          expiresAt: s.expiresAt,
          maxDevices: s.maxDevices || 1,
          devices: Object.keys(s.devices || {}).length,
          active: s.active !== false,
          createdAt: s.createdAt || null,
        };
      });
      list.sort(function (a, b) {
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      res.json({ success: true, data: list });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

app.get(
  "/api/admin/students/:code",
  requireAdmin("students_view"),
  async function (req, res) {
    try {
      const code = req.params.code;
      const s = await fbGet("students/" + code);
      if (!s) return jsonError(res, 404, "الطالب غير موجود");
      res.json({
        success: true,
        data: Object.assign({ code: code }, s, {
          deviceList: Object.entries(s.devices || {}).map(function (entry) {
            return Object.assign({ deviceId: entry[0] }, entry[1]);
          }),
        }),
      });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

app.post(
  "/api/admin/students",
  requireAdmin("students_create"),
  async function (req, res) {
    try {
      const name = String((req.body && req.body.name) || "").trim();
      const section = String((req.body && req.body.section) || "").trim();
      const type = String((req.body && req.body.type) || "month");
      const maxDevices = Math.max(
        1,
        Math.min(10, Number((req.body && req.body.maxDevices) || 1))
      );
      let code = String((req.body && req.body.code) || "").trim();

      if (!name) return jsonError(res, 400, "اسم الطالب مطلوب");
      if (!CONFIG.CODE_TYPES[type]) {
        return jsonError(
          res,
          400,
          "نوع الكود غير صالح (trial|month|term|year)"
        );
      }
      if (code) {
        if (!/^\d{7}$/.test(code))
          return jsonError(res, 400, "الكود يجب 7 أرقام");
        const exists = await fbGet("students/" + code);
        if (exists) return jsonError(res, 409, "الكود مستخدم بالفعل");
      } else {
        for (let i = 0; i < 30; i++) {
          code = randomCode7();
          const exists = await fbGet("students/" + code);
          if (!exists) break;
        }
      }

      const duration = CONFIG.CODE_TYPES[type].ms;
      const record = {
        name: name,
        section: section || null,
        type: type,
        maxDevices: maxDevices,
        devices: {},
        active: true,
        createdAt: now(),
        expiresAt: now() + duration,
        createdBy: req.admin.username,
      };
      await fbSet("students/" + code, record);
      res.json({ success: true, data: Object.assign({ code: code }, record) });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

app.patch(
  "/api/admin/students/:code",
  requireAdmin("students_edit"),
  async function (req, res) {
    try {
      const code = req.params.code;
      const s = await fbGet("students/" + code);
      if (!s) return jsonError(res, 404, "غير موجود");

      const patch = {};
      if (req.body.name != null) patch.name = String(req.body.name).trim();
      if (req.body.section != null)
        patch.section = String(req.body.section).trim() || null;
      if (req.body.maxDevices != null) {
        patch.maxDevices = Math.max(
          1,
          Math.min(10, Number(req.body.maxDevices))
        );
      }
      if (req.body.active != null) patch.active = Boolean(req.body.active);
      if (req.body.type && CONFIG.CODE_TYPES[req.body.type]) {
        patch.type = req.body.type;
        if (req.body.renew) {
          patch.expiresAt = now() + CONFIG.CODE_TYPES[req.body.type].ms;
        }
      }
      if (req.body.extendMs) {
        const base = Math.max(s.expiresAt || now(), now());
        patch.expiresAt = base + Number(req.body.extendMs);
      }
      await fbPatch("students/" + code, patch);
      res.json({
        success: true,
        data: Object.assign({ code: code }, s, patch),
      });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

app.delete(
  "/api/admin/students/:code",
  requireAdmin("students_delete"),
  async function (req, res) {
    try {
      const code = req.params.code;
      const sessions = (await fbGet("sessions")) || {};
      for (const tok of Object.keys(sessions)) {
        const sess = sessions[tok];
        if (sess && sess.code === code) {
          studentSessions.delete(tok);
          await fbDelete("sessions/" + tok);
        }
      }
      await fbDelete("students/" + code);
      res.json({ success: true });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

app.delete(
  "/api/admin/students/:code/devices/:deviceId",
  requireAdmin("devices_kick"),
  async function (req, res) {
    try {
      const code = req.params.code;
      const deviceId = req.params.deviceId;
      const s = await fbGet("students/" + code);
      if (!s) return jsonError(res, 404, "غير موجود");

      const devices = Object.assign({}, s.devices || {});
      delete devices[deviceId];
      await fbSet("students/" + code + "/devices", devices);

      const sessions = (await fbGet("sessions")) || {};
      for (const tok of Object.keys(sessions)) {
        const sess = sessions[tok];
        if (sess && sess.code === code && sess.deviceId === deviceId) {
          studentSessions.delete(tok);
          await fbDelete("sessions/" + tok);
        }
      }
      res.json({ success: true, message: "تم تسجيل خروج الجهاز" });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

// ═══════════════════════════════════════════════════════════
// ADMIN — Sections
// ═══════════════════════════════════════════════════════════
app.get(
  "/api/admin/sections",
  requireAdmin("sections_manage"),
  async function (_req, res) {
    try {
      const all = (await fbGet("sections")) || {};
      const list = Object.entries(all).map(function (entry) {
        return Object.assign({ id: entry[0] }, entry[1]);
      });
      res.json({ success: true, data: list });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

app.put(
  "/api/admin/sections/:id",
  requireAdmin("sections_manage"),
  async function (req, res) {
    try {
      const id = String(req.params.id)
        .trim()
        .replace(/[^\w\u0600-\u06FF\-]/g, "_");
      const name = String((req.body && req.body.name) || id).trim();
      const yearId = Number(
        (req.body && req.body.yearId) || CONFIG.DEFAULT_YEAR_ID
      );
      const subjectIds = Array.isArray(req.body && req.body.subjectIds)
        ? req.body.subjectIds
            .map(Number)
            .filter(function (n) {
              return !Number.isNaN(n);
            })
        : [];
      const record = {
        name: name,
        yearId: yearId,
        subjectIds: subjectIds,
        updatedAt: now(),
      };
      await fbSet("sections/" + id, record);
      res.json({ success: true, data: Object.assign({ id: id }, record) });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

app.delete(
  "/api/admin/sections/:id",
  requireAdmin("sections_manage"),
  async function (req, res) {
    try {
      await fbDelete("sections/" + req.params.id);
      res.json({ success: true });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

// ═══════════════════════════════════════════════════════════
// ADMIN — Admins
// ═══════════════════════════════════════════════════════════
app.get(
  "/api/admin/admins",
  requireAdmin("admins_manage"),
  async function (_req, res) {
    try {
      const all = (await fbGet("admins")) || {};
      const list = Object.entries(all).map(function (entry) {
        const id = entry[0];
        const a = entry[1];
        return {
          id: id,
          username: a.username,
          permissions: a.permissions || {},
          active: a.active !== false,
          createdAt: a.createdAt || null,
        };
      });
      res.json({
        success: true,
        data: [
          {
            id: "bootstrap",
            username: CONFIG.BOOTSTRAP_ADMIN.username,
            permissions: CONFIG.BOOTSTRAP_ADMIN.permissions,
            active: true,
            bootstrap: true,
          },
        ].concat(list),
      });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

app.post(
  "/api/admin/admins",
  requireAdmin("admins_manage"),
  async function (req, res) {
    try {
      const username = String((req.body && req.body.username) || "").trim();
      const password = String((req.body && req.body.password) || "");
      if (!username || username.length < 3)
        return jsonError(res, 400, "يوزر غير صالح");
      if (!password || password.length < 6)
        return jsonError(res, 400, "باسورد قصير");
      if (username === CONFIG.BOOTSTRAP_ADMIN.username) {
        return jsonError(res, 409, "اسم محجوز");
      }

      const all = (await fbGet("admins")) || {};
      for (const a of Object.values(all)) {
        if (a && a.username === username)
          return jsonError(res, 409, "اليوزر موجود");
      }

      const permsIn = (req.body && req.body.permissions) || {};
      const permissions = {
        students_view: !!permsIn.students_view,
        students_create: !!permsIn.students_create,
        students_edit: !!permsIn.students_edit,
        students_delete: !!permsIn.students_delete,
        devices_kick: !!permsIn.devices_kick,
        sections_manage: !!permsIn.sections_manage,
        admins_manage: !!permsIn.admins_manage,
      };

      const id = crypto.randomUUID();
      const record = {
        username: username,
        passwordHash: scryptHash(password),
        permissions: permissions,
        active: true,
        createdAt: now(),
        createdBy: req.admin.username,
      };
      await fbSet("admins/" + id, record);
      res.json({
        success: true,
        data: {
          id: id,
          username: username,
          permissions: permissions,
          active: true,
        },
      });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

app.patch(
  "/api/admin/admins/:id",
  requireAdmin("admins_manage"),
  async function (req, res) {
    try {
      if (req.params.id === "bootstrap") {
        return jsonError(res, 400, "لا يمكن تعديل الأدمن الأساسي من هنا");
      }
      const a = await fbGet("admins/" + req.params.id);
      if (!a) return jsonError(res, 404, "غير موجود");
      const patch = {};
      if (req.body.password)
        patch.passwordHash = scryptHash(String(req.body.password));
      if (req.body.permissions) {
        patch.permissions = {
          students_view: !!req.body.permissions.students_view,
          students_create: !!req.body.permissions.students_create,
          students_edit: !!req.body.permissions.students_edit,
          students_delete: !!req.body.permissions.students_delete,
          devices_kick: !!req.body.permissions.devices_kick,
          sections_manage: !!req.body.permissions.sections_manage,
          admins_manage: !!req.body.permissions.admins_manage,
        };
      }
      if (req.body.active != null) patch.active = Boolean(req.body.active);
      await fbPatch("admins/" + req.params.id, patch);
      res.json({ success: true });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

app.delete(
  "/api/admin/admins/:id",
  requireAdmin("admins_manage"),
  async function (req, res) {
    try {
      if (req.params.id === "bootstrap") {
        return jsonError(res, 400, "لا يمكن حذف الأدمن الأساسي");
      }
      await fbDelete("admins/" + req.params.id);
      res.json({ success: true });
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  }
);

// ═══════════════════════════════════════════════════════════
// Frontend + Fallback
// ═══════════════════════════════════════════════════════════
app.get("/", function (_req, res) {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/index.html", function (_req, res) {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin", function (_req, res) {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/admin.html", function (_req, res) {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.use(function (req, res) {
  res.status(404).json({
    success: false,
    message: "المسار غير موجود",
    path: req.path,
  });
});

// Cleanup timers
setInterval(function () {
  const t = now();
  for (const [k, s] of studentSessions) {
    if (s.expiresAt && t > s.expiresAt) studentSessions.delete(k);
  }
  for (const [k, s] of adminSessions) {
    if (s.expiresAt && t > s.expiresAt) adminSessions.delete(k);
  }
  for (const [k, s] of streamSessions) {
    if (t - (s.lastUsed || s.createdAt) > CONFIG.STREAM_SESSION_MS)
      streamSessions.delete(k);
  }
}, 60_000).unref();

// Boot
async function boot() {
  CONFIG.BOOTSTRAP_ADMIN.passwordHash = scryptHash(
    CONFIG.BOOTSTRAP_ADMIN.passwordPlain
  );
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
    console.log("[API] sections subjectIds force-synced");
  } catch (e) {
    console.warn("[API] section seed skip:", e.message);
  }

  app.listen(CONFIG.PORT, function () {
    console.log("[API] :" + CONFIG.PORT + " protected · segment-decrypt ON");
    console.log("[API] bootstrap admin ready (Shalaby)");
  });
}

boot().catch(function (e) {
  console.error("[boot] fatal:", e);
  process.exit(1);
});
