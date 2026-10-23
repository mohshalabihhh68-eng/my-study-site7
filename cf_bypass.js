/**
 * Cloudflare bypass — solves JS/managed challenge once via real Chromium,
 * caches cf_clearance (+ cookies), reuses on subsequent segment/key fetches.
 *
 * Requires: npm i playwright && npx playwright install chromium
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, "data", "cf_cookies.json");

const jar = new Map(); // host -> { cookies: string, ua: string, exp: number }
let solving = new Map(); // host -> Promise
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
    console.warn("[cf] save cookies:", e.message);
  }
}

loadDisk();

export function isCfBlockedResponse(status, bodyText, headers) {
  if (status !== 403 && status !== 503 && status !== 429) return false;
  const t = String(bodyText || "").slice(0, 4000);
  const server = String(headers?.get?.("server") || "");
  if (/cloudflare/i.test(server)) return true;
  if (/cf-ray/i.test(String(headers?.get?.("cf-ray") || ""))) return true;
  if (/cdn-cgi\/challenge|challenge-platform|cf-browser-verification|just a moment|attention required|turnstile|managed_challenge|_cf_chl/i.test(t)) {
    return true;
  }
  if (status === 403 && /<!DOCTYPE html>/i.test(t) && /cloudflare|cf-ray/i.test(t)) return true;
  return false;
}

function cookieHeaderFor(host) {
  const row = jar.get(host);
  if (!row || Date.now() > row.exp) return null;
  return row;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** parent domain cookie scope e.g. floravon.shop */
function cookieDomainKey(host) {
  const parts = String(host).split(".");
  if (parts.length >= 2) return parts.slice(-2).join(".");
  return host;
}

async function getPlaywright() {
  if (playwrightMod) return playwrightMod;
  try {
    playwrightMod = await import("playwright");
    return playwrightMod;
  } catch {
    throw new Error(
      "playwright غير مثبت — نفّذ: npm i playwright && npx playwright install chromium"
    );
  }
}

async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const pw = await getPlaywright();
    const browser = await pw.chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process"
      ]
    });
    return browser;
  })();
  try {
    return await browserPromise;
  } catch (e) {
    browserPromise = null;
    throw e;
  }
}

/**
 * Open URL in Chromium, wait until CF challenge clears, return cookie header + ua
 */
export async function solveCloudflare(targetUrl, { timeoutMs = 60000 } = {}) {
  const host = hostFromUrl(targetUrl);
  const dkey = cookieDomainKey(host);
  if (!host) throw new Error("bad url");

  // single-flight per domain
  if (solving.has(dkey)) return solving.get(dkey);

  const job = (async () => {
    console.log("[cf] solving challenge for", dkey, "via", targetUrl.slice(0, 80));
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
      javaScriptEnabled: true
    });
    // stealth-ish
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // @ts-ignore
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    });

    const page = await context.newPage();
    try {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs
      });

      const deadline = Date.now() + timeoutMs;
      let cleared = false;
      while (Date.now() < deadline) {
        const title = (await page.title().catch(() => "")) || "";
        const body = await page.content().catch(() => "");
        const hasChallenge =
          /just a moment|attention required|cf-browser-verification|challenge-platform|turnstile/i.test(
            title + body
          );
        // clearance cookie present?
        const cookies = await context.cookies();
        const hasClearance = cookies.some(
          (c) => c.name === "cf_clearance" || c.name === "__cf_bm"
        );
        if (!hasChallenge && (hasClearance || body.length > 500)) {
          // for binary segment URLs, body may be small/non-html after pass
          cleared = true;
          break;
        }
        if (hasClearance && !hasChallenge) {
          cleared = true;
          break;
        }
        // try click if checkbox-like
        try {
          const frame = page.frames().find((f) => /challenge|turnstile|cf-/i.test(f.url()));
          if (frame) {
            const box = frame.locator("input[type=checkbox], .mark, #challenge-stage");
            if (await box.count()) await box.first().click({ timeout: 2000 }).catch(() => {});
          }
        } catch {}
        await page.waitForTimeout(1500);
      }

      const cookies = await context.cookies();
      // keep cookies for floravon domain family
      const relevant = cookies.filter((c) => {
        const d = (c.domain || "").replace(/^\./, "");
        return d.endsWith(dkey) || host.endsWith(d) || d.endsWith(host);
      });
      if (!relevant.length) {
        // take all if filter empty but we got something
        if (!cookies.length) {
          throw new Error("CF challenge failed — no cookies (chromium/playwright?)");
        }
      }
      const use = relevant.length ? relevant : cookies;
      const cookieStr = use.map((c) => `${c.name}=${c.value}`).join("; ");
      const exp = Date.now() + 35 * 60_000; // ~35 min
      const row = { cookies: cookieStr, ua: UA, exp, cleared };
      jar.set(dkey, row);
      jar.set(host, row);
      saveDisk();
      console.log("[cf] solved", dkey, "cookies:", use.map((c) => c.name).join(","));
      return row;
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  })();

  solving.set(dkey, job);
  try {
    return await job;
  } finally {
    solving.delete(dkey);
  }
}

/**
 * fetch with CF cookie jar; on challenge, solve and retry once
 */
export async function cfFetch(url, opts = {}, { timeout = 25_000, forceSolve = false } = {}) {
  const host = hostFromUrl(url);
  const dkey = cookieDomainKey(host);
  let row = forceSolve ? null : cookieHeaderFor(host) || cookieHeaderFor(dkey);

  const doFetch = async (cookieRow) => {
    const headers = {
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
      "Cache-Control": "no-cache",
      "User-Agent": cookieRow?.ua || opts.headers?.["User-Agent"] || UA,
      ...(opts.headers || {})
    };
    if (cookieRow?.cookies) headers.Cookie = cookieRow.cookies;
    // don't let caller Cookie override empty
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeout)
    });
    return res;
  };

  let res = await doFetch(row);
  const cloneText = async (r) => {
    try {
      return await r.clone().text();
    } catch {
      return "";
    }
  };

  let textPeek = "";
  if (!res.ok) textPeek = await cloneText(res);

  if (!res.ok && isCfBlockedResponse(res.status, textPeek, res.headers)) {
    try {
      row = await solveCloudflare(url);
      res = await doFetch(row);
    } catch (e) {
      console.warn("[cf] solve failed:", e.message);
      // return original blocked response
    }
  }

  return res;
}

export function getCfStatus() {
  const out = [];
  for (const [h, row] of jar) {
    out.push({ host: h, exp: row.exp, leftSec: Math.max(0, Math.round((row.exp - Date.now()) / 1000)) });
  }
  return out;
}
