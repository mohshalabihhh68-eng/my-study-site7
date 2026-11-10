# Thanawya Club — taleb.pro source

## الملفات المطلوبة على GitHub (جذر المشروع)

```
server.js          # السيرفر الرئيسي v1.8.0
taleb.js           # محوّل taleb.pro (playlist + key + teachers)
thanawica.js       # stub خفيف (مطلوب للاستيراد — مش مصدر المحتوى)
package.json       # لو موجود عندك سيبه
public/            # الفرونت (player.html …) لو عندك
```

## Variables في Railway (بدل COURSATK_TOKEN)

| Variable | مطلوب؟ | مثال / ملاحظة |
|---|---|---|
| `TALEB_DEVICE` | **نعم** | قيمة كوكي `taleb-device` |
| `TALEB_SESSION` | **نعم** | قيمة كوكي `taleb-session` |
| `PORT` | لا | Railway بيضبطه تلقائي |
| `HOST` | لا | الافتراضي `0.0.0.0` |
| `FIREBASE_URL` / إعدادات Firebase | حسب مشروعك | للكتالوج/الطلاب لو بتستخدمهم |
| `COURSATK_TOKEN` | **لا** (اختياري) | مش محتاجينها لو المصدر taleb فقط |
| `THANAWICA_ENABLED` | لا | سيبه فاضي/0 |

### منين تجيب الكوكيز؟
من المتصفح وأنت فاتح `https://talep.pro` → Application → Cookies:
- `taleb-device`
- `taleb-session`

أو من لوحة الأدمن بعد الرفع:
`PUT /api/admin/taleb/cookies` body: `{ "device":"...", "session":"..." }`

## تشغيل فيديو

معرّف الفيديو:
```
taleb_{partId}
```
مثال:
```
taleb_efb0745c-f2c1-4dad-843a-78d859bc4b1f
```

Endpoints:
- `GET /api/taleb/teachers` — المدرسين + محاضرات من الإشعارات
- `POST /api/taleb/play/:partId` — تشغيل مباشر
- `POST /api/play/taleb_{partId}` — نفس مسار التشغيل العام
- `GET /api/admin/taleb/status` — هل الكوكيز شغالة؟

## ملاحظات
- التشفير: AES-128-CBC، المفتاح من `video.talep.pro/api/video/{partId}/key`
- السيرفر بيفك المقاطع قبل ما يبعتها للمشغّل
- لو الكوكيز انتهت حدّث `TALEB_DEVICE` و `TALEB_SESSION`
