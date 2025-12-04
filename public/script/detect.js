/**
 * botTagger.js
 * Lightweight JS tagging for bot detection (mouse, scroll, forms, fingerprinting)
 *
 * Usage:
 *   <script src="/path/to/botTagger.js"></script>
 *   <script>
 *     BotTagger.init({
 *       endpoint: '/api/bot-events',
 *       siteId: 'my-site',
 *       consentRequired: false,
 *       batchInterval: 2000,
 *     });
 *   </script>
 */

window.BotTagger = (function () {
  const DEFAULTS = {
    endpoint: '/bot-events',
    siteId: null,
    consentRequired: false,
    batchInterval: 3000,
    maxBatchSize: 50,
    sampleRate: 1.0,
  };

  let cfg = Object.assign({}, DEFAULTS);
  let enabled = true;
  let eventQueue = [];
  let sendTimer = null;
  let sessionFingerprint = null;

  let mouseMovements = [];
  let lastMouse = null;
  let scrollTimes = [];
  let formTimers = new WeakMap();
  let started = Date.now();

  function now() { return Date.now(); }

  function passesSample() {
    return Math.random() < cfg.sampleRate;
  }

  function generateFingerprint() {
    try {
      const ua = navigator.userAgent || 'unknown';
      const screenRes = `${window.screen?.width || 0}x${window.screen?.height || 0}`;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
      const plugins = (navigator.plugins && navigator.plugins.length) || 0;
      const hwConcurrency = navigator.hardwareConcurrency || 0;
      const base = [ua, screenRes, tz, plugins, hwConcurrency].join('|');
      let h = 2166136261 >>> 0;
      for (let i = 0; i < base.length; i++) {
        h ^= base.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return `fp_${(h >>> 0).toString(36)}`;
    } catch (e) {
      return `fp_unknown_${Math.floor(Math.random() * 100000)}`;
    }
  }

  function pushEvent(type, payload = {}) {
    if (!enabled) return;
    const ev = { t: type, ts: now(), payload };
    eventQueue.push(ev);

    console.log(`📩 Queued event: ${type}`, payload);

    if (eventQueue.length >= cfg.maxBatchSize) {
      flushEvents();
      return;
    }

    if (!sendTimer) {
      sendTimer = setTimeout(flushEvents, cfg.batchInterval);
    }
  }

  function flushEvents() {
    if (!eventQueue.length) {
      clearTimeout(sendTimer);
      sendTimer = null;
      return;
    }

    if (!passesSample()) {
      eventQueue = [];
      clearTimeout(sendTimer);
      sendTimer = null;
      return;
    }

    const payload = {
	    siteId: cfg.siteId,
	    fingerprint: sessionFingerprint,
	    ts: now(),
	    sessionDurationMs: now() - started,
	    userId,       // <- from sessionStorage
	    step,         // optional
	    events: eventQueue.splice(0, eventQueue.length)
	};

    clearTimeout(sendTimer);
    sendTimer = null;

   // console.log(`🚀 Sending ${payload.events.length} events to ${cfg.endpoint}`, payload);

    try {
      const url = cfg.endpoint;
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, blob);
      } else {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        }).catch(() => { /* ignore */ });
      }
    } catch (e) {
      console.warn('BotTagger flush error', e);
    }
  }

  function computeLinearity(buf) {
    if (!buf || buf.length < 6) return 0;
    const n = Math.min(40, buf.length);
    const step = Math.floor(buf.length / n) || 1;
    const pts = [];
    for (let i = buf.length - 1; i >= 0 && pts.length < n; i -= step) {
      pts.push([buf[i].x, buf[i].y]);
    }
    if (pts.length < 3) return 0;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < pts.length; i++) {
      sx += pts[i][0]; sy += pts[i][1];
      sxx += pts[i][0] * pts[i][0]; sxy += pts[i][0] * pts[i][1];
    }
    const len = pts.length;
    const denom = (len * sxx - sx * sx) || 1;
    const m = (len * sxy - sx * sy) / denom;
    const b = (sy - m * sx) / len;
    let sumDist = 0;
    for (let i = 0; i < pts.length; i++) {
      const x = pts[i][0], y = pts[i][1];
      const yPred = m * x + b;
      sumDist += Math.abs(y - yPred);
    }
    const avg = sumDist / pts.length;
    const linearity = Math.max(0, Math.min(1, (40 - avg) / 40));
    return Number(linearity.toFixed(2));
  }

  function startMouseTracking() {
    document.addEventListener('mousemove', (e) => {
      if (!enabled) return;
      const x = e.clientX, y = e.clientY;
      mouseMovements.push({ x, y, ts: now() });
      if (mouseMovements.length % 50 === 0) {
        const linearity = computeLinearity(mouseMovements);
        pushEvent('mouse_summary', { count: mouseMovements.length, linearity });
        console.log(`🖱️ Mouse activity detected (${mouseMovements.length} points, linearity: ${linearity})`);
      }
    }, { passive: true });
  }

  function startScrollTracking() {
    let lastScrollTs = 0;
    window.addEventListener('scroll', () => {
      if (!enabled) return;
      const ts = now();
      if (lastScrollTs) {
        const dt = ts - lastScrollTs;
        scrollTimes.push(dt);
        if (scrollTimes.length > 200) scrollTimes.shift();
        const recent = scrollTimes.slice(-8);
        const fastCount = recent.filter(v => v < 50).length;
        if (fastCount >= 4) {
          pushEvent('fast_scroll', { fastCount });
          //console.log('⚡ Fast scroll detected!');
        }
      }
      lastScrollTs = ts;
    }, { passive: true });
  }

  function startFormTracking() {
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!enabled || !(form instanceof HTMLFormElement)) return;
      const meta = formTimers.get(form);
      const sinceLoad = now() - started;
      const timeToSubmit = meta ? (now() - meta.startTs) : sinceLoad;
      pushEvent('form_submit', {
        action: form.action || null,
        timeToSubmitMs: timeToSubmit,
      });
      console.log(`📝 Form submitted after ${timeToSubmit} ms`);
      if (timeToSubmit < 700) {
        pushEvent('fast_form_submit_flag', { timeToSubmit });
        console.warn('🚨 Fast form submission detected!');
      }
    }, true);

    document.addEventListener('input', (e) => {
      const form = e.target.form;
      if (form && !formTimers.has(form)) {
        formTimers.set(form, { startTs: now() });
      }
    }, true);
  }

  function init(options = {}) {
    cfg = Object.assign({}, cfg, options);
    let userin = sessionStorage.getItem("userId") || null; 
    step = options.step || null;       // optional
    enabled = !cfg.consentRequired;
    sessionFingerprint = generateFingerprint();

    if (!enabled) return;

    startMouseTracking();
    startScrollTracking();
    startFormTracking();

    pushEvent('page_load', { url: location.href, referrer: document.referrer });
    pushEvent('fingerprint', { fingerprint: sessionFingerprint });

    window.addEventListener('beforeunload', flushEvents, { passive: true });
    window.addEventListener('pagehide', flushEvents, { passive: true });
}

  function computeRiskScore() {
    const linearity = computeLinearity(mouseMovements);
    const recentFastScroll = (scrollTimes.slice(-10).filter(v => v < 50).length) >= 4 ? 1 : 0;
    let score = 10;
    score += Math.round(linearity * -40);
    score += recentFastScroll * 30;
    score += mouseMovements.length < 4 ? 20 : 0;
    score = Math.max(0, Math.min(100, score));
    console.log(`🧮 Current risk score: ${score}`);
    return score;
  }

  return {
    init,
    sendCustomEvent: pushEvent,
    computeRiskScore,
    enable: () => { enabled = true; console.log('✅ BotTagger enabled'); },
    disable: () => { enabled = false; console.log('🚫 BotTagger disabled'); },
    _internal: { cfg },
  };
})(); 