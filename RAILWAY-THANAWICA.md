# ثانويكا كمصدر أساسي — Railway

## الملفات (استبدل القديمة)

- server.js
- thanawica.js
- thanawica_decrypt.wasm
- thanawica_cookies.txt

## متغيرات البيئة (Railway → Variables)

انسخها كما هي:

```
CONTENT_SOURCE=thanawica
THANAWICA_PRIMARY=1
THANAWICA_ENABLED=1
THANAWICA_CODE=44275012
THANAWICA_COOKIES=student_code=44275012; student_session=5a8cd545c9bcb4c022cda3e7c848f4e0b1f94829608cfb48df0b5a8310acacb1; student_device=8457eb08d59b41a3c7af23355e5d87128f6d58e31549113521b16b7272d9fe59; student_device_proof=44275012.b22bbd7d68ab89c3ef4a97232d101ff741fbc92beecd55b5b3a1a7d60c714f5d.969e7f09379f552bb343b13a26ae1f3a1a67c3ed9cf8004a4cf619d2eba95c4c.1795538858.RvYP-HtHrLEtk7_1tH2ax8G0Ab0sidzq1oqIRGzzmWc; cf_clearance=CillOGwVk99sS4VlFCmDrLMJ8_qavd_2mPMPKjlJ4_TD-g_Ci9SgzYXHMsj_MCgIVpru8nSR3mEPU5IeFly1XZZ9n4epAqbDo4d0t5_ssvHrrR0h7wmxYX01am1f-AlFQvRkae-9dCBFaSjdrsb_xk0hRqjH9IEAG8r6LyfJ8HR5SbVCvxoZtW2oT9LEk_l5JAxnPRwN1S3pN4Jt3Kf4xHZ6Ntw7oq6TNH-SupTydhpac1ZzHWGJpbhKIrq6vGn4zQsffd1H1Ug1Xvj-ib2HVSv2FVHMON_nMtEvtfWR4OH6; subscribe_ref=yofa
```

**مهم:** لو الجلسة انتهت (403 على المقاطع) حدّث `THANAWICA_COOKIES` من المتصفح بعد ما تدخل تاني على thanawica.com.

## باقي المتغيرات (زي ما كانت)

- FIREBASE_URL
- ADMIN_USER / ADMIN_PASSWORD
- أي توكنات تانية لو محتاجها

## اللي اتعمل حسب الـ capture

1. mint batch: `{ videoId, segNames: [...] }` → `{ tokens: [{segName,iat,tok}] }`
2. مسار المقاطع: `/api/c/{hash}/600/seg_N.dat?v=&iat=&tok=`
3. referer للمقاطع والـ playlist: `https://thanawica.com/sw.js`
4. تفضيل جودة 600
5. فك التشفير AES-128 بالـ WASM من x-km / x-ks + IV لكل مقطع
6. المصدر الأساسي ثانويكا بدل مساري

## بعد الرفع

في اللوج لازم تشوف:
```
[API] thanawica.js loaded
[API] Thanawica ON · primary= true
[thanawica] using ready cookies (no login)
```
