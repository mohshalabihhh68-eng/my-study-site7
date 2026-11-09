/**
 * taleb.pro adapter — يستبدل coursatk كمصدر للمحتوى
 * يجلب المدرسين والمحاضرات والفيديوهات من taleb.pro
 * التشفير: AES-128-CBC مع مفتاح من /api/video/{partId}/key
 */

// ============================================================
// الكوكيز المستخرجة من الترافيك — غيّرها لو انتهت
// ============================================================
const DEFAULT_DEVICE_COOKIE = process.env.TALEB_DEVICE || "u8XREM1sQS-oA25H4ap7Mkx59H5JFyHQ2brfZvgU-x8";
const DEFAULT_SESSION_COOKIE = process.env.TALEB_SESSION || "3VdToBgYg6TRxOAbCSHzfLeWXmVAM---UjUIeQCgZwz4pNA018wKOA9r1ZON0gGaV28cEgS4rQzVVhxc1YaglcDaO7yQ6WKR0nwc8qosdur0Ej-t6k-DrbackMb877kHeJC7OCzJqtD0Ete8sxtBttuJcBWLaEW6fzjvK12zWPCvANIZQihAvlcGAvwZeJJpn-ulo-NIXJGTqXZZb-I37w5yxLxLaE-NBxqcjSdm8M_Ad4FF4RfT0ON2fXaSthsI4UmbuXmbGIdzWDgNYLG1ewrK344rYq1dVouSW1XKo51dBLUV25-D_EerIW4";

const TALEB_BASE = "https://talep.pro";
const TALEB_VIDEO_BASE = "https://video.talep.pro";

const TALEB_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

// بناء هيدرات الطلب بالكوكيز
function talebHeaders(extra = {}) {
  const device = process.env.TALEB_DEVICE || DEFAULT_DEVICE_COOKIE;
  const session = process.env.TALEB_SESSION || DEFAULT_SESSION_COOKIE;
  return {
    "user-agent": TALEB_UA,
    "accept": "*/*",
    "accept-language": "ar-AE,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    "origin": TALEB_BASE,
    "referer": TALEB_BASE + "/",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "cookie": `taleb-device=${device}; taleb-session=${session}`,
    ...extra
  };
}

function talebVideoHeaders(extra = {}) {
  const device = process.env.TALEB_DEVICE || DEFAULT_DEVICE_COOKIE;
  const session = process.env.TALEB_SESSION || DEFAULT_SESSION_COOKIE;
  return {
    "user-agent": TALEB_UA,
    "accept": "*/*",
    "accept-language": "ar-AE,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    "origin": TALEB_BASE,
    "referer": TALEB_BASE + "/",
    "sec-fetch-site": "same-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "cookie": `taleb-device=${device}; taleb-session=${session}`,
    ...extra
  };
}

// fetch بسيط مع timeout
async function talebFetch(url, opts = {}, timeout = 20_000) {
  const signal = AbortSignal.timeout(timeout);
  return fetch(url, { ...opts, signal });
}

// ============================================================
// جلب قائمة الإشعارات (تحتوي على المدرسين والكورسات)
// ============================================================
export async function getTalebNotifications() {
  const r = await talebFetch(`${TALEB_BASE}/api/notifications`, {
    headers: talebHeaders({
      "pragma": "no-cache",
      "cache-control": "no-cache",
      "sec-fetch-site": "same-origin"
    })
  });
  if (!r.ok) throw new Error(`taleb notifications HTTP ${r.status}`);
  return r.json();
}

// ============================================================
// جلب كورسات مدرس معين
// pattern من الإشعارات: /watch/{courseId}/{lectureId}/{partId}
// بنجيب الكورس من /api/courses/{courseId} أو نبني من الإشعارات
// ============================================================
export async function getTalebCourse(courseId) {
  // /courses/{id} — Next.js RSC endpoint
  const url = `${TALEB_BASE}/api/course/${courseId}`;
  const r = await talebFetch(url, {
    headers: talebHeaders({ "sec-fetch-site": "same-origin" })
  });
  if (!r.ok) {
    // جرّب endpoint تاني
    const r2 = await talebFetch(`${TALEB_BASE}/api/courses/${courseId}`, {
      headers: talebHeaders({ "sec-fetch-site": "same-origin" })
    });
    if (!r2.ok) throw new Error(`taleb course ${courseId} HTTP ${r2.status}`);
    return r2.json();
  }
  return r.json();
}

