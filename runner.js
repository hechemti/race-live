/* Runner page: reads phone GPS, keeps the race state, and publishes updates to ntfy.sh. */
(function () {
  const $ = (id) => document.getElementById(id);
  const H = RL.parseHash();
  const topic = H.topic;
  const SIM = H.sim;
  const SPEED = SIM ? 10 : 1;
  const realT0 = Date.now();
  let simBase = realT0; // simulated clock carries on across reloads
  const now = () => (SIM ? simBase + (Date.now() - realT0) * SPEED : Date.now());

  const MAX_PTS_PER_MSG = 80;
  const MAX_ACC = 50;          // ignore fixes worse than ±50 m
  const DEFAULT_TARGET = 2.5 * 3600;

  /* ---------- page routing ---------- */
  function show(id) {
    for (const v of ['vNoTopic', 'vSetup', 'vLive']) $(v).hidden = v !== id;
  }

  if (!topic) {
    show('vNoTopic');
    $('btnNewTopic').addEventListener('click', () => {
      location.hash = 't=' + RL.newTopic();
      location.reload();
    });
    return;
  }

  const base = location.href.replace(/#.*$/, '').replace(/run\.html.*$/, '');
  const friendsLink = base + '#t=' + topic;
  $('shareLink1').textContent = friendsLink;
  $('shareLink2').textContent = friendsLink;
  document.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', async () => {
      const text = $(b.dataset.copy).textContent;
      try { await navigator.clipboard.writeText(text); flash(b, 'Copied!'); }
      catch (e) {
        const r = document.createRange(); r.selectNodeContents($(b.dataset.copy));
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        flash(b, 'Selected, now copy it');
      }
    });
  });
  function flash(b, t) { const o = b.textContent; b.textContent = t; setTimeout(() => (b.textContent = o), 1800); }

  /* ---------- persistent state ---------- */
  const KEY = 'rl-runner-' + topic + (SIM ? '-sim' : '');
  function fresh(prev) {
    return {
      rid: RL.randomId(10), name: prev ? prev.name : '', race: prev ? prev.race : 'Half Marathon', km: prev ? prev.km : RL.HALF_KM,
      tg: prev ? prev.tg : 0, g: prev ? prev.g : '', voice: prev ? prev.voice : true, kmVoice: prev ? prev.kmVoice : true,
      status: 'setup', st: 0, ft: 0, dist: 0, track: [], splits: [],
      seq: 0, sentIdx: 0, sentCount: 0, readySent: false, finSent: false,
    };
  }
  let S;
  try { S = JSON.parse(localStorage.getItem(KEY)); } catch (e) { S = null; }
  if (!S || !S.rid) S = fresh();
  if (SIM && S.simNow) simBase = S.simNow;
  let saveT = 0;
  function save(force) {
    const t = Date.now();
    if (!force && t - saveT < 2000) { clearTimeout(save._p); save._p = setTimeout(() => save(true), 2100); return; }
    saveT = t;
    if (SIM) S.simNow = now();
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* storage full or blocked */ }
  }

  /* ---------- live (non-persisted) state ---------- */
  let cur = null;           // latest fix {lat, lon, acc, t}
  let lastFixAt = 0;
  let gpsErr = null;
  let watchId = null;
  let rejectStreak = 0;
  let lastSentAt = 0;
  let retryAt = 0;
  let inflight = false;
  let lastErr = null;
  let limitHit = false;
  let iv = 45;
  let budget = { remaining: null, at: 0, sinceFetch: 0 };
  let wake = null;
  let battery = null;
  let finishArmed = 0;

  /* ---------- GPS ---------- */
  function startGPS() {
    if (SIM) return startSimGPS();
    if (!('geolocation' in navigator)) { gpsErr = 'This browser has no GPS access.'; render(); return; }
    stopGPS();
    watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    gpsStartedAt = Date.now();
  }
  let gpsStartedAt = 0;
  function stopGPS() {
    if (watchId != null && !SIM) navigator.geolocation.clearWatch(watchId);
    if (SIM && simTimer) { clearInterval(simTimer); simTimer = null; }
    watchId = null;
  }
  function onPosErr(e) {
    if (e.code === 1) gpsErr = 'Location is blocked. Allow location for this site in your browser settings, then reload.';
    else if (e.code === 2) gpsErr = 'Position unavailable. Move to open sky.';
    else gpsErr = null; // timeouts are normal while searching
    render();
  }
  function onPos(pos) {
    const c = pos.coords;
    cur = { lat: c.latitude, lon: c.longitude, acc: c.accuracy || 999, t: SIM ? pos.timestamp : Date.now() };
    lastFixAt = Date.now();
    gpsErr = null;
    if (S.status === 'running') addPoint(cur);
    if (S.status === 'ready' && !S.readySent && cur.acc <= 100) maybeSend(true);
    renderSoon();
  }

  // Watchdog: some phones silently stop delivering positions; restart the watch.
  setInterval(() => {
    if (!(S.status === 'running' || S.status === 'ready')) return;
    if (watchId == null && !SIM) { startGPS(); return; }
    if (Date.now() - Math.max(lastFixAt, gpsStartedAt) > 30000) startGPS();
  }, 5000);

  /* ---------- simulated GPS (#sim) ---------- */
  let simTimer = null, simS = 0, simLast = 0;
  const course = SIM ? RL.makeCourse() : null;
  function startSimGPS() {
    if (simTimer) return;
    if (!simS && S.status === 'running') simS = S.dist;
    watchId = 'sim';
    simLast = now();
    simTimer = setInterval(() => {
      const t = now();
      if (S.status === 'running') simS += ((t - simLast) / 1000) / (RL.simPace(simS) + (Math.random() - 0.5) * 12) * 1000;
      simLast = t;
      const ll = course.at(simS);
      const j = () => (Math.random() - 0.5) * 0.00003;
      onPos({ coords: { latitude: ll[0] + j(), longitude: ll[1] + j(), accuracy: 4 + Math.random() * 8 }, timestamp: t });
    }, 1000 / SPEED);
  }

  /* ---------- track + distance ---------- */
  function addPoint(c) {
    if (c.acc > MAX_ACC) return;
    const ts = Math.max(0, Math.round((c.t - S.st) / 100) / 10);
    const pt = [RL.r5(c.lat), RL.r5(c.lon), ts, Math.round(c.acc)];
    const last = S.track[S.track.length - 1];
    if (!last) { S.track.push(pt); save(); return; }
    const d = RL.hav(last, pt);
    const dt = Math.max(1, ts - last[2]);
    const thr = Math.min(25, Math.max(8, c.acc * 0.75));
    if (d < thr) { rejectStreak = 0; return; }               // GPS jitter while slow/standing
    const vmax = dt > 60 ? 7 : 9;                             // m/s; 9 m/s is a 1:51/km sprint
    if (d / dt > vmax) {
      // Probably a GPS jump. If it persists, the old anchor was the bad one: re-anchor without adding distance.
      if (++rejectStreak >= 6) { pt[4] = 1; S.track.push(pt); rejectStreak = 0; save(); }
      return;
    }
    rejectStreak = 0;
    const prevDist = S.dist;
    S.dist += d;
    S.track.push(pt);
    while (S.dist >= (S.splits.length + 1) * 1000) {
      const k = S.splits.length + 1;
      const f = (k * 1000 - prevDist) / d;
      const crossTs = last[2] + f * (ts - last[2]);
      const before = S.splits.reduce((a, b) => a + b, 0);
      const split = Math.round((crossTs - before) * 10) / 10;
      S.splits.push(split);
      announceKm(k, split, crossTs);
    }
    save();
  }

  function elapsed() {
    if (S.status === 'running') return Math.max(0, (now() - S.st) / 1000);
    if (S.status === 'finished') return Math.max(0, (S.ft - S.st) / 1000);
    return 0;
  }

  function paceNow() {
    const tr = S.track;
    if (tr.length < 2) return null;
    const last = tr[tr.length - 1];
    if (elapsed() - last[2] > 40) return null; // no movement recently
    let i = tr.length - 1, d = 0;
    while (i > 0 && last[2] - tr[i - 1][2] <= 90) { if (!tr[i][4]) d += RL.hav(tr[i - 1], tr[i]); i--; }
    const span = last[2] - tr[i][2];
    if (span < 20 || d < 40) return null;
    const p = span / (d / 1000);
    return p > 150 && p < 1800 ? Math.round(p) : null;
  }

  function avgPace() { return S.dist >= 300 ? elapsed() / (S.dist / 1000) : null; }

  /* ---------- voice ---------- */
  const synth = window.speechSynthesis;
  function say(text) {
    if (!synth || !S.voice) return;
    try { const u = new SpeechSynthesisUtterance(text); u.rate = 1.02; synth.speak(u); } catch (e) { /* ignore */ }
  }
  function spokenDur(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const parts = [];
    if (h) parts.push(h + (h === 1 ? ' hour' : ' hours'));
    if (m) parts.push(m + (m === 1 ? ' minute' : ' minutes'));
    if (s && !h) parts.push(s + ' seconds');
    return parts.join(' ') || '0 seconds';
  }
  function announceKm(k, split, total) {
    if (!S.kmVoice) return;
    say(`Kilometre ${k}. Split ${spokenDur(split)}. Total time ${spokenDur(total)}.`);
  }

  /* ---------- wake lock + battery ---------- */
  async function keepAwake() {
    if (!('wakeLock' in navigator) || wake || document.visibilityState !== 'visible') { render(); return; }
    try {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; render(); });
    } catch (e) { wake = null; }
    render();
  }
  if (navigator.getBattery) navigator.getBattery().then((b) => { battery = b; }).catch(() => {});

  /* ---------- sharing (ntfy.sh) ---------- */
  async function refreshBudget() {
    if (SIM) return;
    try {
      const r = await fetch(RL.NTFY + '/v1/account', { cache: 'no-store' });
      const j = await r.json();
      if (j && j.stats && typeof j.stats.messages_remaining === 'number') budget = { remaining: j.stats.messages_remaining, at: Date.now(), sinceFetch: 0 };
    } catch (e) { /* keep estimate */ }
  }
  function remainingMsgs() {
    if (budget.remaining == null) return Math.max(10, 240 - S.sentCount);
    return Math.max(0, budget.remaining - budget.sinceFetch);
  }
  // ntfy.sh allows 250 messages a day per network address. Spread them over the expected race time.
  function computeInterval() {
    if (SIM) return 6;
    const target = S.tg || DEFAULT_TARGET;
    const left = Math.max(target - elapsed(), 25 * 60) + 25 * 60;
    const usable = Math.max(1, remainingMsgs() - 10);
    return Math.round(Math.min(180, Math.max(20, left / usable)));
  }

  function thin(pts, max) {
    max = max || MAX_PTS_PER_MSG;
    if (pts.length <= max) return pts;
    const out = [], step = pts.length / (max - 1);
    for (let i = 0; i < max - 1; i++) out.push(pts[Math.floor(i * step)]);
    out.push(pts[pts.length - 1]);
    return out;
  }

  function buildPayload(kind) {
    const endIdx = S.track.length;
    const pts = thin(S.track.slice(S.sentIdx, endIdx)).map((p) => (p[4] ? [p[0], p[1], Math.round(p[2]), p[3], 1] : [p[0], p[1], Math.round(p[2]), p[3]]));
    const p = {
      v: 1, k: kind, rid: S.rid, seq: S.seq,
      n: (S.name || 'Runner').slice(0, 40), r: (S.race || 'Half Marathon').slice(0, 60), km: S.km, tg: S.tg || 0, g: S.g || '',
      el: Math.round(elapsed()), dist: Math.round(S.dist), pc: S.status === 'running' ? paceNow() : null,
      sp: S.splits.map((x) => Math.round(x)),
      cur: cur ? [RL.r5(cur.lat), RL.r5(cur.lon), Math.round(cur.acc), Math.round((Date.now() - lastFixAt) / 1000)] : null,
      p: pts, iv,
    };
    if (battery) { p.b = Math.round(battery.level * 100); p.c = battery.charging ? 1 : 0; }
    if (SIM) p.sim = 1;
    // ntfy turns messages over 4 KB into attachments; stay well under that.
    while (JSON.stringify(p).length > 3600 && p.p.length > 4) p.p = thin(p.p, Math.floor(p.p.length / 2));
    return { p, endIdx };
  }

  async function maybeSend(force) {
    if (inflight) return;
    let kind = null;
    const t = Date.now();
    if (S.status === 'ready' && !S.readySent) {
      if (!cur && t - gpsStartedAt < 20000) return; // wait briefly for a first position
      kind = 's';
    }
    else if (S.status === 'running') {
      iv = computeInterval();
      if (force || t - lastSentAt >= iv * 1000) kind = 'u';
    } else if (S.status === 'finished' && !S.finSent) kind = 'f';
    if (!kind) return;
    if (!force && t < retryAt) return;
    if (kind !== 'u' && t < retryAt) return;

    const { p, endIdx } = buildPayload(kind);
    inflight = true;
    try {
      await RL.publish(topic, p);
      S.sentIdx = endIdx;
      S.seq += 1;
      S.sentCount += 1;
      budget.sinceFetch += 1;
      if (kind === 's') S.readySent = true;
      if (kind === 'f') S.finSent = true;
      lastSentAt = Date.now();
      lastErr = null; limitHit = false; retryAt = 0;
      save(true);
    } catch (e) {
      lastErr = e;
      if (e.status === 429) { limitHit = true; retryAt = Date.now() + 120000; }
      else retryAt = Date.now() + 10000;
    } finally {
      inflight = false;
      render();
    }
  }
  setInterval(() => maybeSend(false), 1000);
  window.addEventListener('online', () => { retryAt = 0; maybeSend(true); });

  /* ---------- cheers from friends ---------- */
  let toastT = null;
  function showCheer(from, msg) {
    $('toastFrom').textContent = from;
    $('toastMsg').textContent = msg;
    $('toast').hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => ($('toast').hidden = true), 9000);
    if (S.voice) say(`Cheer from ${from}: ${msg.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}️]/gu, '')}`);
  }
  let cheersOn = false;
  function listenCheers() {
    if (cheersOn) return;
    cheersOn = true;
    const seen = new Set();
    const handle = (m) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      try {
        const c = JSON.parse(m.message);
        if (c && typeof c.msg === 'string') showCheer(String(c.from || 'A friend').slice(0, 30), c.msg.slice(0, 140));
      } catch (e) { /* ignore */ }
    };
    let close = RL.subscribe(topic + '-c', undefined, handle);
    // Safety net poll for anything the stream missed in the last minute.
    let lastPoll = Math.floor(Date.now() / 1000);
    setInterval(async () => {
      try {
        const since = lastPoll - 5;
        lastPoll = Math.floor(Date.now() / 1000);
        const ms = await RL.poll(topic + '-c', String(since));
        ms.forEach(handle);
      } catch (e) { /* ignore */ }
    }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { close(); close = RL.subscribe(topic + '-c', undefined, handle); }
    });
  }

  /* ---------- setup form ---------- */
  function parseTarget(v) {
    const m = String(v || '').trim().match(/^(\d{1,2})[:.](\d{2})$/);
    if (!m) return 0;
    return (+m[1]) * 3600 + (+m[2]) * 60;
  }
  function fmtTarget(sec) { if (!sec) return ''; const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return `${h}:${String(m).padStart(2, '0')}`; }

  function fillForm() {
    $('fName').value = S.name || '';
    $('fRace').value = S.race || 'Half Marathon';
    $('fKm').value = String(S.km || RL.HALF_KM);
    if (!$('fKm').value) $('fKm').value = String(RL.HALF_KM);
    $('fTarget').value = fmtTarget(S.tg);
    $('fGmaps').value = S.g || '';
    $('fVoice').checked = S.voice !== false;
    $('fKmVoice').checked = S.kmVoice !== false;
  }
  function readForm() {
    S.name = $('fName').value.trim().slice(0, 40);
    S.race = $('fRace').value.trim().slice(0, 60) || 'Half Marathon';
    S.km = parseFloat($('fKm').value) || RL.HALF_KM;
    S.tg = parseTarget($('fTarget').value);
    const g = $('fGmaps').value.trim();
    S.g = /^https:\/\/\S+$/.test(g) ? g.slice(0, 200) : '';
    S.voice = $('fVoice').checked;
    S.kmVoice = $('fKmVoice').checked;
    save(true);
  }
  ['fName', 'fRace', 'fKm', 'fTarget', 'fGmaps', 'fVoice', 'fKmVoice'].forEach((id) => $(id).addEventListener('change', () => { if (S.status === 'setup' || S.status === 'ready') readForm(); }));

  $('btnReady').addEventListener('click', () => {
    readForm();
    if (S.status === 'setup') { S.status = 'ready'; S.readySent = false; save(true); }
    startGPS();
    keepAwake();
    listenCheers();
    refreshBudget();
    if (synth) { try { synth.speak(new SpeechSynthesisUtterance('')); } catch (e) { /* unlock audio on iOS */ } }
    render();
  });

  $('btnStart').addEventListener('click', () => {
    readForm();
    S.status = 'running';
    S.st = now();
    S.dist = 0; S.track = []; S.splits = []; S.sentIdx = 0; S.finSent = false;
    if (cur && Date.now() - lastFixAt < 15000) addPoint({ ...cur, t: S.st });
    save(true);
    startGPS();
    keepAwake();
    listenCheers();
    refreshBudget();
    say('Race started. Have a great run!');
    lastSentAt = 0;
    maybeSend(true);
    render();
  });

  /* ---------- live controls ---------- */
  $('btnSendNow').addEventListener('click', () => { retryAt = 0; maybeSend(true); });
  $('btnVoice').addEventListener('click', () => {
    S.voice = !S.voice; S.kmVoice = S.voice; save(true);
    if (S.voice) say('Voice on.'); else if (synth) synth.cancel();
    render();
  });
  $('btnFinish').addEventListener('click', () => {
    const b = $('btnFinish');
    if (Date.now() - finishArmed > 4000) {
      finishArmed = Date.now();
      b.classList.add('armed'); b.textContent = 'Tap again to stop the clock';
      setTimeout(() => { if (Date.now() - finishArmed >= 4000) { b.classList.remove('armed'); b.textContent = 'Finish race'; } }, 4100);
      return;
    }
    finishArmed = 0;
    if (cur && Date.now() - lastFixAt < 15000) addPoint(cur);
    S.status = 'finished';
    S.ft = now();
    S.finSent = false;
    save(true);
    retryAt = 0;
    maybeSend(true);
    say(`Finished! Your time is ${spokenDur((S.ft - S.st) / 1000)}. Well done!`);
    stopGPS();
    if (wake) { try { wake.release(); } catch (e) { /* ignore */ } }
    render();
  });
  let newArmed = 0;
  $('btnNewRace').addEventListener('click', () => {
    const b = $('btnNewRace');
    if (Date.now() - newArmed > 4000) { newArmed = Date.now(); b.textContent = 'Tap again: this clears the finished race on this phone'; setTimeout(() => (b.textContent = 'Set up a new race'), 4100); return; }
    S = fresh(S); save(true);
    fillForm();
    render();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (S.status === 'running' || S.status === 'ready') {
      keepAwake();
      if (Date.now() - lastFixAt > 10000) startGPS();
      if (S.status === 'running' && Date.now() - lastSentAt > 15000) { retryAt = 0; maybeSend(true); }
    }
  });

  /* ---------- rendering ---------- */
  let renderQueued = false;
  function renderSoon() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); } }

  function setPill(el, cls, text) { el.className = 'pill ' + cls; el.querySelector('span').textContent = text; }

  function gpsState() {
    if (gpsErr) return ['bad', 'GPS problem'];
    if (watchId == null) return ['', 'GPS off'];
    if (!cur || Date.now() - lastFixAt > 20000) return ['warn', 'Searching GPS…'];
    const a = Math.round(cur.acc);
    return a <= 15 ? ['good', `GPS ±${a} m`] : a <= MAX_ACC ? ['warn', `GPS ±${a} m`] : ['bad', `GPS weak ±${a} m`];
  }

  function render() {
    if (S.status === 'setup' || S.status === 'ready') {
      show('vSetup');
      $('simNote').hidden = !SIM;
      const [gc, gt] = gpsState();
      setPill($('gpsPillSetup'), gc, gt);
      if (S.readySent) setPill($('netPillSetup'), 'good', 'Friends see you at the start');
      else if (S.status === 'ready') setPill($('netPillSetup'), lastErr ? 'bad' : 'warn', lastErr ? 'Can\'t reach server' : 'Waiting for GPS fix…');
      else setPill($('netPillSetup'), '', 'Not shared yet');
      $('gpsHelp').textContent = gpsErr || (S.status === 'ready' ? 'GPS is on. Keep this screen open. Tap Start race when the gun goes.' : 'Tap below so the phone can find your position. Do this a few minutes before the start, outdoors.');
      $('btnReady').hidden = S.status === 'ready' && watchId != null;
      return;
    }

    show('vLive');
    const running = S.status === 'running';
    $('liveCtl').hidden = !running;
    $('doneCtl').hidden = running;

    const el = elapsed();
    $('vDist').textContent = RL.fmtKm(S.dist);
    $('distLbl').textContent = running ? `Distance · ${RL.fmtKm(Math.max(0, S.km * 1000 - S.dist))} km to go` : 'Distance';
    $('vClock').textContent = RL.fmtDur(el);
    $('vPace').textContent = running ? RL.fmtPace(paceNow()) : '–';
    const ap = avgPace();
    $('vAvg').textContent = ap ? RL.fmtPace(ap) : '–';
    if (S.splits.length) { $('vLastLbl').textContent = `Km ${S.splits.length}`; $('vLast').textContent = RL.fmtPace(S.splits[S.splits.length - 1]); }
    else { $('vLastLbl').textContent = 'Last km'; $('vLast').textContent = '–'; }
    if (running) { $('vProjLbl').textContent = 'Projected'; $('vProj').textContent = ap && S.dist > 400 ? RL.fmtDur(ap * S.km) : '–'; }
    else { $('vProjLbl').textContent = 'Final time'; $('vProj').textContent = RL.fmtDur(el); }

    // pills
    const [gc, gt] = running ? gpsState() : ['', 'GPS off'];
    setPill($('gpsPill'), gc, gt);
    if (running) setPill($('wakePill'), wake ? 'good' : 'warn', wake ? 'Screen stays on' : 'Screen may sleep');
    else setPill($('wakePill'), '', 'Done');
    const since = lastSentAt ? (Date.now() - lastSentAt) / 1000 : null;
    if (limitHit) setPill($('netPill'), 'bad', 'Daily limit hit');
    else if (lastErr) setPill($('netPill'), 'bad', 'Offline, retrying');
    else if (!running) setPill($('netPill'), S.finSent ? 'good' : 'warn', S.finSent ? 'Friends notified' : 'Sending finish…');
    else if (since != null && since < iv + 30) setPill($('netPill'), 'live', 'Sharing live');
    else setPill($('netPill'), 'warn', 'Connecting…');

    if (running) {
      const left = Math.max(0, Math.round(iv - (since || 0)));
      $('vSendInfo').textContent = (since != null ? `Last update sent ${RL.fmtAgo(since)} · next in ${left} s` : 'Sending first update…') + (budget.remaining != null ? ` · ${remainingMsgs()} updates left today` : '');
    } else {
      $('vSendInfo').textContent = '';
      $('doneInfo').textContent = `${RL.fmtKm(S.dist)} km in ${RL.fmtDur(el)}${ap ? `, average ${RL.fmtPace(ap)} /km` : ''}. ${S.finSent ? 'Your friends can see your finish time.' : 'Sending your finish to your friends…'}`;
    }

    // alert banner
    const al = $('liveAlert');
    let msg = '';
    let bad = false;
    if (running) {
      if (gpsErr) { msg = gpsErr; bad = true; }
      else if (limitHit) { msg = 'The free relay\'s daily limit was reached for this network. Retrying every 2 minutes; your friends see your last position. Your backup live link (if you added one) still works.'; bad = true; }
      else if (S.dist >= S.km * 1000) msg = `You've passed ${Math.round(S.km * 10) / 10} km on GPS. Tap Finish race when you cross the line.`;
      else if (!wake && 'wakeLock' in navigator) msg = 'Keep the screen on: tap here so the phone doesn\'t lock and stop GPS.';
    }
    al.hidden = !msg;
    al.className = 'alert' + (bad ? ' bad' : '');
    al.textContent = msg;
    $('btnVoice').textContent = S.voice ? 'Voice on' : 'Voice off';
  }
  $('liveAlert').addEventListener('click', () => keepAwake());

  /* ---------- boot ---------- */
  fillForm();
  if (S.status === 'running') {
    // Resumed after a reload: keep going from saved state.
    startGPS(); keepAwake(); listenCheers(); refreshBudget();
  } else if (S.status === 'ready') {
    startGPS(); keepAwake(); listenCheers();
  }
  setInterval(() => { if (budget.at && Date.now() - budget.at > 10 * 60000) refreshBudget(); }, 60000);
  setInterval(render, 1000);
  render();
})();
