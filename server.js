const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

const DOWNLOADS_DIR = path.join(os.tmpdir(), 'preview-exe');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// yt-dlp binary: prefer one on PATH, fall back to a local copy dropped next to server.js
const YTDLP_BIN = fs.existsSync(path.join(__dirname, 'yt-dlp.exe'))
  ? path.join(__dirname, 'yt-dlp.exe')
  : 'yt-dlp';

// Cookies file for authenticating yt-dlp as a real YouTube session — needed
// because YouTube blocks datacenter IPs (Render/Railway/AWS/etc) with a
// "Sign in to confirm you're not a bot" error otherwise. Point this at a
// Render "Secret File" (or set YTDLP_COOKIES_FILE) — if it's not there,
// we just skip cookies (fine for local dev on a home IP).
//
// yt-dlp tries to WRITE BACK updated cookies after each run (YouTube
// rotates session cookies), so we can't point it directly at Render's
// Secret File — those are mounted read-only and yt-dlp exits with code 1
// ("OSError: Read-only file system") even when the actual download worked
// fine. So: copy the secret into a writable temp file once at startup, and
// point yt-dlp at that copy instead.
const COOKIES_SECRET_FILE = process.env.YTDLP_COOKIES_FILE || '/etc/secrets/cookies.txt';
const COOKIES_FILE = path.join(os.tmpdir(), 'preview-exe-cookies.txt');
if (fs.existsSync(COOKIES_SECRET_FILE)) {
  fs.copyFileSync(COOKIES_SECRET_FILE, COOKIES_FILE);
}
const COOKIES_ARGS = fs.existsSync(COOKIES_FILE) ? ['--cookies', COOKIES_FILE] : [];
if (COOKIES_ARGS.length) {
  // Sanity-check the file itself: Netscape cookie format is tab-separated.
  // Pasting into a web textarea (e.g. Render's Secret Files editor) can
  // silently collapse tabs into spaces, which leaves the file "present" but
  // with zero parseable cookies — same symptom as having no cookies at all.
  const raw = fs.readFileSync(COOKIES_FILE, 'utf8');
  const validLines = raw.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('\t'));
  const brokenLines = raw.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#') && !l.includes('\t'));
  console.log(`yt-dlp: usando cookies de ${COOKIES_FILE} (${validLines.length} cookies con formato valido, ${brokenLines.length} lineas con formato roto)`);
  if (validLines.length === 0) {
    console.log('yt-dlp: ADVERTENCIA — el archivo de cookies no tiene ninguna linea con tabs. Probablemente se corrompio al pegarlo (los tabs se volvieron espacios). Sube el archivo de nuevo.');
  }
} else {
  console.log('yt-dlp: sin archivo de cookies (', COOKIES_FILE, 'no encontrado) — puede fallar en hosting cloud por bloqueo de bot.');
}

// PO Token: YouTube lo exige ahora ademas de la cookie para trafico de
// datacenter. bgutil-pot corre como servidor local (ver start.sh) y este
// plugin de yt-dlp lo consulta automaticamente para conseguir el token.
//
// player_client=web: por defecto yt-dlp prueba primero web_embedded y
// tv_downgraded, que en este servidor siempre devuelven LOGIN_REQUIRED (2
// round-trips desperdiciados por request) antes de caer en "web", que es
// el que si funciona con nuestras cookies+Deno+PO token. Forzarlo ahorra
// ese tiempo en cada busqueda y descarga.
const EXTRACTOR_ARGS = [
  '--plugin-dirs', '/app/yt-dlp-plugins',
  '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416',
  '--extractor-args', 'youtube:player_client=web',
];

// In-memory job registry: jobId -> { clients: [res], status, ... }
const jobs = new Map();

// Server-side files are cleaned up a few hours after finishing — this is a
// public, no-login tool, so we don't keep strangers' files around forever.
// (History itself lives in each visitor's own browser, not here — see app.js.)
const CLEANUP_HOURS = 6;

function scheduleCleanup(jobId) {
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (job) fs.rmSync(job.jobDir, { recursive: true, force: true });
    jobs.delete(jobId);
  }, CLEANUP_HOURS * 60 * 60 * 1000);
}

function sendEvent(job, data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  job.clients.forEach((res) => res.write(payload));
  job.lastEvent = data;
}

