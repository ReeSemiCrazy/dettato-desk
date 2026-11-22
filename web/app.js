const $ = (id) => document.getElementById(id);
const COLORS = ['#63e0cd', '#83b8ff', '#f0b765', '#c79bff', '#ff8fa3', '#8fe388', '#ffd166', '#66d3e8', '#b9a7ff', '#f28fb0'];
let jobs = [];
let activeId = null;
let renderedKey = '';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTime = (s) => {
  s = Number(s) || 0;
  return s < 60 ? `${Math.round(s)}s` : `${Math.floor(s/60)}m ${Math.round(s%60)}s`;
};

function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function refreshHealth() {
  try {
    const h = await api('/api/health');
    const dot = $('envDot');
    dot.className = 'pulse' + (h.model_loaded ? ' on' : (h.gpu ? ' warn' : ''));
    $('envText').textContent = h.model_loaded
      ? `模型就绪 · ${h.device.toUpperCase()}`
      : (h.gpu ? 'GPU 可用 · 权重待下载' : 'CPU 模式 · 权重待下载');
    $('envPill').title = h.gpu_name ? `${h.gpu_name} · dettato ${h.version}` : `dettato ${h.version}`;
    $('footerInfo').textContent = `设备 ${h.device.toUpperCase()} · 服务已运行 ${fmtTime(h.uptime)}`;
    if (h.model_error && !h.model_loaded) $('hintText').textContent = `模型加载失败：${h.model_error}`;
  } catch (e) {
    $('envText').textContent = '服务不可用';
    $('envDot').className = 'pulse warn';
  }
}

async function uploadFiles(files) {
  for (const file of files) {
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name)},
        body: file
      });
      let data;
      try { data = await res.json(); } catch { data = {}; }
      if (!res.ok) throw new Error(data.error || '上传失败');
      jobs.unshift(data);
      activeId = data.id;
      renderedKey = '';
      renderJobs();
      await startJob(data.id);
    } catch (e) {
      toast(`${file.name}: ${e.message}`, true);
    }
  }
}

async function startJob(id) {
  try {
    await api('/api/transcribe', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id, device: $('deviceSelect').value})
    });
    pollNow();
  } catch (e) { toast(e.message, true); }
}

function renderJobs() {
  const list = $('jobList');
  $('jobCount').textContent = jobs.length;
  if (!jobs.length) {
    list.innerHTML = '<div class="empty-queue">还没有任务。上传一段音频开始吧。</div>';
    return;
  }
  const labels = {
    uploaded: '待开始', queued: '排队中', loading: '加载模型', running: '转录中', done: '完成', error: '失败'
  };
  list.innerHTML = jobs.map((j) => `
    <div class="job ${j.id === activeId ? 'active' : ''}" data-id="${esc(j.id)}">
      <div class="job-top">
        <span class="job-name" title="${esc(j.filename)}">${esc(j.filename)}</span>
        <span class="job-status ${esc(j.status)}">${labels[j.status] || esc(j.status)}</span>
        <button class="job-remove" data-remove="${esc(j.id)}" title="移除任务">×</button>
      </div>
      <div class="job-meta">
        <span>${fmtTime(j.seconds)} 音频</span>
        <span>${j.elapsed ? `耗时 ${fmtTime(j.elapsed)}` : '—'}</span>
        ${j.summary ? `<span>${j.summary.tracks.length} 轨</span>` : ''}
      </div>
      ${j.status === 'running' || j.status === 'loading' || j.status === 'queued'
        ? `<div class="bar"><i style="width:${j.progress || 0}%"></i></div>` : ''}
      ${j.error ? `<div class="job-error">${esc(j.error)}</div>` : ''}
    </div>`).join('');
}

listClickHandler();
function listClickHandler() {
  $('jobList').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      e.stopPropagation();
      const id = remove.dataset.remove;
      api('/api/delete', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id})
      }).then(() => {
        jobs = jobs.filter((j) => j.id !== id);
        if (activeId === id) { activeId = jobs[0]?.id || null; renderedKey = ''; }
        renderJobs(); renderResult();
      }).catch((err) => toast(err.message, true));
      return;
    }
    const card = e.target.closest('.job');
    if (card) { activeId = card.dataset.id; renderedKey = ''; renderJobs(); renderResult(); }
  });
}

