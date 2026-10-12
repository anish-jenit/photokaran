(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');

  const FORMATS = {
    reel: { w: 720, h: 1280, safe: false },
    story: { w: 720, h: 1280, safe: true },
    shorts: { w: 720, h: 1280, safe: false },
    youtube: { w: 1280, h: 720, safe: false },
    square: { w: 1080, h: 1080, safe: false },
  };
  const PX_PER_SEC = 60;
  const TRANS_DUR = 0.5;
  const IMAGE_DUR = 4;

  const media = {}; // id -> {id, kind, el, dur, name}
  let state = { format: 'reel', clips: [], audio: [], t: 0 };
  let history = [];
  let playing = false;
  let exporting = false;
  let restored = false;
  let offline = false;
  let lastTick = performance.now();
  let uid = 1;
  let audioCtx, streamDest, monitor;
  const routed = new WeakSet();

  // ---------- helpers ----------
  const spd = (c) => c.speed || 1;
  const vol = (c) => (c.vol == null ? 1 : c.vol);
  const clipDur = (c) => (c.out - c.in) / spd(c);
  const total = () => state.clips.reduce((s, c) => s + clipDur(c), 0);
  function layout() {
    let s = 0;
    return state.clips.map((c) => { const r = { clip: c, start: s }; s += clipDur(c); return r; });
  }
  function clipAt(t) {
    const L = layout();
    for (let i = 0; i < L.length; i++) if (t < L[i].start + clipDur(L[i].clip)) return { ...L[i], index: i };
    return L.length ? { ...L[L.length - 1], index: L.length - 1 } : null;
  }
  function log(msg, cls = '') {
    const d = document.createElement('div');
    d.className = cls; d.textContent = msg;
    $('log').appendChild(d); $('log').scrollTop = 1e9;
  }
  function snapshot() { history.push(JSON.stringify(state)); if (history.length > 50) history.shift(); }

  // ---------- media ----------
  function ensureAudio() {
    if (audioCtx) return;
    audioCtx = new AudioContext();
    streamDest = audioCtx.createMediaStreamDestination();
    monitor = audioCtx.createGain();
    monitor.connect(audioCtx.destination);
  }
  function route(el) {
    ensureAudio();
    if (routed.has(el)) return;
    routed.add(el);
    const src = audioCtx.createMediaElementSource(el);
    const gain = audioCtx.createGain();
    el._gain = gain;
    src.connect(gain);
    gain.connect(monitor);
    gain.connect(streamDest);
  }

  function loadMedia(file, forcedId) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const id = forcedId || 'm' + uid++;
      const kind = file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'image';
      if (kind === 'image') {
        const el = new Image();
        el.onload = () => { media[id] = { id, kind, el, dur: IMAGE_DUR, name: file.name, file }; resolve(media[id]); };
        el.onerror = () => reject(new Error('Could not load ' + file.name));
        el.src = url;
        return;
      }
      const el = document.createElement(kind);
      el.preload = 'auto'; el.playsInline = true;
      el.onloadedmetadata = () => {
        route(el);
        media[id] = { id, kind, el, dur: el.duration, name: file.name, file };
        resolve(media[id]);
      };
      el.onerror = () => reject(new Error('Could not load ' + file.name));
      el.src = url;
    });
  }

  async function importFiles(files, forceAudio = false) {
    snapshot();
    for (const f of files) {
      try {
        const m = await loadMedia(f);
        idb.put('files', m.id, f).catch(warnSave);
        if (m.kind === 'audio' || forceAudio) {
          if (m.kind !== 'audio') { log('Not an audio file: ' + f.name, 'err'); continue; }
          state.audio.push({ id: 'a' + uid++, media: m.id, start: state.t, in: 0, out: m.dur, name: m.name });
          log('Added audio: ' + m.name, 'ok');
        } else {
          state.clips.push({ id: 'c' + uid++, media: m.id, in: 0, out: m.dur, muted: false, zoom: 1, crop: null, anim: 'none', trans: 'none', name: m.name });
          log('Imported: ' + m.name, 'ok');
        }
      } catch (e) { log(e.message, 'err'); }
    }
    refresh();
  }

  // ---------- rendering ----------
  function srcSize(m) {
    return m.kind === 'video' ? [m.el.videoWidth, m.el.videoHeight] : [m.el.naturalWidth, m.el.naturalHeight];
  }
  const ease = (p) => 1 - Math.pow(1 - p, 3);

  // Frozen last frames of outgoing clips, so transitions can composite old + new.
  const frameCache = {};
  const scratch = {};
  let grabQueue = Promise.resolve();
  const frameKey = (c) => c.media + ':' + Math.max(0, c.out - 0.05).toFixed(2);

  function seekEl(el, time) {
    return new Promise((resolve) => {
      if (Math.abs(el.currentTime - time) < 0.001 && el.readyState >= 2) return resolve();
      const done = () => { el.removeEventListener('seeked', done); clearTimeout(to); resolve(); };
      const to = setTimeout(done, 3000);
      el.addEventListener('seeked', done);
      el.currentTime = time;
    });
  }
  function grabFrame(c) {
    const key = frameKey(c);
    if (key in frameCache) return Promise.resolve();
    frameCache[key] = null;
    grabQueue = grabQueue.then(async () => {
      const m = media[c.media];
      let v = scratch[m.id];
      if (!v) {
        v = scratch[m.id] = document.createElement('video');
        v.muted = true; v.preload = 'auto'; v.src = m.el.src;
        await new Promise((r) => { v.onloadeddata = r; v.onerror = r; });
      }
      await seekEl(v, Math.max(0, c.out - 0.05));
      const cv = document.createElement('canvas');
      cv.width = v.videoWidth; cv.height = v.videoHeight;
      cv.getContext('2d').drawImage(v, 0, 0);
      frameCache[key] = cv;
    }).catch(() => { delete frameCache[key]; });
    return grabQueue;
  }
  function prepareFrames() {
    const jobs = [];
    state.clips.forEach((c, i) => {
      if (i > 0 && c.trans !== 'none' && media[state.clips[i - 1].media].kind === 'video') jobs.push(grabFrame(state.clips[i - 1]));
    });
    return Promise.all(jobs);
  }

  function drawClip(g, c, local, frame, tr) {
    const m = media[c.media];
    const el = frame || m.el;
    const [sw0, sh0] = frame ? [frame.width, frame.height] : srcSize(m);
    if (!sw0) return;
    const W = g.canvas.width, H = g.canvas.height;
    const cr = c.crop || { x: 0, y: 0, w: 1, h: 1 };
    const sx = cr.x * sw0, sy = cr.y * sh0, sw = cr.w * sw0, sh = cr.h * sh0;
    let scale = Math.max(W / sw, H / sh) * c.zoom;
    let ox = 0, oy = 0, alpha = 1, clipW = W;
    const d = clipDur(c);

    if (c.anim === 'fade') alpha *= ease(Math.min(1, local / 0.7));
    if (c.anim === 'slide') ox += (1 - ease(Math.min(1, local / 0.7))) * -W;
    if (c.anim === 'zoom') scale *= 1 + 0.15 * (local / d);
    if (c.anim === 'pulse') scale *= 1 + 0.04 * Math.sin(local * Math.PI * 3);

    if (tr) {
      const p = ease(tr.p);
      if (tr.name === 'fade') alpha *= p;
      if (tr.name === 'slide') ox += (1 - p) * W;
      if (tr.name === 'zoom') { scale *= 0.6 + 0.4 * p; alpha *= p; }
      if (tr.name === 'wipe') clipW = W * p;
    }

    g.save();
    g.globalAlpha = Math.max(0, Math.min(1, alpha));
    g.beginPath(); g.rect(0, 0, clipW, H); g.clip();
    const dw = sw * scale, dh = sh * scale;
    g.drawImage(el, sx, sy, sw, sh, (W - dw) / 2 + ox, (H - dh) / 2 + oy, dw, dh);
    g.restore();
    if (c.caption) drawCaption(g, c.caption);
    if (c.cues) {
      const st = c.in + local * spd(c);
      const cue = c.cues.find((q) => st >= q.s && st < q.e);
      if (cue) drawCaption(g, cue.text);
    }
  }

  function drawCaption(g, text) {
    const W = g.canvas.width, H = g.canvas.height;
    const size = Math.round(Math.min(W, H) / 14);
    g.save();
    g.font = `bold ${size}px "Noto Sans Tamil", system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = size / 6; g.strokeStyle = '#000'; g.fillStyle = '#fff';
    const words = text.split(' '); const lines = []; let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (g.measureText(test).width > W * 0.86 && line) { lines.push(line); line = w; } else line = test;
    }
    lines.push(line);
    const y0 = H * 0.72 - ((lines.length - 1) * size * 1.2) / 2;
    lines.forEach((l, i) => { const y = y0 + i * size * 1.2; g.strokeText(l, W / 2, y); g.fillText(l, W / 2, y); });
    g.restore();
  }

  function compose(g, t, placeholder = true) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, g.canvas.width, g.canvas.height);
    const cur = clipAt(t);
    if (!cur) {
      if (placeholder) {
        g.fillStyle = '#8b93a1'; g.font = `${g.canvas.width / 22}px system-ui`; g.textAlign = 'center';
        g.fillText('Import a video or say "import video"', g.canvas.width / 2, g.canvas.height / 2);
      }
      return;
    }
    const c = cur.clip, local = Math.max(0, t - cur.start);
    const prev = cur.index > 0 ? state.clips[cur.index - 1] : null;
    if (prev && c.trans !== 'none' && local < TRANS_DUR) {
      const pm = media[prev.media];
      if (pm.kind === 'image') drawClip(g, prev, clipDur(prev));
      else { grabFrame(prev); if (frameCache[frameKey(prev)]) drawClip(g, prev, clipDur(prev), frameCache[frameKey(prev)]); }
      drawClip(g, c, local, null, { name: c.trans, p: local / TRANS_DUR });
    } else drawClip(g, c, local);
  }
  const render = () => compose(ctx, state.t);

  // ---------- playback sync ----------
  function syncMedia() {
    const cur = clipAt(state.t);
    const activeVideo = cur && media[cur.clip.media].kind === 'video' ? media[cur.clip.media] : null;
    for (const m of Object.values(media)) {
      if (m.kind !== 'video' || m === activeVideo) continue;
      if (!m.el.paused) m.el.pause();
    }
    if (activeVideo) {
      const el = activeVideo.el;
      const want = cur.clip.in + (state.t - cur.start) * spd(cur.clip);
      el.muted = cur.clip.muted;
      el.preservesPitch = false;
      el.playbackRate = spd(cur.clip);
      if (el._gain) el._gain.gain.value = vol(cur.clip);
      if (playing) {
        if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want;
        if (el.paused) el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        if (!el.seeking && Math.abs(el.currentTime - want) > 0.03) el.currentTime = want;
      }
    }
    for (const a of state.audio) {
      const el = media[a.media].el;
      const local = state.t - a.start;
      const active = playing && local >= 0 && local < a.out - a.in;
      if (active) {
        if (Math.abs(el.currentTime - (a.in + local)) > 0.3) el.currentTime = a.in + local;
        if (el.paused) el.play().catch(() => {});
      } else if (!el.paused) el.pause();
    }
  }

  function tick(now) {
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    if (offline) { requestAnimationFrame(tick); return; }
    if (playing) {
      state.t += dt;
      if (state.t >= total()) { state.t = total(); setPlaying(false); if (exporting) finishExport(); }
    }
    syncMedia();
    render();
    updateTimelineUI();
    requestAnimationFrame(tick);
  }

  function setPlaying(p) {
    if (p && state.t >= total() - 0.01) state.t = 0;
    playing = p && total() > 0;
    $('btnPlay').textContent = playing ? '⏸ Pause' : '▶ Play';
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  // ---------- timeline UI ----------
  function enableClipDragging(block, clip) {
    let gesture = null;
    block.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const handle = e.target.closest('.trim-handle');
      gesture = {
        x: e.clientX,
        y: e.clientY,
        mode: handle ? handle.dataset.edge : 'move',
        start: layout().find((item) => item.clip === clip).start,
        in: clip.in,
        out: clip.out,
        changed: false,
      };
      block.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
    block.addEventListener('pointermove', (e) => {
      if (!gesture) return;
      const dx = e.clientX - gesture.x;
      if (Math.abs(dx) < 3) return;
      if (gesture.mode === 'move') {
        block.classList.add('dragging');
        block.style.transform = `translateX(${dx}px)`;
        return;
      }
      const rate = spd(clip);
      const minSource = 0.1 * rate;
      const delta = (dx / PX_PER_SEC) * rate;
      const bound = media[clip.media].dur;
      let nextIn = gesture.in, nextOut = gesture.out;
      if (gesture.mode === 'left') nextIn = Math.max(0, Math.min(gesture.out - minSource, gesture.in + delta));
      else nextOut = Math.min(bound, Math.max(gesture.in + minSource, gesture.out + delta));
      if (!gesture.changed && (nextIn !== gesture.in || nextOut !== gesture.out)) {
        snapshot();
        gesture.changed = true;
      }
      clip.in = nextIn;
      clip.out = nextOut;
      block.style.width = Math.max(8, clipDur(clip) * PX_PER_SEC - 2) + 'px';
      if (gesture.mode === 'left') block.style.left = gesture.start * PX_PER_SEC + 'px';
      if (gesture.changed) block.dataset.dragged = 'true';
    });
    const finish = (e) => {
      if (!gesture) return;
      const g = gesture;
      gesture = null;
      if (block.hasPointerCapture(e.pointerId)) block.releasePointerCapture(e.pointerId);
      block.style.transform = '';
      block.classList.remove('dragging');
      if (g.mode === 'move' && Math.abs(e.clientX - g.x) >= 3) {
        const blocks = [...$('trackV').querySelectorAll('.block.v')].filter((item) => item !== block);
        const insertion = blocks.filter((item) => e.clientX > item.getBoundingClientRect().left + item.getBoundingClientRect().width / 2).length;
        const from = state.clips.indexOf(clip);
        const to = Math.max(0, Math.min(state.clips.length - 1, insertion));
        if (from !== to) {
          const current = clipAt(state.t);
          const currentClip = current && current.clip;
          const local = current ? state.t - current.start : 0;
          snapshot();
          state.clips.splice(from, 1);
          state.clips.splice(to, 0, clip);
          const movedCurrent = layout().find((item) => item.clip === currentClip);
          if (movedCurrent) state.t = Math.min(movedCurrent.start + local, movedCurrent.start + clipDur(currentClip));
          block.dataset.dragged = 'true';
          log('Clips reordered', 'ok');
        }
      } else if (g.changed) {
        state.t = Math.min(state.t, total());
        log('Clip trimmed', 'ok');
      }
      refresh();
    };
    block.addEventListener('pointerup', finish);
    block.addEventListener('pointercancel', finish);
  }

  function refresh() {
    const tv = $('trackV'), ta = $('trackA');
    tv.innerHTML = ''; ta.innerHTML = '';
    const cur = clipAt(state.t);
    for (const { clip, start } of layout()) {
      const b = document.createElement('div');
      b.className = 'block ' + (media[clip.media].kind === 'image' ? 'i' : 'v') + (cur && cur.clip === clip ? ' sel' : '');
      b.style.left = start * PX_PER_SEC + 'px';
      b.style.width = Math.max(8, clipDur(clip) * PX_PER_SEC - 2) + 'px';
      b.textContent = (clip.muted ? '🔇 ' : '') + clip.name + (spd(clip) !== 1 ? ' ⏩' + spd(clip) + '×' : '') + (vol(clip) !== 1 ? ' 🔊' + Math.round(vol(clip) * 100) + '%' : '');
      for (const edge of ['left', 'right']) {
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'trim-handle trim-' + edge;
        handle.dataset.edge = edge;
        handle.setAttribute('aria-label', `Trim ${edge} edge of ${clip.name}`);
        handle.title = `Drag to trim ${edge === 'left' ? 'start' : 'end'}`;
        b.appendChild(handle);
      }
      b.onclick = (e) => {
        e.stopPropagation();
        if (b.dataset.dragged) { delete b.dataset.dragged; return; }
        state.t = start; refresh();
      };
      enableClipDragging(b, clip);
      tv.appendChild(b);
    }
    for (const a of state.audio) {
      const b = document.createElement('div');
      b.className = 'block a';
      b.style.left = a.start * PX_PER_SEC + 'px';
      b.style.width = Math.max(8, (a.out - a.in) * PX_PER_SEC - 2) + 'px';
      b.textContent = '♪ ' + a.name;
      ta.appendChild(b);
    }
    const w = Math.max(total(), ...state.audio.map((a) => a.start + a.out - a.in), 10) * PX_PER_SEC + 80;
    $('tlInner').style.width = w + 'px';
    scheduleSave();
  }
  let lastSelKey = '';
  function updateTimelineUI() {
    $('playhead').style.left = 60 + state.t * PX_PER_SEC + 'px';
    $('time').textContent = `${state.t.toFixed(1)} / ${total().toFixed(1)}s`;
    const cur = clipAt(state.t);
    const key = cur ? cur.clip.id : '';
    if (key !== lastSelKey) { lastSelKey = key; refresh(); }
  }
  $('tlInner').addEventListener('click', (e) => {
    const r = $('tlInner').getBoundingClientRect();
    state.t = Math.max(0, Math.min(total(), (e.clientX - r.left - 60) / PX_PER_SEC));
  });

  function setFormat(f) {
    const F = FORMATS[f]; if (!F) return;
    state.format = f;
    canvas.width = F.w; canvas.height = F.h;
    $('format').value = f;
    document.querySelector('.canvas-wrap').style.aspectRatio = `${F.w} / ${F.h}`;
    $('safe').classList.toggle('hidden', !F.safe);
  }

  // ---------- actions ----------
  const CROPS = {
    square: (ar) => ar > 1 ? { x: (1 - 1 / ar) / 2, y: 0, w: 1 / ar, h: 1 } : { x: 0, y: (1 - ar) / 2, w: 1, h: ar },
    vertical: (ar) => { const t = 9 / 16; return ar > t ? { x: (1 - t / ar) / 2, y: 0, w: t / ar, h: 1 } : { x: 0, y: (1 - ar / t) / 2, w: 1, h: ar / t }; },
    wide: (ar) => { const t = 16 / 9; return ar > t ? { x: (1 - t / ar) / 2, y: 0, w: t / ar, h: 1 } : { x: 0, y: (1 - ar / t) / 2, w: 1, h: ar / t }; },
  };

  function resolveClip(target) {
    const L = layout();
    const idx = target === 'last' ? L.length - 1 : target - 1;
    return L[idx] ? { ...L[idx], index: idx } : null;
  }
  function needClip(a) {
    if (a && a.target != null) {
      const c = resolveClip(a.target);
      if (!c) log(state.clips.length ? `There is no clip ${a.target} — you have ${state.clips.length}.` : 'No clip yet — import a video first.', 'err');
      return c;
    }
    const cur = clipAt(state.t);
    if (!cur) log('No clip yet — import a video first.', 'err');
    return cur;
  }

  const actions = {
    split(a) {
      const cur = needClip(a); if (!cur) return false;
      const c = cur.clip;
      const inside = state.t > cur.start && state.t < cur.start + clipDur(c);
      const t = a.at != null ? a.at : a.target != null && !inside ? cur.start + clipDur(c) / 2 : state.t;
      const local = t - cur.start;
      if (local < 0.1 || local > clipDur(c) - 0.1) { log('Move the playhead inside a clip (or say "split at 3 seconds").', 'err'); return false; }
      snapshot();
      const cut = c.in + local * spd(c);
      const second = { ...c, id: 'c' + uid++, in: cut, trans: 'none', crop: c.crop && { ...c.crop } };
      c.out = cut;
      state.clips.splice(cur.index + 1, 0, second);
      state.t = t;
      return 'Split clip';
    },
    removeAudio(a) {
      const cur = needClip(a); if (!cur) return false;
      snapshot();
      (a.all ? state.clips : [cur.clip]).forEach((c) => (c.muted = true));
      return a.all ? 'Audio removed from all clips' : 'Audio removed from clip';
    },
    includeAudio(a) {
      const cur = a.target != null ? needClip(a) : clipAt(state.t);
      if (a.target != null && !cur) return false;
      if (!a.fresh && cur && cur.clip.muted) {
        snapshot();
        (a.all ? state.clips : [cur.clip]).forEach((c) => (c.muted = false));
        return 'Original audio restored';
      }
      pickFile('fileAudio');
      return 'Choose an audio file…';
    },
    crop(a) {
      const cur = needClip(a); if (!cur) return false;
      const [w, h] = srcSize(media[cur.clip.media]);
      snapshot();
      const ar = w / h || 1;
      if (a.shape === 'reset') cur.clip.crop = null;
      else if (a.shape === 'left') cur.clip.crop = { x: 0, y: 0, w: 0.5, h: 1 };
      else if (a.shape === 'right') cur.clip.crop = { x: 0.5, y: 0, w: 0.5, h: 1 };
      else cur.clip.crop = CROPS[a.shape](ar);
      return 'Crop: ' + a.shape;
    },
    volume(a) {
      const cur = needClip(a); if (!cur) return false;
      if (media[cur.clip.media].kind !== 'video') { log('Volume applies to video clips.', 'err'); return false; }
      snapshot();
      const v = a.level != null ? a.level : vol(cur.clip) + (a.dir > 0 ? 0.25 : -0.25);
      cur.clip.vol = Math.max(0, Math.min(2, +v.toFixed(2)));
      if (cur.clip.vol > 0) cur.clip.muted = false;
      return `Volume ${Math.round(cur.clip.vol * 100)}%`;
    },
    speed(a) {
      const cur = needClip(a); if (!cur) return false;
      if (media[cur.clip.media].kind !== 'video') { log('Speed applies to video clips.', 'err'); return false; }
      const c = cur.clip, steps = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
      let r = a.rate;
      if (r == null) r = a.dir > 0 ? steps.find((x) => x > spd(c) + 1e-6) || 4 : [...steps].reverse().find((x) => x < spd(c) - 1e-6) || 0.25;
      r = Math.max(0.25, Math.min(4, r));
      snapshot();
      const old = spd(c), local = Math.max(0, state.t - cur.start);
      c.speed = r;
      state.t = Math.min(cur.start + (local * old) / r, cur.start + clipDur(c));
      return `Speed ${r}×`;
    },
    zoom(a) {
      const cur = needClip(a); if (!cur) return false;
      snapshot();
      const z = cur.clip.zoom * (a.dir > 0 ? 1.25 : 0.8);
      cur.clip.zoom = Math.max(0.5, Math.min(4, +z.toFixed(3)));
      return `Zoom ${cur.clip.zoom.toFixed(2)}×`;
    },
    transition(a) {
      const cur = needClip(a); if (!cur) return false;
      if (cur.index === 0) { log('Transitions apply between clips; move to the 2nd clip or later.', 'err'); return false; }
      snapshot(); cur.clip.trans = a.name; prepareFrames(); return 'Transition: ' + a.name;
    },
    animation(a) {
      const cur = needClip(a); if (!cur) return false;
      snapshot(); cur.clip.anim = a.name === 'wipe' ? 'fade' : a.name; return 'Animation: ' + cur.clip.anim;
    },
    format(a) { snapshot(); setFormat(a.format); return 'Layout: ' + a.format; },
    caption(a) {
      const cur = needClip(a); if (!cur) return false;
      snapshot(); cur.clip.caption = a.text || '';
      return a.text ? 'Caption set' : 'Caption removed';
    },
    async autoCaption(a) {
      const cur = needClip(a); if (!cur) return false;
      if (!aiAvailable) { log('Auto-captions need the server with OPENAI_API_KEY.', 'err'); return false; }
      const c = cur.clip, m = media[c.media];
      if (m.kind !== 'video') { log('Auto-captions need a video clip.', 'err'); return false; }
      log('Transcribing audio…');
      const wav = await clipToWav(m, c.in, c.out);
      const r = await fetch('/api/captions?lang=' + lang.slice(0, 2), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.status);
      if (!data.cues.length) { log('No speech found in this clip.', 'err'); return false; }
      snapshot();
      c.cues = data.cues.map((q) => ({ s: c.in + q.s, e: c.in + q.e, text: q.text }));
      return `Added ${c.cues.length} captions`;
    },
    trim(a) {
      const cur = needClip(a); if (!cur) return false;
      const c = cur.clip, d = clipDur(c), k = spd(c);
      let from = 0, to = d;
      if (a.from != null && a.to != null) { from = Math.min(a.from, a.to); to = Math.max(a.from, a.to); }
      else if (a.cutStart != null) from = a.cutStart;
      else if (a.cutEnd != null) to = d - a.cutEnd;
      from = Math.max(0, from); to = Math.min(d, to);
      if (to - from < 0.2) { log('Trim range is outside this clip (0–' + d.toFixed(1) + 's).', 'err'); return false; }
      snapshot();
      const base = c.in;
      c.in = base + from * k; c.out = base + to * k;
      state.t = Math.min(state.t, cur.start + clipDur(c));
      return `Trimmed to ${from.toFixed(1)}–${to.toFixed(1)}s of clip`;
    },
    import() { pickFile('fileMedia'); return 'Choose files to import…'; },
    deleteClip(a) {
      const cur = needClip(a); if (!cur) return false;
      snapshot(); state.clips.splice(cur.index, 1);
      state.t = Math.min(state.t, total()); return 'Clip deleted';
    },
    undo() {
      if (!history.length) { log('Nothing to undo', 'err'); return false; }
      const t = state.t; state = JSON.parse(history.pop()); state.t = Math.min(t, total()); setFormat(state.format);
      return 'Undone';
    },
    play() { setPlaying(true); return 'Playing'; },
    pause() { setPlaying(false); return 'Paused'; },
    seek(a) {
      if (a.to == null) {
        const c = needClip(a); if (!c) return false;
        state.t = c.start; return `Clip ${c.index + 1}`;
      }
      state.t = Math.max(0, Math.min(total(), a.to));
      return `Moved to ${state.t.toFixed(1)}s`;
    },
    export() { startExport(); return 'Exporting…'; },
  };

  function pickFile(id) {
    // Browsers only allow file pickers from a user gesture; voice usually can't open them directly.
    const btn = id === 'fileAudio' ? $('btnAudio') : $('btnImport');
    try { $(id).click(); } catch (_) {}
    btn.classList.add('primary');
    setTimeout(() => btn.classList.remove('primary'), 4000);
    log(`If no dialog opened, click "${btn.textContent.trim()}" (browsers require a click).`);
  }

  async function run(text, spoken = false) {
    log((spoken ? '🎤 ' : '⌨ ') + text, 'heard');
    let cmd = window.parseCommand(text);
    if (!cmd) {
      cmd = await askAI(text);
      if (!cmd) return;
    }
    try {
      if (cmd.target != null && !['split', 'deleteClip', 'seek'].includes(cmd.action)) {
        const tc = resolveClip(cmd.target);
        if (tc) state.t = tc.start;
      }
      const res = await actions[cmd.action](cmd);
      if (res) log('✓ ' + res, 'ok');
    } catch (e) { log('Failed: ' + e.message, 'err'); }
    refresh();
  }

  async function askAI(text) {
    if (!aiAvailable) { log('Not understood (AI fallback is off — start the server with OPENAI_API_KEY).', 'err'); return null; }
    log('🤖 Asking AI…');
    try {
      const r = await fetch('/api/interpret', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.status);
      if (!data.command || !actions[data.command.action]) { log('Not understood', 'err'); return null; }
      return data.command;
    } catch (e) { log('AI unavailable: ' + e.message, 'err'); return null; }
  }
  let aiAvailable = false, mp4Available = false;
  fetch('/api/status').then((r) => r.json()).then((s) => {
    aiAvailable = !!s.ai; mp4Available = !!s.mp4;
    log(aiAvailable ? 'AI fallback and cloud speech are available.' : 'AI is off (set OPENAI_API_KEY and run: node server.js).');
    if (!mp4Available) log('MP4 export is off (needs the server and ffmpeg) — exports will be WebM.');
  }).catch(() => {});

  // ---------- export ----------
  function downloadBlob(blob, ext) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `voicecut-${state.format}.${ext}`; a.click();
  }

  // decodeAudioData can't read audio inside many video files; fall back to server-side extraction.
  async function decodeMedia(ctx, m) {
    try { return await ctx.decodeAudioData((await m.file.arrayBuffer()).slice(0)); } catch (_) {}
    if (!mp4Available) throw new Error(`this browser can't decode the audio of ${m.name}`);
    const r = await fetch('/api/extract-audio', { method: 'POST', body: m.file });
    if (r.status === 204) return null;
    if (!r.ok) throw new Error((await r.json()).error || 'audio extraction failed');
    return ctx.decodeAudioData(await r.arrayBuffer());
  }

  // Mono 16 kHz WAV of [from,to] seconds of a media file (small enough for speech-to-text upload).
  async function clipToWav(m, from, to) {
    const ctx16 = new OfflineAudioContext(1, 1, 16000);
    const buf = await decodeMedia(ctx16, m);
    if (!buf) throw new Error('this clip has no audio');
    const data = buf.getChannelData(0).slice(Math.floor(from * 16000), Math.ceil(to * 16000));
    const out = new DataView(new ArrayBuffer(44 + data.length * 2));
    const w = (o, str) => [...str].forEach((ch, i) => out.setUint8(o + i, ch.charCodeAt(0)));
    w(0, 'RIFF'); out.setUint32(4, 36 + data.length * 2, true); w(8, 'WAVEfmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
    w(36, 'data'); out.setUint32(40, data.length * 2, true);
    data.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true));
    return new Blob([out], { type: 'audio/wav' });
  }

  // Mix every unmuted clip and audio track into one stereo buffer, offline.
  async function mixAudio(T) {
    const SR_OUT = 48000;
    const octx = new OfflineAudioContext(2, Math.ceil(T * SR_OUT), SR_OUT);
    const decoded = {};
    const decode = (m) => (decoded[m.id] ||= decodeMedia(octx, m));
    let any = false;
    const add = (buf, when, offset, dur, rate = 1, gain = 1) => {
      const s = octx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
      const g = octx.createGain(); g.gain.value = gain; s.connect(g); g.connect(octx.destination);
      s.start(when, offset, dur); any = true;
    };
    for (const { clip, start } of layout()) {
      const m = media[clip.media];
      if (m.kind !== 'video' || clip.muted) continue;
      const buf = await decode(m);
      if (buf) add(buf, start, clip.in, clip.out - clip.in, spd(clip), vol(clip));
    }
    for (const a of state.audio) {
      const buf = await decode(media[a.media]);
      if (buf && a.start < T) add(buf, a.start, a.in, Math.min(a.out - a.in, T - a.start));
    }
    return any ? octx.startRendering() : null;
  }

  // Frame-by-frame render with WebCodecs: no need to play in real time.
  async function exportOffline() {
    const W = canvas.width, H = canvas.height, FPS = 30, T = total();
    const vcfg = { codec: 'avc1.640028', width: W, height: H, bitrate: 6e6, framerate: FPS };
    if (!(await VideoEncoder.isConfigSupported(vcfg)).supported) return null;
    setPlaying(false);
    $('btnExport').textContent = 'Preparing audio…';
    const mixed = await mixAudio(T);
    let acodec = null;
    if (mixed) {
      for (const [codec, name] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
        const cfg = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 };
        if ((await AudioEncoder.isConfigSupported(cfg)).supported) { acodec = { cfg, name }; break; }
      }
      if (!acodec) log('Audio encoding unsupported here; exporting without audio.', 'err');
    }
    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H },
      audio: acodec ? { codec: acodec.name, sampleRate: 48000, numberOfChannels: 2 } : undefined,
      fastStart: 'in-memory',
    });
    let encErr = null;
    const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (encErr = e) });
    venc.configure(vcfg);
    offline = true;
    await prepareFrames();
    const stage = document.createElement('canvas'); stage.width = W; stage.height = H;
    const g = stage.getContext('2d');
    const frames = Math.ceil(T * FPS);
    for (let i = 0; i < frames; i++) {
      if (encErr) throw encErr;
      const t = Math.min(i / FPS, T - 1e-3);
      const cur = clipAt(t);
      if (cur && media[cur.clip.media].kind === 'video') await seekEl(media[cur.clip.media].el, cur.clip.in + Math.max(0, t - cur.start) * spd(cur.clip));
      compose(g, t, false);
      const vf = new VideoFrame(stage, { timestamp: Math.round((i * 1e6) / FPS) });
      venc.encode(vf, { keyFrame: i % 60 === 0 });
      vf.close();
      if (venc.encodeQueueSize > 10) await new Promise((r) => setTimeout(r, 5));
      if (i % 10 === 0) { $('btnExport').textContent = `Exporting ${Math.round((i / frames) * 100)}%`; await new Promise((r) => setTimeout(r)); }
    }
    await venc.flush(); venc.close();
    if (encErr) throw encErr;
    if (acodec) {
      const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (encErr = e) });
      aenc.configure(acodec.cfg);
      const L = mixed.getChannelData(0), R = mixed.getChannelData(1), CH = 4800;
      for (let o = 0; o < L.length; o += CH) {
        const n = Math.min(CH, L.length - o);
        const planar = new Float32Array(n * 2);
        planar.set(L.subarray(o, o + n), 0); planar.set(R.subarray(o, o + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((o / 48000) * 1e6), data: planar });
        aenc.encode(ad); ad.close();
      }
      await aenc.flush(); aenc.close();
      if (encErr) throw encErr;
    }
    muxer.finalize();
    offline = false;
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  }
  let recorder, chunks;
  async function startExport() {
    if (!total()) { log('Nothing to export', 'err'); return; }
    if (exporting) return;
    if ($('exportFmt').value === 'mp4' && window.VideoEncoder && window.AudioEncoder && window.Mp4Muxer) {
      exporting = true; $('btnExport').disabled = true;
      try {
        const blob = await exportOffline();
        if (blob) { downloadBlob(blob, 'mp4'); log('✓ Export complete (MP4)', 'ok'); exporting = false; $('btnExport').disabled = false; $('btnExport').textContent = '⬇ Export'; return; }
      } catch (e) { log('Fast export failed (' + e.message + '); using real-time export.', 'err'); }
      offline = false; exporting = false; $('btnExport').disabled = false; $('btnExport').textContent = '⬇ Export';
    }
    ensureAudio();
    const stream = canvas.captureStream(30);
    streamDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6 });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      monitor.gain.value = 1;
      const webm = new Blob(chunks, { type: 'video/webm' });
      const download = downloadBlob;
      try {
        if ($('exportFmt').value === 'mp4' && mp4Available) {
          log('Converting to MP4…');
          const r = await fetch('/api/convert', { method: 'POST', body: webm });
          if (!r.ok) throw new Error((await r.json()).error || r.status);
          download(await r.blob(), 'mp4');
          log('✓ Export complete (MP4)', 'ok');
        } else {
          if ($('exportFmt').value === 'mp4') log('MP4 needs the server with ffmpeg; saving WebM instead.', 'err');
          download(webm, 'webm');
          log('✓ Export complete (WebM)', 'ok');
        }
      } catch (e) { log('MP4 conversion failed (' + e.message + '); saving WebM.', 'err'); download(webm, 'webm'); }
      exporting = false; $('btnExport').disabled = false;
    };
    exporting = true; $('btnExport').disabled = true;
    monitor.gain.value = 0;
    state.t = 0; recorder.start(); setPlaying(true);
  }
  function finishExport() { setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), 300); }

  // ---------- voice ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec, listening = false, lang = 'en-IN';
  const useCloud = () => $('cloudSpeech').checked;

  // Cloud mode: record the mic, cut a phrase on ~1s of silence, transcribe it on the server.
  let micStream, micCtx, phraseTimer;
  async function startCloudVoice() {
    if (!aiAvailable) { log('Cloud speech needs the server with OPENAI_API_KEY.', 'err'); return false; }
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { log('Mic error: ' + e.name, 'err'); return false; }
    micCtx = new AudioContext();
    const analyser = micCtx.createAnalyser(); analyser.fftSize = 1024;
    micCtx.createMediaStreamSource(micStream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let mr = null, parts = [], spoke = false, lastVoice = 0, started = 0;
    const mime = ['audio/webm;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    const level = () => { analyser.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); };
    phraseTimer = setInterval(() => {
      const now = performance.now(), loud = level() > 0.02;
      if (!mr && loud) {
        parts = []; spoke = true; started = now; lastVoice = now;
        mr = new MediaRecorder(micStream, { mimeType: mime });
        mr.ondataavailable = (e) => e.data.size && parts.push(e.data);
        const myParts = parts, rec = mr;
        mr.onstop = () => { if (spoke) sendSpeech(new Blob(myParts, { type: rec.mimeType })); };
        mr.start();
      } else if (mr) {
        if (loud) lastVoice = now;
        if (now - lastVoice > 1000 || now - started > 8000) { const m = mr; mr = null; spoke = true; m.stop(); }
      }
    }, 100);
    return true;
  }
  async function sendSpeech(blob) {
    if (blob.size < 2000) return;
    try {
      const r = await fetch('/api/transcribe?lang=' + lang.slice(0, 2), { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.status);
      if (data.text) run(data.text, true);
    } catch (e) { log('Speech error: ' + e.message, 'err'); }
  }
  function stopCloudVoice() {
    clearInterval(phraseTimer);
    micStream && micStream.getTracks().forEach((t) => t.stop());
    micCtx && micCtx.close();
  }

  async function startVoice() {
    if (useCloud()) {
      if (await startCloudVoice()) { listening = true; updateMic(); }
      return;
    }
    if (!SR) { log('Speech recognition is not supported here. Use Chrome/Edge, tick "Cloud speech", or type commands.', 'err'); return; }
    rec = new SR();
    rec.lang = lang; rec.continuous = true; rec.interimResults = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) run(e.results[i][0].transcript, true);
    };
    rec.onerror = (e) => { if (e.error !== 'no-speech') log('Mic error: ' + e.error, 'err'); if (e.error === 'not-allowed') listening = false; };
    rec.onend = () => { if (listening) try { rec.start(); } catch (_) {} else updateMic(); };
    listening = true; rec.start(); updateMic();
  }
  function stopVoice() { listening = false; rec && rec.stop(); stopCloudVoice(); updateMic(); }
  function updateMic() {
    $('mic').classList.toggle('on', listening);
    $('mic').textContent = listening ? '⏹ Listening… (click to stop)' : '🎤 Start listening';
  }

  // ---------- persistence (IndexedDB) ----------
  const idb = (() => {
    let dbp;
    const open = () => (dbp ||= new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('storage unavailable'));
      const r = indexedDB.open('voicecut', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('files'); r.result.createObjectStore('meta'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = async (store, mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => res(req && req.result);
        t.onerror = t.onabort = () => rej(t.error);
      });
    };
    return {
      put: (store, key, val) => tx(store, 'readwrite', (s) => s.put(val, key)),
      get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
      keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()),
      del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
      clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
    };
  })();
  let saveTimer, saveWarned = false;
  function warnSave(e) {
    if (saveWarned) return;
    saveWarned = true;
    log('Could not save the project for next time: ' + (e && e.message || e), 'err');
  }
  // Never save before restore finishes, or an empty project would overwrite the saved one.
  function scheduleSave() {
    if (!restored) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      idb.put('meta', 'project', { v: 1, uid, state: JSON.parse(JSON.stringify(state)) }).catch(warnSave);
    }, 500);
  }
  async function restoreProject() {
    try {
      const meta = await idb.get('meta', 'project');
      if (meta && meta.state) {
        const s = meta.state;
        const keep = new Set([...s.clips.map((c) => c.media), ...s.audio.map((x) => x.media)]);
        for (const k of await idb.keys('files')) if (!keep.has(k)) idb.del('files', k).catch(() => {});
        for (const id of keep) {
          const f = await idb.get('files', id);
          if (f) await loadMedia(f, id).catch(() => {});
        }
        s.clips = s.clips.filter((c) => media[c.media]);
        s.audio = s.audio.filter((x) => media[x.media]);
        state = s;
        state.t = Math.min(state.t || 0, total());
        uid = Math.max(uid, meta.uid || 1);
        setFormat(state.format || 'reel');
        if (state.clips.length || state.audio.length) log(`Restored your last project (${state.clips.length} clip${state.clips.length === 1 ? '' : 's'}).`, 'ok');
      }
    } catch (e) { log('Could not restore the saved project: ' + e.message, 'err'); }
    restored = true;
    lastSelKey = null;
    refresh();
  }
  async function newProject() {
    if (!confirm('Start a new project? This removes the current clips and the saved copies of your files.')) return;
    setPlaying(false);
    for (const k of Object.keys(media)) { media[k].el.pause && media[k].el.pause(); delete media[k]; }
    for (const k of Object.keys(frameCache)) delete frameCache[k];
    for (const k of Object.keys(scratch)) delete scratch[k];
    state = { format: state.format, clips: [], audio: [], t: 0 };
    history = [];
    try { await idb.clear('files'); } catch (_) {}
    refresh();
    log('New project started.', 'ok');
  }

  // ---------- wiring ----------
  $('cloudSpeech').onchange = () => { if (listening) { stopVoice(); setTimeout(startVoice, 300); } };
  $('mic').onclick = () => (listening ? stopVoice() : startVoice());
  document.querySelectorAll('#lang button').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('#lang button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); lang = b.dataset.lang;
    if (listening) { stopVoice(); setTimeout(startVoice, 300); }
  }));
  $('format').onchange = (e) => { snapshot(); setFormat(e.target.value); };
  $('btnPlay').onclick = () => setPlaying(!playing);
  $('btnImport').onclick = () => $('fileMedia').click();
  $('btnAudio').onclick = () => $('fileAudio').click();
  $('btnExport').onclick = startExport;
  $('btnNew').onclick = newProject;
  $('fileMedia').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
  $('fileAudio').onchange = (e) => { importFiles([...e.target.files], true); e.target.value = ''; };
  $('typed').onsubmit = (e) => { e.preventDefault(); if ($('cmd').value.trim()) run($('cmd').value); $('cmd').value = ''; };
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); importFiles([...e.dataTransfer.files]); });

  setFormat('reel');
  refresh();
  log('Ready. Click "Start listening" and speak, or type a command. Pick English / தமிழ் first.');
  requestAnimationFrame(tick);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  restoreProject();
})();