// --- Metadata preview -------------------------------------------------
app.post('/api/preview', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Falta la URL.' });

  const t0 = Date.now();
  console.log(`[preview] pedido recibido para ${url}`);

  const args = ['-j', '--no-warnings', '--flat-playlist', '--ignore-config', ...COOKIES_ARGS, ...EXTRACTOR_ARGS, url];
  const proc = spawn(YTDLP_BIN, args);
  let out = '';
  let err = '';
  proc.on('error', (e) => {
    res.status(500).json({ error: 'yt-dlp no esta disponible en el servidor.', detail: e.message });
  });
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  proc.on('close', (code) => {
    console.log(`[preview] yt-dlp termino en ${Date.now() - t0}ms (code ${code}) para ${url}`);
    if (res.headersSent) return;
    if (code !== 0 || !out.trim()) {
      console.error(`yt-dlp preview fallo (code ${code}) para ${url}:\n${err.slice(0, 4000)}`);
      return res.status(422).json({ error: 'No se pudo leer ese enlace. Revisa que sea correcto.' , detail: err.slice(0, 300)});
    }
    const lines = out.trim().split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    if (lines.length > 1) {
      // Playlist
      return res.json({
        type: 'playlist',
        title: lines[0].playlist_title || 'Playlist',
        count: lines.length,
        entries: lines.slice(0, 8).map((e) => ({ title: e.title, duration: e.duration })),
      });
    }
    const v = lines[0];
    const heights = Array.isArray(v.formats)
      ? [...new Set(
          v.formats
            .filter((f) => f.vcodec && f.vcodec !== 'none' && Number.isFinite(f.height))
            .map((f) => f.height)
        )].sort((a, b) => a - b)
      : [];

    res.json({
      type: 'video',
      title: v.title,
      uploader: v.uploader || v.channel || '',
      duration: v.duration || null,
      thumbnail: v.thumbnail || (Array.isArray(v.thumbnails) && v.thumbnails.length ? v.thumbnails[v.thumbnails.length - 1].url : null),
      // Real resolutions this video actually has available, for the video-quality picker
      videoResolutions: heights,
      // Present when the URL points at a video that also belongs to a playlist
      // (e.g. watch?v=X&list=Y) — lets the UI offer "just this" vs "whole playlist".
      partOfPlaylist: Boolean(v.playlist_count || v.playlist),
      playlistTitle: v.playlist_title || v.playlist || null,
      playlistCount: v.playlist_count || null,
    });
  });
});

// --- Download queue ----------------------------------------------------
const MAX_CONCURRENT = 2;
const pendingQueue = [];
let activeCount = 0;

function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'downloading';
  job._t0 = job._t0 || Date.now();
  console.log(`[download ${jobId}] arrancando (modo ${job.mode}) para ${job.url}`);
  sendEvent(job, { type: 'status', status: 'downloading' });

  const outTemplate = path.join(
    job.jobDir,
    job.isPlaylist ? '%(playlist_autonumber)s - %(title)s.%(ext)s' : '%(title)s.%(ext)s'
  );

  const args = job.mode === 'video'
    ? [
        '-f', job.quality === 'best'
          ? 'bestvideo+bestaudio/best'
          : `bestvideo[height<=${job.quality}]+bestaudio/best[height<=${job.quality}]`,
        '--merge-output-format', 'mp4',
        '--ignore-config',
        '--extractor-retries', '3',
        ...COOKIES_ARGS,
        ...EXTRACTOR_ARGS,
        '--add-metadata',
        '--newline',
        job.isPlaylist ? '--yes-playlist' : '--no-playlist',
        '-o', outTemplate,
        job.url,
      ]
    : [
        '-x', '--audio-format', 'mp3',
        '--audio-quality', job.quality + 'K',
        '--ignore-config',
        '--extractor-retries', '3',
        ...COOKIES_ARGS,
        ...EXTRACTOR_ARGS,
        '--embed-thumbnail', '--add-metadata',
        '--newline',
        job.isPlaylist ? '--yes-playlist' : '--no-playlist',
        '-o', outTemplate,
        job.url,
      ];

  const proc = spawn(YTDLP_BIN, args);

  proc.on('error', (e) => {
    job.status = 'error';
    sendEvent(job, { type: 'error', message: 'yt-dlp no esta disponible en el servidor.', detail: e.message });
    finishJob();
  });

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    const match = text.match(/\[download\]\s+([\d.]+)% of.*?at\s+([\d.]+\w+\/s)?.*?ETA\s+([\d:]+)/);
    const titleMatch = text.match(/\[download\] Destination:\s+(.+)/);
    if (titleMatch) {
      sendEvent(job, { type: 'item', name: path.basename(titleMatch[1]) });
    }
    if (match) {
      sendEvent(job, { type: 'progress', percent: parseFloat(match[1]), speed: match[2] || '', eta: match[3] });
    }
  });

  let errBuf = '';
  proc.stderr.on('data', (d) => (errBuf += d));

  proc.on('close', (code) => {
    const elapsed = Date.now() - job._t0;
    if (code !== 0) {
      const isTransient = /page needs to be reloaded/i.test(errBuf);
      if (isTransient && job.attemptsLeft > 0) {
        job.attemptsLeft--;
        console.log(`[download ${jobId}] reintentando tras ${elapsed}ms (page needs to be reloaded)`);
        sendEvent(job, { type: 'status', status: 'downloading', note: 'reintentando' });
        runJob(jobId); // same slot, don't touch activeCount/finishJob
        return;
      }
      job.status = 'error';
      console.error(`[download ${jobId}] fallo tras ${elapsed}ms (code ${code}) para ${job.url}:\n${errBuf.slice(0, 1000)}`);
      sendEvent(job, { type: 'error', message: 'La descarga fallo. Revisa el enlace.', detail: errBuf.slice(0, 400) });
      finishJob();
      return;
    }
    console.log(`[download ${jobId}] listo en ${elapsed}ms`);
    const ext = job.mode === 'video' ? 'mp4' : 'mp3';
    const files = fs.readdirSync(job.jobDir).filter((f) => f.toLowerCase().endsWith('.' + ext));
    job.files = files;
    job.status = 'done';

    sendEvent(job, { type: 'done', files, isPlaylist: files.length > 1 });
    scheduleCleanup(jobId);
    finishJob();
  });

  function finishJob() {
    activeCount--;
    if (activeCount < MAX_CONCURRENT && pendingQueue.length) {
      const nextId = pendingQueue.shift();
      activeCount++;
      runJob(nextId);
    }
  }
}