async function renderResult() {
  const empty = $('emptyResult');
  const body = $('resultBody');
  const job = jobs.find((j) => j.id === activeId);
  if (!job) { empty.hidden = false; body.hidden = true; return; }
  empty.hidden = true; body.hidden = false;

  const key = `${job.id}|${job.status}`;
  if (key !== renderedKey) {
    renderedKey = key;
    if (job.status !== 'done') {
      $('resultName').textContent = job.filename;
      $('resultMeta').textContent = job.stage || '处理中…';
      $('stats').innerHTML = `<div class="stat"><div class="stat-label">状态</div><div class="stat-value">${job.progress || 0}<small>%</small></div></div>`;
      $('trackList').innerHTML = `<div class="empty-queue">${esc(job.error || '转录进行中，完成后这里会显示音轨。')}</div>`;
      $('trackCount').textContent = '—';
      $('rawJson').textContent = '';
      $('midiLink').removeAttribute('href'); $('jsonLink').removeAttribute('href');
      $('audioPlayer').removeAttribute('src');
      return;
    }
    let detail = job.detail;
    if (!detail) {
      try { detail = (await api(`/api/job?id=${encodeURIComponent(job.id)}`)).detail; }
      catch (e) { toast(e.message, true); return; }
    }
    const s = job.summary || {};
    $('resultName').textContent = job.filename;
    $('resultMeta').textContent = `${fmtTime(job.seconds)} 音频 · 耗时 ${fmtTime(job.elapsed)} · ${job.device || 'auto'} · 20 ms 精度`;
    $('stats').innerHTML = `
      <div class="stat"><div class="stat-label">音轨</div><div class="stat-value">${s.tracks?.length ?? 0}<small>tracks</small></div></div>
      <div class="stat"><div class="stat-label">音符</div><div class="stat-value">${s.notes?.grouped ?? 0}<small>notes</small></div></div>
      <div class="stat"><div class="stat-label">时长</div><div class="stat-value">${fmtTime(s.seconds)}</div></div>
      <div class="stat"><div class="stat-label">调音偏差</div><div class="stat-value">${s.tuning_cents == null ? '—' : (s.tuning_cents > 0 ? '+' : '') + Number(s.tuning_cents).toFixed(1) + '<small>cents</small>'}</div></div>`;
    $('trackCount').textContent = `${s.notes?.transcribed ?? 0} 个原始音符 → ${s.notes?.grouped ?? 0} 个分轨音符`;
    $('trackList').innerHTML = (detail?.tracks || []).map((t, i) => `
      <div class="track">
        <div class="track-top">
          <span class="track-dot" style="background:${COLORS[i % COLORS.length]}"></span>
          <span class="track-name">${esc(t.name)}</span>
          <span class="track-program">${t.is_drum ? 'GM DRUM' : `GM ${t.program}`}</span>
          <span class="track-notes">${t.notes.length} notes</span>
        </div>
        <canvas data-track="${i}"></canvas>
        <div class="track-axis"><span>0:00</span><span>piano roll · 音高 21–108</span><span>${fmtTime(s.seconds)}</span></div>
      </div>`).join('') || '<div class="empty-queue">未检测到音轨。</div>';
    (detail?.tracks || []).forEach((t, i) => drawRoll(document.querySelector(`canvas[data-track="${i}"]`), t.notes, COLORS[i % COLORS.length], s.seconds));
    $('rawJson').textContent = JSON.stringify(s, null, 2);
    $('midiLink').href = `/api/download?id=${encodeURIComponent(job.id)}&kind=midi`;
    $('midiLink').download = `${job.filename.replace(/\.[^.]+$/, '')}.mid`;
    $('jsonLink').href = `/api/download?id=${encodeURIComponent(job.id)}&kind=json`;
    $('jsonLink').download = `${job.filename.replace(/\.[^.]+$/, '')}.json`;
    $('audioPlayer').src = `/api/audio?id=${encodeURIComponent(job.id)}`;
  }
}

function drawRoll(canvas, notes, color, seconds) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(200, canvas.clientWidth);
  const h = 86;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#101923';
  ctx.fillRect(0, 0, w, h);

  const lo = 21, hi = 108, span = hi - lo + 1;
  const T = Math.max(1, seconds || 1);
  ctx.strokeStyle = 'rgba(139,156,175,.09)';
  ctx.lineWidth = 1;
  for (let p = 24; p <= hi; p += 12) {
    const y = (hi - p + 1) / span * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  for (let t = 0; t < T; t += 10) {
    const x = t / T * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  ctx.fillStyle = color;
  for (const n of notes || []) {
    const [on, off, pitch] = n;
    if (pitch < lo || pitch > hi) continue;
    const x = Math.max(0, on / T * w);
    const nw = Math.max(1.2, (Math.max(off, on + 0.03) - on) / T * w);
    const y = (hi - pitch + 1) / span * h;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x, y, nw, Math.max(1.4, h / span - 0.3));
  }
  ctx.globalAlpha = 1;
}

async function pollNow() {
  try {
    const data = await api('/api/jobs');
    jobs = data.jobs;
    if (!jobs.some((j) => j.id === activeId)) {
      activeId = jobs[0]?.id || null;
      renderedKey = '';
    }
    renderJobs();
    await renderResult();
    if (jobs.some((j) => ['queued', 'loading', 'running'].includes(j.status))) {
      refreshHealth();
    }
  } catch (e) { /* server temporarily unavailable */ }
}

/* ---------- events ---------- */
$('dropzone').addEventListener('dragover', (e) => { e.preventDefault(); $('dropzone').classList.add('dragover'); });
$('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('dragover'));
$('dropzone').addEventListener('drop', (e) => {
  e.preventDefault(); $('dropzone').classList.remove('dragover');
  uploadFiles(Array.from(e.dataTransfer.files || []));
});
$('fileInput').addEventListener('change', (e) => {
  uploadFiles(Array.from(e.target.files || []));
  e.target.value = '';
});
$('demoBtn').addEventListener('click', async () => {
  const btn = $('demoBtn');
  btn.disabled = true; btn.textContent = '正在生成示例…';
  try {
    const res = await fetch('/api/demo.wav');
    const blob = await res.blob();
    await uploadFiles([new File([blob], 'dettato-demo.wav', {type: 'audio/wav'})]);
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>生成示例音频并转录'; }
});
$('refreshBtn').addEventListener('click', refreshHealth);
window.addEventListener('resize', () => {
  const job = jobs.find((j) => j.id === activeId);
  if (job?.status === 'done') { renderedKey = ''; renderResult(); }
});

refreshHealth();
pollNow();
setInterval(pollNow, 1000);
setInterval(refreshHealth, 8000);