// ============================================================
// جلب playlist.m3u8 لجزء (part) محدد
// partId هو UUID مثل 163ac56c-ed17-4af4-bf1d-cf99eb01769f
// ============================================================
export async function getTalebPlaylist(partId) {
  const url = `${TALEB_VIDEO_BASE}/api/video/${partId}/index.m3u8`;
  const r = await talebFetch(url, {
    headers: talebVideoHeaders()
  });
  if (!r.ok) throw new Error(`taleb playlist HTTP ${r.status}`);
  const text = await r.text();
  if (!text.includes("#EXTM3U")) throw new Error("taleb playlist غير صالح");
  return text;
}

// ============================================================
// جلب مفتاح AES-128 لفيديو
// ============================================================
export async function getTalebKey(partId) {
  const url = `${TALEB_VIDEO_BASE}/api/video/${partId}/key`;
  const r = await talebFetch(url, {
    headers: talebVideoHeaders({ "accept": "*/*" })
  });
  if (!r.ok) throw new Error(`taleb key HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length !== 16) throw new Error(`taleb key length ${buf.length} (expected 16)`);
  return buf;
}

// ============================================================
// بناء مصدر تشغيل كامل من partId
// يرجع كائن src متوافق مع باقي السيرفر
// ============================================================
export async function buildTalebSource(partId) {
  // جلب الـ playlist
  const playlistText = await getTalebPlaylist(partId);
  
  // جلب المفتاح
  const plainKey = await getTalebKey(partId);

  // parse الـ playlist
  const lines = playlistText.split(/\r?\n/);
  let mediaSeq = 0;
  let targetDuration = 13;
  let currentIv = null;
  let segIndex = 0;
  const segs = [];
  const SID_TOKEN = "{{SID}}"; // placeholder يتبدل لاحقاً
  const outLines = [];

  // استخرج IV من الـ playlist
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

  // helper: IV من sequence number
  function ivFromSeq(seq) {
    const iv = Buffer.alloc(16, 0);
    iv.writeUInt32BE(seq >>> 0, 12);
    return iv;
  }

  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("#EXT-X-KEY:")) {
      // skip — السيرفر يفك التشفير قبل الإرسال
      continue;
    }
    if (t.startsWith("#EXTINF:")) {
      outLines.push(raw);
      continue;
    }
    if (t && !t.startsWith("#")) {
      // رابط segment — إما مطلق أو نسبي
      let segUrl;
      if (t.startsWith("http")) {
        segUrl = t;
      } else {
        // نسبي من video.talep.pro
        segUrl = `${TALEB_VIDEO_BASE}${t.startsWith("/") ? "" : "/"}${t}`;
      }
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
    if (t.startsWith("#EXT-X-KEY:")) continue; // already handled
    outLines.push(raw);
  }

  if (!segs.length) throw new Error("taleb: مفيش مقاطع في الـ playlist");

  // بناء الـ playlist النهائي
  const playlistOut = outLines.join("\n");

  return {
    reqVideoId: `taleb_${partId}`,
    videoId: partId,
    mode: "taleb",
    token: "taleb",
    streamUrl: `${TALEB_VIDEO_BASE}/api/video/${partId}/index.m3u8`,
    allowedHosts: new Set([
      "video.talep.pro",
      "talep.pro"
    ]),
    plainKey,
    defaultIv: currentIv || ivFromSeq(mediaSeq),
    mediaSeq,
    targetDuration,
    segs,
    playlist: playlistOut,
    createdAt: Date.now(),
    directSegments: false,
    cipherMode: "cbc",
    ivMode: "playlist" // IV من الـ playlist أو seq
  };
}

// ============================================================
// جلب المدرسين من الإشعارات وتحويلهم لصيغة موحدة
// ============================================================
export async function getTalebTeachers() {
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
    // استخرج courseId و lectureId من الـ URL
    const urlMatch = (item.url || "").match(/\/watch\/([^/]+)\/([^/]+)\/([^/]+)/);
    if (urlMatch) {
      teacherMap.get(key).lectures.push({
        courseId: urlMatch[1],
        lectureId: urlMatch[2],
        partId: urlMatch[3],
        title: item.lectureTitle || item.body || item.title,
        createdAt: item.createdAt
      });
    }
  }
  return [...teacherMap.values()];
}

// ============================================================
// الـ STREAM_HOSTS المسموحة لـ taleb
// ============================================================
export const TALEB_STREAM_HOSTS = [
  "video.talep.pro",
  "talep.pro"
];

// ============================================================
// تحديث الكوكيز في runtime (من لوحة الأدمن مثلاً)
// ============================================================
export function updateTalebCookies(device, session) {
  process.env.TALEB_DEVICE = device;
  process.env.TALEB_SESSION = session;
}
