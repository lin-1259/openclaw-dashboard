const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SESSIONS_DIR = '/root/.openclaw/agents/main/sessions';
const SESSIONS_JSON = path.join(SESSIONS_DIR, 'sessions.json');
const PORT = 19999;

// WebSocket clients
const wsClients = new Set();
// Session detail cache
const sessionCache = new Map();

function getSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf8')); }
  catch(e) { return {}; }
}

function extractText(content, userOnly = false) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(x => x.type === 'text')
      .map(x => x.text || '')
      .filter(t => !userOnly || !t.match(/message_id|sender_id|conversation_label|untrusted metadata|Conversation info|"is_group_chat"/))
      .join(' ');
  }
  return '';
}

function inferStatus(sessionFile, updatedAt) {
  // 从 jsonl 最后几行推断真实状态
  try {
    const fd = fs.openSync(sessionFile, 'r');
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const readSize = Math.min(4096, size);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const lines = tail.split('\n').filter(Boolean).slice(-10);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'message') {
          const role = obj.message && obj.message.role;
          const ts = new Date(obj.timestamp).getTime();
          const age = Date.now() - ts;
          if (role === 'assistant') return age < 120000 ? 'active' : age < 600000 ? 'idle' : 'dormant';
          if (role === 'user') return age < 30000 ? 'active' : 'idle';
        }
      } catch(e) {}
    }
  } catch(e) {}
  const age = Date.now() - (updatedAt || 0);
  return age < 60000 ? 'active' : age < 300000 ? 'idle' : 'dormant';
}

function getSessionDetail(sessionFile, fullHistory = false) {
  try {
    const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').filter(Boolean);
    let firstUserMsg = '';
    let lastUserMsg = '';
    let lastAssistantMsg = '';
    let msgCount = 0;
    let model = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let lastContextTokens = 0;
    let lastOutputTokens = 0;
    const history = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'model_change') model = obj.modelId || model;
        if (obj.type === 'custom' && obj.data && obj.data.modelId) model = obj.data.modelId || model;
        if (obj.type === 'message') {
          const msg = obj.message;
          const role = msg.role;
          const ts = obj.timestamp;

          // toolResult → 工具返回
          if (role === 'toolResult' && fullHistory) {
            const output = (msg.details && msg.details.aggregated) || extractText(msg.content) || '';
            const toolName = msg.toolName || 'tool';
            const exitCode = msg.details ? msg.details.exitCode : undefined;
            const dur = msg.details ? msg.details.durationMs : undefined;
            history.push({ role: 'toolResult', toolName, exitCode, durationMs: dur, content: output, ts });
            continue;
          }
          if (role === 'toolResult') continue;

          const content = extractText(msg.content);
          const clean = content
            .replace(/\[\[reply_to[^\]]*\]\]/g, '')
            .replace(/System:\s*\[.*?\].*?\n/gm, '')
            .replace(/NO_REPLY/g, '')
            .replace(/HEARTBEAT_OK/g, '')
            .trim();

          // assistant 消息里提取 toolUse blocks
          if (role === 'assistant' && fullHistory && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'tool_use' || block.type === 'toolUse') {
                const input = block.input ? JSON.stringify(block.input, null, 2) : '';
                history.push({ role: 'toolUse', toolName: block.name, content: input, ts });
              }
            }
          }

          if (role === 'user' && clean) {
            msgCount++;
            // 从 envelope 后面提取真实用户意图
            // 格式: "Conversation info...```json\n{...}```\n\nSender...```json\n{...}```\n\n[真实输入]"
            let realMsg = clean;
            // 取最后一个 ``` 块结束后的内容
            const lastTickIdx = realMsg.lastIndexOf('```');
            if (lastTickIdx !== -1) realMsg = realMsg.substring(lastTickIdx + 3).trim();
            // 如果还是空，取 clean 里最后一个非空行
            if (!realMsg || realMsg.length < 2) {
              const nonEmpty = clean.split('\n').map(l=>l.trim()).filter(l => l.length > 2 && !l.match(/message_id|sender_id|untrusted|Conversation|Sender/));
              realMsg = nonEmpty[nonEmpty.length-1] || '';
            }
            realMsg = realMsg.replace(/\s+/g,' ').trim().substring(0,80);
            if (!firstUserMsg && realMsg.length > 0) firstUserMsg = realMsg;
            lastUserMsg = realMsg || clean.substring(0,80);
            if (fullHistory) history.push({ role: 'user', content: clean, ts });
          }
          if (role === 'assistant' && msg.usage) {
            lastContextTokens = msg.usage.input || 0;
            lastOutputTokens = msg.usage.output || 0;
            totalInputTokens += msg.usage.input || 0;
            totalOutputTokens += msg.usage.output || 0;
          }
          if (role === 'assistant' && clean) {
            const c = clean.replace(/\[\[reply_to_current\]\]/g, '').trim();
            lastAssistantMsg = c.substring(0, 80);
            if (fullHistory) history.push({ role: 'assistant', content: c, ts });
          }
        }
      } catch(e) {}
    }
    return { firstUserMsg, lastUserMsg, lastAssistantMsg, msgCount, model, history, totalInputTokens, totalOutputTokens, lastContextTokens, lastOutputTokens };
  } catch(e) { return { firstUserMsg: '', lastUserMsg: '', lastAssistantMsg: '', msgCount: 0, model: '', history: [] }; }
}

