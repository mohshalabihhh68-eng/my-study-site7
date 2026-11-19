/**
 * mesari.online upstream catalog + stream adapter
 *
 * Auth: MESARI_AUTH_TOKEN (JWT from auth_token cookie) via env or updateMesariAuth().
 * Catalog: subjects → teachers → chapters → lessons → videos
 * Playback: embed (vidmoly / youtube) — not talep AES-CBC segments.
 *
 * SECURITY:
 * - Never hardcode tokens in source.
 * - Client-facing errors stay generic.
 */

import { randomUUID as nodeRandomUUID } from "node:crypto";

const MESARI_WEB = "https://mesari.online";
const MESARI_API = "https://api.mesari.online/api/v1";
const MESARI_UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

function requireMesariAuth() {
  const token = String(process.env.MESARI_AUTH_TOKEN || "").trim();
  if (!token) {
    const err = new Error("خدمة البث غير مهيأة حالياً");
    err.status = 503;
    err.expose = true;
    throw err;
  }
  return token;
}

function mesariHeaders(extra = {}) {
  const token = String(process.env.MESARI_AUTH_TOKEN || "").trim();
  const headers = {
    "user-agent": MESARI_UA,
    accept: "application/json, text/plain, */*",
    "accept-language": "ar-AE,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    origin: MESARI_WEB,
    referer: MESARI_WEB + "/",
    "sec-fetch-site": "same-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...extra
  };
  if (token) headers.cookie = `auth_token=${token}; NEXT_LOCALE=ar`;
  return headers;
}

async function mesariFetch(pathOrUrl, opts = {}, timeout = 25_000) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${MESARI_API}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  const signal = AbortSignal.timeout(timeout);
  return fetch(url, { ...opts, signal, headers: { ...mesariHeaders(opts.headers || {}), ...(opts.headers || {}) } });
}

async function mesariJson(pathOrUrl, timeout = 30_000) {
  const r = await mesariFetch(pathOrUrl, {}, timeout);
  if (!r.ok) {
    const err = new Error("تعذر جلب البيانات من المصدر");
    err.status = r.status >= 400 && r.status < 600 ? r.status : 502;
    throw err;
  }
  return r.json();
}

function unwrapList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

function absUrl(u) {
  if (!u) return null;
  u = String(u).trim();
  if (!u || u.startsWith("data:")) return null;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return MESARI_WEB + u;
  if (/^https?:\/\//i.test(u)) return u;
  return u;
}

function subjectSlugFromName(name) {
  const s = String(name || "").toLowerCase();
  if (/عرب|arabic/.test(s)) return "arabic";
  if (/انج|english|إنج/.test(s)) return "english";
  if (/فيز/.test(s)) return "physics";
  if (/كيم/.test(s)) return "chemistry";
  if (/أحياء|احياء|بيول/.test(s)) return "biology";
  if (/رياض|math/.test(s)) return "mathematics";
  if (/تاريخ/.test(s)) return "history";
  if (/جغراف/.test(s)) return "geography";
  if (/فلسف/.test(s)) return "philosophy";
  if (/نفس/.test(s)) return "psychology";
  if (/فرنس/.test(s)) return "french";
  return String(name || "subject")
    .replace(/\s+/g, "_")
    .slice(0, 32);
}

const SUBJECT_ORDER = ["arabic", "english", "chemistry", "physics", "biology", "mathematics"];

function sortSubjects(list) {
  const rank = new Map(SUBJECT_ORDER.map((s, i) => [s, i]));
  return [...(list || [])].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : 100;
    const rb = rank.has(b.id) ? rank.get(b.id) : 100;
    if (ra !== rb) return ra - rb;
    return String(a.name || "").localeCompare(String(b.name || ""), "ar");
  });
}

function ytIdFromUrl(url) {
  const s = String(url || "");
  let m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  m = s.match(/^[a-zA-Z0-9_-]{11}$/);
  return m ? m[0] : null;
}

