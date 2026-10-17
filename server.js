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

// 📖 جلب محتوى محاضرة
app.get('/api/lectures/:lectureId/content', async (req, res) => {
  try {
    const response = await coursatk.get(`/user/lectures/${req.params.lectureId}/content`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || 'فشل في جلب المحاضرة' });
  }
});

// ▶️ جلب رابط الفيديو والتوكن
app.post('/api/video/:videoId/play', async (req, res) => {
  try {
    const response = await coursatk.post(`/video/${req.params.videoId}/stream-weave/play`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || 'فشل في جلب رابط الفيديو' });
  }
});

// 🎥 سيرفر البث المباشر (اللي هيشغل الفيديو)
app.get('/api/stream', async (req, res) => {
  const { url, token } = req.query;
  if (!url || !token) return res.status(400).send('Missing URL or Token');

  try {
    const response = await axios({
      method: 'get',
      url: url,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
        'Referer': 'https://coursatk.online/',
        'Origin': 'https://coursatk.online',
        'Accept': '*/*'
      },
      responseType: url.includes('.m3u8') ? 'text' : 'stream'
    });

    // لو الملف m3u8، بنعدل الروابط اللي جواه تروح للـ Proxy بتاعنا
    if (url.includes('.m3u8')) {
      const basePath = url.substring(0, url.lastIndexOf('/') + 1);
      let content = response.data;

      content = content.split('\n').map(line => {
        line = line.trim();
        if (line && !line.startsWith('#')) {
          let fullUrl = line.startsWith('http') ? line : basePath + line;
          return `/api/stream?url=${encodeURIComponent(fullUrl)}&token=${token}`;
        }
        return line;
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(content);
    }

    // لو الملف ts (جزء من الفيديو)، بنبعته للمتصفح مباشرة
    res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp2t');
    if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
    if (response.headers['accept-ranges']) res.setHeader('Accept-Ranges', response.headers['accept-ranges']);
    if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);

    response.data.pipe(res);

  } catch (err) {
    console.error('Stream Error:', err.message);
    res.status(500).send('Error streaming video');
  }
});

// 🏠 توجيه الصفحة الرئيسية
app.get('/', (req, res) => {
  const possiblePaths = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'public', 'index.html')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).send("ملف index.html غير موجود");
});

// 🚀 تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
