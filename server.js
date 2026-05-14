const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = 4646;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS custom_models (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    base_model  TEXT    NOT NULL DEFAULT 'qwen2.5:3b',
    temperature REAL    NOT NULL DEFAULT 0.1,
    description TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    DEFAULT (datetime('now','localtime')),
    built_at    TEXT
  );
  CREATE TABLE IF NOT EXISTS knowledge (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id   INTEGER NOT NULL REFERENCES custom_models(id) ON DELETE CASCADE,
    title      TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    created_at TEXT    DEFAULT (datetime('now','localtime')),
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id    INTEGER REFERENCES custom_models(id) ON DELETE SET NULL,
    model_name  TEXT    NOT NULL DEFAULT '',
    base_model  TEXT    NOT NULL DEFAULT '',
    started_at  TEXT    DEFAULT (datetime('now','localtime')),
    ended_at    TEXT,
    msg_count   INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    eval_ms    INTEGER,
    created_at TEXT    DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS build_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id      INTEGER REFERENCES custom_models(id) ON DELETE SET NULL,
    model_name    TEXT    NOT NULL DEFAULT '',
    base_model    TEXT    NOT NULL DEFAULT '',
    temperature   REAL,
    knowledge_cnt INTEGER NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL DEFAULT '',
    error_msg     TEXT,
    built_at      TEXT    DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user',
    token_limit   INTEGER NOT NULL DEFAULT 100000,
    token_used    INTEGER NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    DEFAULT (datetime('now','localtime')),
    last_login    TEXT
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id          TEXT    PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT    DEFAULT (datetime('now','localtime')),
    expires_at  TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username     TEXT    NOT NULL DEFAULT '',
    action       TEXT    NOT NULL DEFAULT '',
    model_name   TEXT    NOT NULL DEFAULT '',
    tokens_in    INTEGER NOT NULL DEFAULT 0,
    tokens_out   INTEGER NOT NULL DEFAULT 0,
    tokens_total INTEGER NOT NULL DEFAULT 0,
    detail       TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    DEFAULT (datetime('now','localtime'))
  );
  INSERT OR IGNORE INTO config VALUES ('ollama_url', 'http://72.62.252.196:32768');
`);

// ── Auth Utilities ────────────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const buf = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(buf, Buffer.from(hash, 'hex'));
  } catch { return false; }
}

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

// Create default admin on first run
if (db.prepare('SELECT COUNT(*) as n FROM users').get().n === 0) {
  db.prepare('INSERT INTO users (username, password_hash, role, token_limit) VALUES (?,?,?,?)')
    .run('admin', hashPassword('admin'), 'admin', 0);
  console.log('[Auth] Default admin created — username: admin  password: admin');
}

// Clean expired auth sessions hourly
setInterval(() => {
  db.prepare(`DELETE FROM auth_sessions WHERE datetime(expires_at) < datetime('now','localtime')`).run();
}, 60 * 60 * 1000);

// ── Usage Logger ──────────────────────────────────────────────────────────────

function logUsage(userId, username, action, modelName = '', tokensIn = 0, tokensOut = 0, detail = '') {
  try {
    db.prepare(`
      INSERT INTO usage_logs (user_id, username, action, model_name, tokens_in, tokens_out, tokens_total, detail)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(userId || null, username || '', action, modelName || '',
           tokensIn || 0, tokensOut || 0, (tokensIn || 0) + (tokensOut || 0), detail || '');
  } catch (e) { console.error('logUsage error:', e.message); }
}

