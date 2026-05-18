require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Detect ffmpeg ───────────────────────────────────────────────────────────
function findFfmpeg() {
  const candidates = [
    'ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/bin/ffmpeg'
  ];
  for (const cmd of candidates) {
    try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); return cmd; } catch {}
  }
  return null;
}
const FFMPEG = findFfmpeg();
console.log(FFMPEG ? `  ffmpeg: ✓ ${FFMPEG}` : '  ffmpeg: ✗ not found (large files may fail)');

// ── Get audio duration via ffprobe ──────────────────────────────────────────
async function getAudioDuration(filePath) {
  const ffprobe = FFMPEG ? FFMPEG.replace('ffmpeg', 'ffprobe') : 'ffprobe';
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', filePath
    ]);
    const info = JSON.parse(stdout);
    return parseFloat(info.format?.duration || '0');
  } catch {
    return 0;
  }
}

// ── Split audio into time-based chunks using ffmpeg ─────────────────────────
// Returns array of chunk file paths
async function splitAudioByTime(filePath, chunkDurationSecs = 600) {
  if (!FFMPEG) throw new Error('ffmpeg not installed. Please run: brew install ffmpeg');
  const ext = path.extname(filePath);
  const base = filePath.replace(ext, '');
  const duration = await getAudioDuration(filePath);
  if (!duration) throw new Error('Could not read audio duration. Is this a valid audio file?');

  const numChunks = Math.ceil(duration / chunkDurationSecs);
  const chunkPaths = [];

  for (let i = 0; i < numChunks; i++) {
    const startSec = i * chunkDurationSecs;
    const chunkPath = `${base}_chunk${i + 1}.mp3`;
    await execFileAsync(FFMPEG, [
      '-y',                          // overwrite
      '-i', filePath,                // input
      '-ss', String(startSec),       // start time
      '-t', String(chunkDurationSecs), // duration
      '-vn',                         // no video
      '-ar', '16000',                // 16kHz (optimal for Whisper)
      '-ac', '1',                    // mono
      '-b:a', '64k',                 // 64kbps — keeps chunks small
      chunkPath
    ]);
    chunkPaths.push(chunkPath);
  }
  return chunkPaths;
}

// ── Send one audio file to Groq Whisper ─────────────────────────────────────
async function transcribeFile(filePath, groqKey, originalName) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'audio/mpeg'
  });
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('response_format', 'text');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${groqKey}`, ...formData.getHeaders() },
    body: formData
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Groq HTTP ${response.status}`);
  }
  return (await response.text()).trim();
}

// ── File upload (multer) ────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB max

// ── Helper: chunk a file into 20MB pieces ──────────────────────────────────
function getChunkRanges(fileSize, chunkSize = 20 * 1024 * 1024) {
  const chunks = [];
  let offset = 0;
  while (offset < fileSize) {
    chunks.push({ start: offset, end: Math.min(offset + chunkSize, fileSize) });
    offset += chunkSize;
  }
  return chunks;
}

