/**
 * Minimal Thanawica stub — السيرفر يشتغل بدون ثانويكا
 * لو حابب تفعّل ثانويكا لاحقًا استبدل الملف بالنسخة الكاملة
 */

export async function thanawicaLogin() {
  return { ok: false, skipped: true };
}
export async function thSubjectsForYear() {
  return [];
}
export async function thTeachers() {
  return [];
}
export async function thChapters() {
  return [];
}
export async function thLectures() {
  return [];
}
export async function thLectureContent() {
  return null;
}
export async function thGetVideoSource() {
  throw new Error("Thanawica غير مفعّلة");
}
export async function thResolveMp4Url() {
  throw new Error("Thanawica غير مفعّلة");
}
export async function thMintAndFetchSegment() {
  throw new Error("Thanawica غير مفعّلة");
}
export async function thResolvePlaylistHash() {
  return null;
}
export async function thResolveVideo() {
  return null;
}
export function isChemOrMathName() {
  return false;
}
export function chemMathKind() {
  return null;
}
export function isThId(id) {
  return /^th[pvmy]_/i.test(String(id || ""));
}
export function encodeThId(kind, id) {
  return `th${kind}_${id}`;
}
export function decodeThId(raw) {
  const m = String(raw || "").match(/^th([pvmy])_(.+)$/i);
  return m ? { kind: m[1].toLowerCase(), id: m[2] } : null;
}
export function getThanawicaSessionInfo() {
  return { enabled: false };
}