// ── Auth Middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const session = db.prepare(`
    SELECT s.user_id,
           u.username, u.role, u.is_active, u.token_used, u.token_limit
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND datetime(s.expires_at) > datetime('now','localtime')
  `).get(token);

  if (!session) return res.status(401).json({ error: 'Session expired' });
  if (!session.is_active) return res.status(403).json({ error: 'Account disabled' });

  req.user = {
    id: session.user_id,
    username: session.username,
    role: session.role,
    token_used: session.token_used,
    token_limit: session.token_limit
  };
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// Protect all /api/* except /api/auth/*
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  requireAuth(req, res, next);
});

// ── General Helpers ───────────────────────────────────────────────────────────

function getConfig() {
  return Object.fromEntries(
    db.prepare('SELECT key, value FROM config').all().map(r => [r.key, r.value])
  );
}

function buildModelfile(m, knowledge) {
  if (!knowledge.length)
    return `FROM ${m.base_model}\nPARAMETER temperature ${m.temperature}`;
  const sys = knowledge
    .map(k => `[${k.title}]: ${k.content}`)
    .join(' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `FROM ${m.base_model}\nPARAMETER temperature ${m.temperature}\nSYSTEM "${sys}"`;
}

function ollamaRequest(ollamaUrl, urlPath, method, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(ollamaUrl); }
    catch (e) { return reject(new Error('Invalid Ollama URL: ' + ollamaUrl)); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;

    const req = lib.request({
      hostname: parsed.hostname,
      port: parseInt(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      path: urlPath,
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 300, status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ ok: res.statusCode < 300, status: res.statusCode, data }); }
      });
    });

    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Timeout 120s')); });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Auth Routes ───────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'กรุณากรอก username และ password' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Username หรือ Password ไม่ถูกต้อง' });
  if (!user.is_active)
    return res.status(403).json({ error: 'บัญชีถูกระงับ กรุณาติดต่อ Admin' });

  const sessionId = generateSessionId();
  const exp = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const expiresAt = exp.toISOString().replace('T', ' ').slice(0, 19);

  db.prepare('INSERT INTO auth_sessions (id, user_id, expires_at) VALUES (?,?,?)').run(sessionId, user.id, expiresAt);
  db.prepare(`UPDATE users SET last_login=datetime('now','localtime') WHERE id=?`).run(user.id);
  logUsage(user.id, user.username, 'login', '', 0, 0, req.ip || '');

  res.json({
    token: sessionId,
    user: { id: user.id, username: user.username, role: user.role, token_used: user.token_used, token_limit: user.token_limit }
  });
});

app.post('/api/auth/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  db.prepare('DELETE FROM auth_sessions WHERE id=?').run(token);
  logUsage(req.user.id, req.user.username, 'logout');
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = db.prepare('SELECT id, username, role, token_used, token_limit, is_active FROM users WHERE id=?').get(req.user.id);
  res.json(user);
});

// ── Admin Routes ──────────────────────────────────────────────────────────────

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  res.json({
    total_users:   db.prepare('SELECT COUNT(*) as n FROM users').get().n,
    active_users:  db.prepare('SELECT COUNT(*) as n FROM users WHERE is_active=1').get().n,
    tokens_today:  db.prepare(`SELECT COALESCE(SUM(tokens_total),0) as n FROM usage_logs WHERE action='chat' AND date(created_at)=date('now','localtime')`).get().n,
    chats_today:   db.prepare(`SELECT COUNT(*) as n FROM usage_logs WHERE action='chat' AND date(created_at)=date('now','localtime')`).get().n,
    total_tokens:  db.prepare('SELECT COALESCE(SUM(token_used),0) as n FROM users').get().n
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(db.prepare(
    'SELECT id, username, role, token_limit, token_used, is_active, created_at, last_login FROM users ORDER BY id ASC'
  ).all());
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password, role, token_limit } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'username และ password จำเป็น' });
  try {
    const r = db.prepare('INSERT INTO users (username, password_hash, role, token_limit) VALUES (?,?,?,?)')
      .run(username.trim(), hashPassword(password), role || 'user', token_limit ?? 100000);
    logUsage(req.user.id, req.user.username, 'user_created', '', 0, 0, `created: ${username.trim()}`);
    res.json(db.prepare('SELECT id, username, role, token_limit, token_used, is_active, created_at FROM users WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: `Username "${username}" มีอยู่แล้ว` });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const { username, password, role, token_limit, is_active } = req.body;
  if (password) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), req.params.id);
  try {
    db.prepare('UPDATE users SET username=?, role=?, token_limit=?, is_active=? WHERE id=?')
      .run(username?.trim(), role, token_limit ?? 100000, is_active ? 1 : 0, req.params.id);
    res.json(db.prepare('SELECT id, username, role, token_limit, token_used, is_active, created_at, last_login FROM users WHERE id=?').get(req.params.id));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username นี้มีอยู่แล้ว' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'ไม่สามารถลบตัวเองได้' });
  const u = db.prepare('SELECT username FROM users WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  if (u) logUsage(req.user.id, req.user.username, 'user_deleted', '', 0, 0, `deleted: ${u.username}`);
  res.json({ success: true });
});

app.post('/api/admin/users/:id/reset-tokens', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT username FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'ไม่พบ user' });
  db.prepare('UPDATE users SET token_used=0 WHERE id=?').run(req.params.id);
  logUsage(req.user.id, req.user.username, 'token_reset', '', 0, 0, `reset: ${u.username}`);
  res.json({ success: true });
});

app.get('/api/admin/logs', requireAdmin, (req, res) => {
  const { username, action, limit = 200 } = req.query;
  let sql = 'SELECT * FROM usage_logs WHERE 1=1';
  const params = [];
  if (username) { sql += ' AND username=?'; params.push(username); }
  if (action)   { sql += ' AND action=?';   params.push(action); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit));
  res.json(db.prepare(sql).all(...params));
});

// ── Config ────────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => res.json(getConfig()));

app.put('/api/config', (req, res) => {
  const upsert = db.prepare('INSERT OR REPLACE INTO config VALUES (?,?)');
  const run = db.transaction(data => { for (const [k, v] of Object.entries(data)) upsert.run(k, String(v)); });
  run(req.body);
  res.json(getConfig());
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  res.json({
    models:   db.prepare('SELECT COUNT(*) as n FROM custom_models').get().n,
    knowledge: db.prepare('SELECT COUNT(*) as n FROM knowledge').get().n,
    sessions: db.prepare('SELECT COUNT(*) as n FROM sessions').get().n,
    messages: db.prepare('SELECT COUNT(*) as n FROM messages').get().n,
  });
});

// ── Custom Models ─────────────────────────────────────────────────────────────

app.get('/api/custom-models', (req, res) => {
  res.json(db.prepare(`
    SELECT m.*, COUNT(k.id) as knowledge_count
    FROM custom_models m
    LEFT JOIN knowledge k ON k.model_id = m.id
    GROUP BY m.id ORDER BY m.created_at DESC
  `).all());
});

app.post('/api/custom-models', (req, res) => {
  const { name, base_model, temperature, description } = req.body;
  if (!name?.trim() || !base_model?.trim())
    return res.status(400).json({ error: 'name และ base_model จำเป็น' });
  try {
    const r = db.prepare('INSERT INTO custom_models (name, base_model, temperature, description) VALUES (?,?,?,?)')
      .run(name.trim(), base_model.trim(), temperature ?? 0.1, description?.trim() || '');
    res.json(db.prepare('SELECT * FROM custom_models WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: `ชื่อ "${name}" มีอยู่แล้ว` });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/custom-models/:id', (req, res) => {
  const { name, base_model, temperature, description } = req.body;
  try {
    db.prepare('UPDATE custom_models SET name=?, base_model=?, temperature=?, description=? WHERE id=?')
      .run(name?.trim(), base_model?.trim(), temperature ?? 0.1, description?.trim() || '', req.params.id);
    const m = db.prepare('SELECT * FROM custom_models WHERE id=?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'ไม่พบ model' });
    res.json(m);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: `ชื่อ "${name}" มีอยู่แล้ว` });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/custom-models/:id', (req, res) => {
  db.prepare('DELETE FROM custom_models WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Knowledge ─────────────────────────────────────────────────────────────────

app.get('/api/custom-models/:id/knowledge', (req, res) => {
  res.json(db.prepare('SELECT * FROM knowledge WHERE model_id=? ORDER BY id ASC').all(req.params.id));
});

app.post('/api/custom-models/:id/knowledge', (req, res) => {
  const { title, content } = req.body;
  if (!title?.trim() || !content?.trim())
    return res.status(400).json({ error: 'title และ content จำเป็น' });
  const r = db.prepare('INSERT INTO knowledge (model_id, title, content) VALUES (?,?,?)').run(req.params.id, title.trim(), content.trim());
  res.json(db.prepare('SELECT * FROM knowledge WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/custom-models/:id/knowledge/:kid', (req, res) => {
  const { title, content } = req.body;
  db.prepare(`UPDATE knowledge SET title=?, content=?, updated_at=datetime('now','localtime') WHERE id=? AND model_id=?`)
    .run(title?.trim(), content?.trim(), req.params.kid, req.params.id);
  const k = db.prepare('SELECT * FROM knowledge WHERE id=?').get(req.params.kid);
  if (!k) return res.status(404).json({ error: 'ไม่พบ knowledge' });
  res.json(k);
});

app.delete('/api/custom-models/:id/knowledge/:kid', (req, res) => {
  db.prepare('DELETE FROM knowledge WHERE id=? AND model_id=?').run(req.params.kid, req.params.id);
  res.json({ success: true });
});

// ── Modelfile Preview ─────────────────────────────────────────────────────────

app.get('/api/custom-models/:id/preview', (req, res) => {
  const m = db.prepare('SELECT * FROM custom_models WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'ไม่พบ model' });
  const knowledge = db.prepare('SELECT * FROM knowledge WHERE model_id=? ORDER BY id ASC').all(req.params.id);
  res.json({ modelfile: buildModelfile(m, knowledge), knowledge_count: knowledge.length, model: m });
});

// ── Build Model ───────────────────────────────────────────────────────────────

app.post('/api/custom-models/:id/build', async (req, res) => {
  const m = db.prepare('SELECT * FROM custom_models WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'ไม่พบ model' });

  const knowledge = db.prepare('SELECT * FROM knowledge WHERE model_id=? ORDER BY id ASC').all(req.params.id);
  const modelfile = buildModelfile(m, knowledge);
  const cfg = getConfig();

  const logBuild = (status, error_msg = null) =>
    db.prepare(`INSERT INTO build_log (model_id, model_name, base_model, temperature, knowledge_cnt, status, error_msg) VALUES (?,?,?,?,?,?,?)`)
      .run(m.id, m.name, m.base_model, m.temperature, knowledge.length, status, error_msg);

  const systemText = knowledge.map(k => `[${k.title}]: ${k.content}`).join('\n');
  const payload = {
    model: m.name, name: m.name, from: m.base_model,
    parameters: { temperature: m.temperature },
    stream: false,
    ...(systemText ? { system: systemText } : {})
  };

  try {
    const result = await ollamaRequest(cfg.ollama_url, '/api/create', 'POST', payload);
    if (result.ok) {
      db.prepare(`UPDATE custom_models SET built_at=datetime('now','localtime') WHERE id=?`).run(m.id);
      logBuild('success');
      logUsage(req.user.id, req.user.username, 'build', m.name, 0, 0, `knowledge: ${knowledge.length}`);
      res.json({ success: true, message: `Build "${m.name}" สำเร็จ`, modelfile });
    } else {
      const errMsg = JSON.stringify(result.data);
      logBuild('error', errMsg);
      res.status(result.status).json({ error: 'Ollama error: ' + errMsg });
    }
  } catch (e) {
    logBuild('error', e.message);
    res.status(500).json({ error: 'เชื่อมต่อ Ollama ไม่ได้: ' + e.message });
  }
});

app.get('/api/build-log', (req, res) => {
  const { model_id } = req.query;
  if (model_id)
    res.json(db.prepare('SELECT * FROM build_log WHERE model_id=? ORDER BY built_at DESC LIMIT 20').all(model_id));
  else
    res.json(db.prepare('SELECT * FROM build_log ORDER BY built_at DESC LIMIT 50').all());
});

// ── Chat Sessions ─────────────────────────────────────────────────────────────

app.post('/api/sessions', (req, res) => {
  const { model_id, model_name, base_model } = req.body;
  const r = db.prepare('INSERT INTO sessions (model_id, model_name, base_model) VALUES (?,?,?)')
    .run(model_id || null, model_name || '', base_model || '');
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/sessions/:id/end', (req, res) => {
  db.prepare(`UPDATE sessions SET ended_at=datetime('now','localtime') WHERE id=?`).run(req.params.id);
  res.json({ success: true });
});

// ── Chat (with token counting) ────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { messages, model, session_id } = req.body;
  const user = req.user;

  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: 'กรุณาส่ง messages array' });

  // Token limit check
  if (user.token_limit > 0 && user.token_used >= user.token_limit) {
    logUsage(user.id, user.username, 'token_limit_exceeded', model, 0, 0, `limit: ${user.token_limit}`);
    return res.status(429).json({
      error: `⛔ Token หมดแล้ว (${user.token_used.toLocaleString()} / ${user.token_limit.toLocaleString()}) กรุณาติดต่อ Admin`
    });
  }

  const cfg = getConfig();
  const userMsg = [...messages].reverse().find(m => m.role === 'user');
  if (session_id && userMsg)
    db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?,?,?)').run(session_id, 'user', userMsg.content);

  try {
    const result = await ollamaRequest(cfg.ollama_url, '/api/chat', 'POST', { model, messages, stream: false });

    if (result.ok && result.data.message?.content) {
      const tokensIn  = result.data.prompt_eval_count || 0;
      const tokensOut = result.data.eval_count || 0;
      const total = tokensIn + tokensOut;

      if (total > 0)
        db.prepare('UPDATE users SET token_used = token_used + ? WHERE id=?').run(total, user.id);

      logUsage(user.id, user.username, 'chat', model, tokensIn, tokensOut);

      const evalMs = result.data.eval_duration ? Math.round(result.data.eval_duration / 1e6) : null;
      if (session_id) {
        db.prepare('INSERT INTO messages (session_id, role, content, eval_ms) VALUES (?,?,?,?)')
          .run(session_id, 'assistant', result.data.message.content, evalMs);
        db.prepare('UPDATE sessions SET msg_count=(SELECT COUNT(*) FROM messages WHERE session_id=?) WHERE id=?')
          .run(session_id, session_id);
      }
    }
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: 'เชื่อมต่อ Ollama ไม่ได้: ' + e.message });
  }
});

// ── History ───────────────────────────────────────────────────────────────────

app.get('/api/history', (req, res) => {
  const { model_name, limit = 50 } = req.query;
  let sql = `
    SELECT s.*,
      (SELECT content FROM messages WHERE session_id=s.id AND role='user' ORDER BY id ASC LIMIT 1) AS first_message
    FROM sessions s
  `;
  const params = [];
  if (model_name) { sql += ' WHERE s.model_name=?'; params.push(model_name); }
  sql += ' ORDER BY s.started_at DESC LIMIT ?';
  params.push(parseInt(limit));
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/history/:sid/messages', (req, res) => {
  res.json(db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id ASC').all(req.params.sid));
});

app.delete('/api/history/:sid', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id=?').run(req.params.sid);
  res.json({ success: true });
});

app.delete('/api/history', (req, res) => {
  const { model_name } = req.query;
  if (model_name) db.prepare('DELETE FROM sessions WHERE model_name=?').run(model_name);
  else db.prepare('DELETE FROM sessions').run();
  res.json({ success: true });
});

// ── Ollama Models ─────────────────────────────────────────────────────────────

app.get('/api/ollama-models', async (req, res) => {
  const cfg = getConfig();
  try {
    const result = await ollamaRequest(cfg.ollama_url, '/api/tags', 'GET');
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Ollama Knowledge Manager v2 → http://localhost:${PORT}`);
});