// ── Route: POST /api/transcribe ─────────────────────────────────────────────
// Accepts: multipart form with audio file
// Returns: { transcript: string, chunks: number }
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY not set in .env' });

  const filePath = req.file.path;
  const fileSize = req.file.size;
  const GROQ_LIMIT = 24 * 1024 * 1024; // 24MB safe limit (Groq max is 25MB)
  const chunkPaths = [];

  try {
    let parts = [];

    if (fileSize <= GROQ_LIMIT) {
      // Small file — send directly without splitting
      console.log(`  Transcribing directly (${(fileSize/1024/1024).toFixed(1)}MB)...`);
      const text = await transcribeFile(filePath, groqKey, req.file.originalname);
      parts.push(text);
    } else {
      // Large file — use ffmpeg to split by time (10-minute chunks)
      if (!FFMPEG) {
        return res.status(500).json({
          error: 'File is too large (>24MB) and ffmpeg is not installed. Run: brew install ffmpeg'
        });
      }
      console.log(`  Large file (${(fileSize/1024/1024).toFixed(1)}MB) — splitting with ffmpeg...`);
      const chunks = await splitAudioByTime(filePath, 600); // 10-min chunks
      chunkPaths.push(...chunks);
      console.log(`  Split into ${chunks.length} chunks. Transcribing...`);

      for (let i = 0; i < chunks.length; i++) {
        console.log(`  Transcribing chunk ${i + 1}/${chunks.length}...`);
        const text = await transcribeFile(chunks[i], groqKey, req.file.originalname);
        parts.push(text);
      }
    }

    // Cleanup
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    for (const cp of chunkPaths) { if (fs.existsSync(cp)) fs.unlinkSync(cp); }

    res.json({ transcript: parts.join('\n\n'), chunks: parts.length });

  } catch (err) {
    // Cleanup on error
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    for (const cp of chunkPaths) { try { if (fs.existsSync(cp)) fs.unlinkSync(cp); } catch {} }
    console.error('Transcription error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Route: POST /api/analyse ────────────────────────────────────────────────

// Accepts: { transcript, teamMembers, provider? }
// Returns: { summary, tasks, deadlines, people, decisions, actions, detectedMembers, language }
app.post('/api/analyse', async (req, res) => {
  const { transcript, teamMembers = [], provider } = req.body;
  if (!transcript) return res.status(400).json({ error: 'No transcript provided' });

  const activeProvider = provider || process.env.AI_PROVIDER || 'groq';

  try {
    let result;
    if (activeProvider === 'gemini') result = await analyseWithGemini(transcript, teamMembers);
    else if (activeProvider === 'mistral') result = await analyseWithMistral(transcript, teamMembers);
    else result = await analyseWithGroq(transcript, teamMembers);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route: POST /api/ask ────────────────────────────────────────────────────
// Accepts: { question, sessions, teamMembers, provider? }
// Returns: { answer }
app.post('/api/ask', async (req, res) => {
  const { question, sessions = [], teamMembers = [], provider } = req.body;
  if (!question) return res.status(400).json({ error: 'No question provided' });

  const activeProvider = provider || process.env.AI_PROVIDER || 'groq';
  const context = sessions.map(s =>
    `[${s.label} · ${s.meetingType} · ${new Date(s.date).toLocaleDateString()}]\nSummary: ${s.summary || ''}\nTasks: ${(s.tasks || []).join('; ')}\nDeadlines: ${(s.deadlines || []).join('; ')}\nPeople: ${(s.people || []).join(', ')}\nDecisions: ${(s.decisions || []).join('; ')}\nTranscript: ${(s.transcript || '').slice(0, 600)}`
  ).join('\n\n---\n\n');

  const teamCtx = teamMembers.length
    ? `Team: ${teamMembers.map(m => `${m.name} (${m.role || 'unknown'}${m.stack ? ', ' + m.stack : ''})`).join(', ')}`
    : '';

  const systemMsg = 'You are a helpful work assistant. Answer based only on the provided meeting data. Be clear and specific.';
  const userMsg = `${teamCtx}\n\nMEETING DATA:\n${context}\n\nQUESTION: ${question}\n\nAnswer based on the data above. If something is not in the data, say so.`;

  try {
    let answer;
    if (activeProvider === 'gemini') answer = await askGemini(systemMsg, userMsg);
    else if (activeProvider === 'mistral') answer = await askMistral(systemMsg, userMsg);
    else answer = await askGroq(systemMsg, userMsg);
    res.json({ answer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route: GET /api/config ──────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    provider: process.env.AI_PROVIDER || 'groq',
    hasGroq: !!process.env.GROQ_API_KEY,
    hasGemini: !!process.env.GEMINI_API_KEY,
    hasMistral: !!process.env.MISTRAL_API_KEY,
    hasSupabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseKey: process.env.SUPABASE_ANON_KEY || ''
  });
});

// ── AI Provider functions ───────────────────────────────────────────────────
function buildAnalysisPrompt(transcript, teamMembers) {
  const teamCtx = teamMembers.length
    ? `Known team members: ${teamMembers.map(m => m.name + (m.role ? ` (${m.role})` : '')).join(', ')}`
    : '';
  return `You are a work intelligence assistant for someone NEW to a team. Analyse this meeting transcript (may contain Hindi, Tamil, Telugu, or English).
${teamCtx}
TRANSCRIPT: """${transcript.slice(0, 6000)}"""
Return ONLY valid JSON, no markdown, no explanation:
{"summary":"2-3 sentence summary","tasks":["task assigned to ME"],"deadlines":["deadline mentioned"],"people":["Person Name"],"decisions":["decision made"],"actions":["follow-up I need to do"],"detectedMembers":[{"name":"Person Name","role":"their role if known","stack":"their tech if mentioned"}],"language":"primary language"}
Rules: tasks/actions only for ME the listener. Empty array [] if nothing found.`;
}

async function analyseWithGroq(transcript, teamMembers) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile', max_tokens: 1200, temperature: 0.1,
      messages: [
        { role: 'system', content: 'You are a work intelligence assistant. Respond with valid JSON only.' },
        { role: 'user', content: buildAnalysisPrompt(transcript, teamMembers) }
      ]
    })
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `Groq ${r.status}`); }
  const data = await r.json();
  return JSON.parse((data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim());
}

async function analyseWithGemini(transcript, teamMembers) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: buildAnalysisPrompt(transcript, teamMembers) }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 1200 } })
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `Gemini ${r.status}`); }
  const data = await r.json();
  return JSON.parse((data.candidates?.[0]?.content?.parts?.[0]?.text || '').replace(/```json|```/g, '').trim());
}

async function analyseWithMistral(transcript, teamMembers) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY not set');
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'mistral-large-latest', max_tokens: 1200, temperature: 0.1,
      messages: [
        { role: 'system', content: 'You are a work intelligence assistant. Respond with valid JSON only.' },
        { role: 'user', content: buildAnalysisPrompt(transcript, teamMembers) }
      ]
    })
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `Mistral ${r.status}`); }
  const data = await r.json();
  return JSON.parse((data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim());
}

async function askGroq(systemMsg, userMsg) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 800, temperature: 0.2, messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }] })
  });
  const data = await r.json();
  return data.choices?.[0]?.message?.content || 'No answer.';
}

async function askGemini(systemMsg, userMsg) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: systemMsg + '\n\n' + userMsg }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 800 } })
  });
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No answer.';
}

async function askMistral(systemMsg, userMsg) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY not set');
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: 'mistral-large-latest', max_tokens: 800, temperature: 0.2, messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }] })
  });
  const data = await r.json();
  return data.choices?.[0]?.message?.content || 'No answer.';
}

// ── Catch-all → serve frontend ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Antigravity running at http://localhost:${PORT}`);
  console.log(`  AI Provider: ${process.env.AI_PROVIDER || 'groq'}`);
  console.log(`  Groq key: ${process.env.GROQ_API_KEY ? '✓ set' : '✗ missing'}`);
  console.log(`  Supabase: ${process.env.SUPABASE_URL ? '✓ set' : '✗ not set (using browser storage)'}\n`);
});