function getProcesses() {
  try {
    const result = execSync('ps aux --sort=-%cpu | grep -E "node|python|openclaw" | grep -v grep | grep -v "ps aux" | head -15', { timeout: 3000, encoding: 'utf8' });
    return result.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.trim().split(/\s+/);
      return { pid: parts[1], cpu: parts[2], mem: parts[3], cmd: parts.slice(10).join(' ').substring(0, 100) };
    });
  } catch(e) { return []; }
}

function buildData() {
  const sessions = getSessions();
  const now = Date.now();
  const result = [];
  for (const [key, s] of Object.entries(sessions)) {
    const age = now - (s.updatedAt || 0);
    const sessionFile = s.sessionFile || path.join(SESSIONS_DIR, s.sessionId + '.jsonl');
    const fileExists = fs.existsSync(sessionFile);
    let status = fileExists ? inferStatus(sessionFile, s.updatedAt) : (age < 60000 ? 'active' : age < 300000 ? 'idle' : 'dormant');
    if (s.abortedLastRun) status = 'aborted';
    const originLabel = s.origin && s.origin.label ? s.origin.label : key;
    const detail = getSessionDetail(sessionFile);
    const channelMatch = originLabel.match(/Guild #(.+?) channel/);
    const isCron = key.includes(':cron:');
    let channelName;
    if (isCron) {
      const cronId = key.match(/cron:([^:]+)/)?.[1]?.substring(0,8) || 'cron';
      channelName = '⏱ ' + cronId + (key.includes(':run:') ? ' (run)' : '');
    } else {
      channelName = channelMatch ? '#' + channelMatch[1] : originLabel || key.split(':').slice(-1)[0];
    }
    const taskDesc = detail.lastUserMsg || detail.firstUserMsg || '（无内容）';
    result.push({
      key, sessionId: s.sessionId,
      chatType: s.chatType || 'unknown',
      updatedAt: s.updatedAt, updatedAgo: Math.floor(age / 1000),
      status, aborted: s.abortedLastRun || false,
      origin: originLabel, channelName, taskDesc,
      lastUserMsg: detail.lastUserMsg,
      lastAssistantMsg: detail.lastAssistantMsg,
      msgCount: detail.msgCount, model: detail.model,
      contextTokens: detail.lastContextTokens, outputTokens: detail.lastOutputTokens
    });
  }
  result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { timestamp: now, sessions: result, processes: getProcesses() };
}

// Broadcast to all WS clients
function broadcast(data) {
  const msg = JSON.stringify({ type: 'update', data });
  for (const ws of wsClients) {
    try { ws.send(msg); } catch(e) { wsClients.delete(ws); }
  }
}

// Context warning config
const ALERT_CHANNEL = '1482226015311888524';
const CONTEXT_LIMIT = 200000;
const ALERT_THRESHOLD = 0.8;
const ALERT_COOLDOWN = 30 * 60 * 1000; // 30 min
const alertedSessions = new Map(); // sessionId -> last alert ts

async function sendDiscordAlert(channelId, message) {
  try {
    const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
    const token = cfg.channels && cfg.channels.discord && cfg.channels.discord.token;
    if (!token) return;
    const https = require('https');
    const body = JSON.stringify({ content: message });
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      method: 'POST',
      headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.resume(); });
    req.on('error', e => console.error('Discord alert error:', e.message));
    req.write(body); req.end();
  } catch(e) { console.error('Alert failed:', e.message); }
}

