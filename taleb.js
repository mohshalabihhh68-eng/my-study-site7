/**
 * taleb.pro adapter — كتالوج كامل (مواد / مدرسين / كورسات / محاضرات)
 * التشغيل: AES-128-CBC من video.talep.pro
 */

const DEFAULT_DEVICE_COOKIE = process.env.TALEB_DEVICE || "u8XREM1sQS-oA25H4ap7Mkx59H5JFyHQ2brfZvgU-x8";
const DEFAULT_SESSION_COOKIE = process.env.TALEB_SESSION || "3VdToBgYg6TRxOAbCSHzfLeWXmVAM---UjUIeQCgZwz4pNA018wKOA9r1ZON0gGaV28cEgS4rQzVVhxc1YaglcDaO7yQ6WKR0nwc8qosdur0Ej-t6k-DrbackMb877kHeJC7OCzJqtD0Ete8sxtBttuJcBWLaEW6fzjvK12zWPCvANIZQihAvlcGAvwZeJJpn-ulo-NIXJGTqXZZb-I37w5yxLxLaE-NBxqcjSdm8M_Ad4FF4RfT0ON2fXaSthsI4UmbuXmbGIdzWDgNYLG1ewrK344rYq1dVouSW1XKo51dBLUV25-D_EerIW4";

const TALEB_BASE = "https://talep.pro";
const TALEB_VIDEO_BASE = "https://video.talep.pro";
const TALEB_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

const SUBJECT_NAME_AR = {
  biology: "أحياء",
  chemistry: "كيمياء",
  physics: "فيزياء",
  math: "رياضة",
  maths: "رياضة",
  arabic: "عربي",
  english: "إنجليزي",
  french: "فرنساوي",
  history: "تاريخ",
  geography: "جغرافيا",
  philosophy: "فلسفة",
  psychology: "علم نفس",
  geology: "جيولوجيا",
  pure_math: "رياضة بحتة",
  applied_math: "رياضة تطبيقية",
  statistics: "إحصاء",
  general: "عام"
};

function talebHeaders(extra = {}) {
  const device = process.env.TALEB_DEVICE || DEFAULT_DEVICE_COOKIE;
  const session = process.env.TALEB_SESSION || DEFAULT_SESSION_COOKIE;
  return {
    "user-agent": TALEB_UA,
    accept: "*/*",
    "accept-language": "ar-AE,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    origin: TALEB_BASE,
    referer: TALEB_BASE + "/",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    cookie: `taleb-device=${device}; taleb-session=${session}`,
    ...extra
  };
}

function talebVideoHeaders(extra = {}) {
  return {
    ...talebHeaders({ "sec-fetch-site": "same-site" }),
    ...extra
  };
}

async function talebFetch(url, opts = {}, timeout = 25_000) {
  const signal = AbortSignal.timeout(timeout);
  return fetch(url, { ...opts, signal });
}

async function talebText(url, timeout = 30_000) {
  const r = await talebFetch(url, { headers: talebHeaders({ accept: "text/html" }) }, timeout);
  if (!r.ok) throw new Error(`taleb HTTP ${r.status} ${url}`);
  return r.text();
}

// ---------- API القديمة (إشعارات) ----------
export async function getTalebNotifications() {
  const r = await talebFetch(`${TALEB_BASE}/api/notifications`, {
    headers: talebHeaders({ pragma: "no-cache", "cache-control": "no-cache" })
  });
  if (!r.ok) throw new Error(`taleb notifications HTTP ${r.status}`);
  return r.json();
}

export async function getTalebPlaylist(partId) {
  const url = `${TALEB_VIDEO_BASE}/api/video/${partId}/index.m3u8`;
  const r = await talebFetch(url, { headers: talebVideoHeaders() });
  if (!r.ok) throw new Error(`taleb playlist HTTP ${r.status}`);
  const text = await r.text();
  if (!text.includes("#EXTM3U")) throw new Error("taleb playlist غير صالح");
  return text;
}

