# TCS/Cisco Project Analysis — Team Intelligence System

Upload daily meeting recordings → AI transcribes + analyses → builds your team picture over time.

## What it does

- Upload audio (scrum calls, 1-on-1s, internal meetings)
- Auto-transcribes using **Groq Whisper** (free)
- AI extracts tasks, deadlines, people, decisions, follow-ups
- Builds a **Team Chart** that grows from recordings
- **Ask Everything** — query all your recordings with natural language
- Saves everything to **Supabase** (free cloud DB)

---

## Project structure

```
antigravity/
├── server.js          ← Express backend (API routes)
├── package.json
├── .env.example       ← Copy to .env and fill in keys
├── .gitignore
└── public/
    └── index.html     ← Full frontend app
```

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/antigravity.git
cd antigravity
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```env
GROQ_API_KEY=gsk_xxxx        # Required — free at console.groq.com/keys
AI_PROVIDER=groq              # groq | gemini | mistral
GEMINI_API_KEY=               # Optional — free at aistudio.google.com
MISTRAL_API_KEY=              # Optional — free at console.mistral.ai
SUPABASE_URL=                 # Optional — free at supabase.com
SUPABASE_ANON_KEY=            # Optional
PORT=3000
```

### 3. Set up Supabase (optional but recommended)

1. Go to [supabase.com](https://supabase.com) → create free project
2. Go to **Project Settings → API** → copy URL and anon key into `.env`
3. Go to **SQL Editor** → run this:

```sql
create table if not exists sessions (
  id text primary key,
  date timestamptz default now(),
  label text,
  filename text,
  meeting_type text,
  transcript text,
  summary text,
  tasks jsonb default '[]',
  deadlines jsonb default '[]',
  people jsonb default '[]',
  decisions jsonb default '[]',
  actions jsonb default '[]',
  detected_members jsonb default '[]',
  language text,
  created_at timestamptz default now()
);

create table if not exists team_members (
  id text primary key,
  name text not null,
  role text,
  stack text,
  notes text,
  is_me boolean default false,
  mention_count int default 0,
  last_mentioned timestamptz,
  detected boolean default false,
  created_at timestamptz default now()
);

create table if not exists task_status (
  id text primary key,
  done boolean default false
);
```

### 4. Run locally

```bash
npm start
# or for development with auto-restart:
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Deploy to a server

### Option A — Any VPS (Ubuntu)

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone your repo
git clone https://github.com/YOUR_USERNAME/antigravity.git
cd antigravity
npm install

# Set up .env
cp .env.example .env
nano .env   # fill in your keys

# Run with PM2 (keeps it running)
npm install -g pm2
pm2 start server.js --name antigravity
pm2 save
pm2 startup
```

### Option B — Railway (free tier)

1. Push code to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add environment variables in Railway dashboard
4. Done — Railway gives you a public URL

### Option C — Render (free tier)

1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service → Connect GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add environment variables
6. Deploy

---

## API routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/config` | GET | Returns server config (which keys are set) |
| `/api/transcribe` | POST | Upload audio file → returns transcript |
| `/api/analyse` | POST | Send transcript → returns extracted data |
| `/api/ask` | POST | Ask a question about your sessions |

---

## How to use daily

1. **Every Monday/Wednesday** — upload scrum recording → label it "Monday scrum"
2. **Every Friday** — upload internal meeting recording
3. **After 1-on-1s** — upload those too
4. **Check Tasks page** — see everything assigned to you
5. **Ask Everything** — type "what is my role?" or "what did the scrum master say?"

The more recordings you upload, the smarter the insights get.