function checkContextAlerts(sessions) {
  const now = Date.now();
  for (const s of sessions) {
    if (!s.contextTokens || !s.sessionId) continue;
    const pct = s.contextTokens / CONTEXT_LIMIT;
    if (pct < ALERT_THRESHOLD) continue;
    const lastAlert = alertedSessions.get(s.sessionId) || 0;
    if (now - lastAlert < ALERT_COOLDOWN) continue;
    alertedSessions.set(s.sessionId, now);
    const pctStr = Math.round(pct * 100);
    const fmt = s.contextTokens >= 1000 ? (s.contextTokens/1000).toFixed(1)+'k' : s.contextTokens;
    const msg = `⚠️ **上下文警告** ${s.channelName}\n已用 **${fmt} / 200k tokens (${pctStr}%)**，建议尽快 /reset 重置上下文。`;
    sendDiscordAlert(ALERT_CHANNEL, msg);
    console.log(`[alert] ${s.channelName} context ${pctStr}%`);
  }
}

// Broadcast to WS clients every 30s
setInterval(() => {
  if (wsClients.size > 0) broadcast(buildData());
}, 30000);

// Context alert check every 5 minutes
setInterval(() => {
  checkContextAlerts(buildData().sessions);
}, 5 * 60 * 1000);
setTimeout(() => checkContextAlerts(buildData().sessions), 15000);

// Simple WebSocket implementation
const crypto = require('crypto');
function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
}

function parseWsFrame(buf) {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  if (buf.length < offset + (masked ? 4 : 0) + len) return null;
  let payload;
  if (masked) {
    const mask = buf.slice(offset, offset + 4); offset += 4;
    payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i % 4];
  } else {
    payload = buf.slice(offset, offset + len);
  }
  return payload.toString();
}