function vidmolyIdFromUrl(url) {
  const s = String(url || "");
  let m = s.match(/vidmoly\.(?:me|to|net|biz)\/(?:embed-)?([a-zA-Z0-9]+)/i);
  if (m) return m[1].replace(/\.html$/i, "");
  m = s.match(/embed-([a-zA-Z0-9]+)/i);
  return m ? m[1] : null;
}


/** Normalize vidmoly embed URL to working host (vidmoly.biz) */
export function normalizeVidmolyEmbedUrl(url) {
  const s = String(url || "").trim();
  if (!s) return null;
  let id = vidmolyIdFromUrl(s);
  if (!id) {
    const m = s.match(/embed-([a-zA-Z0-9]+)/i) || s.match(/\/([a-zA-Z0-9]{8,})(?:\.html)?$/);
    if (m) id = m[1].replace(/\.html$/i, "");
  }
  if (!id) return s.startsWith("http") ? s : null;
  return `https://vidmoly.biz/embed-${id}.html`;
}

/**
 * Fetch vidmoly embed HTML and extract JWPlayer HLS master URL.
 * Returns { m3u8, image, embedUrl, id } or null.
 */
export async function resolveVidmolyHls(embedUrl, timeout = 25_000) {
  const pageUrl = normalizeVidmolyEmbedUrl(embedUrl);
  if (!pageUrl) return null;
  const r = await fetch(pageUrl, {
    headers: {
      "user-agent": MESARI_UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "ar,en;q=0.9",
      referer: MESARI_WEB + "/",
      origin: MESARI_WEB
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout)
  });
  if (!r.ok) {
    console.warn("[vidmoly] embed HTTP", r.status, pageUrl);
    return null;
  }
  const html = await r.text();
  if (!html || html.length < 500) return null;

  let m3u8 = null;
  // sources: [{ file: 'https://...m3u8?...' }]
  let m = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*['"](https?:\/\/[^'"]+m3u8[^'"]*)['"]/i);
  if (m) m3u8 = m[1];
  if (!m3u8) {
    m = html.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
    if (m) m3u8 = m[1];
  }
  if (!m3u8) {
    m = html.match(/https?:\/\/[a-z0-9._-]+\/[^\s'"]+\.m3u8[^\s'"]*/i);
    if (m) m3u8 = m[0];
  }
  if (!m3u8) {
    console.warn("[vidmoly] no m3u8 in embed", pageUrl.slice(0, 80));
    return null;
  }
  // unescape common entities
  m3u8 = m3u8.replace(/&amp;/g, "&");

  let image = null;
  m = html.match(/image\s*:\s*['"](https?:\/\/[^'"]+)['"]/i);
  if (m) image = m[1];

  return {
    m3u8,
    image,
    embedUrl: pageUrl,
    id: vidmolyIdFromUrl(pageUrl)
  };
}


// ---------- caches ----------
const catalogCache = { exp: 0, data: null };
const videoCache = new Map(); // videoId -> details
const chapterCache = new Map();

export function clearMesariCatalogCache() {
  catalogCache.exp = 0;
  catalogCache.data = null;
  videoCache.clear();
  chapterCache.clear();
}

export function updateMesariAuth(token) {
  if (token) process.env.MESARI_AUTH_TOKEN = String(token).trim();
  clearMesariCatalogCache();
}

export async function mesariAuthStatus() {
  const token = String(process.env.MESARI_AUTH_TOKEN || "").trim();
  const configured = Boolean(token);
  let alive = false;
  if (configured) {
    try {
      const r = await mesariFetch("/auth/me", {}, 8_000);
      alive = r.ok;
    } catch {
      alive = false;
    }
  }
  return { configured, alive };
}

/** POST stream/start — registers device session upstream (optional but good for progress) */
export async function mesariStreamStart(videoId, deviceId = null) {
  requireMesariAuth();
  const body = {
    videoId: String(videoId),
    deviceId: deviceId || cryptoRandomUuid()
  };
  const r = await mesariFetch("/stream/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }, 15_000);
  if (!r.ok) {
    const err = new Error("تعذر بدء التشغيل");
    err.status = r.status >= 400 && r.status < 600 ? r.status : 502;
    throw err;
  }
  try {
    return await r.json();
  } catch {
    return { status: "ok" };
  }
}

function cryptoRandomUuid() {
  try { return nodeRandomUUID(); } catch {}
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function getMesariVideo(videoId) {
  const id = String(videoId || "").trim();
  if (!id) {
    const err = new Error("معرّف الفيديو غير صالح");
    err.status = 400;
    throw err;
  }
  if (videoCache.has(id)) return videoCache.get(id);
  requireMesariAuth();
  const full = await mesariJson(`/videos/${encodeURIComponent(id)}`, 25_000);
  videoCache.set(id, full);
  return full;
}

/**
 * Build playable source from mesari video UUID.
 * Returns embed / youtube mode compatible with multi-source player.
 */
export async function buildMesariSource(videoId, opts = {}) {
  const id = String(videoId || "").trim();
  requireMesariAuth();

  // best-effort session start
  try {
    await mesariStreamStart(id, opts.deviceId || null);
  } catch (e) {
    console.warn("[mesari] stream/start", e && e.message);
  }

  const full = await getMesariVideo(id);
  const primaryUrl = absUrl(full.url) || absUrl((full.servers || [])[0]?.url) || null;
  const servers = Array.isArray(full.servers) ? full.servers : [];

  // YouTube
  const ytId = ytIdFromUrl(primaryUrl) || (full.type === "YOUTUBE" ? ytIdFromUrl(full.url) : null);
  if (ytId || String(full.type || "").toUpperCase() === "YOUTUBE") {
    const yid = ytId || ytIdFromUrl(full.url);
    if (yid) {
      const ytUrl = `https://www.youtube.com/watch?v=${yid}`;
      return {
        reqVideoId: `mesari_${id}`,
        videoId: yid,
        mode: "mesari-youtube",
        youtubeUrl: ytUrl,
        streamUrl: ytUrl,
        token: "mesari",
        allowedHosts: new Set(["www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "youtu.be"]),
        plainKey: Buffer.from("youtube"),
        defaultIv: null,
        mediaSeq: 0,
        segs: [],
        playlist: "",
        createdAt: Date.now(),
        directSegments: false,
        embedUrl: `https://www.youtube.com/embed/${yid}`,
        mesariVideoId: id,
        originalName: full.originalName || null,
        thumbnailUrl: absUrl(full.thumbnailUrl)
      };
    }
  }

  // Vidmoly / generic — try HLS unlock first
  const embedUrl = primaryUrl;
  const vmId = vidmolyIdFromUrl(embedUrl);
  if (!embedUrl) {
    const err = new Error("لا يوجد رابط تشغيل لهذا الفيديو");
    err.status = 502;
    throw err;
  }

  const allowed = new Set([
    "vidmoly.me", "vidmoly.to", "vidmoly.net", "vidmoly.biz", "www.vidmoly.me",
    "api.mesari.online", "mesari.online", "files.coursatk.online",
    "vmpx.online", "vmeas.cloud", "staticmoly.me", "cdn.staticmoly.me"
  ]);

  // Attempt direct HLS from vidmoly embed page
  if (/vidmoly\./i.test(embedUrl) || vmId) {
    try {
      const resolved = await resolveVidmolyHls(embedUrl);
      if (resolved && resolved.m3u8) {
        try {
          const host = new URL(resolved.m3u8).hostname;
          if (host) allowed.add(host);
          // parent domains
          const parts = host.split(".");
          if (parts.length >= 2) allowed.add(parts.slice(-2).join("."));
        } catch {}
        return {
          reqVideoId: `mesari_${id}`,
          videoId: id,
          mode: "mesari-hls",
          streamUrl: resolved.m3u8,
          masterUrl: resolved.m3u8,
          embedUrl: resolved.embedUrl || normalizeVidmolyEmbedUrl(embedUrl),
          vidmolyId: resolved.id || vmId,
          token: "mesari",
          allowedHosts: allowed,
          plainKey: null,
          defaultIv: null,
          mediaSeq: 0,
          segs: [],
          playlist: "",
          createdAt: Date.now(),
          directSegments: true,
          cipherMode: null,
          noDecrypt: true,
          servers: servers.map((s) => ({ name: s.name, type: s.type, url: absUrl(s.url) })),
          mesariVideoId: id,
          originalName: full.originalName || null,
          thumbnailUrl: absUrl(full.thumbnailUrl) || resolved.image || null,
          drmMode: full.drmMode || null
        };
      }
    } catch (e) {
      console.warn("[mesari] vidmoly hls resolve failed", e && e.message);
    }
  }

  // fallback: embed iframe
  return {
    reqVideoId: `mesari_${id}`,
    videoId: id,
    mode: "mesari-embed",
    streamUrl: normalizeVidmolyEmbedUrl(embedUrl) || embedUrl,
    embedUrl: normalizeVidmolyEmbedUrl(embedUrl) || embedUrl,
    vidmolyId: vmId,
    token: "mesari",
    allowedHosts: allowed,
    plainKey: Buffer.from("embed"),
    defaultIv: null,
    mediaSeq: 0,
    segs: [],
    playlist: "",
    createdAt: Date.now(),
    directSegments: false,
    cipherMode: null,
    servers: servers.map((s) => ({
      name: s.name,
      type: s.type,
      url: absUrl(s.url)
    })),
    mesariVideoId: id,
    originalName: full.originalName || null,
    thumbnailUrl: absUrl(full.thumbnailUrl),
    drmMode: full.drmMode || null
  };
}

/**
 * Flexible id resolver:
 * - mesari_{uuid}
 * - mesari_v_{uuid}
 * - raw uuid
 * - lesson id → first video
 */
export async function buildMesariSourceFromAnyId(rawId, opts = {}) {
  let id = String(rawId || "").trim();
  while (/^mesari_mesari_/i.test(id)) id = id.replace(/^mesari_/i, "");

  if (/^mesari_v_/i.test(id)) id = id.replace(/^mesari_v_/i, "");
  if (/^mesari_/i.test(id)) id = id.replace(/^mesari_/i, "");

  // lesson: first video
  if (/^lesson_/i.test(id)) {
    const lessonId = id.replace(/^lesson_/i, "");
    const lesson = await mesariJson(`/lessons/${encodeURIComponent(lessonId)}`, 25_000);
    const vids = lesson.videos || [];
    if (!vids.length) {
      const err = new Error("لا يوجد فيديو في هذه المحاضرة");
      err.status = 404;
      throw err;
    }
    return buildMesariSource(vids[0].id, opts);
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    // could be video or lesson — try video first
    try {
      return await buildMesariSource(id, opts);
    } catch (e) {
      if (e && e.status === 404) {
        try {
          const lesson = await mesariJson(`/lessons/${encodeURIComponent(id)}`, 20_000);
          const vids = lesson.videos || [];
          if (vids[0]?.id) return buildMesariSource(vids[0].id, opts);
        } catch {}
      }
      throw e;
    }
  }

  const err = new Error("معرّف الفيديو غير معروف");
  err.status = 400;
  throw err;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/** Full catalog crawl — structure matches previous taleb teachers/courses/lectures shape */
export async function crawlMesariFullCatalog() {
  const nowMs = Date.now();
  if (catalogCache.data && nowMs < catalogCache.exp && (catalogCache.data.subjects || []).length) {
    return catalogCache.data;
  }

  requireMesariAuth();
  console.log("[mesari-catalog] refresh start");

  const subjectsRaw = unwrapList(await mesariJson("/subjects", 40_000));
  const teachersRaw = unwrapList(await mesariJson("/teachers", 40_000));

  // global teacher registry (real names + icons from /teachers)
  const teacherById = new Map();
  for (const t of teachersRaw) {
    if (!t?.id) continue;
    teacherById.set(String(t.id), {
      id: `mesari_t_${t.id}`,
      uuid: String(t.id),
      name: String(t.displayName || t.title || "مدرس").trim(),
      image_url: absUrl(t.icon),
      subjectId: null,
      subjectSlug: null,
      numericId: null,
      courses: [],
      lectures: [],
      mesariTeacherId: String(t.id)
    });
  }

  const subjects = [];
  const teachersFlat = [];

  // build one teacher-subject instance per subject
  function cloneTeacherForSubject(base, slug) {
    return {
      id: `mesari_t_${base.uuid}_${slug}`,
      uuid: base.uuid,
      name: base.name,
      image_url: base.image_url,
      subjectId: slug,
      subjectSlug: slug,
      numericId: null,
      courses: [],
      lectures: [],
      mesariTeacherId: base.uuid
    };
  }

  function buildPartsFromLesson(lec, ch, lectureNum) {
    const parts = [];
    const videos = Array.isArray(lec.videos) ? lec.videos : [];
    // nested catalog often returns video stubs without originalName — don't spam duplicate titles
    const namedVideos = videos.filter((v) => v && v.id && (v.originalName || v.title || v.url));
    const list = namedVideos.length ? namedVideos : [];
    list.forEach((v, idx) => {
      if (!v || !v.id) return;
      const title = String(v.originalName || v.title || lec.title || `فيديو ${idx + 1}`)
        .replace(/\s+/g, " ")
        .trim();
      parts.push({
        id: `mesari_v_${v.id}`,
        title,
        group: "الشرح",
        kind: "video",
        courseId: String(ch.id),
        lectureNum: String(lectureNum),
        partNum: String(idx + 1),
        watchPath: null,
        videoId: `mesari_${v.id}`,
        mesariVideoId: v.id,
        mesariLessonId: lec.id,
        quality: v.quality || null,
        type: v.type || "UPLOAD",
        image_url: absUrl(v.thumbnailUrl) || absUrl(ch.thumbnail) || null
      });
    });
    // files (PDF etc.)
    const files = Array.isArray(lec.files) ? lec.files : [];
    files.forEach((f, idx) => {
      const title = String(f.title || f.name || f.originalName || `ملف ${idx + 1}`).trim();
      parts.push({
        id: `mesari_file_${f.id || idx}`,
        title,
        group: "الملفات",
        kind: "file",
        courseId: String(ch.id),
        lectureNum: String(lectureNum),
        partNum: String(1000 + idx),
        watchPath: null,
        videoId: null,
        fileUrl: absUrl(f.url || f.fileUrl || f.path),
        mesariLessonId: lec.id
      });
    });
    // exams
    const exams = Array.isArray(lec.exams) ? lec.exams : [];
    exams.forEach((ex, idx) => {
      const title = String(ex.title || ex.name || `امتحان ${idx + 1}`).trim();
      parts.push({
        id: `mesari_exam_${ex.id || idx}`,
        title,
        group: "الامتحان",
        kind: "exam",
        courseId: String(ch.id),
        lectureNum: String(lectureNum),
        partNum: String(2000 + idx),
        watchPath: null,
        videoId: null,
        mesariLessonId: lec.id
      });
    });
    // lesson with no nested media yet — keep a resolvable stub named like the site lesson
    if (!parts.length) {
      parts.push({
        id: `mesari_lesson_${lec.id}`,
        title: String(lec.title || "محاضرة").trim(),
        group: "الشرح",
        kind: "video",
        courseId: String(ch.id),
        lectureNum: String(lectureNum),
        partNum: "1",
        watchPath: null,
        videoId: `mesari_lesson_${lec.id}`,
        mesariLessonId: lec.id,
        mesariVideoId: null,
        needsExpand: true
      });
    }
    return parts;
  }

  await mapPool(subjectsRaw, 3, async (sr) => {
    if (!sr?.id || sr.isPublished === false) return;
    let detail = sr;
    try {
      detail = await mesariJson(`/subjects/${encodeURIComponent(sr.id)}`, 45_000);
    } catch (e) {
      console.warn("[mesari-catalog] subject detail", sr.id, e && e.message);
    }

    const subjectName = String(detail.name || sr.name || "").trim() || "مادة";
    const slug = subjectSlugFromName(subjectName);
    const subjectImage = absUrl(detail.thumbnail || detail.coverImage || detail.bannerUrl || detail.icon || sr.thumbnail);

    const stList = Array.isArray(detail.teachers) ? detail.teachers : [];
    const chapters = Array.isArray(detail.chapters) ? detail.chapters : [];

    const chaptersByTeacher = new Map();
    for (const ch of chapters) {
      if (!ch || ch.isPublished === false) continue;
      const tid = String(ch.teacherId || "");
      if (!tid) continue;
      if (!chaptersByTeacher.has(tid)) chaptersByTeacher.set(tid, []);
      chaptersByTeacher.get(tid).push(ch);
    }

    const teacherIds = new Set();
    for (const row of stList) {
      const tid = String(row.teacher?.id || row.teacherId || row.id || "");
      if (tid) teacherIds.add(tid);
    }
    for (const tid of chaptersByTeacher.keys()) teacherIds.add(tid);

    const subjectTeachers = [];

    for (const tid of teacherIds) {
      const base = teacherById.get(tid) || {
        uuid: tid,
        name: "مدرس",
        image_url: null
      };
      // prefer nested subject teacher name/icon
      const nested = stList.find((x) => String(x.teacher?.id || x.teacherId || "") === tid);
      const name = String(nested?.teacher?.displayName || base.name || "مدرس").trim();
      const icon = absUrl(nested?.teacher?.icon) || base.image_url || null;

      const th = cloneTeacherForSubject({ uuid: tid, name, image_url: icon }, slug);
      th.name = name;
      th.image_url = icon;

      const tChapters = (chaptersByTeacher.get(tid) || []).sort((a, b) => (a.order || 0) - (b.order || 0));
      const coursesOut = [];
      const lecturesOut = [];

      for (const ch of tChapters) {
        const chapterTitle = String(ch.title || "فصل").replace(/\s+/g, " ").trim();
        const chapterImage = absUrl(ch.thumbnail) || subjectImage;
        const lessons = Array.isArray(ch.lessons) ? [...ch.lessons] : [];
        lessons.sort((a, b) => (a.order || 0) - (b.order || 0));

        const courseLectures = [];
        for (const lec of lessons) {
          if (!lec || lec.isPublished === false) continue;
          const lectureNum = lec.order != null ? lec.order : courseLectures.length + 1;
          const lecTitle = String(lec.title || `محاضرة ${lectureNum}`).replace(/\s+/g, " ").trim();
          const parts = buildPartsFromLesson(lec, ch, lectureNum);
          const lecObj = {
            id: `mesari_lec_${lec.id}`,
            title: lecTitle.slice(0, 160),
            courseId: String(ch.id),
            lectureNum: String(lectureNum),
            courseTitle: chapterTitle,
            image_url: chapterImage,
            parts,
            mesariLessonId: lec.id
          };
          courseLectures.push(lecObj);
          lecturesOut.push(lecObj);
        }

        coursesOut.push({
          id: String(ch.id),
          title: chapterTitle,
          image_url: chapterImage,
          partsCount: courseLectures.reduce((a, l) => a + (l.parts || []).length, 0),
          lecturesCount: courseLectures.length,
          lectures: courseLectures,
          mesariChapterId: ch.id,
          subjectId: slug,
          mesariSubjectId: sr.id
        });
      }

      th.courses = coursesOut;
      th.lectures = lecturesOut;
      subjectTeachers.push(th);
      teachersFlat.push(th);
    }

    subjects.push({
      id: slug,
      mesariId: sr.id,
      name: subjectName,
      image_url: subjectImage,
      teachers: subjectTeachers
    });
  });

  const data = {
    subjects: sortSubjects(subjects),
    teachers: teachersFlat,
    crawledAt: nowMs,
    source: "mesari",
    stats: {
      subjects: subjects.length,
      teachers: teachersFlat.length,
      courses: teachersFlat.reduce((a, t) => a + (t.courses || []).length, 0),
      lectures: teachersFlat.reduce((a, t) => a + (t.lectures || []).length, 0),
      parts: teachersFlat.reduce(
        (a, t) => a + (t.lectures || []).reduce((b, l) => b + (l.parts || []).length, 0),
        0
      )
    }
  };

  console.log("[mesari-catalog] ready", data.stats);
  catalogCache.data = data;
  catalogCache.exp = nowMs + (teachersFlat.length ? 20 * 60_000 : 60_000);
  return data;
}

export async function getMesariTeachers() {
  const cat = await crawlMesariFullCatalog();
  return cat.teachers.map((t) => ({
    id: t.id,
    name: t.name,
    image_url: t.image_url || null,
    subjectId: t.subjectId,
    subjectIcon: null,
    courses: (t.courses || []).map((c) => ({
      id: c.id,
      title: c.title,
      image_url: c.image_url || null,
      lecturesCount: c.lecturesCount || (c.lectures || []).length,
      partsCount: c.partsCount || 0,
      lectures: c.lectures || []
    })),
    lectures: (t.lectures || []).flatMap((lec) =>
      (lec.parts || []).map((p) => ({
        courseId: p.courseId,
        lectureId: p.lectureNum,
        partId: p.id,
        title: p.title || lec.title,
        createdAt: null,
        videoId: p.videoId,
        courseTitle: lec.courseTitle || null,
        image_url: p.image_url || lec.image_url || null,
        mesariVideoId: p.mesariVideoId || null,
        mesariLessonId: p.mesariLessonId || lec.mesariLessonId || null
      }))
    )
  }));
}

/**
 * Expand a chapter like the website: fetch lessons list, then each lesson detail
 * so video originalName / files / exams match Mesari classroom.
 */
export async function ensureMesariChapterLectures(chapterId, opts = {}) {
  const cid = String(chapterId);
  const force = Boolean(opts.force);
  if (!force && chapterCache.has(cid)) return chapterCache.get(cid);
  requireMesariAuth();

  // chapter meta (title + thumbnail)
  let chapterMeta = { title: null, thumbnail: null };
  try {
    const ch = await mesariJson(`/chapters/${encodeURIComponent(cid)}`, 30_000);
    chapterMeta.title = ch.title || null;
    chapterMeta.thumbnail = absUrl(ch.thumbnail);
  } catch (e) {
    console.warn("[mesari] chapter meta", cid, e && e.message);
  }

  let lessons = unwrapList(await mesariJson(`/lessons?chapterId=${encodeURIComponent(cid)}`, 40_000));
  if (!lessons.length) {
    try {
      const ch = await mesariJson(`/chapters/${encodeURIComponent(cid)}`, 30_000);
      lessons = Array.isArray(ch.lessons) ? ch.lessons : [];
    } catch {}
  }
  lessons = lessons
    .filter((l) => l && l.isPublished !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  // expand each lesson for real video names (parallel limited)
  const expanded = await mapPool(lessons, 4, async (lec) => {
    let full = lec;
    const hasNamedVideos = (lec.videos || []).some((v) => v && (v.originalName || v.url));
    if (!hasNamedVideos || !(lec.videos || []).length) {
      try {
        full = await mesariJson(`/lessons/${encodeURIComponent(lec.id)}`, 30_000);
      } catch (e) {
        console.warn("[mesari] lesson expand", lec.id, e && e.message);
        full = lec;
      }
    }
    return full;
  });

  const lectures = [];
  for (const lec of expanded) {
    if (!lec) continue;
    const lectureNum = lec.order != null ? lec.order : lectures.length + 1;
    const lecTitle = String(lec.title || `محاضرة ${lectureNum}`).replace(/\s+/g, " ").trim();
    const parts = [];
    const videos = Array.isArray(lec.videos) ? lec.videos : [];
    videos.forEach((v, idx) => {
      if (!v?.id) return;
      parts.push({
        id: `mesari_v_${v.id}`,
        title: String(v.originalName || v.title || lecTitle || `فيديو ${idx + 1}`).replace(/\s+/g, " ").trim(),
        group: "الشرح",
        kind: "video",
        courseId: cid,
        lectureNum: String(lectureNum),
        partNum: String(idx + 1),
        watchPath: null,
        videoId: `mesari_${v.id}`,
        mesariVideoId: v.id,
        mesariLessonId: lec.id,
        quality: v.quality || null,
        type: v.type || "UPLOAD",
        image_url: absUrl(v.thumbnailUrl) || chapterMeta.thumbnail
      });
    });
    (lec.files || []).forEach((f, idx) => {
      parts.push({
        id: `mesari_file_${f.id || idx}`,
        title: String(f.title || f.name || f.originalName || `ملف ${idx + 1}`).trim(),
        group: "الملفات",
        kind: "file",
        courseId: cid,
        lectureNum: String(lectureNum),
        partNum: String(1000 + idx),
        fileUrl: absUrl(f.url || f.fileUrl || f.path),
        mesariLessonId: lec.id
      });
    });
    (lec.exams || []).forEach((ex, idx) => {
      parts.push({
        id: `mesari_exam_${ex.id || idx}`,
        title: String(ex.title || ex.name || `امتحان ${idx + 1}`).trim(),
        group: "الامتحان",
        kind: "exam",
        courseId: cid,
        lectureNum: String(lectureNum),
        partNum: String(2000 + idx),
        mesariLessonId: lec.id
      });
    });
    if (!parts.length) {
      parts.push({
        id: `mesari_lesson_${lec.id}`,
        title: lecTitle,
        group: "الشرح",
        kind: "video",
        courseId: cid,
        lectureNum: String(lectureNum),
        partNum: "1",
        videoId: `mesari_lesson_${lec.id}`,
        mesariLessonId: lec.id,
        needsExpand: true
      });
    }
    lectures.push({
      id: `mesari_lec_${lec.id}`,
      title: lecTitle.slice(0, 160),
      courseId: cid,
      lectureNum: String(lectureNum),
      courseTitle: chapterMeta.title,
      image_url: chapterMeta.thumbnail,
      mesariLessonId: lec.id,
      parts
    });
  }

  const out = {
    lectures,
    title: chapterMeta.title,
    image_url: chapterMeta.thumbnail,
    lecturesCount: lectures.length,
    partsCount: lectures.reduce((a, l) => a + (l.parts || []).length, 0)
  };
  chapterCache.set(cid, out);

  // patch live catalog cache
  if (catalogCache.data) {
    for (const th of catalogCache.data.teachers || []) {
      const c = (th.courses || []).find((x) => String(x.id) === cid);
      if (c) {
        c.lectures = lectures;
        c.lecturesCount = out.lecturesCount;
        c.partsCount = out.partsCount;
        if (out.title) c.title = out.title;
        if (out.image_url) c.image_url = out.image_url;
      }
      th.lectures = (th.lectures || []).filter((l) => String(l.courseId) !== cid).concat(lectures);
    }
  }
  return out;
}

export const MESARI_STREAM_HOSTS = [
  "api.mesari.online",
  "mesari.online",
  "vidmoly.me",
  "vidmoly.to",
  "vidmoly.biz",
  "www.vidmoly.me",
  "files.coursatk.online",
  "vmpx.online",
  "vmeas.cloud",
  "staticmoly.me",
  "cdn.staticmoly.me",
  "www.youtube.com",
  "youtube.com",
  "youtu.be"
];

export { subjectSlugFromName as mesariSubjectSlug };
