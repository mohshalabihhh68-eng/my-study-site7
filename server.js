/**
 * Coursatk Open Proxy v6
 * No Firebase / no student auth
 * Hardcoded COURSATK token
 * Catalog + HLS via server-side Stream-Weave decrypt
 * Segment fetch matches userscript: Authorization Bearer stream token
 */
import express from "express";
import cors from "cors";
import compression from "compression";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const APP_VERSION = "v6";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  COURSATK_API: "https://api.coursatk.online/api/v1",
  COURSATK_TOKEN:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxMDk1NTUsInJvbGUiOiJzdHVkZW50IiwidXVpZCI6IjU3OGIxNjBjMjgxZWVkY2Y1ZTY4MjViNDZmMWExNTY0In0.x9vV-N_13KcrGbx-y9owTgGdirKpKh_X0JXDpolYegs",
  DEFAULT_YEAR_ID: 4,
  STREAM_UA:
    "Mozilla/5.0 (Linux; Android 15; CPH2591 Build/AP3A.240617.008) AppleWebKit/537.36 (KHTML, like Gecko) Jrryilw/4.0 Chrome/155.0.8059.43 Mobile Safari/537.36",
  PLAYER_JS: "https://player.stream-weave.com/assets/player.js?v=1.1.1",
  STREAM_SESSION_MS: 30 * 60 * 1000,
  MAX_PROXY_BYTES: 20 * 1024 * 1024
};

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true }));
app.use(express.json({ limit: "512kb" }));
app.use(compression());

const streamSessions = new Map();
let decryptPlaybackKeyFn = null;

function now() {
  return Date.now();
}

function jsonError(res, status, message, detail) {
  const body = { success: false, message, status };
  if (detail !== undefined) body.detail = detail;
  return res.status(status).json(body);
}

function getStreamSession(id) {
  const s = streamSessions.get(id);
  if (!s) return null;
  const last = s.lastUsed || s.createdAt;
  if (now() - last > CONFIG.STREAM_SESSION_MS) {
    streamSessions.delete(id);
    return null;
  }
  s.lastUsed = now();
  return s;
}

