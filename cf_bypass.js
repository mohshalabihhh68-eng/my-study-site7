/**
 * Cloudflare bypass for floravon.shop (and similar)
 * 1) Reuse cached cf_clearance cookies (IP-bound)
 * 2) Optional FlareSolverr: FLARESOLVERR_URL=http://flaresolverr:8191/v1
 * 3) Playwright Chromium headless (needs Docker image with browsers)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, "data", "cf_cookies.json");

const jar = new Map();
let solving = new Map();
let playwrightMod = null;
let browserPromise = null;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function loadDisk() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    const t = Date.now();
    for (const [host, row] of Object.entries(raw || {})) {
      if (row && row.exp > t && row.cookies) jar.set(host, row);
    }
  } catch {}
}

function saveDisk() {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const out = {};
    for (const [h, row] of jar) out[h] = row;
    fs.writeFileSync(CACHE_PATH, JSON.stringify(out, null, 2), "utf8");
  } catch (e) {
    console.warn("[cf] save:", e.message);
  }
}

loadDisk();

export function isCfBlockedResponse(status, bodyText, headers) {
  if (status !== 403 && status !== 503 && status !== 429) return false;
  const t = String(bodyText || "").slice(0, 6000);
  const server = String(headers?.get?.("server") || "");
  if (/cloudflare/i.test(server)) return true;
  if (headers?.get?.("cf-ray")) return true;
  if (
    /cdn-cgi\/challenge|challenge-platform|cf-browser-verification|just a moment|attention required|turnstile|managed_challenge|_cf_chl|cf-error|blocked/i.test(
      t
    )
  ) {
    return true;
  }
  if (status === 403 && /<!DOCTYPE html>/i.test(t)) return true;
  return false;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function cookieDomainKey(host) {
  const parts = String(host).split(".");
  if (parts.length >= 2) return parts.slice(-2).join(".");
  return host;
}

function cookieHeaderFor(host) {
  const t = Date.now();
  for (const key of [host, cookieDomainKey(host)]) {
    const row = jar.get(key);
    if (row && row.exp > t && row.cookies) return row;
  }
  return null;
}

function storeCookies(host, cookieStr, ua = UA, ttlMs = 30 * 60_000) {
  const row = { cookies: cookieStr, ua, exp: Date.now() + ttlMs };
  jar.set(host, row);
  jar.set(cookieDomainKey(host), row);
  saveDisk();
  return row;
}

async function solveWithFlareSolverr(targetUrl) {
  const base = String(process.env.FLARESOLVERR_URL || "").replace(/\/$/, "");
  if (!base) return null;
  const endpoint = base.endsWith("/v1") ? base : base + "/v1";
  console.log("[cf] FlareSolverr", endpoint);
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cmd: "request.get",
      url: targetUrl,
      maxTimeout: 60000
    }),
    signal: AbortSignal.timeout(70000)
  });
  const j = await r.json();
  if (j.status !== "ok" || !j.solution) {
    throw new Error("FlareSolverr: " + (j.message || j.status || "fail"));
  }
  const host = hostFromUrl(targetUrl);
  const cookies = (j.solution.cookies || [])
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const ua = j.solution.userAgent || UA;
  if (!cookies) throw new Error("FlareSolverr: empty cookies");
  return storeCookies(host, cookies, ua);
}

async function getPlaywright() {
  if (playwrightMod) return playwrightMod;
  playwrightMod = await import("playwright");
  return playwrightMod;
}

async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const pw = await getPlaywright();
    return pw.chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process"
      ]
    });
  })();
  try {
    return await browserPromise;
  } catch (e) {
    browserPromise = null;
    throw e;
  }
}

async function solveWithPlaywright(targetUrl, { timeoutMs = 90000 } = {}) {
  const host = hostFromUrl(targetUrl);
  const dkey = cookieDomainKey(host);
  console.log("[cf] Playwright solve", dkey);

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    javaScriptEnabled: true
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  });

  const page = await context.newPage();
  try {
    const origin = "https://" + host + "/";
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const title = (await page.title().catch(() => "")) || "";
      const content = await page.content().catch(() => "");
      const challenge =
        /just a moment|attention required|cf-browser-verification|challenge-platform|turnstile|checking your browser/i.test(
          title + " " + content.slice(0, 3000)
        );
      const cookies = await context.cookies();
      const hasCf = cookies.some((c) => c.name === "cf_clearance" || c.name === "__cf_bm");
      if (hasCf && !challenge) break;
      if (!challenge && cookies.length) break;
      try {
        for (const frame of page.frames()) {
          if (!/challenge|turnstile|cf-/i.test(frame.url())) continue;
          const loc = frame.locator("input[type=checkbox], body");
          if (await loc.count()) await loc.first().click({ timeout: 1500 }).catch(() => {});
        }
      } catch {}
      await page.waitForTimeout(2000);
    }

    const cookies = await context.cookies();
    const use = cookies.filter((c) => {
      const d = (c.domain || "").replace(/^\./, "");
      return d.endsWith(dkey) || host.endsWith(d) || d.endsWith(host) || !d;
    });
    const list = use.length ? use : cookies;
    if (!list.length) throw new Error("Playwright: no cookies after challenge");
    const cookieStr = list.map((c) => c.name + "=" + c.value).join("; ");
    console.log("[cf] Playwright ok", dkey, list.map((c) => c.name).join(","));
    return storeCookies(host, cookieStr, UA);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

export async function solveCloudflare(targetUrl) {
  const host = hostFromUrl(targetUrl);
  const dkey = cookieDomainKey(host);
  if (solving.has(dkey)) return solving.get(dkey);

  const job = (async () => {
    try {
      const row = await solveWithFlareSolverr(targetUrl);
      if (row) return row;
    } catch (e) {
      console.warn("[cf] FlareSolverr skip:", e.message);
    }
    return solveWithPlaywright(targetUrl);
  })();

  solving.set(dkey, job);
  try {
    return await job;
  } finally {
    solving.delete(dkey);
  }
}

export async function cfFetch(url, opts = {}, { timeout = 30000, forceSolve = false } = {}) {
  const host = hostFromUrl(url);
  let row = forceSolve ? null : cookieHeaderFor(host);

  const doFetch = async (cookieRow) => {
    const headers = {
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "User-Agent": cookieRow?.ua || opts.headers?.["User-Agent"] || UA,
      ...(opts.headers || {})
    };
    if (cookieRow?.cookies) headers.Cookie = cookieRow.cookies;
    return fetch(url, {
      method: opts.method || "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeout)
    });
  };

  let res = await doFetch(row);
  if (res.ok) return res;

  let peek = "";
  try {
    peek = await res.clone().text();
  } catch {}

  if (isCfBlockedResponse(res.status, peek, res.headers) || res.status === 403) {
    try {
      row = await solveCloudflare(url);
      res = await doFetch(row);
    } catch (e) {
      console.warn("[cf] solve failed:", e.message);
    }
  }
  return res;
}

export function getCfStatus() {
  const t = Date.now();
  const out = [];
  for (const [h, row] of jar) {
    out.push({
      host: h,
      leftSec: Math.max(0, Math.round((row.exp - t) / 1000)),
      hasCookie: Boolean(row.cookies)
    });
  }
  return out;
}
