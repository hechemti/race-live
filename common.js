/* Shared helpers for the runner page and the spectator page. */
(function () {
  const RL = {};
  RL.NTFY = 'https://ntfy.sh';
  RL.HALF_KM = 21.0975;

  /* Hash format: #t=<topic>[&sim] or #demo */
  RL.parseHash = function () {
    const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
    const q = new URLSearchParams(raw.includes('=') ? raw : (raw === 'demo' ? 'demo' : 't=' + raw));
    const t = (q.get('t') || '').trim();
    return {
      topic: /^[A-Za-z0-9_-]{8,64}$/.test(t) ? t : null,
      sim: q.has('sim'),
      demo: q.has('demo') || raw === 'demo',
    };
  };

  RL.randomId = function (len) {
    const abc = 'abcdefghijkmnopqrstuvwxyz23456789';
    const a = new Uint8Array(len);
    crypto.getRandomValues(a);
    let s = '';
    for (const x of a) s += abc[x % abc.length];
    return s;
  };

  RL.newTopic = () => 'race-' + RL.randomId(20);

  RL.r5 = (x) => Math.round(x * 1e5) / 1e5;

  /* Great-circle distance in metres between [lat, lon, ...] points. */
  RL.hav = function (a, b) {
    const R = 6371008.8, k = Math.PI / 180;
    const dLat = (b[0] - a[0]) * k, dLon = (b[1] - a[1]) * k;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * k) * Math.cos(b[0] * k) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  };

  const pad = (n) => String(n).padStart(2, '0');

  /* 3725 -> "1:02:05", 325 -> "5:25" */
  RL.fmtDur = function (sec) {
    if (sec == null || !isFinite(sec) || sec < 0) return '–';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  };

  /* seconds per km -> "5:25" */
  RL.fmtPace = function (spk) {
    if (spk == null || !isFinite(spk) || spk <= 0 || spk > 30 * 60) return '–';
    const s = Math.round(spk);
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  };

  RL.fmtKm = (m) => (Math.max(0, m) / 1000).toFixed(2);

  RL.fmtClock = function (ms) {
    try {
      return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      const d = new Date(ms);
      return `${d.getHours()}:${pad(d.getMinutes())}`;
    }
  };

  RL.fmtAgo = function (sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 5) return 'just now';
    if (sec < 60) return `${sec} s ago`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m} min ago`;
    return `${Math.floor(m / 60)} h ${m % 60} min ago`;
  };

  /* ---------- ntfy.sh relay ---------- */

  /* Publish a JSON payload. A plain string body keeps this a CORS "simple request". */
  RL.publish = async function (topic, obj, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 15000);
    try {
      const r = await fetch(`${RL.NTFY}/${topic}`, { method: 'POST', body: JSON.stringify(obj), signal: ctl.signal });
      if (!r.ok) {
        const e = new Error('HTTP ' + r.status);
        e.status = r.status;
        throw e;
      }
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  };

  /* Fetch cached messages. since = 'all' | message id | unix seconds. */
  RL.poll = async function (topic, since) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(`${RL.NTFY}/${topic}/json?poll=1&since=${encodeURIComponent(since || 'all')}`, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      const out = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.event === 'message') out.push(m);
        } catch (e) { /* skip */ }
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  };

  /* Live stream. Calls onMsg(ntfyMessage). Returns a close function. */
  RL.subscribe = function (topic, since, onMsg, onState) {
    if (!('EventSource' in window)) return () => {};
    const url = `${RL.NTFY}/${topic}/sse` + (since ? `?since=${encodeURIComponent(since)}` : '');
    let es;
    try { es = new EventSource(url); } catch (e) { return () => {}; }
    es.onopen = () => onState && onState(true);
    es.onerror = () => onState && onState(false);
    es.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.event === 'message') onMsg(m);
      } catch (e) { /* ignore */ }
    };
    return () => es.close();
  };

  /* ---------- OwnTracks app setup ----------
     OwnTracks keeps sending location while the phone is locked. It posts
     {"_type":"location", ...} straight to the same ntfy topic. */
  RL.ownTracksConfig = function (topic, monitoring) {
    return {
      _type: 'configuration',
      mode: 3,                               // HTTP
      url: `${RL.NTFY}/${topic}`,
      auth: false,
      cmd: false,
      remoteConfiguration: false,
      allowRemoteLocation: false,
      monitoring: monitoring,                // -1 quiet, 2 move
      locatorDisplacement: 150,              // metres between updates (about every 50 s while running)
      locatorInterval: 60,
      adapt: 0,                              // never drop out of move mode when standing still
      ignoreInaccurateLocations: 0,
      extendedData: true,
      tid: 'ME',
    };
  };
  RL.ownTracksLink = function (topic, monitoring) {
    const json = JSON.stringify(RL.ownTracksConfig(topic, monitoring));
    return 'owntracks:///config?inline=' + encodeURIComponent(btoa(json));
  };

  /* ---------- synthetic course for demo / simulation ---------- */
  RL.makeCourse = function (center) {
    center = center || [15.3647, 75.124];
    const R = 1650, N = 900, pts = [];
    const kx = 111320 * Math.cos(center[0] * Math.PI / 180), ky = 111320;
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * 2 * Math.PI;
      const r = R * (1 + 0.22 * Math.sin(3 * th) + 0.08 * Math.cos(5 * th + 1));
      const x = r * Math.cos(th), y = r * Math.sin(th) * 0.8;
      pts.push([center[0] + y / ky, center[1] + x / kx]);
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + RL.hav(pts[i - 1], pts[i]));
    const per = cum[cum.length - 1];
    return {
      per,
      at(s) {
        s = ((s % per) + per) % per;
        let lo = 0, hi = cum.length - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (cum[mid] <= s) lo = mid; else hi = mid;
        }
        const f = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
        return [pts[lo][0] + f * (pts[hi][0] - pts[lo][0]), pts[lo][1] + f * (pts[hi][1] - pts[lo][1])];
      },
    };
  };

  /* Pace (s/km) the simulated runner holds at distance s metres. */
  RL.simPace = function (s) {
    return 332 + 14 * Math.sin(s / 1700) + (s > 15000 ? ((s - 15000) / 6100) * 22 : 0) - (s > 20200 ? 25 : 0);
  };

  window.RL = RL;
})();
