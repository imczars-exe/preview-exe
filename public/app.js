const urlInput = document.getElementById('urlInput');
const goBtn = document.getElementById('goBtn');
const modeGroup = document.getElementById('modeGroup');
const qualityGroup = document.getElementById('qualityGroup');
const previewCard = document.getElementById('previewCard');
const previewBody = document.getElementById('previewBody');
const previewActions = document.getElementById('previewActions');
const queueList = document.getElementById('queueList');
const queueCount = document.getElementById('queueCount');
const historyList = document.getElementById('historyList');
const historyCount = document.getElementById('historyCount');

const AUDIO_QUALITIES = [
  { v: '128', label: '128' },
  { v: '192', label: '192' },
  { v: '320', label: '320' },
];
const DEFAULT_VIDEO_HEIGHTS = [360, 480, 720, 1080];
const DEFAULT_AUDIO_QUALITY = '192';

function buildVideoQualities(heights) {
  const list = (heights && heights.length ? heights : DEFAULT_VIDEO_HEIGHTS);
  const opts = list.map((h) => ({ v: String(h), label: `${h}p` }));
  opts.push({ v: 'best', label: 'max' });
  return opts;
}

function pickDefaultVideoQuality(qualities) {
  if (qualities.some((o) => o.v === '720')) return '720';
  const heights = qualities.filter((o) => o.v !== 'best').map((o) => parseInt(o.v, 10));
  return heights.length ? String(Math.max(...heights)) : 'best';
}

let videoQualities = buildVideoQualities(null);

let mode = 'audio';
let quality = DEFAULT_AUDIO_QUALITY;
let currentUrl = '';
let lastPreviewData = null;
const activeJobs = new Map();

function renderQualityOptions() {
  const options = mode === 'video' ? videoQualities : AUDIO_QUALITIES;
  qualityGroup.innerHTML = options.map((o) =>
    `<button class="pill${o.v === quality ? ' active' : ''}" data-q="${o.v}">${o.label}</button>`
  ).join('');
}

modeGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.pill');
  if (!btn) return;
  mode = btn.dataset.m;
  quality = mode === 'video' ? pickDefaultVideoQuality(videoQualities) : DEFAULT_AUDIO_QUALITY;
  [...modeGroup.children].forEach((p) => p.classList.toggle('active', p === btn));
  renderQualityOptions();
  if (lastPreviewData) renderPreviewActions(lastPreviewData);
});

qualityGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.pill');
  if (!btn) return;
  quality = btn.dataset.q;
  [...qualityGroup.children].forEach((p) => p.classList.toggle('active', p === btn));
});