// --- Start a download job ---------------------------------------------
app.post('/api/download', (req, res) => {
  const { url, quality, mode, isPlaylist } = req.body;
  if (!url) return res.status(400).json({ error: 'Falta la URL.' });

  const jobId = uuidv4();
  const jobDir = path.join(DOWNLOADS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const jobMode = mode === 'video' ? 'video' : 'audio';
  const jobQuality = jobMode === 'video'
    ? (String(quality) === 'best' || /^\d{2,4}$/.test(String(quality)) ? String(quality) : '720')
    : (['128', '192', '320'].includes(String(quality)) ? String(quality) : '192');

  const job = { clients: [], status: 'queued', jobDir, files: [], url, mode: jobMode, quality: jobQuality, isPlaylist: Boolean(isPlaylist), attemptsLeft: 2 };
  jobs.set(jobId, job);
  res.json({ jobId });

  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    runJob(jobId);
  } else {
    pendingQueue.push(jobId);
    job.lastEvent = { type: 'status', status: 'queued', position: pendingQueue.length };
  }
});

// --- Progress stream (SSE) --------------------------------------------
app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  job.clients.push(res);
  if (job.lastEvent) res.write(`data: ${JSON.stringify(job.lastEvent)}\n\n`);

  req.on('close', () => {
    job.clients = job.clients.filter((c) => c !== res);
  });
});

// --- Fetch finished file(s) --------------------------------------------
app.get('/api/file/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'done') return res.status(404).end();

  if (job.files.length === 1) {
    return res.download(path.join(job.jobDir, job.files[0]));
  }
  // Multiple files: zip on the fly
  res.attachment('playlist.zip');
  const archive = archiver('zip');
  archive.pipe(res);
  job.files.forEach((f) => archive.file(path.join(job.jobDir, f), { name: f }));
  archive.finalize();
});

// --- Direct re-download by job id (used by each browser's own local history) --
app.get('/api/history/:jobId/file', (req, res) => {
  const jobDir = path.join(DOWNLOADS_DIR, req.params.jobId);
  if (!fs.existsSync(jobDir)) return res.status(404).end();
  const files = fs.readdirSync(jobDir).filter((f) => /\.(mp3|mp4)$/i.test(f));
  if (!files.length) return res.status(404).end();
  if (files.length === 1) return res.download(path.join(jobDir, files[0]));
  res.attachment('playlist.zip');
  const archive = archiver('zip');
  archive.pipe(res);
  files.forEach((f) => archive.file(path.join(jobDir, f), { name: f }));
  archive.finalize();
});

const PORT = process.env.PORT || 3939;
app.listen(PORT, () => {
  console.log(`preview-exe corriendo en http://localhost:${PORT}`);
});