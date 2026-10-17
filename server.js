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
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36'
  },
  timeout: 15000
});

// ============ جلب كل الكورسات ============
app.get('/api/courses', async (req, res) => {
  const endpoints = [
    '/user/courses',
    '/user/enrollments',
    '/courses/my',
    '/user/dashboard',
    '/user/my-courses',
    '/student/courses'
  ];

  const tried = [];

  for (const ep of endpoints) {
    try {
      const response = await coursatk.get(ep);
      tried.push({ endpoint: ep, status: response.status });

      const body = response.data;
      // نحاول نلاقي مصفوفة كورسات في أي مكان في الرد
      const possibleArrays = [
        body?.data,
        body?.data?.courses,
        body?.courses,
        body?.data?.enrollments,
        body?.enrollments,
        body?.data?.data
      ];

      for (const arr of possibleArrays) {
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

      // لو الرد ناجح بس مش لاقيين مصفوفة، نرجع الرد الخام للفحص
      if (body) {
        return res.json({
          success: true,
          endpoint: ep,
          courses: [],
          raw: body,
          note: 'الرد ناجح لكن شكل البيانات غير متوقع، راجع raw'
        });
      }
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
    message: 'كل الـ endpoints فشلت، جرب تشوف الـ endpoint الصح من Network Tab في المتصفح',
    tried
  });
});

// ============ جلب محاضرات كورس معين ============
app.get('/api/courses/:courseId/lectures', async (req, res) => {
  const { courseId } = req.params;
  const endpoints = [
    `/user/courses/${courseId}/lectures`,
    `/user/courses/${courseId}`,
    `/courses/${courseId}/lectures`,
    `/user/courses/${courseId}/content`,
    `/user/enrollments/${courseId}`
  ];

  const tried = [];

  for (const ep of endpoints) {
    try {
      const response = await coursatk.get(ep);
      tried.push({ endpoint: ep, status: response.status });

      const body = response.data;
      const possibleArrays = [
        body?.data,
        body?.data?.lectures,
        body?.lectures,
        body?.data?.course?.lectures,
        body?.course?.lectures,
        body?.data?.sections,
        body?.sections
      ];

      for (const arr of possibleArrays) {
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

      if (body) {
        return res.json({
          success: true,
          endpoint: ep,
          lectures: [],
          raw: body,
          note: 'الرد ناجح لكن شكل البيانات غير متوقع، راجع raw'
        });
      }
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

// ============ جلب محتوى محاضرة (الأصلي) ============
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

// ============ تشغيل فيديو (الأصلي) ============
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

// ============ الصفحة الرئيسية ============
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`السيرفر شغال: http://localhost:${PORT}`);
});