function fmtDuration(sec) {
  if (!sec && sec !== 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

async function preview() {
  const url = urlInput.value.trim();
  if (!url) return;
  currentUrl = url;
  goBtn.disabled = true;
  goBtn.textContent = '...';
  previewCard.classList.add('is-loading');
  previewCard.classList.remove('has-content');
  previewBody.innerHTML = `<span class="lcd-loading">&gt; leyendo enlace_</span>`;
  previewActions.innerHTML = '';

  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    if (!res.ok) {
      previewCard.classList.remove('is-loading');
      previewBody.innerHTML = `
        <span class="preview-error">&gt; ${data.error || 'no se pudo leer ese enlace'}</span>
        ${data.detail ? `<span class="preview-error" style="display:block;font-size:10px;opacity:.7;margin-top:6px;">${escapeHtml(data.detail.slice(0, 200))}</span>` : ''}`;
      return;
    }

    previewCard.classList.remove('is-loading');
    previewCard.classList.add('has-content');

    if (data.type === 'playlist') {
      previewBody.innerHTML = `
        <div class="meta-row">
          <div class="meta">
            <p class="meta-title">${escapeHtml(data.title)}</p>
            <p class="meta-sub">playlist · ${data.count} pistas</p>
          </div>
        </div>`;
      videoQualities = buildVideoQualities(null);
      if (mode === 'video') {
        quality = pickDefaultVideoQuality(videoQualities);
        renderQualityOptions();
      }
      lastPreviewData = data;
      renderPreviewActions(data);
      return;
    }

    // Single video, possibly also part of a playlist
    previewBody.innerHTML = `
      <div class="meta-row">
        ${data.thumbnail ? `<img class="art" src="${data.thumbnail}" alt="">` : ''}
        <div class="meta">
          <p class="meta-title">${escapeHtml(data.title)}</p>
          <p class="meta-sub">${escapeHtml([data.uploader, fmtDuration(data.duration)].filter(Boolean).join(' · '))}</p>
        </div>
      </div>`;

    lastPreviewData = data;
    videoQualities = buildVideoQualities(data.videoResolutions);
    if (mode === 'video') {
      quality = pickDefaultVideoQuality(videoQualities);
      renderQualityOptions();
    }
    renderPreviewActions(data);
  } catch (err) {
    previewCard.classList.remove('is-loading');
    previewBody.innerHTML = `<span class="preview-error">&gt; error de red</span>`;
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = 'buscar';
  }
}

function renderPreviewActions(data) {
  previewActions.innerHTML = '';
  if (data.type === 'playlist') {
    previewActions.className = 'preview-actions';
    addActionButton(`descargar playlist (${data.count})`, 'btn-block', () => {
      addToQueue(currentUrl, true);
      resetPreview();
    });
    return;
  }

  if (data.partOfPlaylist) {
    previewActions.className = 'preview-actions two-up';
    addActionButton('solo este', 'btn-quiet', () => {
      addToQueue(currentUrl, false);
      resetPreview();
    });
    addActionButton(`playlist (${data.playlistCount || '?'})`, 'btn-primary', () => {
      addToQueue(currentUrl, true);
      resetPreview();
    });
  } else {
    previewActions.className = 'preview-actions';
    addActionButton(mode === 'video' ? 'descargar video' : 'descargar audio', 'btn-block', () => {
      addToQueue(currentUrl, false);
      resetPreview();
    });
  }
}

function addActionButton(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.className = `btn ${cls}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  previewActions.appendChild(btn);
}

function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function resetPreview() {
  urlInput.value = '';
  urlInput.focus();
  lastPreviewData = null;
  previewCard.classList.remove('has-content', 'is-loading');
  previewBody.innerHTML = `<p class="idle-msg">&gt; esperando enlace_</p>`;
  previewActions.innerHTML = '';
}

goBtn.addEventListener('click', preview);
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') preview(); });

// --- Queue -------------------------------------------------------------
async function addToQueue(url, isPlaylist) {
  const jobMode = mode;       // capture at enqueue time, not completion time
  const jobQuality = quality; // (user might switch mode/quality while this runs)
  const emptyEl = queueList.querySelector('.queue-empty');
  if (emptyEl) emptyEl.remove();

  const li = document.createElement('li');
  li.className = 'queue-item';
  li.innerHTML = `
    <div class="qi-top">
      <span class="qi-title">conectando...</span>
      <span class="qi-status">en cola</span>
    </div>
    <div class="qi-bar"><div class="qi-bar-fill indeterminate"></div></div>
  `;
  queueList.prepend(li);
  queueCount.textContent = activeJobs.size + 1;

  const titleEl = li.querySelector('.qi-title');
  const statusEl = li.querySelector('.qi-status');
  const barFill = li.querySelector('.qi-bar-fill');

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, quality: jobQuality, mode: jobMode, isPlaylist }),
    });
    const data = await res.json();
    if (!res.ok) {
      titleEl.textContent = url;
      statusEl.textContent = data.error || 'error';
      statusEl.classList.add('is-error');
      barFill.classList.remove('indeterminate');
      return;
    }

    activeJobs.set(data.jobId, { el: li });
    const es = new EventSource(`/api/progress/${data.jobId}`);

    es.onmessage = (ev) => {
      const ev_data = JSON.parse(ev.data);

      if (ev_data.type === 'status' && ev_data.status === 'queued') {
        statusEl.textContent = `en cola (#${ev_data.position})`;
      }
      if (ev_data.type === 'status' && ev_data.status === 'downloading') {
        statusEl.textContent = ev_data.note === 'reintentando' ? 'reintentando...' : 'descargando';
        if (ev_data.note === 'reintentando') barFill.classList.add('indeterminate');
      }
      if (ev_data.type === 'item') {
        titleEl.textContent = ev_data.name.replace(/\.(mp3|mp4)$/i, '');
      }
      if (ev_data.type === 'progress') {
        barFill.classList.remove('indeterminate');
        barFill.style.width = `${ev_data.percent}%`;
        statusEl.textContent = `${ev_data.percent.toFixed(0)}%  ·  ${ev_data.speed || ''}`;
      }
      if (ev_data.type === 'done') {
        es.close();
        barFill.classList.remove('indeterminate');
        barFill.style.width = '100%';
        statusEl.textContent = 'listo';
        statusEl.classList.add('is-done');
        activeJobs.delete(data.jobId);
        queueCount.textContent = activeJobs.size;
        saveHistoryEntry({
          id: data.jobId,
          title: ev_data.isPlaylist
            ? `Playlist (${ev_data.files.length} ${jobMode === 'video' ? 'videos' : 'pistas'})`
            : titleEl.textContent,
          kind: jobMode,
          quality: jobQuality,
          date: Date.now(),
        });
        triggerDownload(`/api/file/${data.jobId}`);
        li.classList.add('is-leaving');
        setTimeout(() => {
          li.remove();
          if (!queueList.children.length) {
            queueList.innerHTML = '<li class="queue-empty">nada descargando ahorita</li>';
          }
        }, 250);
      }
      if (ev_data.type === 'error') {
        es.close();
        barFill.classList.remove('indeterminate');
        statusEl.textContent = ev_data.message;
        statusEl.classList.add('is-error');
        if (ev_data.detail) {
          const small = document.createElement('div');
          small.style.cssText = 'font-family:var(--mono);font-size:10px;color:#55565c;margin-top:6px;';
          small.textContent = ev_data.detail.slice(0, 140);
          li.appendChild(small);
        }
        activeJobs.delete(data.jobId);
        queueCount.textContent = activeJobs.size;
      }
    };
  } catch (err) {
    titleEl.textContent = url;
    statusEl.textContent = 'error de red';
    statusEl.classList.add('is-error');
    barFill.classList.remove('indeterminate');
  }
}