export async function getTalebKey(partId) {
  const url = `${TALEB_VIDEO_BASE}/api/video/${partId}/key`;
  const r = await talebFetch(url, { headers: talebVideoHeaders({ accept: "*/*" }) });
  if (!r.ok) throw new Error(`taleb key HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length !== 16) throw new Error(`taleb key length ${buf.length} (expected 16)`);
  return buf;
}

// ---------- زحف الكتالوج الكامل ----------
const catalogCache = { exp: 0, data: null };
const partIdCache = new Map(); // watchKey -> uuid
const COURSE_CONCURRENCY = 4;

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

function subjectNameAr(sid) {
  return SUBJECT_NAME_AR[String(sid || "").toLowerCase()] || String(sid || "مادة");
}

/** اكتشاف المواد من الصفحة الرئيسية */
async function discoverSubjects() {
  const html = await talebText(`${TALEB_BASE}/home`);
  const slugs = [...new Set([...html.matchAll(/\/subjects\/([a-zA-Z0-9_-]+)/g)].map((m) => m[1]))];
  // fallback معروف
  const base = ["biology", "chemistry", "physics", "arabic", "english"];
  for (const s of base) if (!slugs.includes(s)) slugs.push(s);
  return slugs.filter((s) => s && s !== "teachers");
}

/** مدرسو مادة */
async function discoverTeachers(subjectSlug) {
  const html = await talebText(`${TALEB_BASE}/subjects/${encodeURIComponent(subjectSlug)}`);
  const ids = [...new Set([...html.matchAll(new RegExp(`/subjects/${subjectSlug}/teachers/(\\d+)`, "g"))].map((m) => m[1]))];
  // أسماء المدرسين من الروابط إن وُجدت
  const teachers = [];
  for (const id of ids) {
    let name = `مدرس ${id}`;
    const re = new RegExp(`/subjects/${subjectSlug}/teachers/${id}"[^>]*>[\\s\\S]{0,300}?([\\u0600-\\u06FF][^<]{2,60})`, "m");
    const m = html.match(re);
    if (m) name = m[1].replace(/\s+/g, " ").trim();
    // محاولة ثانية: نص عربي قريب
    if (name.startsWith("مدرس")) {
      const idx = html.indexOf(`/subjects/${subjectSlug}/teachers/${id}`);
      if (idx >= 0) {
        const slice = html.slice(Math.max(0, idx - 200), idx + 400);
        const ar = slice.match(/[\u0600-\u06FF][\u0600-\u06FF\s.\d]{3,40}/);
        if (ar) name = ar[0].replace(/\s+/g, " ").trim();
      }
    }
    name = String(name || "").replace(/["'].*$/, "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() || `مدرس ${id}`;
    teachers.push({
      id: `taleb_t_${subjectSlug}_${id}`,
      numericId: id,
      name,
      subjectId: subjectSlug,
      subjectSlug
    });
  }
  return teachers;
}

/** كورسات مدرس */
async function discoverCourses(subjectSlug, teacherNumericId) {
  const html = await talebText(`${TALEB_BASE}/subjects/${encodeURIComponent(subjectSlug)}/teachers/${teacherNumericId}`);
  const ids = [...new Set([...html.matchAll(/\/courses\/(\d+)/g)].map((m) => m[1]))];
  const courses = [];
  for (const id of ids) {
    let title = `كورس ${id}`;
    const idx = html.indexOf(`/courses/${id}`);
    if (idx >= 0) {
      const slice = html.slice(Math.max(0, idx - 100), idx + 500);
      const ar = slice.match(/[\u0600-\u06FF][\u0600-\u06FF\s\w.+ـ\-]{4,80}/);
      if (ar) title = ar[0].replace(/\s+/g, " ").trim();
    }
    courses.push({ id, title, subjectSlug, teacherNumericId });
  }
  return courses;
}

/** محاضرات/أجزاء كورس من cv-item */
async function parseCourseParts(courseId) {
  const html = await talebText(`${TALEB_BASE}/courses/${courseId}`, 45_000);
  const titleM = html.match(/<title>([^<]+)<\/title>/i);
  let courseTitle = titleM ? titleM[1].replace(/\s*\|\s*طالب برو.*$/i, "").trim() : `كورس ${courseId}`;
  courseTitle = courseTitle.replace(/^طالب برو\s*\|\s*/i, "").trim();

  const items = [];
  const re = /<a class="cv-item" href="\/watch\/(\d+)\/(\d+)\/(\d+)"[^>]*>[\s\S]*?<span class="cv-item-title"[^>]*>([^<]+)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    items.push({
      courseId: m[1],
      lectureNum: m[2],
      partNum: m[3],
      title: m[4].replace(/\s+/g, " ").trim(),
      watchPath: `/watch/${m[1]}/${m[2]}/${m[3]}`
    });
  }
  // مجموعات العناوين (اختياري)
  const groups = [...html.matchAll(/cv-group-title[^>]*>([^<]+)/g)].map((x) => x[1].trim());
  return { courseTitle, items, groups };
}

/** تحويل مسار watch → UUID الجزء (part.id) */
export async function resolveTalebPartId(courseId, lectureNum, partNum) {
  const key = `${courseId}/${lectureNum}/${partNum}`;
  if (partIdCache.has(key)) return partIdCache.get(key);

  const html = await talebText(`${TALEB_BASE}/watch/${courseId}/${lectureNum}/${partNum}`, 40_000);
  // "part":{"id":"uuid"
  let m = html.match(/\\"part\\":\{\\"id\\":\\"([0-9a-f-]{36})\\"/);
  if (!m) m = html.match(/"part":\{"id":"([0-9a-f-]{36})"/);
  if (!m) m = html.match(/data-subject="[^"]*"[\s\S]{0,200}?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  // fallback: أول videoSrc بعد كلمة part
  if (!m) {
    const idx = html.search(/part\\":\{/);
    if (idx >= 0) {
      const slice = html.slice(idx, idx + 500);
      const m2 = slice.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      if (m2) m = m2;
    }
  }
  if (!m) throw new Error(`تعذر استخراج partId من /watch/${key}`);
  const uuid = m[1];
  partIdCache.set(key, uuid);
  return uuid;
}

/**
 * كتالوج كامل:
 * subjects[] → teachers[] → courses[] → lectures (parts)
 */
export async function crawlTalebFullCatalog() {
  const nowMs = Date.now();
  if (catalogCache.data && nowMs < catalogCache.exp) return catalogCache.data;

  console.log("[taleb] crawling full catalog…");
  const subjectSlugs = await discoverSubjects();
  const subjects = [];
  const teachersFlat = [];

  for (const slug of subjectSlugs) {
    let teachers = [];
    try {
      teachers = await discoverTeachers(slug);
    } catch (e) {
      console.warn("[taleb] subject", slug, e.message);
      continue;
    }
    const subjectTeachers = [];

    for (const th of teachers) {
      let courses = [];
      try {
        courses = await discoverCourses(slug, th.numericId);
      } catch (e) {
        console.warn("[taleb] teacher courses", th.id, e.message);
      }

      const courseDetails = await mapPool(courses, COURSE_CONCURRENCY, async (c) => {
        try {
          const parsed = await parseCourseParts(c.id);
          return { ...c, title: parsed.courseTitle || c.title, parts: parsed.items || [] };
        } catch (e) {
          console.warn("[taleb] course", c.id, e.message);
          return { ...c, parts: [] };
        }
      });

      // محاضرات = كل جزء فيديو
      const lectures = [];
      for (const c of courseDetails) {
        // جمّع حسب lectureNum كـ "محاضرة"
        const byLec = new Map();
        for (const p of c.parts || []) {
          const ln = p.lectureNum;
          if (!byLec.has(ln)) byLec.set(ln, []);
          byLec.get(ln).push(p);
        }
        if (!byLec.size && (c.parts || []).length === 0) {
          // كورس فاضي — سجّل الكورس كعنصر
          lectures.push({
            id: `taleb_course_${c.id}`,
            title: c.title,
            courseId: c.id,
            parts: []
          });
          continue;
        }
        for (const [ln, parts] of byLec) {
          const mainTitle = parts[0]?.title || `محاضرة ${ln}`;
          // عنوان أبسط: لو كل الأجزاء لنفس المحاضرة
          lectures.push({
            id: `taleb_lec_${c.id}_${ln}`,
            title: `${c.title} — ${mainTitle}`.slice(0, 120),
            courseId: c.id,
            lectureNum: ln,
            courseTitle: c.title,
            parts: parts.map((p) => ({
              id: `taleb_w_${p.courseId}_${p.lectureNum}_${p.partNum}`,
              title: p.title,
              courseId: p.courseId,
              lectureNum: p.lectureNum,
              partNum: p.partNum,
              watchPath: p.watchPath,
              videoId: `taleb_w_${p.courseId}_${p.lectureNum}_${p.partNum}`
            }))
          });
        }
      }

      const teacherObj = {
        id: th.id,
        name: th.name,
        subjectId: slug,
        subjectSlug: slug,
        numericId: th.numericId,
        courses: courseDetails.map((c) => ({
          id: c.id,
          title: c.title,
          partsCount: (c.parts || []).length
        })),
        lectures
      };
      subjectTeachers.push(teacherObj);
      teachersFlat.push(teacherObj);
    }

    subjects.push({
      id: slug,
      name: subjectNameAr(slug),
      image_url: null,
      teachers: subjectTeachers
    });
  }

  const data = {
    subjects,
    teachers: teachersFlat,
    crawledAt: nowMs,
    stats: {
      subjects: subjects.length,
      teachers: teachersFlat.length,
      lectures: teachersFlat.reduce((a, t) => a + (t.lectures || []).length, 0),
      parts: teachersFlat.reduce(
        (a, t) => a + (t.lectures || []).reduce((b, l) => b + (l.parts || []).length, 0),
        0
      )
    }
  };
  console.log("[taleb] catalog ready", data.stats);
  catalogCache.data = data;
  catalogCache.exp = nowMs + 30 * 60_000; // 30 دقيقة
  return data;
}

/** متوافق مع النسخة القديمة — يرجع مدرسين من الكتالوج الكامل */
export async function getTalebTeachers() {
  try {
    const cat = await crawlTalebFullCatalog();
    return cat.teachers.map((t) => ({
      id: t.id,
      name: t.name,
      subjectId: t.subjectId,
      subjectIcon: null,
      lectures: (t.lectures || []).flatMap((lec) =>
        (lec.parts || []).map((p) => ({
          courseId: p.courseId,
          lectureId: p.lectureNum,
          partId: p.id, // watch-based id; resolve at play
          title: p.title || lec.title,
          createdAt: null,
          videoId: p.videoId
        }))
      )
    }));
  } catch (e) {
    console.warn("[taleb] full catalog failed, fallback notifications:", e.message);
    // fallback إشعارات
    const data = await getTalebNotifications();
    const items = data.items || [];
    const teacherMap = new Map();
    for (const item of items) {
      if (!item.teacherName) continue;
      const key = item.teacherName;
      if (!teacherMap.has(key)) {
        teacherMap.set(key, {
          id: `taleb_t_${key.replace(/\s+/g, "_")}`,
          name: item.teacherName,
          subjectId: item.subjectId || null,
          subjectIcon: item.subjectIcon || null,
          lectures: []
        });
      }
      const urlMatch = (item.url || "").match(/\/watch\/([^/]+)\/([^/]+)\/([^/]+)/);
      if (urlMatch) {
        teacherMap.get(key).lectures.push({
          courseId: urlMatch[1],
          lectureId: urlMatch[2],
          partId: urlMatch[3],
          title: item.lectureTitle || item.body || item.title,
          createdAt: item.createdAt,
          videoId: `taleb_${urlMatch[3]}`
        });
      }
    }
    return [...teacherMap.values()];
  }
}

/** بناء مصدر تشغيل من part UUID */
export async function buildTalebSource(partId) {
  const playlistText = await getTalebPlaylist(partId);
  const plainKey = await getTalebKey(partId);

  const lines = playlistText.split(/\r?\n/);
  let mediaSeq = 0;
  let targetDuration = 13;
  let currentIv = null;
  let segIndex = 0;
  const segs = [];
  const SID_TOKEN = "{{SID}}";
  const outLines = [];

  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("#EXT-X-MEDIA-SEQUENCE:")) mediaSeq = Number(t.split(":")[1]) || 0;
    if (t.startsWith("#EXT-X-TARGETDURATION:")) targetDuration = Number(t.split(":")[1]) || targetDuration;
    if (t.startsWith("#EXT-X-KEY:")) {
      const ivM = t.match(/IV=(0x[0-9a-fA-F]+|[0-9a-fA-F]{32})/i);
      if (ivM) {
        const h = ivM[1].replace(/^0x/i, "");
        currentIv = Buffer.from(h.padStart(32, "0"), "hex");
      }
    }
  }

  function ivFromSeq(seq) {
    const iv = Buffer.alloc(16, 0);
    iv.writeUInt32BE(seq >>> 0, 12);
    return iv;
  }

  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("#EXT-X-KEY:")) continue;
    if (t.startsWith("#EXTINF:")) {
      outLines.push(raw);
      continue;
    }
    if (t && !t.startsWith("#")) {
      let segUrl;
      if (t.startsWith("http")) segUrl = t;
      else segUrl = `${TALEB_VIDEO_BASE}${t.startsWith("/") ? "" : "/"}${t}`;
      const seq = mediaSeq + segIndex;
      const iv = currentIv || ivFromSeq(seq);
      segs.push({
        u: segUrl,
        iv: iv.toString("hex"),
        s: seq,
        i: segIndex,
        dur: targetDuration
      });
      outLines.push(`/api/hls/${SID_TOKEN}/seg/${segIndex}`);
      segIndex++;
      continue;
    }
    outLines.push(raw);
  }

  if (!segs.length) throw new Error("taleb: مفيش مقاطع في الـ playlist");

  return {
    reqVideoId: `taleb_${partId}`,
    videoId: partId,
    mode: "taleb",
    token: "taleb",
    streamUrl: `${TALEB_VIDEO_BASE}/api/video/${partId}/index.m3u8`,
    allowedHosts: new Set(["video.talep.pro", "talep.pro"]),
    plainKey,
    defaultIv: currentIv || ivFromSeq(mediaSeq),
    mediaSeq,
    targetDuration,
    segs,
    playlist: outLines.join("\n"),
    createdAt: Date.now(),
    directSegments: false,
    cipherMode: "cbc",
    ivMode: "playlist"
  };
}

