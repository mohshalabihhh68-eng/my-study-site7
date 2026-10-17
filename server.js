const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// التوكن بتاع كورساتك
const COURSATK_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxMDczNjMsInJvbGUiOiJzdHVkZW50IiwidXVpZCI6IjYwYTU0MzZiMDY2MzU4NmI1MDQwOTBhZTM3ZThmOWM5In0.Jz2LWCWeYW6O6Y3h_MntJJi8mcauFhRjcInC37Ns5wI";

const coursatk = axios.create({
  baseURL: 'https://api.coursatk.online/api/v1',
  headers: {
    'Authorization': `Bearer ${COURSATK_TOKEN}`,
    'Origin': 'https://coursatk.online',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
    'Referer': 'https://coursatk.online/',
    'X-Requested-With': 'XMLHttpRequest'
  },
  timeout: 15000
});

// ==================================================
// 🔍 endpoint تشخيصي: بيجرب مسارات كتير ويوريك الرد
// ==================================================
app.get('/api/debug/endpoints', async (req, res) => {
  const endpoints = [
    // المستخدم
    '/user',
    '/user/profile',
    '/user/dashboard',
    '/user/courses',
    '/user/my-courses',
    '/user/enrollments',
    '/user/subscriptions',
    '/user/lectures',
    '/user/library',
    '/user/content',
    '/user/me',
    '/me',
    '/profile',
    '/dashboard',
    '/home',
    // الكورسات
    '/courses',
    '/courses/my',
    '/courses/enrolled',
    '/courses/list',
    '/my-courses',
    '/enrollments',
    '/subscriptions',
    // الطالب
    '/student',
    '/student/courses',
    '/student/dashboard',
    '/student/enrollments',
    '/student/my-courses',
    // المحاضرات
    '/lectures',
    '/user/lectures/all',
    '/videos',
    '/user/videos',
    // مسارات بديلة
    '/student/lectures',
    '/courses/enrolled/list',
  ];

  const results = [];

  for (const ep of endpoints) {
    try {
      const response = await coursatk.get(ep);
      results.push({
        endpoint: ep,
        status: response.status,
        ok: true,
        preview: JSON.stringify(response.data).slice(0, 400)
      });
    } catch (err) {
      results.push({
        endpoint: ep,
        status: err.response?.status || 'ERR',
        ok: false,
        message: (err.response?.data?.message || err.message || '').slice(0, 150)
      });
    }
  }

  // ملخص سريع
  const working = results.filter(r => r.ok).map(r => r.endpoint);

  res.json({
    total: endpoints.length,
    workingEndpoints: working,
    results
  });
});

// ==================================================
// 📚 جلب كل الكورسات
// ==================================================
app.get('/api/courses', async (req, res) => {
  const endpoints = [
    '/user/courses',
    '/courses',
    '/my-courses',
    '/user/enrollments',
    '/enrollments',
    '/student/courses',
    '/user/dashboard',
    '/user/subscriptions',
    '/subscriptions',
  ];

  const tried = [];

  for (const ep of endpoints) {
    try {
      const response = await coursatk.get(ep);
      const body = response.data;

      const candidates = [
        body?.data,
        body?.data?.courses,
        body?.courses,
        body?.data?.enrollments,
        body?.enrollments,
        body?.data?.data,
        body?.results,
        body?.data?.subscriptions,
        body?.subscriptions,
      ];

      for (const arr of candidates) {
        if (Array.isArray(arr) && arr.length > 0) {
          return res.json({
            success: true,
            endpoint: ep,
            count: arr.length,
            courses: arr,
            raw: body
          });
        }
      }

      tried.push({
        endpoint: ep,
        status: response.status,
        note: 'نجح لكن مفيش مصفوفة كورسات معروفة',
        raw: body
      });
    } catch (err) {
      tried.push({
        endpoint: ep,
        status: err.response?.status || 'ERR',
        message: err.response?.data?.message || err.message
      });
    }
  }

  res.status(404).json({
    success: false,
    message: 'مفيش endpoint رجع كورسات. افتح /api/debug/endpoints وشوف المسارات الشغالة.',
    tried
  });
});

// ==================================================
// 🎬 جلب محاضرات كورس معين
// ==================================================
app.get('/api/courses/:courseId/lectures', async (req, res) => {
  const { courseId } = req.params;
  const endpoints = [
    `/user/courses/${courseId}/lectures`,
    `/user/courses/${courseId}`,
    `/courses/${courseId}/lectures`,
    `/courses/${courseId}`,
    `/user/courses/${courseId}/content`,
    `/user/enrollments/${courseId}`,
    `/enrollments/${courseId}`,
  ];

  const tried = [];

  for (const ep of endpoints) {
    try {
      const response = await coursatk.get(ep);
      const body = response.data;

      const candidates = [
        body?.data,
        body?.data?.lectures,
        body?.lectures,
        body?.data?.course?.lectures,
        body?.course?.lectures,
        body?.data?.sections,
        body?.sections,
        body?.data?.content,
        body?.content,
      ];

      for (const arr of candidates) {
        if (Array.isArray(arr) && arr.length > 0) {
          return res.json({
            success: true,
            endpoint: ep,
            count: arr.length,
            lectures: arr,
            raw: body
          });
        }
      }

      tried.push({
        endpoint: ep,
        status: response.status,
        note: 'نجح لكن مفيش مصفوفة محاضرات معروفة',
        raw: body
      });
    } catch (err) {
      tried.push({
        endpoint: ep,
        status: err.response?.status || 'ERR',
        message: err.response?.data?.message || err.message
      });
    }
  }

  res.status(404).json({
    success: false,
    message: 'تعذر جلب محاضرات الكورس',
    tried
  });
});

// ==================================================
// 📖 جلب محتوى محاضرة (الأصلي)
// ==================================================
app.get('/api/lectures/:lectureId/content', async (req, res) => {
  try {
    const { lectureId } = req.params;
    const response = await coursatk.get(`/user/lectures/${lectureId}/content`);
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: err.response?.data?.message || 'فشل في جلب المحاضرة'
    });
  }
});

// ==================================================
// ▶️ تشغيل فيديو (الأصلي)
// ==================================================
app.post('/api/video/:videoId/play', async (req, res) => {
  try {
    const { videoId } = req.params;
    const response = await coursatk.post(`/video/${videoId}/stream-weave/play`);
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: err.response?.data?.message || 'فشل في جلب رابط الفيديو'
    });
  }
});

// ==================================================
// 🏠 الصفحة الرئيسية
// ==================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`السيرفر شغال: http://localhost:${PORT}`);
  console.log(`فحص الـ endpoints: http://localhost:${PORT}/api/debug/endpoints`);
});