// --- History (per-browser, stored locally — never sent to the server) --
const HISTORY_KEY = 'preview-exe_history';
const HISTORY_TTL_HOURS = 6; // matches the server's file cleanup window

function getLocalHistory() {
  let items = [];
  try { items = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { items = []; }
  const cutoff = Date.now() - HISTORY_TTL_HOURS * 60 * 60 * 1000;
  const fresh = items.filter((it) => it.date > cutoff);
  if (fresh.length !== items.length) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(fresh));
  }
  return fresh;
}

function saveHistoryEntry(entry) {
  const items = getLocalHistory();
  items.unshift(entry);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 30)));
  renderHistory();
}

function renderHistory() {
  const items = getLocalHistory();
  historyCount.textContent = items.length;
  if (!items.length) {
    historyList.innerHTML = '<li class="history-empty">nada por aquí todavía</li>';
    return;
  }
  historyList.innerHTML = items.map((it) => `
    <li class="history-item">
      <span class="h-title">${escapeHtml(it.title)}</span>
      <span style="display:flex;align-items:center;">
        <span class="h-meta">${formatQualityLabel(it)}</span>
        <a href="/api/history/${it.id}/file">bajar</a>
      </span>
    </li>
  `).join('');
}

function formatQualityLabel(it) {
  if (it.kind === 'video') return it.quality === 'best' ? 'max' : `${it.quality}p`;
  return `${it.quality}k`;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

renderHistory();