async function loadDecryptionUtils() {
  const cachePath = path.join(__dirname, "player.stream-weave.cache.js");
  let source = null;
  try {
    if (fs.existsSync(cachePath)) source = fs.readFileSync(cachePath, "utf8");
  } catch {}
  if (!source) {
    console.log("[crypto] fetching player.js");
    const r = await fetch(CONFIG.PLAYER_JS, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" }
    });
    if (!r.ok) throw new Error("player.js HTTP " + r.status);
    source = await r.text();
    try {
      fs.writeFileSync(cachePath, source);
    } catch {}
  }

  const { webcrypto } = crypto;
  const sandbox = {
    window: {},
    self: {},
    globalThis: {},
    global: {},
    console: { log() {}, warn() {}, error() {}, info() {} },
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Error,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    JSON,
    Date,
    Map,
    Set,
    WeakMap,
    Symbol,
    Proxy,
    Reflect,
    document: {
      createElement: () => ({
        style: {},
        setAttribute() {},
        appendChild() {},
        remove() {}
      }),
      head: { appendChild() {} },
      body: { appendChild() {} },
      querySelector: () => null,
      addEventListener() {}
    },
    navigator: { userAgent: "Node" },
    location: { href: "https://coursatk.online/" },
    HTMLElement: class {},
    HTMLVideoElement: class {},
    MediaSource: class {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: class {
      constructor(p) {
        this.p = p;
      }
    },
    fetch: async () => ({ ok: false }),
    XMLHttpRequest: class {
      open() {}
      send() {}
      setRequestHeader() {}
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;

  vm.runInNewContext(source, sandbox, { timeout: 10000 });
  const du = sandbox.DecryptionUtils;
  if (!du || typeof du.decryptPlaybackKey !== "function") {
    throw new Error("DecryptionUtils.decryptPlaybackKey missing");
  }
  decryptPlaybackKeyFn = du.decryptPlaybackKey.bind(du);
  console.log("[crypto] ready");
}

async function unwrapKey(wrappedBuf, videoId) {
  if (!decryptPlaybackKeyFn) throw new Error("crypto not loaded");
  const wrapped = Buffer.isBuffer(wrappedBuf)
    ? new Uint8Array(wrappedBuf)
    : new Uint8Array(wrappedBuf);
  if (wrapped.byteLength === 16) return Buffer.from(wrapped);
  const result = await decryptPlaybackKeyFn(wrapped, String(videoId));
  const key = result && result.key;
  if (!key) throw new Error("empty key");
  let aes;
  if (Buffer.isBuffer(key)) aes = key;
  else if (key instanceof ArrayBuffer) aes = Buffer.from(key);
  else
    aes = Buffer.from(
      key.buffer || key,
      key.byteOffset || 0,
      key.byteLength || key.length
    );
  if (aes.length !== 16) throw new Error("key len " + aes.length);
  return aes;
}

function decryptSegment(encrypted, key, iv) {
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function parseIvHex(hex) {
  const h = String(hex || "")
    .replace(/^0x/i, "")
    .trim();
  if (!/^[0-9a-fA-F]{32}$/.test(h)) return null;
  return Buffer.from(h, "hex");
}

function ivFromMediaSequence(seq) {
  const iv = Buffer.alloc(16, 0);
  iv.writeUInt32BE(Number(seq) >>> 0, 12);
  return iv;
}

async function upstreamJson(apiPath, options = {}) {
  const url = CONFIG.COURSATK_API + apiPath;
  const headers = {
    Authorization: "Bearer " + CONFIG.COURSATK_TOKEN,
    Accept: "application/json",
    ...(options.headers || {})
  };
  let r;
  try {
    r = await fetch(url, { ...options, headers });
  } catch (e) {
    throw new Error("Upstream network: " + e.message);
  }
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Upstream non-JSON (" + r.status + ") " + text.slice(0, 200));
  }
  if (!r.ok) {
    throw new Error(
      "Upstream HTTP " +
        r.status +
        ": " +
        (data.message || JSON.stringify(data).slice(0, 200))
    );
  }
  return data;
}

/** Match userscript: Authorization Bearer stream token on all stream URLs */
async function streamFetch(session, url) {
  const headers = {
    Accept: "*/*",
    "Cache-Control": "no-store",
    "User-Agent": CONFIG.STREAM_UA
  };
  if (session && session.token) {
    headers.Authorization = "Bearer " + session.token;
  }
  return fetch(url, { headers, cache: "no-store", redirect: "follow" });
}

function isHttpsUrl(raw) {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

function buildHtml() {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Coursatk Open Catalog ${APP_VERSION}</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.7"><\/script>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif;background:#0b0d12;color:#e8eaed;min-height:100vh}
header{position:sticky;top:0;z-index:20;background:#12151c;border-bottom:1px solid #2a2f3a;padding:12px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
header h1{font-size:1.05rem;margin:0;font-weight:600;flex:1}
.crumb{font-size:.8rem;color:#9aa0a6;width:100%}
.crumb span{cursor:pointer;color:#60a5fa}
main{padding:16px;max-width:1100px;margin:0 auto}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;align-items:center}
.toolbar select,.toolbar input,.toolbar button{padding:8px 12px;border-radius:8px;border:1px solid #3a4050;background:#1a1d24;color:#e8eaed;font-size:.9rem}
.toolbar button{background:#3b82f6;border:none;cursor:pointer;font-weight:600}
.toolbar button.ghost{background:#2a2f3a}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
.item{background:#1a1d24;border:1px solid #2a2f3a;border-radius:12px;overflow:hidden;cursor:pointer;display:flex;flex-direction:column}
.item:hover{border-color:#3b82f6}
.item .thumb{aspect-ratio:16/10;background:#0f1218 center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#4b5563;font-size:2rem}
.item .body{padding:10px;flex:1}
.item .title{font-size:.9rem;font-weight:600;margin:0 0 4px}
.item .sub{font-size:.75rem;color:#9aa0a6}
.player-box{position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:50;display:none;flex-direction:column;align-items:center;justify-content:center;padding:16px}
.player-box.open{display:flex}
.player-box .inner{width:100%;max-width:900px;background:#12151c;border-radius:12px;border:1px solid #2a2f3a;overflow:hidden}
.player-box .bar{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #2a2f3a}
.player-box .bar button{background:#374151;border:none;color:#fff;padding:6px 12px;border-radius:6px;cursor:pointer}
video{width:100%;aspect-ratio:16/9;background:#000;display:block}
.log{font-family:ui-monospace,monospace;font-size:.7rem;background:#0a0c10;padding:8px 12px;max-height:120px;overflow:auto;color:#a5b4c8;white-space:pre-wrap;word-break:break-all}
.loading,.empty,.err-msg{text-align:center;padding:40px 16px;color:#9aa0a6}
.err-msg{color:#f87171}
.ok{color:#4ade80}.err{color:#f87171}
.manual{margin-top:24px;padding:14px;background:#1a1d24;border-radius:12px;border:1px solid #2a2f3a}
.manual label{font-size:.8rem;color:#9aa0a6;display:block;margin-bottom:4px}
.manual input{width:100%;padding:8px;border-radius:8px;border:1px solid #3a4050;background:#12151a;color:#e8eaed;margin-bottom:8px}
</style>
</head>
<body>
<header>
  <h1>Coursatk Open Catalog ${APP_VERSION}</h1>
  <div class="toolbar" style="margin:0">
    <select id="yearId">
      <option value="4">Year 4</option>
      <option value="1">1</option>
      <option value="2">2</option>
      <option value="3">3</option>
      <option value="5">5</option>
    </select>
    <button type="button" id="btnHome" class="ghost">Subjects</button>
    <button type="button" id="btnStop" class="ghost">Stop</button>
  </div>
  <div class="crumb" id="crumb">-</div>
</header>
<main>
  <div id="content" class="loading">Loading...</div>
  <div class="manual">
    <label>Manual Video ID</label>
    <div class="toolbar" style="margin:0">
      <input id="manualId" type="text" placeholder="Video ID" style="flex:1;min-width:120px"/>
      <button type="button" id="btnManual">Play</button>
    </div>
  </div>
</main>
<div class="player-box" id="playerBox">
  <div class="inner">
    <div class="bar"><span id="playerTitle">-</span>
      <button type="button" id="btnClosePlayer">Close</button>
    </div>
    <video id="player" controls playsinline></video>
    <div class="log" id="log"></div>
  </div>
</div>
<script>
(function(){
  var content=document.getElementById('content');
  var crumbEl=document.getElementById('crumb');
  var logEl=document.getElementById('log');
  var video=document.getElementById('player');
  var playerBox=document.getElementById('playerBox');
  var hls=null;
  var stack=[];
  function log(msg,cls){
    var t=new Date().toLocaleTimeString();
    var line=document.createElement('div');
    if(cls)line.className=cls;
    line.textContent='['+t+'] '+msg;
    logEl.prepend(line);
  }
  function stop(){if(hls){hls.destroy();hls=null;}video.removeAttribute('src');video.load();}
  function closePlayer(){stop();playerBox.classList.remove('open');}
  function openPlayer(title){
    document.getElementById('playerTitle').textContent=title||'Video';
    playerBox.classList.add('open');logEl.innerHTML='';
  }
  async function api(path,opts){
    var r=await fetch(path,opts);
    var j=await r.json().catch(function(){return {};});
    if(!r.ok)throw new Error(j.message||('HTTP '+r.status));
    return j;
  }
  function esc(s){
    return String(s||'').replace(/[&<>"']/g,function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function renderCrumb(){
    if(!stack.length){crumbEl.innerHTML='<span data-i="-1">Subjects</span>';return;}
    var html='<span data-i="-1">Subjects</span>';
    stack.forEach(function(s,i){html+=' › <span data-i="'+i+'">'+esc(s.title)+'</span>';});
    crumbEl.innerHTML=html;
    crumbEl.querySelectorAll('span').forEach(function(el){
      el.onclick=function(){
        var i=Number(el.dataset.i);
        if(i<0){stack=[];loadSubjects();return;}
        stack=stack.slice(0,i+1);
        var top=stack[stack.length-1];
        if(top.type==='subject')loadTeachers(top.id,top.title,true);
        else if(top.type==='teacher')loadChapters(top.id,top.title,true);
        else if(top.type==='chapter')loadLectures(top.id,top.title,true);
        else if(top.type==='lecture')loadContent(top.id,top.title,true);
      };
    });
  }
  function card(opts){
    var div=document.createElement('div');
    div.className='item';
    var thumb=document.createElement('div');
    thumb.className='thumb';
    if(opts.image)thumb.style.backgroundImage='url('+opts.image+')';
    else thumb.textContent=opts.icon||'📁';
    var body=document.createElement('div');
    body.className='body';
    body.innerHTML='<div class="title">'+esc(opts.title)+'</div>'+(opts.sub?'<div class="sub">'+esc(opts.sub)+'</div>':'');
    div.appendChild(thumb);div.appendChild(body);
    div.onclick=opts.onClick;
    return div;
  }
  function showGrid(items){
    content.innerHTML='';
    if(!items.length){content.innerHTML='<div class="empty">Empty</div>';return;}
    var grid=document.createElement('div');
    grid.className='grid';
    items.forEach(function(it){grid.appendChild(it);});
    content.appendChild(grid);
  }
  async function loadSubjects(){
    content.innerHTML='<div class="loading">Loading subjects...</div>';
    renderCrumb();
    var yearId=document.getElementById('yearId').value||'4';
    try{
      var j=await api('/api/subjects/'+encodeURIComponent(yearId));
      var list=Array.isArray(j.data)?j.data:[];
      showGrid(list.map(function(s){
        return card({title:s.name||('Subject '+s.id),sub:'ID: '+s.id,image:s.image_url||s.image||null,icon:'📚',
          onClick:function(){loadTeachers(s.id,s.name||String(s.id));}});
      }));
    }catch(e){content.innerHTML='<div class="err-msg">'+esc(e.message)+'</div>';}
  }
  async function loadTeachers(subjectId,title,keep){
    if(!keep)stack=[{type:'subject',id:subjectId,title:title}];
    content.innerHTML='<div class="loading">Loading teachers...</div>';renderCrumb();
    try{
      var j=await api('/api/subjects/'+encodeURIComponent(subjectId)+'/teachers');
      var d=j.data;var list=[];
      if(Array.isArray(d))list=d;
      else if(d&&Array.isArray(d.teachers))list=d.teachers;
      else if(d&&Array.isArray(d.data))list=d.data;
      else if(d&&(d.id||d.name))list=[d];
      if(!list.length&&d){for(var k in d){if(Array.isArray(d[k])&&d[k].length&&d[k][0]&&d[k][0].id){list=d[k];break;}}}
      showGrid(list.map(function(t){
        var id=t.id||t.teacher_id;var name=t.name||t.teacher_name||('Teacher '+id);
        return card({title:name,sub:'ID: '+id,image:t.image_url||t.image||null,icon:'👤',
          onClick:function(){loadChapters(id,name);}});
      }));
      if(!list.length)content.innerHTML='<div class="empty">No teachers</div>';
    }catch(e){content.innerHTML='<div class="err-msg">'+esc(e.message)+'</div>';}
  }
  async function loadChapters(teacherId,title,keep){
    if(!keep){stack=stack.filter(function(s){return s.type==='subject';});stack.push({type:'teacher',id:teacherId,title:title});}
    content.innerHTML='<div class="loading">Loading chapters...</div>';renderCrumb();
    try{
      var j=await api('/api/teachers/'+encodeURIComponent(teacherId)+'/chapters');
      var list=Array.isArray(j.data)?j.data:[];
      if(!list.length&&j.data&&Array.isArray(j.data.chapters))list=j.data.chapters;
      showGrid(list.map(function(c){
        return card({title:c.name||c.title||('Chapter '+c.id),sub:'ID: '+c.id,icon:'📂',
          onClick:function(){loadLectures(c.id,c.name||c.title||String(c.id));}});
      }));
    }catch(e){content.innerHTML='<div class="err-msg">'+esc(e.message)+'</div>';}
  }
  async function loadLectures(chapterId,title,keep){
    if(!keep){stack=stack.filter(function(s){return s.type==='subject'||s.type==='teacher';});stack.push({type:'chapter',id:chapterId,title:title});}
    content.innerHTML='<div class="loading">Loading lectures...</div>';renderCrumb();
    try{
      var j=await api('/api/chapters/'+encodeURIComponent(chapterId)+'/lectures');
      var list=Array.isArray(j.data)?j.data:[];
      if(!list.length&&j.data&&Array.isArray(j.data.lectures))list=j.data.lectures;
      showGrid(list.map(function(l){
        return card({title:l.name||l.title||('Lecture '+l.id),sub:'ID: '+l.id,icon:'🎬',
          onClick:function(){loadContent(l.id,l.name||l.title||String(l.id));}});
      }));
    }catch(e){content.innerHTML='<div class="err-msg">'+esc(e.message)+'</div>';}
  }
  async function loadContent(lectureId,title,keep){
    if(!keep){stack=stack.filter(function(s){return s.type==='subject'||s.type==='teacher'||s.type==='chapter';});stack.push({type:'lecture',id:lectureId,title:title});}
    content.innerHTML='<div class="loading">Loading content...</div>';renderCrumb();
    try{
      var j=await api('/api/lectures/'+encodeURIComponent(lectureId)+'/content');
      var d=j.data||j;var videos=[];
      function pushVid(v,idx){
        if(!v)return;
        var id=v.video_id||v.videoId||v.stream_weave_id||v.id||v.content_id||null;
        var name=v.name||v.title||v.file_name||('Video '+(id||idx));
        if(id)videos.push({id:String(id),name:name});
      }
      if(Array.isArray(d))d.forEach(pushVid);
      else if(Array.isArray(d.videos))d.videos.forEach(pushVid);
      else if(Array.isArray(d.contents))d.contents.forEach(pushVid);
      else if(Array.isArray(d.data))d.data.forEach(pushVid);
      else if(d.video_id||d.id)pushVid(d);
      var seen={};videos=videos.filter(function(v){if(seen[v.id])return false;seen[v.id]=1;return true;});
      if(!videos.length){
        content.innerHTML='<div class="empty">No videos<br><pre style="font-size:11px;max-height:300px;overflow:auto">'+esc(JSON.stringify(j,null,2).slice(0,3000))+'</pre></div>';
        return;
      }
      showGrid(videos.map(function(v){
        return card({title:v.name,sub:'Video ID: '+v.id,icon:'▶️',onClick:function(){playVideo(v.id,v.name);}});
      }));
    }catch(e){content.innerHTML='<div class="err-msg">'+esc(e.message)+'</div>';}
  }
  function playManifest(url){
    stop();log('Loading: '+url);
    if(window.Hls&&Hls.isSupported()){
      hls=new Hls({enableWorker:true,lowLatencyMode:false});
      hls.loadSource(url);hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED,function(){log('Manifest OK','ok');video.play().catch(function(e){log('play: '+e.message,'err');});});
      hls.on(Hls.Events.ERROR,function(_,data){
        log('HLS '+data.type+' '+data.details+' fatal='+data.fatal,data.fatal?'err':'');
        if(data.response)log('  HTTP '+data.response.code,'err');
      });
    }else if(video.canPlayType('application/vnd.apple.mpegurl')){
      video.src=url;video.play();
    }else log('HLS not supported','err');
  }
  async function playVideo(videoId,title){
    openPlayer(title||('Video '+videoId));
    log('POST /api/play/'+videoId);
    try{
      var j=await api('/api/play/'+encodeURIComponent(videoId),{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'}});
      if(!j.success||!j.data||!j.data.manifest_url){log('Play failed: '+JSON.stringify(j),'err');return;}
      log('session='+j.data.session,'ok');
      playManifest(j.data.manifest_url);
    }catch(e){log('Error: '+e.message,'err');}
  }
  document.getElementById('btnHome').onclick=function(){stack=[];loadSubjects();};
  document.getElementById('yearId').onchange=function(){stack=[];loadSubjects();};
  document.getElementById('btnStop').onclick=closePlayer;
  document.getElementById('btnClosePlayer').onclick=closePlayer;
  document.getElementById('btnManual').onclick=function(){
    var id=document.getElementById('manualId').value.trim();
    if(!id)return log('Enter Video ID','err');
    playVideo(id,'Video '+id);
  };
  loadSubjects();
})();
<\/script>
</body>
</html>`;
}

const HTML_PAGE = buildHtml();

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "coursatk-open-proxy",
    version: APP_VERSION,
    cryptoReady: Boolean(decryptPlaybackKeyFn),
    mode: "open-no-auth",
    now: new Date().toISOString()
  });
});

app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(HTML_PAGE);
});

app.get("/api/subjects/:id", async (req, res) => {
  try {
    const yearId = Number(req.params.id) || CONFIG.DEFAULT_YEAR_ID;
    res.json(await upstreamJson("/user/subjects/" + encodeURIComponent(yearId)));
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.get("/api/subjects/:id/teachers", async (req, res) => {
  try {
    res.json(
      await upstreamJson(
        "/user/subjects/" + encodeURIComponent(req.params.id) + "/teachers"
      )
    );
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.get("/api/teachers/:id/chapters", async (req, res) => {
  try {
    res.json(
      await upstreamJson(
        "/user/teachers/" + encodeURIComponent(req.params.id) + "/chapters"
      )
    );
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.get("/api/chapters/:id/lectures", async (req, res) => {
  try {
    res.json(
      await upstreamJson(
        "/user/chapters/" + encodeURIComponent(req.params.id) + "/lectures"
      )
    );
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.get("/api/lectures/:id/content", async (req, res) => {
  try {
    res.json(
      await upstreamJson(
        "/user/lectures/" + encodeURIComponent(req.params.id) + "/content"
      )
    );
  } catch (e) {
    jsonError(res, 502, e.message);
  }
});

app.post("/api/play/:videoId", async (req, res) => {
  try {
    const videoId = req.params.videoId;
    const data = await upstreamJson(
      "/video/" + encodeURIComponent(videoId) + "/stream-weave/play",
      { method: "POST", headers: { Accept: "application/json" } }
    );
    if (
      !data ||
      !data.success ||
      !data.data ||
      !data.data.token ||
      !data.data.stream_url ||
      !data.data.video_id
    ) {
      return jsonError(res, 502, "Playback response incomplete", { upstream: data });
    }
    const id = crypto.randomUUID();
    streamSessions.set(id, {
      id,
      videoId: String(data.data.video_id),
      token: data.data.token,
      streamUrl: data.data.stream_url,
      playId: String(videoId),
      createdAt: now(),
      lastUsed: now(),
      plainKey: null,
      defaultIv: null
    });
    console.log("[play]", id, data.data.stream_url);
    res.json({
      success: true,
      data: {
        session: id,
        video_id: data.data.video_id,
        manifest_url: "/api/stream/manifest/" + id
      }
    });
  } catch (e) {
    console.error("[play]", e.message);
    jsonError(res, 502, e.message);
  }
});

async function refreshPlayback(session) {
  const data = await upstreamJson(
    "/video/" + encodeURIComponent(session.playId) + "/stream-weave/play",
    { method: "POST", headers: { Accept: "application/json" } }
  );
  if (!data || !data.success || !data.data || !data.data.token || !data.data.stream_url) {
    throw new Error("token refresh failed");
  }
  session.token = data.data.token;
  session.streamUrl = data.data.stream_url;
  session.lastUsed = now();
}

async function rewritePlaylist(sessionId, session, text, baseUrl, res) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let mediaSeq = 0;
  let currentIv = null;
  let keyFetched = false;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSeq = Number(t.split(":")[1]) || 0;
    }
  }

  let segIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-KEY:")) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      const ivMatch = line.match(/IV=(0x[0-9a-fA-F]+|[0-9a-fA-F]{32})/i);
      if (ivMatch) currentIv = parseIvHex(ivMatch[1]);
      if (uriMatch && !keyFetched && !session.plainKey) {
        const keyUrl = new URL(uriMatch[1], baseUrl).href;
        const keyRes = await streamFetch(session, keyUrl);
        if (!keyRes.ok) {
          const body = (await keyRes.text().catch(() => "")).slice(0, 200);
          throw new Error("Key HTTP " + keyRes.status + " " + body);
        }
        const wrapped = Buffer.from(await keyRes.arrayBuffer());
        session.plainKey = await unwrapKey(wrapped, session.videoId);
        session.defaultIv = currentIv;
        keyFetched = true;
        console.log("[key] unwrapped", session.videoId, "len=" + session.plainKey.length);
      } else if (session.plainKey) {
        session.defaultIv = currentIv;
        keyFetched = true;
      }
      continue;
    }
    if (line && !line.startsWith("#")) {
      const segmentUrl = new URL(line, baseUrl).href;
      const seq = mediaSeq + segIndex;
      const iv = currentIv || ivFromMediaSequence(seq);
      const payload = Buffer.from(
        JSON.stringify({ u: segmentUrl, iv: iv.toString("hex"), s: seq }),
        "utf8"
      ).toString("base64url");
      out.push("/api/stream/segment/" + sessionId + "/" + payload);
      segIndex++;
      continue;
    }
    out.push(lines[i]);
  }

  if (!session.plainKey) throw new Error("failed to prepare encryption key");

  res.set({
    "Content-Type": "application/vnd.apple.mpegurl",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.send(out.join("\n"));
}

app.get("/api/stream/manifest/:sessionId", async (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) return jsonError(res, 404, "stream session expired");

  try {
    let master = await streamFetch(session, session.streamUrl);
    if (master.status === 401 && session.playId) {
      await refreshPlayback(session);
      master = await streamFetch(session, session.streamUrl);
    }
    if (!master.ok) {
      const body = (await master.text().catch(() => "")).slice(0, 300);
      throw new Error("Stream master HTTP " + master.status + " " + body);
    }
    const masterText = await master.text();
    const lines = masterText.split(/\r?\n/);

    let variant = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("#EXT-X-STREAM-INF")) {
        const next = lines[i + 1] && lines[i + 1].trim();
        if (next && !next.startsWith("#")) {
          variant = new URL(next, session.streamUrl).href;
          break;
        }
      }
    }

    if (variant) {
      let variantRes = await streamFetch(session, variant);
      if (variantRes.status === 401 && session.playId) {
        await refreshPlayback(session);
        variantRes = await streamFetch(session, variant);
      }
      if (!variantRes.ok) {
        const body = (await variantRes.text().catch(() => "")).slice(0, 300);
        throw new Error("Variant HTTP " + variantRes.status + " " + body);
      }
      return rewritePlaylist(
        req.params.sessionId,
        session,
        await variantRes.text(),
        variant,
        res
      );
    }
    return rewritePlaylist(
      req.params.sessionId,
      session,
      masterText,
      session.streamUrl,
      res
    );
  } catch (e) {
    console.error("[manifest]", e.message);
    jsonError(res, 502, e.message);
  }
});

app.get("/api/stream/segment/:sessionId/:encoded", async (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) return jsonError(res, 404, "stream session expired");
  if (!session.plainKey) return jsonError(res, 404, "key not ready");

  let meta;
  try {
    meta = JSON.parse(Buffer.from(req.params.encoded, "base64url").toString("utf8"));
  } catch {
    return jsonError(res, 400, "bad segment meta");
  }
  const url = meta && meta.u;
  if (!url || !isHttpsUrl(url)) return jsonError(res, 403, "url not allowed");

  const iv = parseIvHex(meta.iv) || session.defaultIv || ivFromMediaSequence(meta.s || 0);

  try {
    const upstream = await streamFetch(session, url);
    if (!upstream.ok && upstream.status !== 206) {
      const body = (await upstream.text().catch(() => "")).slice(0, 250);
      console.error("[segment-fail]", upstream.status, new URL(url).hostname);
      throw new Error("Segment HTTP " + upstream.status + " " + body.slice(0, 150));
    }
    const encrypted = Buffer.from(await upstream.arrayBuffer());
    if (encrypted.length > CONFIG.MAX_PROXY_BYTES) {
      return jsonError(res, 413, "segment too large");
    }
    let plain;
    try {
      plain = decryptSegment(encrypted, session.plainKey, iv);
    } catch (decErr) {
      console.warn("[segment-decrypt]", decErr.message);
      plain = encrypted;
    }
    res.status(200);
    res.set({
      "Content-Type": "video/mp2t",
      "Content-Length": String(plain.length),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    res.send(plain);
  } catch (e) {
    console.error("[segment]", e.message);
    if (!res.headersSent) jsonError(res, 502, e.message);
    else res.end();
  }
});

app.use((req, res) => {
  jsonError(res, 404, "not found", { path: req.path });
});

setInterval(() => {
  const t = now();
  for (const [k, s] of streamSessions) {
    if (t - (s.lastUsed || s.createdAt) > CONFIG.STREAM_SESSION_MS) {
      streamSessions.delete(k);
    }
  }
}, 60000).unref();

await loadDecryptionUtils();

app.listen(CONFIG.PORT, () => {
  console.log("[OPEN " + APP_VERSION + "] http://localhost:" + CONFIG.PORT);
  console.log("[OPEN " + APP_VERSION + "] health=/health player=/");
});
