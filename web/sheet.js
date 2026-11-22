/* Dettato Sheet — 播放 MIDI 音符 + 导出五线谱，独立页面逻辑 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const COLORS = ['#63e0cd', '#83b8ff', '#f0b765', '#c79bff', '#ff8fa3', '#8fe388', '#ffd166', '#66d3e8', '#b9a7ff', '#f28fb0'];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (s) => { s = Math.max(0, Number(s) || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

  let jobs = [];
  let activeId = null;
  let detail = null;
  let seconds = 0;
  let filename = '';
  let model = null;
  let enabled = new Set();
  let piece = [];          // {t0, t1, pitch, vel, track, color}
  let duration = 0;

  /* ---------- audio ---------- */
  let ctx = null, master = null;
  let playing = false, startedAt = 0, offset = 0, rafId = 0;
  let timerId = 0, nextIdx = 0, live = [], speed = 1;
  const LOOKAHEAD = 0.6;

  function ensureAudio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('此浏览器不支持 Web Audio');
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = Number($('volRange').value) / 100 * 0.55;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  }
  function tone(freq, when, dur, vel, wave, drum) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, when);
    const peak = Math.max(0.02, Math.min(0.5, (vel || 100) / 127 * (drum ? 0.32 : 0.42)));
    const attack = drum ? 0.004 : 0.012;
    const release = drum ? Math.min(0.18, dur) : Math.min(0.35, dur * 0.5 + 0.04);
    if (drum) osc.frequency.exponentialRampToValueAtTime(Math.max(35, freq * 0.5), when + Math.min(dur, 0.12));
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + attack);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.28), when + Math.max(attack + 0.01, dur - release));
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.03);
    osc.connect(gain); gain.connect(master);
    osc.start(when); osc.stop(when + dur + 0.06);
    live.push(osc);
    osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch (e) {} live = live.filter((o) => o !== osc); };
  }
  function silence() {
    live.forEach((o) => { try { o.stop(); } catch (e) {} });
    live = [];
    clearInterval(timerId);
  }
  // 所有时间统一用“曲目秒”；speed 只影响转换成 AudioContext 时间
  function songTime() {
    return playing && ctx ? offset + (ctx.currentTime - startedAt) * speed : offset;
  }
  function resetCursor(t) {
    offset = Math.max(0, Math.min(duration || 0, t == null ? offset : t));
    nextIdx = 0;
    while (nextIdx < piece.length && piece[nextIdx].t1 <= offset) nextIdx++;
  }
  function schedule() {
    if (!playing || !ctx) return;
    const wave = $('waveSel').value;
    const horizon = ctx.currentTime + LOOKAHEAD;
    while (nextIdx < piece.length) {
      const n = piece[nextIdx];
      const when = startedAt + (n.t0 - offset) / speed;
      if (when > horizon) break;             // 未来的音符留到下一轮
      nextIdx++;
      if (!enabled.has(n.track)) continue;   // 静音音轨不发声
      if (when < ctx.currentTime - 0.02) continue;
      const dur = Math.max(0.04, (n.t1 - n.t0) / speed);
      tone(440 * Math.pow(2, (n.pitch - 69) / 12), Math.max(ctx.currentTime, when), dur, n.vel, wave, n.drum);
    }
  }
  function stopAt(end) {
    stopPlayback();
    if (end != null) seek(end);
  }
  function play() {
    if (!detail || !piece.length) return;
    try { ensureAudio(); } catch (e) { toast(e.message, true); return; }
    if (playing) { pause(); return; }
    speed = Number($('speedSel').value) || 1;
    if (offset >= duration - 0.02 || !piece.some((n) => n.t0 >= offset && enabled.has(n.track))) {
      offset = 0;
    }
    playing = true;
    startedAt = ctx.currentTime - offset / speed;   // 曲目 0 秒对应的音频时间
    resetCursor(offset);
    schedule();
    timerId = setInterval(schedule, 80);
    $('playBtn').innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
    $('playState').textContent = '播放中';
    tick();
  }
  function pause() {
    if (!playing) return;
    offset = songTime();
    stopPlayback();
    $('playState').textContent = '已暂停';
  }
  function stopPlayback() {
    playing = false;
    silence();
    cancelAnimationFrame(rafId);
    $('playBtn').innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  }
  function seek(t) {
    offset = Math.max(0, Math.min(duration || 0, t));
    if (playing) {
      silence();
      startedAt = ctx.currentTime - offset / speed;
      resetCursor(offset);
      schedule(); timerId = setInterval(schedule, 80);
    }
    updatePosition();
  }
  function restart() {
    // 速度/波形/音轨变化：停掉已排程音符，从当前曲目时间继续
    const wasPlaying = playing;
    const t = songTime();
    silence();
    if (wasPlaying) {
      speed = Number($('speedSel').value) || 1;
      startedAt = ctx.currentTime - t / speed;
      offset = t;
      resetCursor(t);
      schedule(); timerId = setInterval(schedule, 80);
    }
    updatePosition();
  }
  function tick() {
    if (!playing) return;
    const t = songTime();
    if (t >= duration) { stopAt(0); $('nowPlaying').textContent = '播放结束'; return; }
    updatePosition();
    const now = piece.filter((n) => enabled.has(n.track) && n.t0 <= t && n.t1 > t);
    $('nowPlaying').textContent = now.length
      ? '正在发声：' + now.slice(0, 4).map((n) => midiName(n.pitch)).join(' · ') + (now.length > 4 ? ` 等 ${now.length} 音` : '')
      : '—';
    rafId = requestAnimationFrame(tick);
  }
  function updatePosition() {
    const t = playing ? songTime() : offset;
    const pct = duration ? Math.min(100, t / duration * 100) : 0;
    $('progressFill').style.width = pct + '%';
    $('progressHead').style.left = pct + '%';
    $('overviewHead').style.left = pct + '%';
    $('timeNow').textContent = fmt(t);
  }
  function midiName(p) {
    const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return N[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
  }

  /* ---------- overview ---------- */
  function drawOverview() {
    const c = $('overviewCanvas');
    const w = Math.max(200, c.clientWidth), h = 48;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#0e1720'; g.fillRect(0, 0, w, h);
    const T = duration || 1;
    let lo = 108, hi = 21;
    piece.forEach((n) => { if (n.pitch < lo) lo = n.pitch; if (n.pitch > hi) hi = n.pitch; });
    const span = Math.max(12, hi - lo + 1);
    for (const n of piece) {
      if (!enabled.has(n.track)) continue;
      g.globalAlpha = 0.75;
      g.fillStyle = n.color;
      const x = n.t0 / T * w;
      const bw = Math.max(1.2, (n.t1 - n.t0) / T * w);
      const y = (hi - n.pitch + 1) / span * (h - 6) + 3;
      g.fillRect(x, y, bw, Math.max(1.4, (h - 6) / span - 0.4));
    }
    g.globalAlpha = 1;
  }

  /* ---------- data ---------- */
  async function api(path, opts) {
    const r = await fetch(path, opts);
    let d; try { d = await r.json(); } catch (e) { d = {}; }
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  }
  function toast(msg, bad) {
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = msg; document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }
  async function refreshJobs(keep) {
    try {
      const d = await api('/api/jobs');
      jobs = (d.jobs || []).filter((j) => j.status === 'done');
      $('jobCount').textContent = jobs.length;
      $('jobList').innerHTML = jobs.length
        ? jobs.map((j) => `<div class="job ${j.id === activeId ? 'active' : ''}" data-id="${esc(j.id)}">
            <div class="job-top"><span class="job-name" title="${esc(j.filename)}">${esc(j.filename)}</span><span class="job-status">完成</span></div>
            <div class="job-meta"><span>${fmt(j.seconds)} 音频</span><span>${j.summary?.tracks?.length || 0} 轨</span><span>${j.summary?.notes?.grouped || 0} 音符</span></div>
          </div>`).join('')
        : '<div class="empty-queue">还没有完成的转录，请到首页上传音频。</div>';
      if (!jobs.length) { selectJob(null); return; }
      const id = keep && jobs.some((j) => j.id === keep) ? keep : jobs[0].id;
      if (id !== activeId) await selectJob(id);
    } catch (e) { toast('无法连接服务：' + e.message, true); }
  }
  async function selectJob(id) {
    stopPlayback(); offset = 0; activeId = id;
    if (!id) {
      detail = null; piece = []; model = null;
      $('emptyMain').hidden = false; $('mainBody').hidden = true;
      $('jobList').querySelectorAll('.job').forEach((el) => el.classList.remove('active'));
      renderMix(); updatePosition(); return;
    }
    $('emptyMain').hidden = true; $('mainBody').hidden = false;
    $('jobList').querySelectorAll('.job').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
    try {
      const job = await api('/api/job?id=' + encodeURIComponent(id));
      detail = job.detail; seconds = job.seconds || 0;
      filename = job.filename || '转录结果';
      if (!detail || !detail.tracks) throw new Error('结果数据缺失');
      $('resultName').textContent = filename;
      $('resultMeta').textContent = `${fmt(seconds)} 音频 · ${(job.summary?.tracks || []).length} 轨 · ${job.device || 'auto'}`;
      $('midiLink').href = `/api/download?id=${encodeURIComponent(id)}&kind=midi`;
      $('midiLink').download = filename.replace(/\.[^.]+$/, '') + '.mid';
      $('jsonLink').href = `/api/download?id=${encodeURIComponent(id)}&kind=json`;
      $('jsonLink').download = filename.replace(/\.[^.]+$/, '') + '.json';
      piece = [];
      detail.tracks.forEach((t, ti) => t.notes.forEach((n) => piece.push({
        t0: n[0], t1: Math.max(n[0] + 0.03, n[1]), pitch: n[2], vel: n[3] ?? 100,
        track: ti, color: COLORS[ti % COLORS.length], drum: !!t.is_drum,
      })));
      piece.sort((a, b) => a.t0 - b.t0);
      duration = Math.max(seconds || 0, piece.reduce((m, n) => Math.max(m, n.t1), 0));
      $('timeTotal').textContent = fmt(duration);
      enabled = new Set(detail.tracks.map((_, i) => i));
      renderMix(); drawOverview(); renderScore(); updatePosition();
      $('nowPlaying').textContent = '未播放'; $('playState').textContent = '就绪';
    } catch (e) { toast(e.message, true); }
  }
  function renderMix() {
    const box = $('trackMix');
    if (!detail) { box.innerHTML = '<p class="hint">选择结果后可在下方单独开关每条音轨。</p>'; return; }
    box.innerHTML = '<div style="font-size:11px;color:var(--muted);margin-bottom:4px">音轨开关（同时影响播放与谱面）</div>' +
      detail.tracks.map((t, i) => `<label class="mix-row">
        <input type="checkbox" data-track="${i}" ${enabled.has(i) ? 'checked' : ''}>
        <span class="mix-dot" style="background:${COLORS[i % COLORS.length]}"></span>
        <span class="mix-name" title="${esc(t.name)}">${esc(t.name)}</span>
        <span class="mix-notes">${t.notes.length}</span></label>`).join('');
  }
  function filteredDetail() {
    if (!detail) return null;
    return { tracks: detail.tracks.filter((_, i) => enabled.has(i)) };
  }
  function renderScore() {
    const d = filteredDetail();
    if (!d || !d.tracks.length || !window.DettatoScore) {
      $('scoreSheet').innerHTML = '<p class="sheet-empty">未选择音轨。</p>';
      $('tempoNote').textContent = '—'; $('sheetFoot').textContent = '';
      return;
    }
    model = window.DettatoScore.build(d, { quant: $('quantSel').value });
    if (!model) {
      $('scoreSheet').innerHTML = '<p class="sheet-empty">没有可记谱的音符。</p>';
      $('tempoNote').textContent = '—'; $('sheetFoot').textContent = '';
      return;
    }
    const all = d.tracks.reduce((a, t) => a.concat(t.notes), []);
    // 用原始速度估算，保证不同量化档位下 BPM 一致
    model.beat = window.DettatoScore.estimateBeat(all);
    model.tempo = Math.round(60 / model.beat);
    const info = window.DettatoScore.render($('scoreSheet'), model, {});
    const keyName = model.key ? model.key.name + (model.key.minor ? ' 小调' : ' 大调') : '—';
    const clefs = Array.from(new Set(d.tracks.map((t) => t.clef === 'bass' ? '低音' : (t.clef === 'percussion' ? '打击乐' : '高音')))).join('/');
    $('tempoNote').textContent = `约 ${model.tempo} BPM · ${model.subdiv >= 8 ? '细网格' : '1/' + (4 * model.subdiv)} · 调性 ${keyName} · 谱号 ${clefs}`;
    $('sheetFoot').textContent = '演奏型 MIDI 自动量化后的近似记谱，时值与音高可能有偏差' +
      (info && info.clipped ? '；仅显示前 80 小节' : '') + '。';
  }

  /* ---------- exports ---------- */
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 3000);
  }
  const baseName = () => filename.replace(/\.[^.]+$/, '') || 'dettato';
  async function exportPNG() {
    const svg = $('scoreSheet').querySelector('svg');
    if (!svg) { toast('当前没有可导出的谱面', true); return; }
    try {
      const clone = svg.cloneNode(true);
      const box = $('scoreSheet').getBoundingClientRect();
      const w = Math.max(800, Math.ceil(box.width - 36));
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', w + 'px');
      const src = new XMLSerializer().serializeToString(clone);
      const img = new Image();
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src);
      img.onload = () => {
        const h = Math.ceil(img.naturalHeight * (w / (img.naturalWidth || w)));
        const c = document.createElement('canvas');
        c.width = w; c.height = Math.max(200, h);
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, w, h);
        c.toBlob((b) => { if (b) download(b, baseName() + '-五线谱.png'); else toast('导出失败', true); }, 'image/png');
      };
      img.onerror = () => toast('PNG 导出失败', true);
      img.src = url;
    } catch (e) { toast(e.message, true); }
  }

  /* ---------- events ---------- */
  $('jobList').addEventListener('click', (e) => {
    const card = e.target.closest('.job');
    if (card) refreshJobs(card.dataset.id).then(() => selectJob(card.dataset.id));
  });
  $('trackMix').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-track]');
    if (!cb) return;
    const i = Number(cb.dataset.track);
    if (cb.checked) enabled.add(i); else enabled.delete(i);
    restart();
    drawOverview(); renderScore(); updatePosition();
  });
  $('playBtn').addEventListener('click', play);
  $('stopBtn').addEventListener('click', () => { stopPlayback(); offset = 0; updatePosition(); $('nowPlaying').textContent = '未播放'; $('playState').textContent = '就绪'; });
  $('progress').addEventListener('click', (e) => {
    const r = $('progress').getBoundingClientRect();
    seek((e.clientX - r.left) / r.width * duration);
  });
  $('volRange').addEventListener('input', () => { if (master) master.gain.value = Number($('volRange').value) / 100 * 0.55; });
  $('speedSel').addEventListener('change', restart);
  $('waveSel').addEventListener('change', restart);
  $('quantSel').addEventListener('change', renderScore);
  $('xmlBtn').addEventListener('click', () => {
    if (!model) { toast('请先选择转录结果', true); return; }
    const xml = window.DettatoScore.musicXML(model, baseName());
    download(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml;charset=utf-8' }), baseName() + '.musicxml');
    toast('MusicXML 已导出，可用 MuseScore 打开');
  });
  $('pngBtn').addEventListener('click', exportPNG);
  $('pdfBtn').addEventListener('click', () => window.print());
  window.addEventListener('resize', () => { if (detail) { drawOverview(); renderScore(); } });

  async function health() {
    try {
      const h = await api('/api/health');
      $('envDot').className = 'pulse' + (h.model_loaded ? ' on' : (h.gpu ? ' warn' : ''));
      $('envText').textContent = h.model_loaded ? `模型就绪 · ${h.device.toUpperCase()}` : (h.gpu ? 'GPU 可用' : 'CPU 模式');
      $('footerInfo').textContent = `设备 ${h.device.toUpperCase()} · 本地服务已运行 ${fmt(h.uptime)}`;
    } catch (e) { $('envText').textContent = '服务不可用'; $('envDot').className = 'pulse warn'; }
  }
  health(); refreshJobs();
  setInterval(() => refreshJobs(activeId), 3000);
  setInterval(health, 8000);
})();