function makeWsFrame(data) {
  const payload = Buffer.from(data);
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.from([0x81, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
  else { header = Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(len),2); }
  return Buffer.concat([header, payload]);
}

// Track log file watchers
const logWatchers = new Map();

function getRecentLogs() {
  try {
    const files = fs.readdirSync('/tmp').filter(f => f.endsWith('.log'));
    const result = [];
    for (const f of files) {
      const fp = '/tmp/' + f;
      try {
        const stat = fs.statSync(fp);
        if (stat.size === 0) continue;
        if (Date.now() - stat.mtimeMs > 86400000) continue;
        const tail = getLogTail(fp, 5);
        result.push({ file: fp, name: f, size: stat.size, mtime: stat.mtimeMs, tail });
      } catch(e) {}
    }
    return result.sort((a,b) => b.mtime - a.mtime);
  } catch(e) { return []; }
}

function getTaskProcesses() {
  try {
    // Find all processes with log files in /tmp
    const result = execSync('ps aux --no-headers', { timeout: 3000, encoding: 'utf8' });
    const procs = [];
    for (const line of result.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[1];
      const cmd = parts.slice(10).join(' ');
      // Skip system/infra processes
      if (!cmd.match(/python|bash.*\.sh|node.*\.js(?!.*server\.js|.*openclaw|.*build|.*dist|.*launcher)/)) continue;
      if (cmd.match(/grep|ps aux|server\.js|openclaw|fail2ban|containerd|build\/index|dist\/|launcher|supervisord|searxng|flaresolverr|granian|dumb-init|start\.sh|playwright\/driver/)) continue;
      // Check if this process has a log file
      let logFile = null;
      try {
        const fds = execSync(`ls -la /proc/${pid}/fd 2>/dev/null`, { timeout: 1000, encoding: 'utf8' });
        const logMatch = fds.match(/-> (\S+\.log)/m);
        if (logMatch) logFile = logMatch[1];
      } catch(e) {}
      // Get runtime
      let runtime = '';
      try {
        const stat = execSync(`ps -p ${pid} -o etime= 2>/dev/null`, { timeout: 500, encoding: 'utf8' });
        runtime = stat.trim();
      } catch(e) {}
      procs.push({ pid, cmd: cmd.substring(0, 80), logFile, runtime, alive: true });
    }
    // Also scan /tmp/*.log for recently modified logs (orphaned)
    const logs = execSync('ls -t /tmp/*.log 2>/dev/null | head -10', { timeout: 1000, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const logFile of logs) {
      if (procs.find(p => p.logFile === logFile)) continue;
      // Check if modified in last hour
      try {
        const stat = fs.statSync(logFile);
        const age = Date.now() - stat.mtimeMs;
        if (age < 3600000) {
          procs.push({ pid: null, cmd: path.basename(logFile), logFile, runtime: '', alive: false });
        }
      } catch(e) {}
    }
    return procs;
  } catch(e) { return []; }
}

function getLogTail(logFile, lines = 50) {
  try {
    if (!logFile || !fs.existsSync(logFile)) return [];
    const content = execSync(`tail -n ${lines} ${logFile}`, { timeout: 2000, encoding: 'utf8' });
    return content.split('\n').filter(Boolean);
  } catch(e) { return []; }
}

// Watch log files and broadcast changes
function watchLogs() {
  try {
    const procs = getTaskProcesses();
    for (const p of procs) {
      if (!p.logFile || logWatchers.has(p.logFile)) continue;
      try {
        const watcher = fs.watch(p.logFile, () => {
          const tail = getLogTail(p.logFile, 5);
          broadcast({ type: 'log', logFile: p.logFile, cmd: p.cmd, lines: tail });
        });
        logWatchers.set(p.logFile, watcher);
      } catch(e) {}
    }
  } catch(e) {}
}

setInterval(watchLogs, 5000);
watchLogs();

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(buildData()));
  } else if (url === '/api/tasks') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    const tasks = getTaskProcesses();
    const logs = getRecentLogs();
    // merge: attach recent logs to tasks, and add standalone logs
    const taskPids = new Set(tasks.map(t => t.logFile).filter(Boolean));
    const standaloneLogs = logs.filter(l => !tasks.some(t => t.logFile === l.file));
    res.end(JSON.stringify({ tasks, logs: standaloneLogs }));
  } else if (url === '/api/procs') {
    const tasks = getTaskProcesses();
    const logs = getRecentLogs();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ tasks, logs }));
  } else if (url === '/api/log') {
    const params = new URL(req.url, 'http://x').searchParams;
    const logFile = params.get('file');
    const lines = parseInt(params.get('lines') || '100');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ lines: getLogTail(logFile, lines) }));
  } else if (url === '/api/session') {
    const params = new URL(req.url, 'http://x').searchParams;
    const sid = params.get('id');
    const limit = parseInt(params.get('limit') || '80');
    const offset = parseInt(params.get('offset') || '0');
    const sessions = getSessions();
    const s = Object.values(sessions).find(x => x.sessionId === sid);
    if (!s) { res.writeHead(404); res.end('{}'); return; }
    const sessionFile = s.sessionFile || path.join(SESSIONS_DIR, sid + '.jsonl');
    // cache by file mtime
    let stat; try { stat = fs.statSync(sessionFile); } catch(e) { res.writeHead(404); res.end('{}'); return; }
    const cacheKey = sid + ':' + stat.mtimeMs;
    if (!sessionCache.has(cacheKey)) {
      const detail = getSessionDetail(sessionFile, true);
      sessionCache.set(cacheKey, detail);
      // evict old entries
      if (sessionCache.size > 10) sessionCache.delete(sessionCache.keys().next().value);
    }
    const full = sessionCache.get(cacheKey);
    const history = full.history || [];
    const total = history.length;
    // return last `limit` items by default, or paginate with offset from end
    const start = offset > 0 ? Math.max(0, total - offset - limit) : Math.max(0, total - limit);
    const end = offset > 0 ? Math.max(0, total - offset) : total;
    const page = history.slice(start, end);
    const result = Object.assign({}, full, { history: page, total, hasMore: start > 0 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
  } else {
    const file = path.join(__dirname, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' });
    res.end(fs.readFileSync(file));
  }
});

server.on('upgrade', (req, socket) => {
  if (req.headers['upgrade'] !== 'websocket') { socket.destroy(); return; }
  wsHandshake(req, socket);
  const ws = { send: (data) => socket.write(makeWsFrame(data)) };
  wsClients.add(ws);
  socket.on('data', buf => { try { parseWsFrame(buf); } catch(e) {} });
  socket.on('close', () => wsClients.delete(ws));
  socket.on('error', () => wsClients.delete(ws));
  // Send initial data
  try { ws.send(JSON.stringify({ type: 'update', data: buildData() })); } catch(e) {}
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running at http://0.0.0.0:${PORT}`);
});
// This line intentionally left blank - checking append works
