// Static server + /api/interpret AI fallback for unrecognised voice commands.
// Env: OPENAI_API_KEY (required for AI), OPENAI_BASE_URL (default https://api.openai.com/v1),
//      AI_MODEL (default gpt-4o-mini), PORT (default 8080)
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const path = require('path');

const PORT = process.env.PORT || 8080;
const BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const KEY = process.env.OPENAI_API_KEY;
const STATIC = ['index.html', 'style.css', 'app.js', 'commands.js', 'vendor/mp4-muxer.js'];
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

const SYSTEM = `You translate a spoken video-editing command (English or Tamil, possibly mis-transcribed) into ONE JSON object.
Allowed actions and fields:
split {at?:number seconds} | removeAudio {all?:bool} | includeAudio {fresh?:bool,all?:bool} |
crop {shape:"square"|"vertical"|"wide"|"left"|"right"|"reset"} | zoom {dir:1|-1} |
transition {name:"fade"|"slide"|"zoom"|"wipe"|"none"} | animation {name:"fade"|"slide"|"zoom"|"pulse"|"none"} |
format {format:"reel"|"story"|"shorts"|"youtube"|"square"} | import {} | deleteClip {} | undo {} | play {} | pause {} | export {} |
trim {from?:number,to?:number,cutStart?:number,cutEnd?:number} | seek {to?:number seconds} | caption {text:string} | autoCaption {} (generate subtitles from speech) |
volume {level?:number 0-2 where 1 is 100%, dir?:1|-1} | speed {rate?:number 0.25-4, dir?:1|-1}
Clip-level actions (split, removeAudio, includeAudio, crop, zoom, transition, animation, deleteClip, trim, autoCaption, seek, volume, speed) may also include target: the 1-based clip number or "last" when the user names a specific clip (seek with only a target jumps to that clip).
If the request does not match any action, return {"action":"none"}. Output JSON only.`;

const VALID = {
  split: { at: 'number' }, removeAudio: { all: 'boolean' }, includeAudio: { fresh: 'boolean', all: 'boolean' },
  crop: { shape: ['square', 'vertical', 'wide', 'left', 'right', 'reset'] }, zoom: { dir: [1, -1] },
  transition: { name: ['fade', 'slide', 'zoom', 'wipe', 'none'] }, animation: { name: ['fade', 'slide', 'zoom', 'pulse', 'none'] },
  format: { format: ['reel', 'story', 'shorts', 'youtube', 'square'] },
  import: {}, deleteClip: {}, undo: {}, play: {}, pause: {}, export: {},
  trim: { from: 'number', to: 'number', cutStart: 'number', cutEnd: 'number' }, caption: { text: 'string' }, autoCaption: {}, seek: { to: 'number' },
  volume: { level: 'number', dir: [1, -1] }, speed: { rate: 'number', dir: [1, -1] },
};

const TARGETABLE = new Set(['split', 'removeAudio', 'includeAudio', 'crop', 'zoom', 'transition', 'animation', 'deleteClip', 'trim', 'autoCaption', 'seek', 'volume', 'speed']);

// Keep only whitelisted action/fields with the right types so model output can't inject anything else.
function sanitize(obj) {
  if (!obj || typeof obj.action !== 'string' || !VALID[obj.action]) return null;
  const out = { action: obj.action };
  for (const [k, rule] of Object.entries(VALID[obj.action])) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(rule) ? rule.includes(v) : typeof v === rule) out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  if (TARGETABLE.has(obj.action) && (obj.target === 'last' || (Number.isInteger(obj.target) && obj.target >= 1 && obj.target <= 99))) out.target = obj.target;
  return out;
}

async function interpret(text) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }],
    }),
  });
  if (!res.ok) throw new Error('AI provider error ' + res.status);
  const data = await res.json();
  return sanitize(JSON.parse(data.choices[0].message.content));
}

const send = (res, code, o) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));

async function readBody(req, limit) {
  const parts = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('too large'), { code: 413 }); parts.push(c); }
  return Buffer.concat(parts);
}

