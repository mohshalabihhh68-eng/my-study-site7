const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

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
// 📖 جلب محتوى محاضرة
// ==================================================
app.get('/api/lectures/:lectureId/content', async (req, res) => {
  try {
    const response = await coursatk.get(`/user/lectures/${req.params.lectureId}/content`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || 'فشل في جلب المحاضرة' });
  }
});

// ==================================================
// ▶️ تشغيل فيديو (جلب الرابط)
// ==================================================
app.post('/api/video/:videoId/play', async (req, res) => {
  try {
    const response = await coursatk.post(`/video/${req.params.videoId}/stream-weave/play`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || 'فشل في جلب رابط الفيديو' });
  }
});

// ==================================================
// 🎥 بروكسي لتشغيل الفيديو وتجاوز الحظر
// ==================================================
app.get('/api/proxy-video', async (req, res) => {
  const { url, token } = req.query;
  if (!url) return res.status(400).send('Missing URL');

  try {
    const response = await axios({
      method: 'get',
      url: url,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Mozilla/5.0'
      },
      responseType: 'stream'
    });

    // نقل الهيدرز المهمة للمتصفح عشان المشغل يشتغل
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/vnd.apple.mpegurl');
    if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
    if (response.headers['accept-ranges']) res.setHeader('Accept-Ranges', response.headers['accept-ranges']);
    if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);

    response.data.pipe(res);
  } catch (err) {
    console.error('Proxy Error:', err.message);
    res.status(500).send('Error proxying video');
  }
});

// ==================================================
// 🏠 توجيه الصفحة الرئيسية (لضمان عدم ظهور خطأ ENOENT)
// ==================================================
app.get('/', (req, res) => {
  const possiblePaths = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'public', 'index.html'),
    path.join(process.cwd(), 'index.html')
  ];
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return res.sendFile(p);
    }
  }
  res.status(404).send("ملف index.html غير موجود في السيرفر.");
});

// ==================================================
// 🚀 تشغيل السيرفر
// ==================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
