const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// تعديل مسار الملفات الثابتة ليكون من المجلد الرئيسي مباشرة
app.use(express.static(__dirname));

const COURSATK_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxMDczNjMsInJvbGUiOiJzdHVkZW50IiwidXVpZCI6IjYwYTU0MzZiMDY2MzU4NmI1MDQwOTBhZTM3ZThmOWM5In0.Jz2LWCWeYW6O6Y3h_MntJJi8mcauFhRjcInC37Ns5wI";

const coursatk = axios.create({
  baseURL: 'https://api.coursatk.online/api/v1',
  headers: {
    'Authorization': `Bearer ${COURSATK_TOKEN}`,
    'Origin': 'https://coursatk.online',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36'
  }
});

// جلب قائمة المحاضرات تلقائياً من السيرفر
app.get('/api/all-lectures', async (req, res) => {
  try {
    const lectureIds = [5548, 5549, 5550, 5551];
    let allLectures = [];

    for (let id of lectureIds) {
      try {
        const response = await coursatk.get(`/user/lectures/${id}/content`);
        if (response.data && response.data.success) {
          allLectures.push(response.data.data);
        }
      } catch (e) {
        // تجاهل المحاضرات غير المتاحة
      }
    }

    res.json({
      success: true,
      data: allLectures
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({
      success: false,
      message: 'فشل في جلب المحاضرات'
    });
  }
});

// تشغيل فيديو
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

// توجيه الصفحة الرئيسية إلى ملف index.html في المجلد الرئيسي
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`السيرفر شغال: http://localhost:${PORT}`);
});
