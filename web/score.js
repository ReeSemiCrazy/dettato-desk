/* Dettato Sheet — 演奏型 MIDI → 五线谱（调号/谱号识别、连续谱行、连梁、MusicXML 导出） */
(function () {
  'use strict';
  const VF = window.VexFlow;
  const SHARP_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  const FLAT_NAMES = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];
  const DRUM_KEYS = ['c/5', 'd/5', 'e/5', 'f/5', 'g/5', 'a/5', 'b/5', 'c/6'];
  const MAX_BARS = 80;
  const DUR = [[4, 'whole'], [2, 'half'], [1, 'quarter'], [0.5, 'eighth'],
               [0.25, '16th'], [0.125, '32nd'], [0.0625, '64th']];
  const VF_DUR = { whole: 'w', half: 'h', quarter: 'q', eighth: '8', '16th': '16', '32nd': '32', '64th': '64' };
  const SHARP_PCS = [6, 1, 8, 3, 10, 5, 0];    // F# C# G# D# A# E# B#
  const FLAT_PCS = [10, 3, 8, 1, 6, 2, 5];    // Bb Eb Ab Db Gb Cb Fb
  const MAJ_BY_FIFTHS = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
  const MIN_BY_FIFTHS = ['Abm', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m'];
  const TONIC_FIFTHS = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: 7, 5: -1, 10: -2, 3: -3, 8: -4 };
  const KP_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KP_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function pitchParts(p) {
    const m = Math.round(p);
    return { pc: ((m % 12) + 12) % 12, octave: Math.floor(m / 12) - 1 };
  }
  function drumKey(p) { return DRUM_KEYS[Math.abs(Math.round(p)) % DRUM_KEYS.length]; }

  function estimateBeat(notes) {
    const onsets = Array.from(new Set(notes.map((n) => n[0]))).sort((a, b) => a - b);
    const diffs = [];
    for (let i = 1; i < onsets.length; i++) {
      const d = onsets[i] - onsets[i - 1];
      if (d > 0.06 && d < 2.5) diffs.push(d);
    }
    if (!diffs.length) return 0.5;
    diffs.sort((a, b) => a - b);
    let beat = diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * 0.25))];
    while (beat < 0.28) beat *= 2;
    while (beat > 0.9) beat /= 2;
    return beat;
  }

  function corr(hist, profile, tonic) {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < 12; i++) {
      const x = hist[i], y = profile[(i + tonic) % 12];
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    const num = 12 * sxy - sx * sy;
    const den = Math.sqrt((12 * sxx - sx * sx) * (12 * syy - sy * sy));
    return den ? num / den : 0;
  }

  /* Krumhansl-Schmuckler 简化版：按时值加权的音级分布识别调性 */
  function detectKey(notes) {
    const hist = new Array(12).fill(0);
    notes.forEach((n) => {
      const p = pitchParts(n[2]);
      hist[p.pc] += Math.min(4, Math.max(0.3, (n[1] - n[0]) * 2)) * Math.min(1.4, (n[3] || 90) / 100);
    });
    let best = { score: -2, tonic: 0, minor: false };
    for (let t = 0; t < 12; t++) {
      const ma = corr(hist, KP_MAJ, (12 - t) % 12);
      const mi = corr(hist, KP_MIN, (12 - t) % 12);
      if (ma > best.score) best = { score: ma, tonic: t, minor: false };
      if (mi > best.score) best = { score: mi, tonic: t, minor: true };
    }
    let fifths = TONIC_FIFTHS[best.tonic] ?? 0;
    if (best.minor) fifths = TONIC_FIFTHS[(best.tonic + 3) % 12] ?? 0;
    fifths = Math.max(-7, Math.min(7, fifths));
    const name = (best.minor ? MIN_BY_FIFTHS : MAJ_BY_FIFTHS)[fifths + 7];
    const pcs = {};
    if (fifths > 0) SHARP_PCS.slice(0, fifths).forEach((pc) => { pcs[pc] = '#'; });
    if (fifths < 0) FLAT_PCS.slice(0, -fifths).forEach((pc) => { pcs[pc] = 'b'; });
    return { name: name, fifths: fifths, minor: best.minor, pcs: pcs, confidence: Math.max(0, best.score) };
  }

  /* 音域 + GM 乐器号 + 名称判断谱号 */
  function detectClef(track) {
    if (track.is_drum) return 'percussion';
    const ps = (track.notes || []).map((n) => n[2]).filter((p) => p > 0).sort((a, b) => a - b);
    const median = ps.length ? ps[Math.floor(ps.length / 2)] : 60;
    const prog = track.program;
    const name = String(track.name || '').toLowerCase();
    if ((prog != null && prog >= 32 && prog <= 39) || /bass|低音|贝斯/.test(name) || median < 52) return 'bass';
    return 'treble';
  }

  function spell(p, key) {
    const parts = pitchParts(p);
    const names = key && key.fifths < 0 ? FLAT_NAMES : SHARP_NAMES;
    const raw = names[parts.pc];
    const inKey = key && key.pcs[parts.pc];
    const needAcc = !inKey && /[#b]/.test(raw);
    return { key: raw + '/' + parts.octave, accidental: needAcc ? (raw.indexOf('#') >= 0 ? '#' : 'b') : null };
  }

  function build(detail, opts) {
    opts = opts || {};
    const tracks = (detail && detail.tracks) || [];
    const melodic = tracks.filter((t) => !t.is_drum).reduce((a, t) => a.concat(t.notes || []), []);
    const all = tracks.reduce((a, t) => a.concat(t.notes || []), []);
    if (!all.length) return null;
    const beat = opts.beat || estimateBeat(all);
    const subdiv = opts.quant === '8' ? 2 : opts.quant === '16' ? 4 : 8;
    const grid = beat / subdiv;
    const perQuarter = Math.max(1, Math.round(beat / grid));
    const key = detectKey(melodic.length ? melodic : all);
    const built = tracks.map((t) => {
      const groups = new Map();
      for (const n of t.notes || []) {
        const start = Math.max(0, Math.round(n[0] / grid));
        const end = Math.max(start + 1, Math.round(n[1] / grid));
        const g = groups.get(start);
        if (g) { g.end = Math.max(g.end, end); g.pitches.push(n[2]); }
        else groups.set(start, { start: start, end: end, pitches: [n[2]] });
      }
      return {
        name: t.name, program: t.program, is_drum: !!t.is_drum,
        clef: detectClef(t), key: t.is_drum ? null : key,
        events: Array.from(groups.values())
          .map((g) => ({ u: g.start, dur: g.end - g.start, pitches: g.pitches }))
          .sort((a, b) => a.u - b.u),
      };
    });
    return { beat: beat, tempo: Math.round(60 / beat), subdiv: subdiv, grid: grid,
             perQuarter: perQuarter, measureUnits: 4 * perQuarter, tracks: built, key: key };
  }

  function bestDuration(units, perQuarter) {
    const q = Math.max(0.0625, units / perQuarter);
    let best = null;
    for (const [val, name] of DUR) {
      for (const [mul, suffix] of [[1, ''], [1.5, 'd'], [1.75, 'dd']]) {
        const cand = val * mul;
        if (cand > q * 1.22) continue;
        if (!best || Math.abs(cand - q) < best.score) best = { name: name, suffix: suffix, score: Math.abs(cand - q) };
      }
    }
    return best || { name: '64th', suffix: '', score: 0 };
  }
  function durType(units, model) { return bestDuration(units, model.perQuarter).name; }
  function vxDuration(units, perQuarter) {
    const d = bestDuration(units, perQuarter);
    return (VF_DUR[d.name] || 'q') + (d.suffix || '');
  }

  function addNote(voice, keys, units, perQuarter, clef, isRest) {
    const dur = vxDuration(units, perQuarter) + (isRest ? 'r' : '');
    const note = new VF.StaveNote({ keys: keys.map((k) => k.key || k), duration: dur,
      clef: clef, auto_stem: true });
    if (!isRest && clef !== 'percussion') {
      keys.forEach((k, i) => { if (k && k.acc) note.addModifier(new VF.Accidental(k.acc), i); });
    }
    if (clef === 'percussion') note.setStyle({ fillStyle: '#1a1a1a', strokeStyle: '#1a1a1a' });
    voice.addTickable(note);
    return note;
  }

  /* 连续谱行：同一行的小节首尾相接，行首带谱号/调号/拍号，八分音符及以下自动连梁 */
  function render(container, model) {
    if (!VF || !model) return null;
    container.innerHTML = '';
    const avail = container.clientWidth || 900;
    const perRow = Math.max(2, Math.min(5, Math.floor(avail / 205)));
    const mw = Math.min(240, (avail - 24) / perRow);
    let totalBars = 0;

    model.tracks.forEach((track) => {
      const section = document.createElement('section');
      section.className = 'sheet-track';
      const h = document.createElement('h4');
      h.textContent = track.name + (track.is_drum ? ' · 打击乐'
        : ' · ' + (track.clef === 'bass' ? '低音谱号' : '高音谱号') + ' · ' + (track.key ? track.key.name : ''));
      section.appendChild(h);
      const canvas = document.createElement('div');
      canvas.className = 'sheet-canvas';
      section.appendChild(canvas);
      container.appendChild(section);
      if (!track.events.length) {
        const em = document.createElement('p'); em.className = 'sheet-empty'; em.textContent = '（无音符）';
        section.appendChild(em); return;
      }

      const last = track.events[track.events.length - 1];
      const bars = Math.min(MAX_BARS, Math.ceil((last.u + last.dur) / model.measureUnits) + 1);
      totalBars = Math.max(totalBars, bars);
      const rows = Math.ceil(bars / perRow);
      const renderer = new VF.Renderer(canvas, VF.Renderer.Backends.SVG);
      renderer.resize(Math.ceil(mw * perRow + 24), rows * 120 + 18);
      const ctx = renderer.getContext();
      ctx.setFillStyle('#171717'); ctx.setStrokeStyle('#171717');

      let ei = 0;
      for (let m = 0; m < bars; m++) {
        const col = m % perRow, row = Math.floor(m / perRow);
        const stave = new VF.Stave(12 + col * mw, 14 + row * 120, Math.ceil(mw));
        if (col === 0) {
          stave.addClef(track.clef);
          if (track.key) stave.addKeySignature(track.key.name);
          stave.addTimeSignature('4/4');
        }
        stave.setContext(ctx).draw();

        const start = m * model.measureUnits, end = start + model.measureUnits;
        const voice = new VF.Voice({ numBeats: 4, beatValue: 4 }).setStrict(false);
        while (ei < track.events.length && track.events[ei].u < start) ei++;
        let idx = ei, cursor = start;
        while (idx < track.events.length && track.events[idx].u < end) {
          const ev = track.events[idx];
          if (ev.u > cursor) {
            let gap = ev.u - cursor;
            while (gap > 0) {
              const d = Math.min(gap, 4 * model.perQuarter);
              addNote(voice, ['b/4'], d, model.perQuarter, track.clef, true);
              gap -= d;
            }
          }
          const units = Math.max(1, Math.min(ev.dur, end - ev.u));
          const keys = track.clef === 'percussion'
            ? ev.pitches.map((p) => ({ key: drumKey(p), acc: null }))
            : ev.pitches.map((p) => { const s = spell(p, track.key); return { key: s.key, acc: s.accidental }; });
          addNote(voice, keys, units, model.perQuarter, track.clef, false);
          cursor = Math.max(cursor, ev.u + units);
          idx++;
        }
        if (cursor < end) {
          let gap = end - cursor;
          while (gap > 0) {
            const d = Math.min(gap, 4 * model.perQuarter);
            addNote(voice, ['b/4'], d, model.perQuarter, track.clef, true);
            gap -= d;
          }
        }
        if (!voice.getTickables().length)
          addNote(voice, ['b/4'], model.measureUnits, model.perQuarter, track.clef, true);

        const tickables = voice.getTickables();
        new VF.Formatter().joinVoices([voice]).format([voice], mw - 18);
        voice.draw(ctx, stave);
        try {
          VF.Beam.generateBeams(tickables, { beam_rests: false }).forEach((b) => {
            try { b.setContext(ctx).draw(); } catch (e) {}
          });
        } catch (e) { /* 连梁失败不影响音符 */ }
      }
    });
    return { bars: totalBars, clipped: totalBars >= MAX_BARS };
  }

  function musicXML(model, title) {
    if (!model) return '';
    const div = 480;
    const L = [];
    L.push('<?xml version="1.0" encoding="utf-8"?>');
    L.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
    L.push('<score-partwise version="4.0">');
    L.push('  <work><work-title>' + esc(title || 'Dettato transcription') + '</work-title></work>');
    L.push('  <identification><creator type="composer">dettato</creator></identification>');
    L.push('  <defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling></defaults>');
    L.push('  <part-list>');
    model.tracks.forEach((t, i) => {
      L.push('    <score-part id="P' + (i + 1) + '"><part-name>' + esc(t.name) + '</part-name>' +
        (t.program != null && !t.is_drum ? '<midi-program>' + (t.program + 1) + '</midi-program>' : '') + '</score-part>');
    });
    L.push('  </part-list>');
    model.tracks.forEach((t, ti) => {
      L.push('  <part id="P' + (ti + 1) + '">');
      const last = t.events[t.events.length - 1] || { u: 0, dur: 4 * model.perQuarter };
      const bars = Math.min(MAX_BARS, Math.ceil((last.u + last.dur) / model.measureUnits) + 1);
      let ei = 0;
      for (let m = 0; m < bars; m++) {
        L.push('    <measure number="' + (m + 1) + '">');
        if (m === 0) {
          const fifths = t.key ? t.key.fifths : 0;
          const mode = t.key && t.key.minor ? 'minor' : 'major';
          L.push('      <attributes><divisions>' + div + '</divisions>' +
            '<key><fifths>' + fifths + '</fifths><mode>' + mode + '</mode></key>' +
            '<time><beats>4</beats><beat-type>4</beat-type></time>' +
            '<clef><sign>' + (t.clef === 'bass' ? 'F' : (t.clef === 'percussion' ? 'percussion' : 'G')) + '</sign>' +
            (t.clef === 'bass' ? '<line>4</line>' : (t.clef === 'percussion' ? '' : '<line>2</line>')) + '</clef></attributes>');
          L.push('      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>' +
            '<per-minute>' + model.tempo + '</per-minute></metronome></direction-type><sound tempo="' + model.tempo + '"/></direction>');
        }
        const start = m * model.measureUnits, end = start + model.measureUnits;
        while (ei < t.events.length && t.events[ei].u < start) ei++;
        let idx = ei, cursor = start;
        while (idx < t.events.length && t.events[idx].u < end) {
          const ev = t.events[idx];
          if (ev.u > cursor) rest(L, ev.u - cursor, div, model);
          const units = Math.max(1, Math.min(ev.dur, end - ev.u));
          const d = Math.max(1, Math.round(units / model.perQuarter * div));
          const typ = durType(units, model);
          ev.pitches.forEach((p, k) => {
            L.push('      <note>' + (k > 0 ? '<chord/>' : ''));
            const parts = pitchParts(p);
            const sp = t.clef === 'percussion' ? null : spell(p, t.key);
            const step = sp ? sp.key[0].toUpperCase() : SHARP_NAMES[parts.pc][0].toUpperCase();
            const alter = sp && sp.accidental === '#' ? 1 : (sp && sp.accidental === 'b' ? -1 : 0);
            if (t.is_drum) {
              L.push('        <unpitched><display-step>' + step + '</display-step><display-octave>' + parts.octave + '</display-octave></unpitched>');
            } else {
              L.push('        <pitch><step>' + step + '</step>' + (alter ? '<alter>' + alter + '</alter>' : '') + '<octave>' + parts.octave + '</octave></pitch>');
            }
            L.push('        <duration>' + d + '</duration><voice>1</voice><type>' + typ + '</type></note>');
          });
          cursor = Math.max(cursor, ev.u + units);
          idx++;
        }
        if (cursor < end) rest(L, end - cursor, div, model);
        if (m === bars - 1) L.push('      <barline location="right"><bar-style>light-heavy</bar-style></barline>');
        L.push('    </measure>');
      }
      L.push('  </part>');
    });
    L.push('</score-partwise>');
    return L.join('\n');
  }
  function rest(L, units, div, model) {
    let gap = units;
    while (gap > 0) {
      const d = Math.min(gap, 4 * model.perQuarter);
      L.push('      <note><rest/><duration>' + Math.max(1, Math.round(d / model.perQuarter * div)) +
        '</duration><voice>1</voice><type>' + durType(d, model) + '</type></note>');
      gap -= d;
    }
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }

  window.DettatoScore = { build: build, render: render, musicXML: musicXML,
                          estimateBeat: estimateBeat, detectKey: detectKey, detectClef: detectClef };
})();
