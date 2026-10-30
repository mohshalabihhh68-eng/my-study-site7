# ثانوية club — نشر على Vercel

## مهم جدًا اقرأ ده الأول

المشروع الأصلي مصمم كـ **سيرفر Node دائم** (Railway).  
على Vercel بيشتغل كـ **Serverless Functions**.

| الميزة | الحالة على Vercel |
|--------|-------------------|
| الصفحات (HTML) | ✅ ممتازة وسريعة |
| تسجيل الدخول / المواد / المدرسين | ✅ |
| لوحة الأدمن | ✅ (مع Firebase) |
| بث HLS + فك التشفير | ⚠️ يشتغل غالبًا، مع Cold Start أحيانًا |
| الجلسات في الذاكرة | ⚠️ تتصفر مع كل Cold Start (الاعتماد الأساسي على Firebase/التوكن) |
| SSE / رسائل لحظية طويلة | ⚠️ محدودة بمدة الدالة |
| الاستخدام التجاري | ⚠️ باقة Hobby للشخصي فقط — للاشتراكات المدفوعة يلزم Pro |

**المدة القصوى للدالة:** 60 ثانية (Hobby قد يحدّها أقل حسب الحساب).  
البث الطويل يعتمد على طلبات متعددة قصيرة (كل مقطع segment) — ده مناسب أكثر من اتصال واحد طويل.

---

## خطوات الرفع (10 دقايق)

### 1) ارفع على GitHub
```bash
cd thanawya-vercel
git init
git add .
git commit -m "Thanawya Club Vercel"
# اعمل ريبو جديد على GitHub ثم:
git remote add origin https://github.com/YOUR_USER/thanawya-club.git
git branch -M main
git push -u origin main
```

### 2) اربط Vercel
1. ادخل [vercel.com](https://vercel.com) وسجّل بـ GitHub (بدون بطاقة للـ Hobby).
2. **Add New Project** → اختار الريبو.
3. Framework Preset: **Other**
4. Root Directory: اتركه فاضي
5. Build Command: اتركه فاضي (أو `npm install`)
6. Output Directory: اتركه فاضي — الـ `public/` بيتعامل معاه Vercel تلقائي

### 3) Environment Variables (مهم)
في Project → Settings → Environment Variables أضف:

| Key | Value |
|-----|--------|
| `FIREBASE_URL` | رابط Firebase بتاعك |
| `ADMIN_USER` | admin |
| `ADMIN_PASSWORD` | باسورد قوي |
| `THANAWICA_ENABLED` | `1` |
| `THANAWICA_CODE` | كود ثناويكا (أو اعتمد على `thanawica_cookies.txt`) |
| `COURSATK_TOKEN` | لو موجود |

Apply على **Production + Preview**.

### 4) Deploy
اضغط Deploy. بعد ما يخلص هتاخد رابط زي:
`https://thanawya-club.vercel.app`

---

## ملفات مهمة في المشروع

```
thanawya-vercel/
├── public/           ← كل صفحات الموقع
│   ├── index.html
│   ├── login.html
│   ├── player.html
│   ├── admin.html
│   └── ...
├── api/index.js      ← مدخل Vercel للـ API
├── server.js         ← الباك إند كامل
├── thanawica.js
├── thanawica_decrypt.wasm
├── thanawica_cookies.txt
├── vercel.json
└── package.json
```

---

## لو البث فشل أو بطّأ

1. تأكد إن `thanawica_decrypt.wasm` و `thanawica_cookies.txt` موجودين في الريبو.
2. في Vercel → Functions تأكد إن الذاكرة 1024MB و maxDuration 60.
3. Cold start أول طلب بعد سكون ممكن ياخد 3–8 ثواني — بعده أسرع.
4. راقب Logs: Vercel Dashboard → Deployments → Function Logs.

---

## تشغيل محلي للتجربة

```bash
npm install
cp .env.example .env
# عدّل .env
npm start
# افتح http://localhost:3000
```

أو:
```bash
npx vercel dev
```

---

## بديل أقوى للبث الدائم

لو لاحظت مشاكل في الفيديو على Vercel، الحل الأفضل:
- **فرونت** على Vercel (سريع)
- **باك إند** على Render (بدون بطاقة، ينام بعد خمول)

وفي الحالة دي غيّر في الصفحات أو حط:
```js
const API_BASE = 'https://your-app.onrender.com';
```

---

تم تجهيز الملفات بواسطة Grok — ثانوية club v1.7.2