/**
 * تشغيل من معرّف مرن:
 * - taleb_{uuid}
 * - taleb_w_{course}_{lec}_{part}
 * - uuid خام
 */
export async function buildTalebSourceFromAnyId(rawId) {
  let id = String(rawId || "").trim();
  if (id.startsWith("taleb_w_")) {
    const rest = id.slice("taleb_w_".length);
    const [courseId, lectureNum, partNum] = rest.split("_");
    const uuid = await resolveTalebPartId(courseId, lectureNum, partNum);
    const src = await buildTalebSource(uuid);
    src.reqVideoId = id;
    return src;
  }
  if (id.startsWith("taleb_")) id = id.slice(6);
  // uuid
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return buildTalebSource(id);
  }
  // watch numeric path course/lec/part
  if (/^\d+\/\d+\/\d+$/.test(id)) {
    const [c, l, p] = id.split("/");
    const uuid = await resolveTalebPartId(c, l, p);
    return buildTalebSource(uuid);
  }
  throw new Error("معرّف taleb غير معروف: " + rawId);
}

export const TALEB_STREAM_HOSTS = ["video.talep.pro", "talep.pro"];

export function updateTalebCookies(device, session) {
  if (device) process.env.TALEB_DEVICE = device;
  if (session) process.env.TALEB_SESSION = session;
  catalogCache.exp = 0;
  catalogCache.data = null;
  partIdCache.clear();
}

export { subjectNameAr };
