const http = require('http');
const path = require('path');
const fs = require('fs');

const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const yaml = require('js-yaml');
const multer = require('multer');
const { WebSocketServer } = require('ws');

function loadConfig() {
  const configPath = path.resolve(__dirname, '..', 'config.yml');
  const raw = fs.readFileSync(configPath, 'utf8');
  const cfg = yaml.load(raw) || {};
  return {
    port: Number(cfg.port || 3000),
    adminPassword: String(cfg.adminPassword || ''),
    uploadDir: String(cfg.uploadDir || './data/uploads'),
    sessionSecret: String(cfg.sessionSecret || ''),
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function randomToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

const config = loadConfig();
if (!config.adminPassword) {
  console.error('config.yml 缺少 adminPassword');
  process.exit(1);
}
const sessionSecret = config.sessionSecret || randomToken();

const rootDir = path.resolve(__dirname, '..');
const uploadDirAbs = path.resolve(rootDir, config.uploadDir);
ensureDir(uploadDirAbs);

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser(sessionSecret));

// ---- In-memory store (一对一、最小实现) ----
const store = {
  phase: 'idle',
  candidate: {
    connected: false,
    lastSeenAt: null,
    lastAckAt: null,
  },
  pendingPhotoKind: null, // 'paper_check' | 'collect_paper' | null
  photos: {
    paper_check: [],
    collect_paper: [],
  },
  notifications: [],
};

const sessions = new Map(); // token -> createdAt

function isAdminAuthed(req) {
  const token = req.signedCookies?.eksam_admin;
  return Boolean(token && sessions.has(token));
}

function requireAdmin(req, res, next) {
  if (!isAdminAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }
  next();
}

function snapshot() {
  return {
    phase: store.phase,
    candidate: store.candidate,
    pendingPhotoKind: store.pendingPhotoKind,
    photos: store.photos,
    notifications: store.notifications.slice(-20),
  };
}

// ---- WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

let candidateWs = null;
const adminSockets = new Set();

function wsSend(ws, msg) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function broadcastToAdmins(msg) {
  for (const ws of adminSockets) wsSend(ws, msg);
}

function setPhase(nextPhase) {
  store.phase = nextPhase;
  broadcastToAdmins({ type: 'state', data: snapshot() });
}

function setPendingPhoto(kindOrNull) {
  store.pendingPhotoKind = kindOrNull;
  broadcastToAdmins({ type: 'state', data: snapshot() });
}

function pushNotification(text) {
  store.notifications.push({ ts: Date.now(), text: String(text || '') });
  broadcastToAdmins({ type: 'state', data: snapshot() });
}

function sendCommandToCandidate(command) {
  if (!candidateWs) {
    return { delivered: false, error: 'CANDIDATE_NOT_CONNECTED' };
  }
  wsSend(candidateWs, { type: 'command', ts: Date.now(), command });
  broadcastToAdmins({ type: 'candidate_command', ts: Date.now(), command });
  return { delivered: true };
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, url);
  });
});

wss.on('connection', (ws, req, url) => {
  const role = url.searchParams.get('role') || 'candidate';

  if (role === 'candidate') {
    if (candidateWs && candidateWs.readyState === candidateWs.OPEN) {
      ws.close(1013, 'Only one candidate allowed');
      return;
    }
    candidateWs = ws;
    store.candidate.connected = true;
    store.candidate.lastSeenAt = Date.now();
    broadcastToAdmins({ type: 'state', data: snapshot() });

    wsSend(ws, { type: 'hello', data: snapshot() });

    ws.on('message', (buf) => {
      store.candidate.lastSeenAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (msg?.type === 'ack') {
        store.candidate.lastAckAt = Date.now();
        broadcastToAdmins({ type: 'state', data: snapshot() });
      }
    });

    ws.on('close', () => {
      if (candidateWs === ws) candidateWs = null;
      store.candidate.connected = false;
      broadcastToAdmins({ type: 'state', data: snapshot() });
    });

    return;
  }

  if (role === 'admin') {
    // 简化：管理员页面同源，依靠 cookie 做鉴权；WS 连接时不做强鉴权
    adminSockets.add(ws);
    wsSend(ws, { type: 'state', data: snapshot() });
    ws.on('close', () => adminSockets.delete(ws));
    return;
  }

  ws.close(1008, 'Unknown role');
});

// ---- Uploads ----
app.use('/uploads', express.static(uploadDirAbs, { maxAge: '1h' }));

