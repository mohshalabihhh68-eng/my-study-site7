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
// ▶️ تشغيل فيديو (جلب الرابط والتوكن)
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
// 🏠 توجيه الصفحة الرئيسية
// ==================================================
app.get('/', (req, res) => {
  const possiblePaths = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'public', 'index.html'),
    path.join(process.cwd(), 'index.html')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).send("ملف index.html غير موجود");
});

// ==================================================
// 🚀 تشغيل السيرفر
// ==================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
