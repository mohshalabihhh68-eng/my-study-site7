/**
 * Vercel catch-all for /api/*
 * يحافظ على المسار الكامل عشان راوتس Express تتطابق
 */
import app from "../server.js";

export default function handler(req, res) {
  // في بعض الحالات Vercel بيبعت المسار بدون /api أو بيغيّر url
  const original = req.url || "/";
  if (!original.startsWith("/api")) {
    // path params من [...path] موجودة في req.query.path أحيانًا
    const parts = req.query?.path;
    if (Array.isArray(parts) && parts.length) {
      req.url = "/api/" + parts.join("/") + (original.includes("?") ? original.slice(original.indexOf("?")) : "");
    } else if (typeof parts === "string" && parts) {
      req.url = "/api/" + parts + (original.includes("?") ? original.slice(original.indexOf("?")) : "");
    } else if (original === "/" || original.startsWith("/?")) {
      req.url = "/api" + original;
    } else {
      req.url = "/api" + (original.startsWith("/") ? original : "/" + original);
    }
  }
  return app(req, res);
}
