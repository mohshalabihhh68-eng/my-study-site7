const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

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

// ▶️ تشغيل فيديو (جلب الرابط)
app.post('/api/video/:videoId/play', async (req, res) => {
  try {
    const response = await coursatk.post(`/video/${req.params.videoId}/stream-weave/play`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || 'فشل في جلب رابط الفيديو' });
  }
});

// 🎥 بروكسي مباشر للفيديو (بيعمل بث للفيديو مباشرة)
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
      responseType: 'stream' // بث مباشر
    });

    // نقل الهيدرز المهمة
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/vnd.apple.mpegurl');
    
    if (url.includes('.m3u8')) {
        let content = '';
        response.data.on('data', chunk => content += chunk.toString());
        response.data.on('end', () => {
            const basePath = url.substring(0, url.lastIndexOf('/') + 1);
            const modifiedContent = content.split('\n').map(line => {
                line = line.trim();
                if (line && !line.startsWith('#')) {
                    let fullUrl = line.startsWith('http') ? line : basePath + line;
                    return `/api/proxy-video?url=${encodeURIComponent(fullUrl)}&token=${token}`;
                }
                return line;
            }).join('\n');
            res.send(modifiedContent);
        });
    } else {
        if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
        if (response.headers['accept-ranges']) res.setHeader('Accept-Ranges', response.headers['accept-ranges']);
        if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
        response.data.pipe(res);
    }
    
  } catch (err) {
    console.error('Proxy Error:', err.message);
    res.status(500).send('Error proxying video');
  }
});

// 🏠 توجيه الصفحة الرئيسية
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
