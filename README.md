# Ollama Knowledge Manager

เว็บแอปสำหรับจัดการ Custom Model ของ Ollama พร้อมระบบ Knowledge Base, Chat Testing, User Management และ Usage Logs

---

## Features

- **Multi Custom Model** — สร้างและจัดการหลาย Custom Model แยกกัน
- **Knowledge Management** — เพิ่ม/แก้ไข/ลบ Domain Knowledge ต่อ model
- **Build Model** — Build Custom Model ผ่าน UI พร้อม Modelfile Preview
- **Test Chat** — ทดสอบ chat กับ model พร้อม context history และ System Prompt
- **Chat History** — บันทึกทุก session และ message ลง SQLite
- **User Management** — ระบบ login, role-based access, token limit ต่อ user
- **Admin Dashboard** — ดู usage logs, token usage, จัดการ user

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Database | SQLite (`better-sqlite3`) |
| Frontend | Bootstrap 5.3 + SweetAlert2 (CDN) |
| LLM | Ollama (external) |
| Container | Docker + Docker Compose |

---

## Quick Start

### 1. Clone / วาง files

```
ollama-knowledge-manager/
├── docker-compose.yaml
├── Dockerfile
├── package.json
├── server.js
└── public/
    ├── index.html
    └── login.html
```

### 2. Build & Run

```bash
docker-compose up -d --build
```

### 3. เปิดเบราว์เซอร์

```
http://localhost:4646
```

Login ด้วย `admin` / `admin` (เปลี่ยน password หลัง login ครั้งแรก)

---

## Configuration

แก้ Ollama URL ได้ใน tab **Settings** หรือแก้ค่า default ใน `server.js`:

```js
INSERT OR IGNORE INTO config VALUES ('ollama_url', 'http://YOUR_OLLAMA_HOST:PORT');
```

### docker-compose.yaml

```yaml
version: '3.8'
services:
  knowledge-manager:
    build: .
    container_name: ollama-knowledge-manager
    ports:
      - "4646:4646"
    volumes:
      - ./data:/app/data       # database & config (persistent)
      - ./public:/app/public   # UI files (hot-reload without rebuild)
    restart: unless-stopped
```

> **หมายเหตุ:** `./public` mount เป็น volume ทำให้แก้ไข UI ได้ทันทีโดยไม่ต้อง rebuild image

---

## Database Schema

ไฟล์: `data/data.db` (SQLite)

| Table | ข้อมูล |
|-------|--------|
| `custom_models` | Custom Model ที่สร้าง (name, base_model, temperature) |
| `knowledge` | Knowledge entries ต่อ model |
| `sessions` | Chat sessions |
| `messages` | Chat messages ทุกข้อความ |
| `build_log` | ประวัติ Build model |
| `users` | User accounts |
| `auth_sessions` | Login sessions (expire 24h) |
| `usage_logs` | Usage tracking ทุก action |
| `config` | Global settings (Ollama URL) |

---

## User Roles

| Role | สิทธิ์ |
|------|--------|
| `admin` | เข้าถึงได้ทุกหน้า รวม Admin tab, จัดการ User |
| `user` | ใช้งานได้ทุก feature ยกเว้น Admin |

### Token Limit

- ตั้งค่าต่อ user ใน Admin → User Management
- `0` = ไม่จำกัด (default สำหรับ admin)
- เมื่อ token หมด: chat ถูกบล็อก จนกว่า admin จะ reset

Token นับจาก: `prompt_eval_count + eval_count` ของ Ollama response

---

## API Endpoints

### Auth (Public)
```
POST /api/auth/login        { username, password }
POST /api/auth/logout
GET  /api/auth/me
```

### Custom Models
```
GET    /api/custom-models
POST   /api/custom-models
PUT    /api/custom-models/:id
DELETE /api/custom-models/:id
GET    /api/custom-models/:id/preview
POST   /api/custom-models/:id/build
```

### Knowledge
```
GET    /api/custom-models/:id/knowledge
POST   /api/custom-models/:id/knowledge
PUT    /api/custom-models/:id/knowledge/:kid
DELETE /api/custom-models/:id/knowledge/:kid
```

### Chat & History
```
POST /api/sessions
PUT  /api/sessions/:id/end
POST /api/chat              { messages, model, session_id }
GET  /api/history
GET  /api/history/:sid/messages
DELETE /api/history/:sid
DELETE /api/history
```

### Admin (admin only)
```
GET  /api/admin/dashboard
GET  /api/admin/users
POST /api/admin/users
PUT  /api/admin/users/:id
DELETE /api/admin/users/:id
POST /api/admin/users/:id/reset-tokens
GET  /api/admin/logs        ?username=&action=&limit=
```

---

## How It Works

### Build Custom Model Flow

```
1. สร้าง Custom Model (name, base_model, temperature)
2. เพิ่ม Knowledge entries (title + content)
3. กด Build → ระบบสร้าง payload ส่งไป Ollama API /api/create
   {
     model: "my-model",
     from:  "qwen2.5:3b",
     system: "[ต้อกระจก]: ... [ความดัน]: ...",
     parameters: { temperature: 0.1 }
   }
4. Ollama สร้าง Custom Model พร้อม Knowledge ฝังใน SYSTEM prompt
```

### Chat Flow

```
1. เลือก Model จาก dropdown
2. (Optional) เปิด System Prompt เพิ่มเติม
3. ส่ง message → ระบบส่ง messages[] ทั้งหมดไป /api/chat
4. Ollama ตอบกลับ → บันทึกลง DB พร้อมนับ token
5. Token เกิน limit → blocked
```

---

## Development

### รัน local (ไม่ใช้ Docker)

```bash
npm install
node server.js
```

### แก้ไข UI

เนื่องจาก `./public` mount เป็น volume แค่ **refresh browser** (Ctrl+Shift+R) หลังแก้ไข `index.html` หรือ `login.html` ได้เลย ไม่ต้อง rebuild

### แก้ไข Backend

```bash
docker-compose restart knowledge-manager
```

---

## Ollama API Compatibility

ใช้ Ollama API **v0.5+** (structured format):

```json
POST /api/create
{
  "model": "custom-name",
  "from":  "base-model:tag",
  "system": "domain knowledge...",
  "parameters": { "temperature": 0.1 },
  "stream": false
}
```

> หากใช้ Ollama เวอร์ชันเก่า (< 0.5) ให้เปลี่ยน payload ใน `server.js` ฟังก์ชัน build กลับเป็น `{ name, modelfile, stream }` แทน

---

## Troubleshooting

| ปัญหา | วิธีแก้ |
|-------|---------|
| Build error: `neither 'from' or 'files' was specified` | Ollama เวอร์ชันเก่า ใช้ `modelfile` format แทน |
| Chat ไม่ตอบ | ตรวจ Ollama URL ใน Settings และ Status dot บน navbar |
| Token หมด | Admin → Reset tokens |
| ลืม password | เข้าไปแก้ DB โดยตรง: `sqlite3 data/data.db "UPDATE users SET password_hash='...' WHERE username='admin'"` |
| UI ไม่อัปเดต | Ctrl+Shift+R (hard refresh) |

---

## License

MIT