// Cloud speech-to-text (Whisper-compatible) — much better Tamil than the browser's built-in recogniser.
async function handleTranscribe(req, res, url) {
  try {
    if (!KEY) return send(res, 503, { error: 'AI not configured (set OPENAI_API_KEY)' });
    const lang = url.searchParams.get('lang') === 'ta' ? 'ta' : 'en';
    const audio = await readBody(req, 10 * 1024 * 1024);
    const type = (req.headers['content-type'] || 'audio/webm').split(';')[0];
    const form = new FormData();
    form.append('file', new Blob([audio], { type }), 'speech.' + (type.includes('mp4') ? 'mp4' : 'webm'));
    form.append('model', process.env.STT_MODEL || 'whisper-1');
    form.append('language', lang);
    form.append('prompt', 'Video editing commands: split, trim, crop, zoom in, zoom out, remove audio, add music, transition, caption, export. பிரி, நீக்கு, சேர், பெரிதாக்கு, சிறிதாக்கு.');
    const r = await fetch(`${BASE}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: form });
    if (!r.ok) throw new Error('Speech provider error ' + r.status);
    send(res, 200, { text: ((await r.json()).text || '').trim() });
  } catch (e) { send(res, e.code === 413 ? 413 : 502, { error: e.message }); }
}

// Timed subtitles for a clip's audio (WAV from the browser) via Whisper segments.
async function handleCaptions(req, res, url) {
  try {
    if (!KEY) return send(res, 503, { error: 'AI not configured (set OPENAI_API_KEY)' });
    const lang = url.searchParams.get('lang') === 'ta' ? 'ta' : 'en';
    const wav = await readBody(req, 24 * 1024 * 1024);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
    form.append('model', process.env.STT_MODEL || 'whisper-1');
    form.append('language', lang);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    const r = await fetch(`${BASE}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: form });
    if (!r.ok) throw new Error('Speech provider error ' + r.status);
    const data = await r.json();
    const cues = (data.segments || [])
      .map((s) => ({ s: +s.start, e: +s.end, text: String(s.text || '').trim().slice(0, 300) }))
      .filter((c) => c.text && c.e > c.s);
    send(res, 200, { cues });
  } catch (e) { send(res, e.code === 413 ? 413 : 502, { error: e.message }); }
}

// Extract a media file's audio as 48 kHz stereo WAV (browsers often can't decode audio inside video files).
async function handleExtractAudio(req, res) {
  const id = Date.now() + '-' + Math.random().toString(36).slice(2);
  const inp = path.join(os.tmpdir(), `vc-${id}.bin`), out = path.join(os.tmpdir(), `vc-${id}.wav`);
  const cleanup = () => { fs.rm(inp, { force: true }, () => {}); fs.rm(out, { force: true }, () => {}); };
  try {
    if (!HAS_FFMPEG) return send(res, 503, { error: 'ffmpeg not installed on server' });
    fs.writeFileSync(inp, await readBody(req, 500 * 1024 * 1024));
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', inp, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-f', 'wav', out]);
    let err = ''; ff.stderr.on('data', (d) => (err += d));
    ff.on('close', (code) => {
      if (code !== 0) {
        cleanup();
        // No audio stream at all is a normal case (silent video), not an error.
        if (/matches no streams|does not contain any stream/i.test(err)) return res.writeHead(204).end();
        return send(res, 500, { error: 'ffmpeg failed: ' + err.slice(-200) });
      }
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      fs.createReadStream(out).pipe(res).on('close', cleanup);
    });
  } catch (e) { cleanup(); send(res, e.code === 413 ? 413 : 500, { error: e.message }); }
}

// Convert the browser's WebM recording to a widely compatible H.264/AAC MP4.
async function handleConvert(req, res) {
  const id = Date.now() + '-' + Math.random().toString(36).slice(2);
  const inp = path.join(os.tmpdir(), `vc-${id}.webm`), out = path.join(os.tmpdir(), `vc-${id}.mp4`);
  const cleanup = () => { fs.rm(inp, { force: true }, () => {}); fs.rm(out, { force: true }, () => {}); };
  try {
    if (!HAS_FFMPEG) return send(res, 503, { error: 'ffmpeg not installed on server' });
    fs.writeFileSync(inp, await readBody(req, 500 * 1024 * 1024));
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', inp, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', out]);
    let err = ''; ff.stderr.on('data', (d) => (err += d));
    ff.on('close', (code) => {
      if (code !== 0) { cleanup(); return send(res, 500, { error: 'ffmpeg failed: ' + err.slice(-200) }); }
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      fs.createReadStream(out).pipe(res).on('close', cleanup);
    });
  } catch (e) { cleanup(); send(res, e.code === 413 ? 413 : 500, { error: e.message }); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/interpret') {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4096) return res.writeHead(413).end(); }
    const send = (code, o) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    try {
      const text = String(JSON.parse(body).text || '').slice(0, 500);
      if (!text) return send(400, { error: 'empty' });
      if (!KEY) return send(503, { error: 'AI not configured (set OPENAI_API_KEY)' });
      send(200, { command: await interpret(text) });
    } catch (e) { send(502, { error: e.message }); }
    return;
  }
  if (req.url === '/api/status') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ai: !!KEY, mp4: HAS_FFMPEG }));
  if (req.method === 'POST' && url.pathname === '/api/transcribe') return handleTranscribe(req, res, url);
  if (req.method === 'POST' && url.pathname === '/api/captions') return handleCaptions(req, res, url);
  if (req.method === 'POST' && url.pathname === '/api/extract-audio') return handleExtractAudio(req, res);
  if (req.method === 'POST' && url.pathname === '/api/convert') return handleConvert(req, res);
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!STATIC.includes(name)) return res.writeHead(404).end('Not found');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] });
  fs.createReadStream(path.join(__dirname, name)).pipe(res);
}).listen(PORT, () => console.log(`VoiceCut on http://localhost:${PORT}  (AI: ${KEY ? 'on' : 'off – set OPENAI_API_KEY'}, MP4 export: ${HAS_FFMPEG ? 'on' : 'off – install ffmpeg'})`));