function buildStorage() {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const kind = String(req.body.kind || 'unknown');
      const safeKind = kind.replace(/[^a-z0-9_\-]/gi, '_');
      const day = new Date();
      const y = day.getFullYear();
      const m = String(day.getMonth() + 1).padStart(2, '0');
      const d = String(day.getDate()).padStart(2, '0');
      const dest = path.join(uploadDirAbs, safeKind, `${y}${m}${d}`);
      ensureDir(dest);
      cb(null, dest);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 10) || '.jpg';
      cb(null, `${Date.now()}_${randomToken().slice(0, 6)}${ext}`);
    },
  });
}

const upload = multer({
  storage: buildStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

app.post('/api/candidate/photo', upload.single('photo'), (req, res) => {
  const kind = String(req.body.kind || '');
  if (!['paper_check', 'collect_paper'].includes(kind)) {
    return res.status(400).json({ ok: false, error: 'INVALID_KIND' });
  }
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'MISSING_FILE' });
  }

  const relPath = path.relative(uploadDirAbs, req.file.path).split(path.sep).join('/');
  const url = `/uploads/${relPath}`;

  store.photos[kind].push({ ts: Date.now(), url });
  if (store.pendingPhotoKind === kind) setPendingPhoto(null);

  broadcastToAdmins({ type: 'photo', kind, url, ts: Date.now() });
  res.json({ ok: true, url });
});

