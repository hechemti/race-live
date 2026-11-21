/* Spectator page: reads the runner's updates from ntfy.sh and renders them. */
(function () {
  const $ = (id) => document.getElementById(id);
  const H = RL.parseHash();
  const DEMO = H.demo && !H.topic;
  const topic = H.topic;
  const cheerTopic = topic ? topic + '-c' : null;
  const STALE_SEC = 180;

  const st = {
    seen: new Set(),
    payloads: [],
    lastId: null,
    lastTime: 0,
    run: null,          // derived view of the current race
    cheers: [],
    cheerSeen: new Set(),
    loaded: false,
    netOk: true,
  };

  /* ---------- data in ---------- */
  st.ot = []; // OwnTracks background locations

  function ingest(m) {
    if (!m || st.seen.has(m.id)) return false;
    st.seen.add(m.id);
    if (m.time >= st.lastTime) { st.lastTime = m.time; st.lastId = m.id; }
    let p;
    try { p = JSON.parse(m.message); } catch (e) { return false; }
    if (!p || typeof p !== 'object') return false;
    if (p._type === 'location') {
      // Sent by the OwnTracks app, which keeps running while the phone is locked.
      const lat = +p.lat, lon = +p.lon, tst = +p.tst;
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(tst) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return false;
      st.ot.push({ lat, lon, tst: Math.min(tst, m.time + 120), acc: isFinite(+p.acc) && +p.acc > 0 ? +p.acc : 30,
        batt: typeof p.batt === 'number' ? p.batt : null, bs: p.bs, _time: m.time });
      return true;
    }
    if (p.v !== 1 || typeof p.rid !== 'string') return false;
    p._time = m.time;
    st.payloads.push(p);
    return true;
  }

  /* First point of the most recent unbroken stretch of OwnTracks points after `after`. */
  function otSessionStart(sorted, after) {
    const pts = sorted.filter((o) => o.tst >= after);
    if (!pts.length) return null;
    let i = pts.length - 1;
    while (i > 0 && pts[i].tst - pts[i - 1].tst < 30 * 60) i--;
    // Only count it as a race if the phone is actually moving (ignores a one-off test send).
    let d = 0;
    for (let k = i + 1; k < pts.length; k++) d += RL.hav([pts[k - 1].lat, pts[k - 1].lon], [pts[k].lat, pts[k].lon]);
    if (pts.length - i < 4 || d < 300) return null;
    return pts[i].tst;
  }

  function rebuild() {
    const otSorted = st.ot.slice().sort((a, b) => a.tst - b.tst);
    const lastOtAll = otSorted[otSorted.length - 1] || null;
    let latest = null, raw = [], startedAt = null, finAt = null;

    if (st.payloads.length) {
      // The current race is the one with the most recent message from the runner page.
      let newest = st.payloads[0];
      for (const p of st.payloads) if (p._time > newest._time) newest = p;
      const ps = st.payloads.filter((p) => p.rid === newest.rid);
      // One payload per sequence number; a retried send carries a superset of points.
      const bySeq = new Map();
      for (const p of ps) {
        const prev = bySeq.get(p.seq);
        const n = (p.p || []).length, pn = prev ? (prev.p || []).length : -1;
        if (!prev || n > pn || (n === pn && p._time > prev._time)) bySeq.set(p.seq, p);
      }
      for (const sq of [...bySeq.keys()].sort((a, b) => a - b)) {
        const p = bySeq.get(sq);
        if (!latest || sq > latest.seq || (sq === latest.seq && p._time >= latest._time)) latest = p;
        for (const pt of p.p || []) if (Array.isArray(pt) && pt.length >= 3) raw.push(pt);
      }
      const fin = ps.find((p) => p.k === 'f');
      if (fin && latest.k !== 'f') latest = fin;
      const started = ps.filter((p) => p.k !== 's' && typeof p.el === 'number');
      if (started.length) startedAt = Math.min(...started.map((p) => p._time - p.el));
      if (latest.k === 'f' && startedAt != null) finAt = startedAt + latest.el;
    }

    // OwnTracks is running but Start was never tapped on the runner page: start from OwnTracks.
    if (startedAt == null && lastOtAll && nowSec() - lastOtAll._time < 3 * 3600) {
      const after = latest && latest.k === 's' ? latest._time - 600 : 0;
      const s0 = otSessionStart(otSorted, after);
      if (s0 != null) {
        startedAt = s0;
        latest = Object.assign({ v: 1, rid: 'ot', seq: 0, n: '', r: 'Half Marathon', km: RL.HALF_KM }, latest || {},
          { k: 'u', el: 0, dist: 0, p: [], sp: [], pc: null, cur: null, iv: 0, _time: latest ? latest._time : s0 });
        raw = [];
      }
    }
    if (!latest) { st.run = null; return; }

    // OwnTracks points that belong to this race
    const otPts = [];
    let lastOt = null;
    if (startedAt != null) {
      for (const o of otSorted) {
        if (o.tst < startedAt - 2 || o.tst > startedAt + 8 * 3600) continue;
        if (finAt != null && o.tst > finAt + 5) continue;
        otPts.push([o.lat, o.lon, Math.max(0, Math.round(o.tst - startedAt)), Math.round(o.acc)]);
        if (!lastOt || o.tst >= lastOt.tst) lastOt = o;
      }
    }
    const hasOt = otPts.length > 0;

    // Merge both sources in time order and drop GPS glitches.
    const merged = raw.concat(otPts).sort((a, b) => a[2] - b[2]);
    const track = [], cum = [];
    let streak = 0;
    for (const pt of merged) {
      if (pt[3] != null && pt[3] > 60) continue;
      const last = track[track.length - 1];
      if (!last) { track.push(pt); cum.push(0); continue; }
      if (last[2] === pt[2] && last[0] === pt[0] && last[1] === pt[1]) continue;
      if (pt[4]) { track.push(pt); cum.push(cum[cum.length - 1]); streak = 0; continue; }
      const d = RL.hav(last, pt), dt = Math.max(1, pt[2] - last[2]);
      if (d < 4) continue;
      if (d / dt > (dt > 60 ? 7 : 9)) {
        if (++streak >= 3) { track.push([pt[0], pt[1], pt[2], pt[3], 1]); cum.push(cum[cum.length - 1]); streak = 0; }
        continue;
      }
      streak = 0;
      track.push(pt);
      cum.push(cum[cum.length - 1] + d);
    }
    const cumLast = cum.length ? cum[cum.length - 1] : 0;
    const lastTs = track.length ? track[track.length - 1][2] : 0;

    // km splits from the merged track
    const splits = [];
    let next = 1000, prevT = 0;
    for (let i = 1; i < track.length; i++) {
      while (cum[i] >= next) {
        const seg = cum[i] - cum[i - 1] || 1, f = (next - cum[i - 1]) / seg;
        const t = track[i - 1][2] + f * (track[i][2] - track[i - 1][2]);
        splits.push(t - prevT); prevT = t; next += 1000;
      }
    }

    // Use whichever source has the fresher fix for each figure.
    const runnerFixAt = Array.isArray(latest.cur) ? latest._time - (latest.cur[3] || 0) : -1;
    const otNewer = hasOt && lastOt.tst >= runnerFixAt - 5;
    let pc = latest.pc || null;
    if (hasOt && (otNewer || !pc)) {
      pc = null;
      let j = track.length - 1;
      while (j > 0 && lastTs - track[j - 1][2] <= 100) j--;
      if (j > 0 && lastTs - track[j][2] < 40) j--;
      const span = lastTs - (track[j] ? track[j][2] : lastTs), dd = cumLast - (cum[j] || 0);
      if (span >= 40 && span <= 400 && dd > 50 && nowSec() - lastOt._time < 150) {
        const p = span / (dd / 1000);
        if (p > 150 && p < 1800) pc = Math.round(p);
      }
    }

    const firstMsg = st.payloads.length ? st.payloads.reduce((a, b) => (a._time < b._time ? a : b)) : latest;
    st.run = {
      latest, track, cum, startedAt, finAt, hasOt,
      dist: hasOt ? Math.max(cumLast, latest.dist || 0) : (latest.dist || 0),
      splits: hasOt ? splits : (Array.isArray(latest.sp) ? latest.sp : []),
      dataEl: hasOt && cumLast >= (latest.dist || 0) ? lastTs : (latest.k === 's' ? 0 : (latest.el || 0)),
      lastUpdate: Math.max(latest._time, lastOt ? lastOt._time : 0),
      cur: otNewer ? [lastOt.lat, lastOt.lon, Math.round(lastOt.acc)] : latest.cur,
      batt: hasOt && lastOt.batt != null && (otNewer || typeof latest.b !== 'number') ? lastOt.batt : latest.b,
      charging: hasOt && lastOt.batt != null && (otNewer || typeof latest.b !== 'number') ? lastOt.bs === 2 : !!latest.c,
      pc, otNewer, firstTime: firstMsg._time,
    };
  }

  /* ---------- derived numbers ---------- */
  function nowSec() { return Date.now() / 1000; }

  function view() {
    const r = st.run;
    if (!r) return null;
    const L = r.latest;
    const km = L.km || RL.HALF_KM;
    const age = nowSec() - r.lastUpdate;
    let mode = 'live';
    if (L.k === 's') mode = 'ready';
    else if (L.k === 'f') mode = 'done';
    else if (age > STALE_SEC) mode = 'lost';
    const el = mode === 'done' ? L.el : (mode === 'ready' || r.startedAt == null) ? null : Math.max(0, nowSec() - r.startedAt);
    const dist = r.dist;
    const avg = dist >= 300 && r.dataEl > 0 ? r.dataEl / (dist / 1000) : null;
    let proj = null;
    if (mode === 'done') proj = L.el;
    else if (avg && dist >= 400) proj = avg * km;
    return { L, r, km, age, mode, el, dist, avg, proj, sp: r.splits, cur: r.cur, pc: r.pc, batt: r.batt, charging: r.charging };
  }

  /* ---------- rendering ---------- */
  let lastHeavyKey = '';

  function setStatus(s, text) {
    $('status').dataset.s = s;
    $('statusText').textContent = text;
  }

  function renderTicks(km) {
    const box = $('courseTicks');
    if (box.dataset.km === String(km)) return;
    box.dataset.km = String(km);
    box.textContent = '';
    const whole = Math.floor(km);
    for (let k = 0; k <= whole; k++) {
      const s = document.createElement('span');
      s.style.left = (k / km) * 100 + '%';
      const major = k % 5 === 0;
      if (!major) s.className = 'minor';
      s.textContent = major ? String(k) : '';
      if (major && km - k < 1.2 && k !== 0) continue; // avoid crowding the finish label
      box.appendChild(s);
    }
    const f = document.createElement('span');
    f.className = 'fin';
    f.style.left = '100%';
    f.style.transform = 'translateX(-100%)';
    f.textContent = 'FINISH ' + (Math.round(km * 10) / 10);
    box.appendChild(f);
  }

  function renderLight() {
    const v = view();
    if (!v) {
      setStatus('wait', st.loaded ? 'Not started' : 'Connecting…');
      if (st.loaded) {
        $('updated').textContent = st.netOk ? 'The runner hasn\'t started sharing yet. This page will update by itself as soon as they do.' : 'Can\'t reach the live feed right now. Retrying…';
      }
      renderTicks(RL.HALF_KM);
      return;
    }
    const { L, km, age, mode, el, dist, avg, proj } = v;
    const name = (L.n || 'Runner').slice(0, 40);
    $('runnerName').textContent = name;
    $('raceName').textContent = (L.r || 'Half Marathon').slice(0, 60) + (L.sim ? ' · test' : '');
    document.title = `${name} · ${RL.fmtKm(dist)} km · ${mode === 'done' ? 'Finished' : 'Live'}`;
    $('raceKm').textContent = (Math.round(km * 10) / 10).toString();
    renderTicks(km);

    $('dist').textContent = RL.fmtKm(dist);
    const frac = Math.max(0, Math.min(1, dist / (km * 1000)));
    $('courseFill').style.width = frac * 100 + '%';
    $('courseDot').style.left = frac * 100 + '%';

    const ivTxt = st.run.hasOt ? ' · updates about every minute' : (L.iv ? ` · updates about every ${L.iv} s` : '');
    if (mode === 'ready') {
      setStatus('ready', 'At the start');
      $('updated').textContent = `${name} is at the start line and ready to go. Updated ${RL.fmtAgo(age)}.`;
    } else if (mode === 'live') {
      setStatus('live', 'Live');
      $('updated').textContent = `Updated ${RL.fmtAgo(age)}${ivTxt}`;
    } else if (mode === 'lost') {
      setStatus('lost', 'No signal');
      $('updated').textContent = `Last update ${RL.fmtAgo(age)}. The phone is probably out of mobile signal for a moment. The race clock keeps running and the page catches up on its own.`;
    } else {
      setStatus('done', 'Finished');
      $('updated').textContent = `Finished in ${RL.fmtDur(L.el)}${st.run.startedAt ? ' at ' + RL.fmtClock((st.run.startedAt + L.el) * 1000) : ''}. 🎉`;
    }

    // race clock
    $('sClock').textContent = el == null ? '–' : RL.fmtDur(el);
    $('sClockSub').textContent = st.run.startedAt ? 'started ' + RL.fmtClock(st.run.startedAt * 1000) : (mode === 'ready' ? 'waiting for the start' : ' ');

    // pace now
    const pcOk = mode === 'live' && v.pc;
    $('sPace').textContent = pcOk ? RL.fmtPace(v.pc) : '–';
    $('sPaceSub').textContent = mode === 'live' ? (v.pc ? 'last minute or two' : 'standing or walking') : mode === 'done' ? 'race over' : ' ';

    $('sAvg').textContent = avg ? RL.fmtPace(avg) : '–';
    $('sAvgSub').textContent = avg ? `${(3600 / avg).toFixed(1)} km/h` : ' ';

    // projection
    if (mode === 'done') {
      $('sProjLbl').textContent = 'Finish time';
      $('sProj').textContent = RL.fmtDur(L.el);
      $('sProjSub').textContent = st.run.startedAt ? 'crossed at ' + RL.fmtClock((st.run.startedAt + L.el) * 1000) : ' ';
    } else {
      $('sProjLbl').textContent = 'Projected finish';
      $('sProj').textContent = proj ? RL.fmtDur(proj) : '–';
      if (proj && el != null) {
        const leftSec = proj - el;
        $('sProjSub').textContent = leftSec > 0 ? `around ${RL.fmtClock(Date.now() + leftSec * 1000)}` : 'any moment now';
      } else $('sProjSub').textContent = 'after the first few hundred metres';
    }

    const left = Math.max(0, km * 1000 - dist);
    $('sLeft').textContent = RL.fmtKm(left);
    $('sLeftSub').textContent = mode === 'done' ? 'done!' : (avg && left > 0 ? `~${RL.fmtDur(avg * left / 1000)} at avg pace` : ' ');

    const sp = Array.isArray(v.sp) ? v.sp : [];
    if (sp.length) {
      $('sLast').textContent = RL.fmtPace(sp[sp.length - 1]);
      $('sLastSub').textContent = `km ${sp.length}`;
    } else { $('sLast').textContent = '–'; $('sLastSub').textContent = 'after km 1'; }

    const b = $('sBatt');
    if (typeof v.batt === 'number') {
      b.textContent = Math.round(v.batt) + '%';
      b.className = 'val' + (v.batt < 15 ? ' bad' : v.batt < 30 ? ' warn' : '');
      $('sBattSub').textContent = v.charging ? 'charging' : ' ';
    } else { b.textContent = '–'; b.className = 'val'; $('sBattSub').textContent = 'not shared by this phone'; }

    const g = $('sGps');
    if (Array.isArray(v.cur)) {
      const acc = v.cur[2];
      g.textContent = acc <= 12 ? 'Strong' : acc <= 30 ? 'Good' : 'Weak';
      g.className = 'val' + (acc <= 12 ? ' good' : acc <= 30 ? '' : ' warn');
      $('sGpsSub').textContent = `±${acc} m`;
    } else { g.textContent = '–'; g.className = 'val'; $('sGpsSub').textContent = ' '; }

    // backup link
    const bk = $('lnkBackup');
    if (L.g && /^https:\/\//.test(L.g)) { bk.href = L.g; bk.hidden = false; } else bk.hidden = true;

    const banner = $('banner');
    if (L.sim) { banner.hidden = false; banner.className = 'banner info'; banner.textContent = 'This is a test run with simulated GPS, not the real race.'; }
    else if (!st.netOk) { banner.hidden = false; banner.className = 'banner'; banner.textContent = 'Your connection to the live feed dropped. Retrying automatically…'; }
    else banner.hidden = true;
  }

  function renderHeavy() {
    const v = view();
    const key = v ? `${v.L.rid}:${v.L.seq}:${st.run.lastUpdate}:${st.run.track.length}:${v.mode}` : 'none';
    if (key === lastHeavyKey) return;
    lastHeavyKey = key;
    renderMap(v);
    renderSplits(v);
    renderPace(v);
  }

  function render() { renderLight(); renderHeavy(); }

  /* ---------- map ---------- */
  let map = null, routeLine = null, runner = null, accCircle = null, startMk = null, kmLayer = null, follow = true, fittedOnce = false;
  let gmapsTarget = null;

  function initMap() {
    if (map) return true;
    if (!window.L) {
      $('map').innerHTML = '<div class="map-msg">The map couldn\'t load on this connection. Use “Open in Google Maps” below to see the runner\'s position.</div>';
      return false;
    }
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView([20.6, 78.9], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    const routeColor = getComputedStyle(document.documentElement).getPropertyValue('--route').trim() || '#2453d4';
    routeLine = L.polyline([], { color: routeColor, weight: 5, opacity: 0.9, lineJoin: 'round' }).addTo(map);
    kmLayer = L.layerGroup().addTo(map);
    map.on('dragstart', () => setFollow(false));
    return true;
  }

  function setFollow(on) {
    follow = on;
    const b = $('btnFollow');
    b.classList.toggle('on', on);
    b.textContent = on ? 'Following runner' : 'Follow runner';
    if (on) centerOnRunner();
  }

  function centerOnRunner() {
    if (!map || !runner) return;
    map.setView(runner.getLatLng(), Math.max(map.getZoom(), 15), { animate: true });
  }

  function renderMap(v) {
    if (!initMap() && !v) return;
    if (!v) return;
    const { track, cum } = st.run;
    const L_ = v.L;
    const latlngs = track.map((p) => [p[0], p[1]]);
    let pos = Array.isArray(v.cur) ? [v.cur[0], v.cur[1]] : latlngs.length ? latlngs[latlngs.length - 1] : null;
    const acc = Array.isArray(v.cur) ? v.cur[2] : null;
    gmapsTarget = pos;
    const gl = $('lnkGmaps');
    if (pos) { gl.href = `https://www.google.com/maps/search/?api=1&query=${pos[0]},${pos[1]}`; gl.hidden = false; } else gl.hidden = true;
    if (!map) return;

    routeLine.setLatLngs(latlngs);

    // start marker
    if (latlngs.length) {
      if (!startMk) startMk = L.marker(latlngs[0], { icon: L.divIcon({ className: '', html: '<div class="start-pin">GO</div>', iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false, keyboard: false }).addTo(map);
      else startMk.setLatLng(latlngs[0]);
    }

    // km markers where the cumulative distance passes each whole km
    kmLayer.clearLayers();
    let next = 1000;
    for (let i = 1; i < track.length; i++) {
      while (cum[i] >= next) {
        const seg = cum[i] - cum[i - 1] || 1;
        const f = (next - cum[i - 1]) / seg;
        const a = track[i - 1], b = track[i];
        const ll = [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
        L.marker(ll, { icon: L.divIcon({ className: '', html: `<div class="km-pin">${next / 1000}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false, keyboard: false }).addTo(kmLayer);
        next += 1000;
      }
    }

    if (pos) {
      const stale = v.mode === 'lost';
      const html = `<div class="runner-pin${stale ? ' stale' : ''}"><span class="pulse"></span><span class="core"></span></div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [20, 20], iconAnchor: [10, 10] });
      if (!runner) runner = L.marker(pos, { icon, zIndexOffset: 1000, keyboard: false, title: 'Runner' }).addTo(map);
      else { runner.setLatLng(pos); runner.setIcon(icon); }
      if (acc != null) {
        if (!accCircle) accCircle = L.circle(pos, { radius: acc, weight: 1, color: '#ff5a1f', fillOpacity: 0.08, interactive: false }).addTo(map);
        else { accCircle.setLatLng(pos); accCircle.setRadius(acc); }
      }
      if (!fittedOnce) {
        fittedOnce = true;
        if (latlngs.length > 3) map.fitBounds(routeLine.getBounds().extend(pos), { padding: [30, 30], maxZoom: 16 });
        else map.setView(pos, 16);
        if (follow) map.setView(pos, Math.max(map.getZoom(), 15));
      } else if (follow) {
        map.panTo(pos, { animate: true });
      }
    }
  }

  /* ---------- splits ---------- */
  function renderSplits(v) {
    const body = $('splitsBody');
    const sp = v && Array.isArray(v.sp) ? v.sp.filter((x) => typeof x === 'number' && x > 0) : [];
    if (!sp.length) {
      body.innerHTML = '<tr><td colspan="4" class="empty">Splits appear after each full kilometre.</td></tr>';
      $('splitHint').textContent = '';
      return;
    }
    const avg = sp.reduce((a, b) => a + b, 0) / sp.length;
    const best = Math.min(...sp), worst = Math.max(...sp);
    const maxDev = Math.max(15, ...sp.map((s) => Math.abs(s - avg)));
    $('splitHint').textContent = `average ${RL.fmtPace(avg)} /km`;
    body.textContent = '';
    let tot = 0;
    sp.forEach((s, i) => {
      tot += s;
      const tr = document.createElement('tr');
      if (sp.length > 1 && s === best) tr.className = 'best';
      else if (sp.length > 1 && s === worst) tr.className = 'worst';
      const dev = s - avg;
      const w = Math.min(50, (Math.abs(dev) / maxDev) * 50);
      const bar = dev < 0 ? `<i class="f" style="right:50%;width:${w}%"></i>` : `<i class="s" style="left:50%;width:${w}%"></i>`;
      const sign = dev < 0 ? '−' : '+';
      tr.innerHTML = `<td>${i + 1}</td><td>${RL.fmtPace(s)}</td><td class="barcol"><div class="sbar" title="${sign}${Math.abs(Math.round(dev))} s vs average">${bar}</div></td><td>${RL.fmtDur(tot)}</td>`;
      body.appendChild(tr);
    });
  }

  /* ---------- pace chart ---------- */
  function renderPace(v) {
    const wrap = $('paceWrap');
    if (!v || !st.run || st.run.track.length < 4 || st.run.cum[st.run.cum.length - 1] < 500) {
      wrap.innerHTML = '<p class="empty">The pace chart fills in once the runner has covered half a kilometre.</p>';
      return;
    }
    const { track, cum } = st.run;
    const total = cum[cum.length - 1];
    // rolling pace over ~400 m, sampled every ~100 m
    const pts = [];
    let j = 0, nextSample = 0;
    for (let i = 1; i < track.length; i++) {
      while (j < i && cum[i] - cum[j + 1] >= 400) j++;
      const dd = cum[i] - cum[j], dt = track[i][2] - track[j][2];
      if (cum[i] >= nextSample && dd >= 150 && dt > 0) {
        const pace = dt / (dd / 1000);
        if (pace > 120 && pace < 1200) pts.push([cum[i], pace]);
        nextSample = cum[i] + 100;
      }
    }
    if (pts.length < 2) { wrap.innerHTML = '<p class="empty">Not enough GPS data yet for a pace chart.</p>'; return; }

    const W = Math.max(280, wrap.clientWidth || 600), Hh = 190, pl = 40, pr = 10, pt = 10, pb = 24;
    const xMax = Math.max(v.km * 1000, total);
    let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
    lo = Math.floor((lo - 15) / 30) * 30; hi = Math.ceil((hi + 15) / 30) * 30;
    if (hi - lo < 120) { const mid = (hi + lo) / 2; lo = Math.floor((mid - 60) / 30) * 30; hi = lo + 120; }
    const x = (d) => pl + (d / xMax) * (W - pl - pr);
    const y = (p) => pt + ((p - lo) / (hi - lo)) * (Hh - pt - pb); // faster (smaller) pace is higher
    const css = getComputedStyle(document.documentElement);
    const cRoute = css.getPropertyValue('--route').trim(), cLine = css.getPropertyValue('--line').trim(), cSig = css.getPropertyValue('--signal').trim(), cMuted = css.getPropertyValue('--muted').trim();

    let g = '';
    const step = hi - lo > 300 ? 60 : 30;
    for (let p = lo; p <= hi; p += step) {
      g += `<line x1="${pl}" x2="${W - pr}" y1="${y(p)}" y2="${y(p)}" stroke="${cLine}" stroke-width="1"/>`;
      g += `<text x="${pl - 6}" y="${y(p) + 4}" text-anchor="end">${RL.fmtPace(p)}</text>`;
    }
    const kmStep = xMax > 15000 ? 5000 : xMax > 6000 ? 2000 : 1000;
    for (let d = 0; d <= xMax; d += kmStep) g += `<text x="${x(d)}" y="${Hh - 6}" text-anchor="middle">${d / 1000} km</text>`;

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const area = line + `L${x(pts[pts.length - 1][0]).toFixed(1)},${Hh - pb}L${x(pts[0][0]).toFixed(1)},${Hh - pb}Z`;
    let avgLine = '';
    if (v.avg) {
      const ya = y(Math.min(hi, Math.max(lo, v.avg)));
      avgLine = `<line x1="${pl}" x2="${W - pr}" y1="${ya}" y2="${ya}" stroke="${cMuted}" stroke-dasharray="4 4" stroke-width="1"/><text x="${W - pr}" y="${ya - 5}" text-anchor="end">avg ${RL.fmtPace(v.avg)}</text>`;
    }
    const lp = pts[pts.length - 1];
    wrap.innerHTML = `<svg viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" role="img" aria-label="Pace over distance">
      ${g}
      <path d="${area}" fill="${cRoute}" fill-opacity="0.12" stroke="none"/>
      <path d="${line}" fill="none" stroke="${cRoute}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${avgLine}
      <circle cx="${x(lp[0])}" cy="${y(lp[1])}" r="5" fill="${cSig}" stroke="#fff" stroke-width="2"/>
    </svg>`;
  }

  /* ---------- cheers ---------- */
  function ingestCheer(m) {
    if (st.cheerSeen.has(m.id)) return false;
    st.cheerSeen.add(m.id);
    let c;
    try { c = JSON.parse(m.message); } catch (e) { return false; }
    if (!c || typeof c.msg !== 'string') return false;
    st.cheers.push({ id: m.id, time: m.time, from: String(c.from || 'A friend').slice(0, 30), msg: c.msg.slice(0, 140) });
    st.cheers.sort((a, b) => b.time - a.time);
    return true;
  }

  function renderFeed() {
    const ul = $('feed');
    ul.textContent = '';
    for (const c of st.cheers.slice(0, 25)) {
      const li = document.createElement('li');
      const who = document.createElement('span'); who.className = 'who'; who.textContent = c.from;
      const when = document.createElement('span'); when.className = 'when'; when.textContent = RL.fmtAgo(nowSec() - c.time);
      const msg = document.createElement('div'); msg.textContent = c.msg;
      li.append(who, when, msg);
      ul.appendChild(li);
    }
  }

  function setupCheers() {
    const from = $('cheerFrom'), msg = $('cheerMsg'), status = $('cheerStatus'), send = $('cheerSend');
    try { from.value = localStorage.getItem('rl-cheer-name') || ''; } catch (e) { /* ignore */ }
    let lastSent = 0;
    $('quick').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-q]');
      if (!b) return;
      msg.value = b.dataset.q;
      msg.focus();
    });
    $('cheerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = msg.value.trim();
      const name = from.value.trim() || 'A friend';
      if (!text) { status.textContent = 'Write a message or tap one of the suggestions first.'; return; }
      const wait = 15 - (Date.now() - lastSent) / 1000;
      if (wait > 0) { status.textContent = `Give it ${Math.ceil(wait)} more seconds before the next cheer.`; return; }
      try { localStorage.setItem('rl-cheer-name', name); } catch (err) { /* ignore */ }
      if (DEMO || !cheerTopic) {
        ingestCheer({ id: 'local' + Date.now(), time: nowSec(), message: JSON.stringify({ from: name, msg: text }) });
        renderFeed(); msg.value = ''; status.textContent = 'Demo mode: your cheer is only shown here.';
        return;
      }
      send.disabled = true; status.textContent = 'Sending…';
      try {
        const m = await RL.publish(cheerTopic, { v: 1, from: name.slice(0, 30), msg: text.slice(0, 140) });
        lastSent = Date.now();
        if (m && m.id) { ingestCheer(m); renderFeed(); }
        msg.value = '';
        status.textContent = 'Sent! It will be read out on the runner\'s phone.';
      } catch (err) {
        status.textContent = err.status === 429 ? 'Too many cheers from this network today. Try again later.' : 'Couldn\'t send. Check your connection and try again.';
      } finally { send.disabled = false; }
    });
  }

  /* ---------- network loop ---------- */
  async function pollMain() {
    try {
      const msgs = await RL.poll(topic, st.lastId || 'all');
      let changed = false;
      for (const m of msgs) changed = ingest(m) || changed;
      st.netOk = true;
      if (changed || !st.loaded) { st.loaded = true; rebuild(); render(); }
    } catch (e) {
      st.netOk = false; st.loaded = true; renderLight();
    }
  }
  async function pollCheers() {
    try {
      const msgs = await RL.poll(cheerTopic, 'all');
      let changed = false;
      for (const m of msgs) changed = ingestCheer(m) || changed;
      if (changed) renderFeed();
    } catch (e) { /* ignore */ }
  }

  async function startLive() {
    await pollMain();
    // Server-sent events for instant updates; polling as a safety net.
    RL.subscribe(topic, st.lastId || undefined, (m) => { if (ingest(m)) { st.netOk = true; rebuild(); render(); } });
    RL.subscribe(cheerTopic, undefined, (m) => { if (ingestCheer(m)) renderFeed(); });
    setInterval(pollMain, 20000);
    pollCheers();
    setInterval(pollCheers, 45000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { pollMain(); pollCheers(); } });
  }

  /* ---------- demo mode: a simulated race, nothing sent anywhere ---------- */
  function startDemo() {
    const course = RL.makeCourse();
    let simT = 0, s = 0, seq = 0, splits = [], prevS = 0, pending = [];
    const rid = 'demo';
    const pushPts = (secs) => {
      const end = simT + secs;
      while (simT < end) {
        simT += 4;
        const pace = RL.simPace(s) + (Math.random() - 0.5) * 10;
        prevS = s;
        s += (4 / pace) * 1000;
        while (s >= (splits.length + 1) * 1000) {
          const k = splits.length + 1, f = (k * 1000 - prevS) / (s - prevS);
          const crossT = simT - 4 + f * 4;
          splits.push(Math.round((crossT - splits.reduce((a, b) => a + b, 0)) * 10) / 10);
        }
        const ll = course.at(s);
        pending.push([RL.r5(ll[0]), RL.r5(ll[1]), Math.round(simT), 6]);
      }
    };
    const emit = (timeSec, kind) => {
      const last = pending[pending.length - 1] || [0, 0, 0];
      const p = { v: 1, k: kind || 'u', rid, seq: seq++, n: 'Your runner', r: 'Half Marathon (demo)', km: RL.HALF_KM, el: Math.round(simT), dist: Math.round(s), pc: Math.round(RL.simPace(s)), sp: splits.slice(), cur: [last[0], last[1], 7, 2], p: pending, b: Math.max(5, Math.round(92 - simT / 160)), iv: 45 };
      pending = [];
      ingest({ id: 'd' + seq, time: timeSec, message: JSON.stringify(p) });
    };
    // history: 58 simulated minutes, one message every 45 s
    const startReal = nowSec() - 58 * 60;
    while (simT < 58 * 60) { pushPts(45); emit(startReal + simT); }
    ingestCheer({ id: 'c1', time: nowSec() - 900, message: JSON.stringify({ from: 'Aditi', msg: 'You\'ve got this! 💪' }) });
    ingestCheer({ id: 'c2', time: nowSec() - 300, message: JSON.stringify({ from: 'Rohan', msg: 'Halfway there, looking strong!' }) });
    st.loaded = true; rebuild(); render(); renderFeed();
    $('cheerNote').textContent = 'Demo mode: this is a made-up race so you can see how the page works.';
    // then speed up: every 3 s real time adds 30 s of race
    const timer = setInterval(() => {
      if (s >= RL.HALF_KM * 1000) {
        clearInterval(timer);
        const p = { v: 1, k: 'f', rid, seq: seq++, n: 'Your runner', r: 'Half Marathon (demo)', km: RL.HALF_KM, el: Math.round(simT), dist: Math.round(s), sp: splits.slice(), p: [], iv: 45 };
        ingest({ id: 'df', time: nowSec(), message: JSON.stringify(p) });
      } else { pushPts(30); emit(nowSec()); }
      rebuild(); render();
    }, 3000);
  }

  /* ---------- boot ---------- */
  $('btnFollow').addEventListener('click', () => setFollow(!follow));
  $('btnFit').addEventListener('click', () => {
    if (!map || !routeLine || !st.run || !st.run.track.length) return;
    setFollow(false);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  });
  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { lastHeavyKey = ''; renderHeavy(); if (map) map.invalidateSize(); }, 200); });
  setInterval(() => { renderLight(); if (st.cheers.length) renderFeed(); }, 1000);
  setupCheers();
  initMap();

  if (DEMO) startDemo();
  else if (!topic) {
    st.loaded = true;
    setStatus('wait', 'Link incomplete');
    $('updated').textContent = 'This link is missing the runner\'s tracking code. Ask them to send the full link again.';
    const b = $('banner'); b.hidden = false; b.className = 'banner info';
    b.innerHTML = 'Just curious how it looks? <a href="#demo" onclick="setTimeout(()=>location.reload(),0)">Open the demo race</a>.';
  } else startLive();
})();