// ---- Admin API ----
app.post('/api/admin/login', (req, res) => {
  const password = String(req.body?.password || '');
  if (password !== config.adminPassword) {
    return res.status(401).json({ ok: false, error: 'BAD_PASSWORD' });
  }
  const token = randomToken();
  sessions.set(token, Date.now());
  res.cookie('eksam_admin', token, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.signedCookies?.eksam_admin;
  if (token) sessions.delete(token);
  res.clearCookie('eksam_admin');
  res.json({ ok: true });
});

app.get('/api/admin/state', requireAdmin, (req, res) => {
  res.json({ ok: true, data: snapshot() });
});

app.post('/api/admin/action', requireAdmin, (req, res) => {
  const type = String(req.body?.type || '');
  const payload = req.body?.payload || {};

  // 更新状态 + 下发指令
  switch (type) {
    case 'open_exam':
      setPhase('opened');
      res.json({ ok: true, ...sendCommandToCandidate({ type }) });
      return;
    case 'paper_check':
      setPhase('paper_check');
      setPendingPhoto('paper_check');
      res.json({ ok: true, ...sendCommandToCandidate({ type }) });
      return;
    case 'start_exam':
      setPhase('in_progress');
      res.json({ ok: true, ...sendCommandToCandidate({ type }) });
      return;
    case 'notify': {
      const text = String(payload?.text || '');
      pushNotification(text);
      res.json({ ok: true, ...sendCommandToCandidate({ type, payload: { text } }) });
      return;
    }
    case 'end_exam':
      setPhase('ended');
      res.json({ ok: true, ...sendCommandToCandidate({ type }) });
      return;
    case 'collect_paper':
      setPhase('collecting');
      setPendingPhoto('collect_paper');
      res.json({ ok: true, ...sendCommandToCandidate({ type }) });
      return;
    case 'close_exam':
      setPhase('closed');
      res.json({ ok: true, ...sendCommandToCandidate({ type }) });
      return;
    default:
      res.status(400).json({ ok: false, error: 'UNKNOWN_ACTION' });
      return;
  }
});

// ---- Admin page (最小UI) ----
app.get('/admin', (req, res) => {
  res.type('html').send(renderAdminHtml());
});

app.get('/', (req, res) => {
  res.redirect('/admin');
});

function renderAdminHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Eksam Evaluator</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 16px; }
    .row { display:flex; gap: 8px; flex-wrap: wrap; }
    button { padding: 8px 12px; }
    input { padding: 8px 10px; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin: 12px 0; }
    .muted { color: #666; }
    img { max-width: 240px; border-radius: 6px; border: 1px solid #ddd; }
    .grid { display:flex; gap: 12px; flex-wrap: wrap; }
  </style>
</head>
<body>
  <h2>一对一考试控制台</h2>

  <div id="login" class="card">
    <div class="row">
      <input id="pwd" type="password" placeholder="管理员密码" />
      <button onclick="login()">登录</button>
      <span id="loginMsg" class="muted"></span>
    </div>
  </div>

  <div id="panel" class="card" style="display:none">
    <div class="row" style="align-items:center; justify-content: space-between;">
      <div>
        <div><b>考试状态：</b><span id="phase">-</span></div>
        <div class="muted">考生连接：<span id="cand">-</span>；待拍照：<span id="pending">-</span></div>
      </div>
      <button onclick="logout()">退出</button>
    </div>

    <hr />
    <div class="row">
      <button onclick="action('open_exam')">开启考试</button>
      <button onclick="action('paper_check')">试卷检查(拍照)</button>
      <button onclick="action('start_exam')">开考</button>
      <button onclick="notifyPrompt()">考试中通知</button>
      <button onclick="action('end_exam')">下考</button>
      <button onclick="action('collect_paper')">收卷(拍照)</button>
      <button onclick="action('close_exam')">关闭考试</button>
    </div>

    <div class="card">
      <div><b>通知</b></div>
      <ul id="notifs"></ul>
    </div>

    <div class="card">
      <div><b>试卷检查照片</b></div>
      <div id="photos_check" class="grid"></div>
    </div>

    <div class="card">
      <div><b>收卷照片</b></div>
      <div id="photos_collect" class="grid"></div>
    </div>

    <div id="err" class="muted"></div>
  </div>

<script>
  let ws;

  function qs(id){ return document.getElementById(id); }

  async function login(){
    qs('loginMsg').textContent='';
    const password = qs('pwd').value;
    const r = await fetch('/api/admin/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password}), credentials:'include' });
    if(!r.ok){ qs('loginMsg').textContent='密码错误'; return; }
    qs('login').style.display='none';
    qs('panel').style.display='block';
    await refresh();
    connectWs();
  }

  async function logout(){
    await fetch('/api/admin/logout', { method:'POST', credentials:'include' });
    location.reload();
  }

  async function refresh(){
    const r = await fetch('/api/admin/state', { credentials:'include' });
    if(!r.ok){ qs('err').textContent='未登录或会话失效'; return; }
    const j = await r.json();
    render(j.data);
  }

  async function action(type){
    qs('err').textContent='';
    const r = await fetch('/api/admin/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type}), credentials:'include' });
    const j = await r.json().catch(()=>({}));
    if(!r.ok || j.ok===false){ qs('err').textContent = '操作失败：' + (j.error || r.status); return; }
    if(j.error){ qs('err').textContent = '已执行，但考生未连接'; }
    await refresh();
  }

  async function notifyPrompt(){
    const text = prompt('通知内容：');
    if(text==null) return;
    const r = await fetch('/api/admin/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type:'notify', payload:{text}}), credentials:'include' });
    const j = await r.json().catch(()=>({}));
    if(!r.ok || j.ok===false){ qs('err').textContent = '通知失败：' + (j.error || r.status); return; }
    await refresh();
  }

  function connectWs(){
    ws = new WebSocket((location.protocol==='https:'?'wss':'ws') + '://' + location.host + '/ws?role=admin');
    ws.onmessage = (ev)=>{
      try{ const msg = JSON.parse(ev.data); if(msg.type==='state'){ render(msg.data); } }catch{}
    };
    ws.onclose = ()=>{ setTimeout(connectWs, 1500); };
  }

  function render(data){
    qs('phase').textContent = data.phase;
    qs('cand').textContent = data.candidate.connected ? '已连接' : '未连接';
    qs('pending').textContent = data.pendingPhotoKind || '-';

    const ul = qs('notifs');
    ul.innerHTML = '';
    for(const n of (data.notifications||[]).slice().reverse()){
      const li = document.createElement('li');
      li.textContent = new Date(n.ts).toLocaleString() + ' - ' + n.text;
      ul.appendChild(li);
    }

    const c1 = qs('photos_check');
    c1.innerHTML='';
    for(const p of (data.photos?.paper_check || []).slice().reverse()){
      const a = document.createElement('a'); a.href = p.url; a.target='_blank';
      const img = document.createElement('img'); img.src = p.url;
      a.appendChild(img);
      c1.appendChild(a);
    }

    const c2 = qs('photos_collect');
    c2.innerHTML='';
    for(const p of (data.photos?.collect_paper || []).slice().reverse()){
      const a = document.createElement('a'); a.href = p.url; a.target='_blank';
      const img = document.createElement('img'); img.src = p.url;
      a.appendChild(img);
      c2.appendChild(a);
    }
  }
</script>
</body>
</html>`;
}

server.listen(config.port, () => {
  console.log(`Eksam server listening on http://localhost:${config.port}`);
  console.log('Admin console: /admin');
});
