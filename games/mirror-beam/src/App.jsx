import React, { useEffect, useMemo, useRef, useState } from "react";

// Mirror Beam — Clean Locked Layout / Responsive
// - desktop: records locked beside playfield
// - phone: playfield goes fullscreen-ish, records only appear after a clear
// - mobile next/reset live beside the running score
// - no medal/startup bug
// - reset gives a fresh attempt on same map

const W = 360;
const H = 640;
const FRAME_H = 660;
const MAX_MAPS = 10;
const TRACE_LIMIT = 5000;
const SOURCE = { x: 64, y: 320 };
const PLAY_AREA = { x: 28, y: 30, w: W - 56, h: H - 60, r: 8 };
const SCOREBOARD_SIZE = 20;
const ONLINE_FETCH_LIMIT = 200;
const SCORE_SEASON = 2;
const ONLINE_LEVEL_OFFSET = SCORE_SEASON * 1000;
const SOUND_PREF_KEY = "mb_clean_sound_on";
const SFX_MASTER_VOLUME = 0.82;
const SFX_GAIN_BOOST = 3.2;
const EPS = 1e-6;
const rawScoreApi = typeof window !== "undefined" ? window.MIRROR_BEAM_SCORE_API : "";
const SCORE_API_ENABLED = rawScoreApi === "same-origin" || Boolean(rawScoreApi);
const SCORE_API_BASE = rawScoreApi === "same-origin" ? "" : String(rawScoreApi || "").replace(/\/$/, "");

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y);
const norm = (a) => {
  const l = len(a);
  return l < EPS ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
};
const reflect = (v, n) => add(v, mul(n, -2 * dot(v, n)));
const fromAngle = (a) => ({ x: Math.cos(a), y: Math.sin(a) });
const angleOf = (v) => Math.atan2(v.y, v.x);
const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const easeAngle = (from, to, amount) => from + angleDelta(from, to) * amount;

function rng(seed) {
  return () => (seed = (seed * 48271) % 0x7fffffff) / 0x7fffffff;
}
function stageSeed(index) {
  return 12345 + index * 101;
}

function raySegIntersect(o, d, p, q) {
  const s = sub(q, p);
  const rxs = d.x * s.y - d.y * s.x;
  if (Math.abs(rxs) < EPS) return null;
  const qp = sub(p, o);
  const t = (qp.x * s.y - qp.y * s.x) / rxs;
  const u = (qp.x * d.y - qp.y * d.x) / rxs;
  if (t >= EPS && u >= -EPS && u <= 1 + EPS) {
    return { t, u: clamp(u, 0, 1), point: add(o, mul(d, t)) };
  }
  return null;
}

function rayPlayAreaHit(o, d) {
  const area = PLAY_AREA;
  const hits = [];

  if (Math.abs(d.x) > EPS) {
    const leftT = (area.x - o.x) / d.x;
    const leftY = o.y + d.y * leftT;
    if (leftT >= EPS && leftY >= area.y - EPS && leftY <= area.y + area.h + EPS) {
      hits.push({ t: leftT, point: { x: area.x, y: leftY }, side: "left" });
    }

    const rightT = (area.x + area.w - o.x) / d.x;
    const rightY = o.y + d.y * rightT;
    if (rightT >= EPS && rightY >= area.y - EPS && rightY <= area.y + area.h + EPS) {
      hits.push({ t: rightT, point: { x: area.x + area.w, y: rightY }, side: "right" });
    }
  }

  if (Math.abs(d.y) > EPS) {
    const topT = (area.y - o.y) / d.y;
    const topX = o.x + d.x * topT;
    if (topT >= EPS && topX >= area.x - EPS && topX <= area.x + area.w + EPS) {
      hits.push({ t: topT, point: { x: topX, y: area.y }, side: "top" });
    }

    const bottomT = (area.y + area.h - o.y) / d.y;
    const bottomX = o.x + d.x * bottomT;
    if (bottomT >= EPS && bottomX >= area.x - EPS && bottomX <= area.x + area.w + EPS) {
      hits.push({ t: bottomT, point: { x: bottomX, y: area.y + area.h }, side: "bottom" });
    }
  }

  return hits.sort((a, b) => a.t - b.t)[0] || null;
}

function pointSegDist(p, a, b) {
  const ab = sub(b, a);
  const t = clamp(dot(sub(p, a), ab) / Math.max(dot(ab, ab), EPS), 0, 1);
  return len(sub(p, add(a, mul(ab, t))));
}

function segNormal(a, b) {
  const d = sub(b, a);
  const l = len(d);
  if (l < EPS) return { x: 0, y: 0 };
  return { x: -d.y / l, y: d.x / l };
}

function onlineLevelForMap(map) {
  return ONLINE_LEVEL_OFFSET + map;
}

function mapFromOnlineLevel(level, fallbackMap) {
  const n = Number(level);
  if (!Number.isFinite(n)) return fallbackMap;
  if (n >= ONLINE_LEVEL_OFFSET && n < ONLINE_LEVEL_OFFSET + MAX_MAPS) return n - ONLINE_LEVEL_OFFSET;
  return n;
}

function bestKey(seed) {
  return `mb_clean_s${SCORE_SEASON}_best_${seed}`;
}
function scoreKey(seed) {
  return `mb_clean_s${SCORE_SEASON}_scores_${seed}`;
}
function clearLegacyScoreStorage() {
  try {
    const prefixes = ["mb_clean_best_", "mb_clean_scores_"];
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (prefixes.some((prefix) => key && key.startsWith(prefix))) {
        localStorage.removeItem(key);
      }
    }
  } catch {}
}
function loadBest(seed) {
  try {
    const v = localStorage.getItem(bestKey(seed));
    return v ? parseInt(v, 10) : null;
  } catch {
    return null;
  }
}
function saveBest(seed, score) {
  try {
    const cur = loadBest(seed);
    if (cur == null || score > cur) localStorage.setItem(bestKey(seed), String(score));
  } catch {}
}
function loadScores(seed) {
  try {
    const raw = localStorage.getItem(scoreKey(seed));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveScores(seed, scores) {
  try {
    localStorage.setItem(scoreKey(seed), JSON.stringify(scores));
  } catch {}
}
function addScore(seed, entry) {
  const scores = [...loadScores(seed), entry]
    .sort((a, b) => b.score - a.score || a.time - b.time)
    .slice(0, SCOREBOARD_SIZE);
  saveScores(seed, scores);
  return scores;
}
function normalizeScoreEntry(entry) {
  const map = Number(entry.map) || 0;
  const time = Number(entry.time) || Date.parse(entry.created_at) || Date.now();
  return {
    initials: cleanInitials(entry.initials) || "AAA",
    score: Number(entry.score) || 0,
    map,
    seed: Number(entry.seed) || stageSeed(map),
    time,
  };
}
function mergeScores(...lists) {
  const seen = new Set();
  return lists
    .flat()
    .map(normalizeScoreEntry)
    .filter((entry) => {
      const key = `${entry.initials}:${entry.score}:${entry.map}:${entry.time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score || a.time - b.time)
    .slice(0, SCOREBOARD_SIZE);
}
function currentMapScores(scores, map) {
  return scores.filter((entry) => Number(entry.map) === map).slice(0, SCOREBOARD_SIZE);
}
async function fetchOnlineScores(map, seed) {
  if (!SCORE_API_ENABLED) return null;
  const onlineLevel = onlineLevelForMap(map);
  const res = await fetch(`${SCORE_API_BASE}/api/scores?map=${onlineLevel}&seed=${seed}&season=${SCORE_SEASON}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return fetchCloudflareAiScores(map, seed);
  const scores = await res.json();
  return Array.isArray(scores)
    ? scores
        .map((score) => normalizeScoreEntry({
          ...score,
          map: mapFromOnlineLevel(score.map ?? score.level ?? onlineLevel, map),
          seed,
        }))
        .filter((score) => score.map === map)
    : [];
}
async function submitOnlineScore(entry) {
  if (!SCORE_API_ENABLED) return false;
  const score = normalizeScoreEntry(entry);
  const res = await fetch(`${SCORE_API_BASE}/api/scores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...score,
      map: onlineLevelForMap(score.map),
      level: onlineLevelForMap(score.map),
      season: SCORE_SEASON,
    }),
  });
  if (res.ok) return true;
  return submitCloudflareAiScore(entry);
}
async function fetchCloudflareAiScores(map, seed) {
  const onlineLevel = onlineLevelForMap(map);
  const res = await fetch(`${SCORE_API_BASE}/scores?limit=${ONLINE_FETCH_LIMIT}&level=${onlineLevel}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error("Could not load scores");
  const scores = await res.json();
  return Array.isArray(scores)
    ? scores
        .map((score) => {
          const rawLevel = Number(score.map ?? score.level);
          if (rawLevel !== onlineLevel) return null;
          return normalizeScoreEntry({
            initials: score.initials || score.player_name,
            score: score.score,
            map,
            seed,
            created_at: score.created_at,
          });
        })
        .filter(Boolean)
    : [];
}
async function submitCloudflareAiScore(entry) {
  const score = normalizeScoreEntry(entry);
  const res = await fetch(`${SCORE_API_BASE}/scores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      player_name: score.initials,
      score: score.score,
      level: onlineLevelForMap(score.map),
    }),
  });
  return res.ok;
}
function cleanInitials(v) {
  return (v || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 3);
}

const MEDALS = [
  { min: 101, name: "GOLD", color: "#f6d45f" },
  { min: 50, name: "SILVER", color: "#c8d0d8" },
  { min: 10, name: "BRONZE", color: "#c0793d" },
  { min: 1, name: "CLEAR", color: "#80d48b" },
  { min: -Infinity, name: "YOU SUCK", color: "#d04d5f" },
];
function medalFor(score) {
  return MEDALS.find((m) => score >= m.min) || MEDALS[MEDALS.length - 1];
}

function loadSoundPreference() {
  try {
    return localStorage.getItem(SOUND_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

function saveSoundPreference(on) {
  try {
    localStorage.setItem(SOUND_PREF_KEY, on ? "1" : "0");
  } catch {}
}

function createSynthAudio() {
  let ctx = null;
  let master = null;

  const ensure = () => {
    if (typeof window === "undefined") return null;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!ctx) {
      ctx = new AudioCtx();
      master = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.knee.value = 8;
      limiter.ratio.value = 10;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;
      master.gain.value = SFX_MASTER_VOLUME;
      master.connect(limiter);
      limiter.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };

  const tone = (c, start, freq, duration, options = {}) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = options.type || "square";
    osc.frequency.setValueAtTime(Math.max(1, freq), start);
    if (options.endFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, options.endFreq), start + duration);
    }
    const peak = Math.min(options.maxGain || 0.18, (options.gain || 0.03) * SFX_GAIN_BOOST);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peak, start + (options.attack || 0.004));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  };

  const noise = (c, start, duration, options = {}) => {
    const buffer = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * duration)), c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = c.createBufferSource();
    const filter = c.createBiquadFilter();
    const gain = c.createGain();
    source.buffer = buffer;
    filter.type = options.filterType || "bandpass";
    filter.frequency.setValueAtTime(options.frequency || 1800, start);
    filter.Q.setValueAtTime(options.q || 5, start);
    const peak = Math.min(options.maxGain || 0.16, (options.gain || 0.02) * SFX_GAIN_BOOST);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(start);
    source.stop(start + duration + 0.02);
  };

  return {
    resume() {
      ensure();
    },
    play(name, options = {}) {
      const c = ensure();
      if (!c) return;
      const now = c.currentTime + 0.006;
      const count = Number(options.count) || 0;
      const wobble = Number(options.value) || 0;

      if (name === "button" || name === "toggle") {
        tone(c, now, 164, 0.045, { type: "square", gain: 0.024, endFreq: 205 });
        tone(c, now + 0.028, 246, 0.055, { type: "triangle", gain: 0.016 });
      } else if (name === "select") {
        tone(c, now, 420, 0.035, { type: "triangle", gain: 0.018, endFreq: 520 });
      } else if (name === "move") {
        tone(c, now, 105 + (wobble % 45), 0.034, { type: "sawtooth", gain: 0.011, endFreq: 90 + (wobble % 55) });
      } else if (name === "rotate") {
        tone(c, now, 170 + (wobble % 70), 0.045, { type: "triangle", gain: 0.014, endFreq: 210 + (wobble % 80) });
      } else if (name === "aim") {
        tone(c, now, 480 + (wobble % 90), 0.05, { type: "sine", gain: 0.012, endFreq: 560 + (wobble % 100) });
      } else if (name === "bounce") {
        tone(c, now, 320 + count * 18, 0.065, { type: "triangle", gain: 0.03, endFreq: 395 + count * 19 });
        tone(c, now + 0.012, 640 + count * 20, 0.046, { type: "sine", gain: 0.01 });
      } else if (name === "wall") {
        noise(c, now, 0.07, { gain: 0.024, frequency: 2100, q: 7 });
        tone(c, now, 118, 0.04, { type: "square", gain: 0.015, endFreq: 70 });
        tone(c, now + 0.014, 980, 0.036, { type: "triangle", gain: 0.011, endFreq: 720 });
      } else if (name === "target") {
        tone(c, now, 392, 0.11, { type: "triangle", gain: 0.032 });
        tone(c, now + 0.07, 523, 0.13, { type: "triangle", gain: 0.028 });
        tone(c, now + 0.14, 784, 0.1, { type: "sine", gain: 0.012 });
      } else if (name === "record") {
        [440, 660, 880, 1320].forEach((freq, i) => {
          tone(c, now + i * 0.055, freq, 0.07, { type: i % 2 ? "triangle" : "square", gain: 0.028 - i * 0.003 });
        });
      }
    },
  };
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 760 || window.innerHeight > window.innerWidth * 1.25);
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);
  return isMobile;
}

function rebuildMirror(m) {
  const d = fromAngle(m.angle);
  return {
    ...m,
    a: add({ x: m.cx, y: m.cy }, mul(d, -m.length / 2)),
    b: add({ x: m.cx, y: m.cy }, mul(d, m.length / 2)),
  };
}

function makeStage(seed, index) {
  const r = rng(seed);
  const mirrorCount = 2 + Math.floor((index / Math.max(1, MAX_MAPS - 1)) * 18);
  const mirrors = [];

  for (let i = 0; i < mirrorCount; i++) {
    const cx = 80 + r() * 220;
    const cy = 70 + r() * 500;
    const length = 28 + r() * 56;
    const angle = r() * Math.PI * 2;
    mirrors.push(rebuildMirror({ cx, cy, length, angle }));
  }

  let target = { x: 210 + r() * 120, y: 100 + r() * 420, r: 12 };
  for (let tries = 0; tries < 80; tries++) {
    const ahead = target.x - SOURCE.x;
    const offset = Math.abs(target.y - SOURCE.y);
    if (ahead > 80 && offset > 35) break;
    target = { x: 210 + r() * 120, y: 100 + r() * 420, r: 12 };
  }

  return { mirrors, target };
}

function traceBeam(sourceAngle, mirrors, target) {
  let o = { ...SOURCE };
  let d = fromAngle(sourceAngle);
  const segments = [];
  const hitPoints = [];
  const wallHits = [];
  let reflections = 0;
  let didHit = false;

  for (let b = 0; b < TRACE_LIMIT; b++) {
    let best = null;
    for (let i = 0; i < mirrors.length; i++) {
      const h = raySegIntersect(o, d, mirrors[i].a, mirrors[i].b);
      if (h && (!best || h.t < best.t)) best = { ...h, idx: i };
    }

    const wall = rayPlayAreaHit(o, d);
    const stopT = Math.min(best ? best.t : Infinity, wall ? wall.t : Infinity, 9999);
    const end = add(o, mul(d, stopT));
    const ab = sub(end, o);
    const tt = clamp(dot(sub(target, o), ab) / Math.max(dot(ab, ab), EPS), 0, 1);
    const close = add(o, mul(ab, tt));

    if (len(sub(target, close)) <= target.r + 1) {
      segments.push({ from: o, to: close });
      didHit = true;
      break;
    }

    if (!best || (wall && wall.t <= best.t + EPS)) {
      segments.push({ from: o, to: end });
      if (wall && wall.t <= stopT + EPS) wallHits.push(wall);
      break;
    }

    segments.push({ from: o, to: best.point });
    hitPoints.push(best.point);
    const n = segNormal(mirrors[best.idx].a, mirrors[best.idx].b);
    d = norm(reflect(d, n));
    o = add(best.point, mul(d, 0.01));
    reflections++;
  }

  return { segments, hitPoints, wallHits, hit: didHit, reflections };
}

function pixelRect(ctx, x, y, w, h, fill, stroke = null) {
  ctx.fillStyle = fill;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
  }
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function fillRoundedRect(ctx, x, y, w, h, r, fill, shadow = null) {
  ctx.save();
  if (shadow) {
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = shadow.blur;
    ctx.shadowOffsetX = shadow.x || 0;
    ctx.shadowOffsetY = shadow.y || 0;
  }
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

function strokeRoundedRect(ctx, x, y, w, h, r, stroke, width = 1) {
  ctx.save();
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

function drawPixelLine(ctx, a, b, color, w = 2, outline = "#100d18") {
  ctx.lineCap = "butt";
  ctx.strokeStyle = outline;
  ctx.lineWidth = w + 2;
  ctx.beginPath();
  ctx.moveTo(Math.round(a.x), Math.round(a.y));
  ctx.lineTo(Math.round(b.x), Math.round(b.y));
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(Math.round(a.x), Math.round(a.y));
  ctx.lineTo(Math.round(b.x), Math.round(b.y));
  ctx.stroke();
}

function paintBackground(ctx, t) {
  ctx.fillStyle = "#0c0d0c";
  ctx.fillRect(0, 0, W, H);

  const outer = { x: 12, y: 12, w: W - 24, h: H - 24, r: 18 };
  const inner = PLAY_AREA;

  const frameGrad = ctx.createLinearGradient(outer.x, outer.y, outer.x + outer.w, outer.y + outer.h);
  frameGrad.addColorStop(0, "#8a8c87");
  frameGrad.addColorStop(0.2, "#4e514e");
  frameGrad.addColorStop(0.56, "#262827");
  frameGrad.addColorStop(1, "#777a74");
  fillRoundedRect(ctx, outer.x, outer.y, outer.w, outer.h, outer.r, frameGrad, {
    color: "rgba(0,0,0,0.72)",
    blur: 18,
    y: 8,
  });
  strokeRoundedRect(ctx, outer.x + 1, outer.y + 1, outer.w - 2, outer.h - 2, outer.r - 2, "rgba(230,232,225,0.18)", 2);
  strokeRoundedRect(ctx, outer.x + 8, outer.y + 8, outer.w - 16, outer.h - 16, 12, "rgba(0,0,0,0.55)", 8);

  const floorGrad = ctx.createLinearGradient(inner.x, inner.y, inner.x + inner.w, inner.y + inner.h);
  floorGrad.addColorStop(0, "#d1d3cd");
  floorGrad.addColorStop(0.5, "#bfc2bb");
  floorGrad.addColorStop(1, "#aeb1aa");
  fillRoundedRect(ctx, inner.x, inner.y, inner.w, inner.h, inner.r, floorGrad, {
    color: "rgba(0,0,0,0.65)",
    blur: 20,
    y: 2,
  });

  ctx.save();
  roundedRectPath(ctx, inner.x, inner.y, inner.w, inner.h, inner.r);
  ctx.clip();
  ctx.strokeStyle = "rgba(95,99,95,0.26)";
  ctx.lineWidth = 1;
  for (let x = inner.x + 52; x < inner.x + inner.w; x += 52) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, inner.y);
    ctx.lineTo(Math.round(x) + 0.5, inner.y + inner.h);
    ctx.stroke();
  }
  for (let y = inner.y + 52; y < inner.y + inner.h; y += 52) {
    ctx.beginPath();
    ctx.moveTo(inner.x, Math.round(y) + 0.5);
    ctx.lineTo(inner.x + inner.w, Math.round(y) + 0.5);
    ctx.stroke();
  }

  const noiseAlpha = 0.025;
  for (let i = 0; i < 240; i++) {
    const x = (i * 61 + 17) % inner.w + inner.x;
    const y = (i * 43 + 11) % inner.h + inner.y;
    ctx.fillStyle = i % 2 ? `rgba(255,255,255,${noiseAlpha})` : `rgba(40,42,38,${noiseAlpha})`;
    ctx.fillRect(x, y, 1, 1);
  }

  const vignette = ctx.createRadialGradient(W / 2, H / 2, 120, W / 2, H / 2, 340);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(0.72, "rgba(0,0,0,0.08)");
  vignette.addColorStop(1, "rgba(0,0,0,0.48)");
  ctx.fillStyle = vignette;
  ctx.fillRect(inner.x, inner.y, inner.w, inner.h);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "rgba(210,214,205,0.12)";
  ctx.lineWidth = 1;
  for (let y = outer.y + 28; y < outer.y + outer.h - 20; y += 92) {
    ctx.beginPath();
    ctx.moveTo(outer.x + 2, y);
    ctx.lineTo(outer.x + 10, y);
    ctx.moveTo(outer.x + outer.w - 10, y + 18);
    ctx.lineTo(outer.x + outer.w - 2, y + 18);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBeam(ctx, trace, t) {
  const pts = [SOURCE, ...trace.segments.map((s) => s.to)];
  if (pts.length < 2) return;
  const bounceEnergy = Math.min(1, trace.reflections / 12);
  const floorWidth = 13 + bounceEnergy * 9;
  const floorAlpha = 0.13 + bounceEnergy * 0.1;
  const haloWidth = 4 + bounceEnergy * 5;
  const midWidth = 1.4 + bounceEnergy * 1.4;
  const coreWidth = 0.8 + bounceEnergy * 0.5;
  const haloAlpha = 0.1 + bounceEnergy * 0.18;
  const midAlpha = 0.34 + bounceEnergy * 0.25;
  const pulseSize = 0.8 + bounceEnergy * 0.7;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  roundedRectPath(ctx, PLAY_AREA.x, PLAY_AREA.y, PLAY_AREA.w, PLAY_AREA.h, PLAY_AREA.r);
  ctx.clip();
  ctx.globalCompositeOperation = "screen";
  ctx.shadowColor = "rgba(71, 229, 255, 0.42)";
  ctx.shadowBlur = 18 + bounceEnergy * 14;
  ctx.strokeStyle = `rgba(48, 197, 244, ${floorAlpha})`;
  ctx.lineWidth = floorWidth;
  ctx.filter = "blur(1.2px)";
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y + 1.8);
    ctx.lineTo(b.x, b.y + 1.8);
    ctx.stroke();
  }

  ctx.filter = "none";
  ctx.shadowBlur = 8 + bounceEnergy * 8;
  ctx.strokeStyle = `rgba(185, 250, 255, ${0.18 + bounceEnergy * 0.1})`;
  ctx.lineWidth = 2.4 + bounceEnergy * 1.2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y + 2.2);
    ctx.lineTo(b.x, b.y + 2.2);
    ctx.stroke();
  }

  ctx.globalCompositeOperation = "lighter";

  const offset = (t * 0.08) % 22;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = sub(b, a);
    const L = len(seg);
    const d = norm(seg);

    ctx.shadowColor = "#45dfff";
    ctx.shadowBlur = 5 + bounceEnergy * 9;
    ctx.strokeStyle = `rgba(40, 210, 255, ${haloAlpha})`;
    ctx.lineWidth = haloWidth;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    ctx.shadowBlur = 3 + bounceEnergy * 6;
    ctx.strokeStyle = `rgba(85, 226, 255, ${midAlpha})`;
    ctx.lineWidth = midWidth;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    ctx.shadowBlur = 1.5 + bounceEnergy * 3;
    ctx.strokeStyle = "#f4fdff";
    ctx.lineWidth = coreWidth;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.9)";
    for (let p = offset; p < L; p += 22) {
      const q = add(a, mul(d, p));
      ctx.beginPath();
      ctx.arc(q.x, q.y, pulseSize, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function sourceHandlePos(angle) {
  return add(SOURCE, mul(fromAngle(angle), 34));
}
function mirrorHandlePos(m) {
  return add({ x: m.cx, y: m.cy }, mul(fromAngle(m.angle), m.length / 2 + 20));
}

function drawMirror(ctx, m, selected, hovered) {
  const width = selected || hovered ? 8 : 6;
  ctx.save();
  ctx.translate(m.cx, m.cy);
  ctx.rotate(m.angle);
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 1.5;
  ctx.shadowOffsetY = 4;
  fillRoundedRect(ctx, -m.length / 2 - 1, -width / 2 - 1, m.length + 2, width + 2, 3, "rgba(34,29,24,0.58)");
  ctx.shadowBlur = 0;

  const body = ctx.createLinearGradient(0, -width / 2, 0, width / 2);
  body.addColorStop(0, selected ? "#ffe29a" : "#c17a22");
  body.addColorStop(0.2, "#f2a43a");
  body.addColorStop(0.55, "#8d4f13");
  body.addColorStop(1, "#51310f");
  fillRoundedRect(ctx, -m.length / 2, -width / 2, m.length, width, 3, body);
  fillRoundedRect(ctx, -m.length / 2 + 4, -1.5, m.length - 8, 3, 1.5, "rgba(232,248,255,0.74)");
  fillRoundedRect(ctx, -m.length / 2 + 5, -0.5, m.length - 10, 1, 0.5, "rgba(37,87,116,0.42)");
  if (selected || hovered) {
    strokeRoundedRect(ctx, -m.length / 2 - 1, -width / 2 - 1, m.length + 2, width + 2, 3, selected ? "#ffe7a5" : "rgba(235,240,238,0.6)", 1);
  }
  ctx.restore();

  fillRoundedRect(ctx, m.cx - 2.5, m.cy - 2.5, 5, 5, 2, selected ? "#ffe49b" : "#58656b");
  const handle = mirrorHandlePos(m);
  fillRoundedRect(ctx, handle.x - 4, handle.y - 4, 8, 8, 3, selected ? "#ffd56d" : "#c06b2d", {
    color: "rgba(0,0,0,0.26)",
    blur: 3,
    y: 2,
  });
  strokeRoundedRect(ctx, handle.x - 4, handle.y - 4, 8, 8, 3, "#6b3510", 0.8);
}

function drawSource(ctx, angle, selected) {
  ctx.save();
  fillRoundedRect(ctx, SOURCE.x - 16, SOURCE.y - 16, 32, 32, 5, "#58646f", {
    color: "rgba(0,0,0,0.48)",
    blur: 8,
    x: 5,
    y: 7,
  });
  const body = ctx.createLinearGradient(SOURCE.x - 16, SOURCE.y - 16, SOURCE.x + 16, SOURCE.y + 16);
  body.addColorStop(0, "#b9c4cf");
  body.addColorStop(0.48, "#6f7f8f");
  body.addColorStop(1, "#2e3b47");
  fillRoundedRect(ctx, SOURCE.x - 14, SOURCE.y - 14, 28, 28, 4, body);
  strokeRoundedRect(ctx, SOURCE.x - 14, SOURCE.y - 14, 28, 28, 4, "#26313b", 2);
  for (const sx of [-9, 9]) {
    for (const sy of [-9, 9]) {
      ctx.fillStyle = "#1f2830";
      ctx.beginPath();
      ctx.arc(SOURCE.x + sx, SOURCE.y + sy, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.shadowColor = "#61e4ff";
  ctx.shadowBlur = selected ? 18 : 12;
  fillRoundedRect(ctx, SOURCE.x - 6, SOURCE.y - 7, 12, 14, 3, "#78e9ff");
  fillRoundedRect(ctx, SOURCE.x - 2, SOURCE.y - 4, 6, 8, 2, "#ecfdff");
  ctx.restore();

  const tip = add(SOURCE, mul(fromAngle(angle), 24));
  ctx.save();
  ctx.lineCap = "round";
  ctx.shadowColor = "#61e4ff";
  ctx.shadowBlur = 8;
  ctx.strokeStyle = "#dffbff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(SOURCE.x, SOURCE.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.restore();

  const handle = sourceHandlePos(angle);
  fillRoundedRect(ctx, handle.x - 5, handle.y - 5, 10, 10, 5, selected ? "#f8fdff" : "#6de8ff", {
    color: "#61e4ff",
    blur: 9,
  });
  strokeRoundedRect(ctx, handle.x - 5, handle.y - 5, 10, 10, 5, "#174c59", 1);
}

function drawTarget(ctx, target, hit, t, activeAttempt) {
  const pulse = Math.floor(t * 0.01) % 10 < 5;
  fillRoundedRect(ctx, target.x - 13, target.y - 13, 26, 26, 3, "#25543b", {
    color: "rgba(0,0,0,0.42)",
    blur: 7,
    x: 4,
    y: 6,
  });
  strokeRoundedRect(ctx, target.x - 13, target.y - 13, 26, 26, 3, "#133021", 2);
  ctx.save();
  ctx.shadowColor = hit && activeAttempt ? "#94ffb3" : "#58cf7d";
  ctx.shadowBlur = hit && activeAttempt ? 16 : pulse ? 9 : 4;
  fillRoundedRect(ctx, target.x - 7, target.y - 7, 14, 14, 2, hit && activeAttempt ? "#d7ffe1" : "#79d98f");
  fillRoundedRect(ctx, target.x - 3, target.y - 3, 6, 6, 1, hit && activeAttempt ? "#ffffff" : "#b6ffc4");
  ctx.restore();
}

function drawImpactSparks(ctx, points, t) {
  for (let i = 0; i < Math.min(points.length, 220); i++) {
    const p = points[i];
    const phase = Math.floor(t * 0.02 + i) % 4;
    ctx.save();
    ctx.shadowColor = phase < 2 ? "#ffe08a" : "#8ae8ff";
    ctx.shadowBlur = 6;
    ctx.fillStyle = phase < 2 ? "#ffe08a" : "#8ae8ff";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function wallNormal(side) {
  if (side === "left") return { x: 1, y: 0 };
  if (side === "right") return { x: -1, y: 0 };
  if (side === "top") return { x: 0, y: 1 };
  return { x: 0, y: -1 };
}

function drawWallSparks(ctx, hits, t, reflections) {
  const energy = Math.min(1, reflections / 12);
  for (let h = 0; h < Math.min(hits.length, 8); h++) {
    const hit = hits[h];
    const p = hit.point;
    const normal = wallNormal(hit.side);
    const tangent = { x: -normal.y, y: normal.x };
    const base = angleOf(normal);
    const pulse = 0.55 + 0.45 * Math.sin(t * 0.038 + h * 1.7);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.shadowColor = "#75eaff";
    ctx.shadowBlur = 14 + energy * 12;
    ctx.fillStyle = `rgba(244, 253, 255, ${0.65 + pulse * 0.25})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.1 + energy * 1.1, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(150, 242, 255, 0.64)";
    ctx.lineWidth = 1.1;
    for (const side of [-1, 1]) {
      const a = add(p, mul(tangent, side * (3 + pulse * 2)));
      const b = add(p, mul(tangent, side * (10 + energy * 3)));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (let i = 0; i < 11; i++) {
      const spread = -1.05 + i * 0.21;
      const jitter = Math.sin(t * 0.021 + i * 2.13 + h) * 0.18;
      const a = base + spread + jitter;
      const dir = fromAngle(a);
      const lenSpark = (7 + ((i * 7 + h * 3) % 10)) * (0.78 + pulse * 0.5 + energy * 0.45);
      const start = add(p, mul(normal, 1.2));
      const end = add(start, mul(dir, lenSpark));

      ctx.strokeStyle = i % 3 === 0 ? "rgba(255, 223, 127, 0.94)" : "rgba(107, 232, 255, 0.84)";
      ctx.lineWidth = i % 3 === 0 ? 1.45 : 1;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();

      if (i % 4 === 1) {
        ctx.fillStyle = "rgba(255, 238, 168, 0.8)";
        ctx.beginPath();
        ctx.arc(end.x, end.y, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

function drawHUD(ctx, map, trace, best, hasInteracted, compact = false) {
  if (compact) return;
  fillRoundedRect(ctx, 14, 16, 230, 60, 4, "rgba(35,38,42,0.68)", {
    color: "rgba(0,0,0,0.25)",
    blur: 8,
    y: 3,
  });
  strokeRoundedRect(ctx, 14, 16, 230, 60, 4, "rgba(255,255,255,0.24)", 1);
  ctx.fillStyle = "#f3f2e7";
  ctx.font = "bold 11px monospace";
  ctx.fillText(`MAP ${map + 1}/${MAX_MAPS}`, 24, 34);
  ctx.fillStyle = "#77e3ff";
  ctx.fillText(`BOUNCES ${trace.reflections}`, 114, 34);
  ctx.fillStyle = "#f4d35e";
  ctx.fillText(`SCORE ${hasInteracted ? trace.reflections : "--"}`, 24, 52);
  ctx.fillStyle = "#a3acc0";
  ctx.fillText(`BEST ${best == null ? "--" : best}`, 114, 52);
  ctx.fillStyle = "#7f90ad";
  ctx.fillText(trace.hit && hasInteracted ? "TARGET LOCK" : "DRAG / ROTATE", 24, 68);
}

function drawMedal(ctx, text, color, subline) {
  pixelRect(ctx, 48, 255, 264, 86, "#12131d", "#8a7a46");
  pixelRect(ctx, 52, 259, 256, 78, "#1c1d2a", "#3a3c55");
  ctx.fillStyle = color;
  ctx.font = "bold 28px monospace";
  ctx.textAlign = "center";
  ctx.fillText(text, 180, 292);
  ctx.fillStyle = "#e8e3d4";
  ctx.font = "bold 12px monospace";
  ctx.fillText(subline, 180, 318);
  ctx.textAlign = "start";
}

function TopControls({ nextMap, resetMap, soundOn, toggleSound }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <button onClick={nextMap} className="flex-1 px-3 py-2 border-2 border-[#5a6272] bg-[#272433] hover:bg-[#333047] font-bold text-sm text-[#e9e3d1]">NEXT MAP</button>
        <button onClick={resetMap} className="flex-1 px-3 py-2 border-2 border-[#5a6272] bg-[#272433] hover:bg-[#333047] font-bold text-sm text-[#e9e3d1]">RESET</button>
      </div>
      <button onClick={toggleSound} className={`px-3 py-2 border-2 font-black text-[10px] ${soundOn ? "border-[#8a7a46] bg-[#f4d35e] text-black" : "border-[#5a6272] bg-[#1f1c29] text-[#d3d8e2]"}`}>
        {soundOn ? "SFX ON" : "SFX OFF"}
      </button>
    </div>
  );
}

function MobileTopBar({ map, score, best, hasInteracted, nextMap, resetMap, soundOn, toggleSound }) {
  return (
    <div className="w-full max-w-[380px] border-2 border-[#61543a] bg-[#15111a] px-2 py-2 text-[#e9e3d1] shadow-[0_0_0_2px_#09070d]">
      <div className="flex items-center gap-2">
        <div className="flex-1 grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] leading-none font-mono">
          <span className="text-[#f4d35e] font-black">MAP {map + 1}</span>
          <span className="text-[#77e3ff] font-black">SCORE {hasInteracted ? score : "--"}</span>
          <span className="text-[#9aa4b7]">BEST {best == null ? "--" : best}</span>
          <span className="text-[#9aa4b7]">DRAG / ROTATE</span>
        </div>
        <button onClick={nextMap} className="px-2 py-2 border-2 border-[#5a6272] bg-[#272433] text-[10px] font-black">NEXT</button>
        <button onClick={resetMap} className="px-2 py-2 border-2 border-[#5a6272] bg-[#272433] text-[10px] font-black">RESET</button>
        <button onClick={toggleSound} className={`px-2 py-2 border-2 text-[10px] font-black ${soundOn ? "border-[#8a7a46] bg-[#f4d35e] text-black" : "border-[#5a6272] bg-[#1f1c29] text-[#d3d8e2]"}`}>{soundOn ? "SFX" : "OFF"}</button>
      </div>
    </div>
  );
}

function ScoreboardPanel({ map, scores, currentScore, best, hasInteracted, nextMap, resetMap, scoreStatus, soundOn, toggleSound }) {
  return (
    <div className="mirror-panel w-56 border-2 border-[#61543a] bg-[#15111a] text-[#e9e3d1] shadow-[0_0_0_2px_#09070d] overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b-2 border-[#3e4250] bg-[#201a26]">
        <TopControls nextMap={nextMap} resetMap={resetMap} soundOn={soundOn} toggleSound={toggleSound} />
        <div className="mt-4 text-[11px] font-black tracking-[0.22em] text-[#f4d35e]">CURRENT MAP</div>
        <div className="mt-1 flex justify-between text-[11px] text-[#9aa4b7]"><span>MAP {map + 1}</span><span>BEST {best == null ? "--" : best}</span></div>
        <div className="mt-2 flex justify-between text-[10px] text-[#7f90ad]"><span>initials on record</span><span>{scoreStatus}</span></div>
      </div>
      <div className="flex-1 px-3 py-3 text-xs overflow-y-auto">
        {scores.length === 0 ? (
          <div className="border border-[#3e4250] bg-[#0f0d14] p-3 text-[#8b94a7]">No records yet.</div>
        ) : (
          scores.map((s, i) => (
            <div key={`${s.initials}-${s.score}-${s.time}-${i}`} className={`mb-2 grid grid-cols-[24px_1fr_64px] items-center gap-2 border px-2 py-2 ${i === 0 ? "border-[#a3883a] bg-[#2a2413]" : "border-[#303341] bg-[#100e15]"}`}>
              <span className="text-[#7f90ad] font-black">{String(i + 1).padStart(2, "0")}</span>
              <span className="font-black tracking-widest text-[#f0ead8]">{s.initials}</span>
              <span className="text-right font-black text-[#77e3ff]">M{String(s.map + 1).padStart(2, "0")} {s.score}</span>
            </div>
          ))
        )}
      </div>
      <div className="px-4 py-3 border-t-2 border-[#3e4250] bg-[#1a1620] text-[11px] flex justify-between">
        <span className="text-[#9aa4b7]">CURRENT</span><span className="font-black text-[#77e3ff]">{hasInteracted ? currentScore : "--"}</span>
      </div>
    </div>
  );
}

function InstructionsPanel() {
  return (
    <div className="mirror-panel mirror-instructions w-56 border-2 border-[#61543a] bg-[#15111a] text-[#e9e3d1] shadow-[0_0_0_2px_#09070d] overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b-2 border-[#3e4250] bg-[#201a26]">
        <div className="text-[11px] font-black tracking-[0.22em] text-[#f4d35e]">HOW TO PLAY</div>
        <div className="mt-1 text-[11px] text-[#9aa4b7]">Hit the green target.</div>
      </div>
      <div className="flex-1 px-4 py-3 text-xs overflow-y-auto">
        <div className="mirror-help-block">
          <div className="mirror-help-title">MOVE</div>
          <p>Drag a mirror to move it. Drag the orange handle to rotate it.</p>
        </div>
        <div className="mirror-help-block">
          <div className="mirror-help-title">SOURCE</div>
          <p>Drag the blue source handle to aim the beam.</p>
        </div>
        <div className="mirror-help-block">
          <div className="mirror-help-title">SCORE</div>
          <p>Each mirror bounce before the target is worth 1 point. More bounces means a higher score.</p>
        </div>
        <div className="mirror-help-block">
          <div className="mirror-help-title">RECORDS</div>
          <p>If you beat the map record, enter initials. If not, choose retry or next map.</p>
        </div>
      </div>
    </div>
  );
}

function MobileRecordsOverlay({ map, scores, best, score, nextMap, resetMap, scoreStatus }) {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/72 px-4">
      <div className="w-full max-w-xs max-h-[82vh] border-2 border-[#61543a] bg-[#15111a] text-[#e9e3d1] shadow-[0_0_0_2px_#09070d] flex flex-col">
        <div className="px-4 py-3 border-b-2 border-[#3e4250] bg-[#201a26]">
          <div className="text-[11px] font-black tracking-[0.22em] text-[#f4d35e]">MAP FINISHED</div>
          <div className="mt-2 flex justify-between text-xs"><span>MAP {map + 1}</span><span className="text-[#77e3ff] font-black">SCORE {score}</span></div>
          <div className="mt-1 flex justify-between text-[11px] text-[#9aa4b7]"><span>BEST {best == null ? "--" : best}</span><span>{scoreStatus}</span></div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 text-xs">
          {scores.length === 0 ? (
            <div className="border border-[#3e4250] bg-[#0f0d14] p-3 text-[#8b94a7]">No records yet.</div>
          ) : (
            scores.map((s, i) => (
              <div key={`${s.initials}-${s.score}-${s.time}-${i}`} className={`mb-2 grid grid-cols-[24px_1fr_64px] items-center gap-2 border px-2 py-2 ${i === 0 ? "border-[#a3883a] bg-[#2a2413]" : "border-[#303341] bg-[#100e15]"}`}>
                <span className="text-[#7f90ad] font-black">{String(i + 1).padStart(2, "0")}</span>
                <span className="font-black tracking-widest text-[#f0ead8]">{s.initials}</span>
                <span className="text-right font-black text-[#77e3ff]">M{String(s.map + 1).padStart(2, "0")} {s.score}</span>
              </div>
            ))
          )}
        </div>
        <div className="p-3 border-t-2 border-[#3e4250] flex gap-2">
          <button onClick={nextMap} className="flex-1 px-3 py-2 border-2 border-[#5a6272] bg-[#272433] font-black text-sm">NEXT</button>
          <button onClick={resetMap} className="flex-1 px-3 py-2 border-2 border-[#5a6272] bg-[#272433] font-black text-sm">RETRY</button>
        </div>
      </div>
    </div>
  );
}

function InitialsModal({ pendingScore, initials, setInitials, submitInitials, skipInitials }) {
  if (!pendingScore) return null;
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70">
      <div className="w-80 border-2 border-[#8a7a46] bg-[#15111a] p-5 text-center text-[#e9e3d1] shadow-[0_0_0_2px_#09070d]">
        <div className="text-xs font-black tracking-[0.28em] text-[#f4d35e]">NEW MAP RECORD</div>
        <div className="mt-2 text-5xl font-black text-[#f4d35e]">{pendingScore.score}</div>
        <div className="mt-1 text-sm text-[#9aa4b7]">MAP {pendingScore.map + 1} • enter initials</div>
        <input
          autoFocus
          value={initials}
          onChange={(e) => setInitials(cleanInitials(e.target.value))}
          onKeyDown={(e) => { if (e.key === "Enter") submitInitials(); if (e.key === "Escape") skipInitials(); }}
          maxLength={3}
          className="mt-5 w-40 border-2 border-[#5a6272] bg-[#09080c] px-4 py-3 text-center text-3xl font-black tracking-[0.32em] text-[#77e3ff] outline-none"
          placeholder="AAA"
        />
        <div className="mt-5 flex justify-center gap-2">
          <button onClick={submitInitials} className="border-2 border-[#8a7a46] bg-[#f4d35e] px-4 py-2 text-sm font-black text-black">SAVE</button>
          <button onClick={skipInitials} className="border-2 border-[#5a6272] bg-[#1f1c29] px-4 py-2 text-sm font-bold text-[#d3d8e2]">SKIP</button>
        </div>
      </div>
    </div>
  );
}

function ClearModal({ map, score, best, nextMap, resetMap }) {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/70">
      <div className="w-80 border-2 border-[#61543a] bg-[#15111a] p-5 text-center text-[#e9e3d1] shadow-[0_0_0_2px_#09070d]">
        <div className="text-xs font-black tracking-[0.28em] text-[#f4d35e]">TARGET HIT</div>
        <div className="mt-2 text-5xl font-black text-[#77e3ff]">{score}</div>
        <div className="mt-1 text-sm text-[#9aa4b7]">MAP {map + 1} • BEST {best == null ? "--" : best}</div>
        <div className="mt-5 flex justify-center gap-2">
          <button onClick={resetMap} className="border-2 border-[#5a6272] bg-[#1f1c29] px-4 py-2 text-sm font-bold text-[#d3d8e2]">TRY AGAIN</button>
          <button onClick={nextMap} className="border-2 border-[#8a7a46] bg-[#f4d35e] px-4 py-2 text-sm font-black text-black">NEXT MAP</button>
        </div>
      </div>
    </div>
  );
}

function SplashScreen({ enterGame }) {
  return (
    <div className="fixed inset-0 z-20 mirror-splash flex items-center justify-center">
      <div className="mirror-splash-card">
        <div className="mirror-splash-kicker">EDGEHOG SYSTEMS</div>
        <div className="mirror-splash-title">MIRROR BEAM</div>
        <div className="mirror-splash-rule">More reflections. More points.</div>
        <p>Angle the source, tune the mirrors, and hit the green target.</p>
        <button onClick={enterGame} className="mirror-splash-button">ENTER GAME</button>
      </div>
    </div>
  );
}

export default function App() {
  const canvasRef = useRef(null);
  const isMobile = useIsMobile();
  const [map, setMap] = useState(0);
  const [mapAttempt, setMapAttempt] = useState(0);
  const [mirrors, setMirrors] = useState([]);
  const [target, setTarget] = useState({ x: 300, y: 320, r: 12 });
  const [sourceAngle, setSourceAngle] = useState(0);
  const [drag, setDrag] = useState(null);
  const [hoverMirror, setHoverMirror] = useState(null);
  const [trace, setTrace] = useState({ segments: [], hitPoints: [], wallHits: [], hit: false, reflections: 0 });
  const [celebrate, setCelebrate] = useState(false);
  const [lastMedal, setLastMedal] = useState(null);
  const [prevBest, setPrevBest] = useState(null);
  const [pendingScore, setPendingScore] = useState(null);
  const [initials, setInitials] = useState("AAA");
  const [scoreVersion, setScoreVersion] = useState(0);
  const [onlineScores, setOnlineScores] = useState([]);
  const [scoreStatus, setScoreStatus] = useState(SCORE_API_ENABLED ? "SYNCING" : "LOCAL");
  const [hasInteracted, setHasInteracted] = useState(false);
  const [hasClearedThisAttempt, setHasClearedThisAttempt] = useState(false);
  const [soundOn, setSoundOn] = useState(loadSoundPreference);
  const [introOpen, setIntroOpen] = useState(true);
  const audioRef = useRef(null);
  const soundOnRef = useRef(soundOn);
  const dragSoundAtRef = useRef(0);
  const beamSoundRef = useRef({ reflections: 0, wallKey: "", wallAt: 0 });

  const finalScore = trace.reflections;
  const seed = stageSeed(map);
  const scores = useMemo(() => currentMapScores(mergeScores(loadScores(seed), onlineScores), map), [map, seed, scoreVersion, onlineScores]);
  const localBest = loadBest(seed);
  const best = scores.length ? Math.max(localBest == null ? -Infinity : localBest, scores[0].score) : localBest;

  useEffect(() => {
    clearLegacyScoreStorage();
  }, []);

  useEffect(() => {
    soundOnRef.current = soundOn;
  }, [soundOn]);

  const primeSound = () => {
    if (!soundOnRef.current) return;
    if (!audioRef.current) audioRef.current = createSynthAudio();
    audioRef.current.resume();
  };

  const playSound = (name, options = {}) => {
    if (!soundOnRef.current) return;
    if (!audioRef.current) audioRef.current = createSynthAudio();
    audioRef.current.play(name, options);
  };

  const toggleSound = () => {
    const next = !soundOnRef.current;
    soundOnRef.current = next;
    saveSoundPreference(next);
    setSoundOn(next);
    if (next) {
      if (!audioRef.current) audioRef.current = createSynthAudio();
      audioRef.current.resume();
      audioRef.current.play("toggle");
    }
  };

  const enterGame = () => {
    primeSound();
    playSound("button");
    setIntroOpen(false);
  };

  useEffect(() => {
    const workingSeed = stageSeed(map) + mapAttempt * 99991;
    const s = makeStage(workingSeed, map);
    setMirrors(s.mirrors.map(rebuildMirror));
    setTarget(s.target);
    setSourceAngle(0);
    setCelebrate(false);
    setLastMedal(null);
    setPrevBest(null);
    setPendingScore(null);
    setHasInteracted(false);
    setHasClearedThisAttempt(false);
    beamSoundRef.current = { reflections: 0, wallKey: "", wallAt: 0 };
  }, [map, mapAttempt]);

  useEffect(() => {
    setTrace(traceBeam(sourceAngle, mirrors, target));
  }, [sourceAngle, mirrors, target]);

  useEffect(() => {
    let cancelled = false;
    setOnlineScores([]);

    if (!SCORE_API_ENABLED) {
      setScoreStatus("LOCAL");
      return () => {};
    }

    setScoreStatus("SYNCING");
    fetchOnlineScores(map, seed)
      .then((remoteScores) => {
        if (cancelled || !remoteScores) return;
        const merged = currentMapScores(mergeScores(loadScores(seed), remoteScores), map);
        saveScores(seed, merged);
        setOnlineScores(remoteScores);
        setScoreStatus("ONLINE");
      })
      .catch(() => {
        if (!cancelled) setScoreStatus("OFFLINE");
      });

    return () => {
      cancelled = true;
    };
  }, [map, seed, scoreVersion]);

  useEffect(() => {
    const prev = beamSoundRef.current;
    if (!hasInteracted || hasClearedThisAttempt) {
      prev.reflections = trace.reflections;
      prev.wallKey = "";
      return;
    }

    if (trace.reflections > prev.reflections) {
      playSound("bounce", { count: trace.reflections });
    }

    const wall = (trace.wallHits || [])[0];
    if (wall && !trace.hit) {
      const key = `${wall.side}:${Math.round(wall.point.x / 6)}:${Math.round(wall.point.y / 6)}`;
      const now = performance.now();
      if (key !== prev.wallKey || now - prev.wallAt > 240) {
        playSound("wall", { count: trace.reflections });
        prev.wallKey = key;
        prev.wallAt = now;
      }
    } else {
      prev.wallKey = "";
    }

    prev.reflections = trace.reflections;
  }, [trace, hasInteracted, hasClearedThisAttempt]);

  useEffect(() => {
    if (!hasInteracted || !trace.hit || pendingScore || hasClearedThisAttempt) return;

    const oldBest = best;
    setPrevBest(oldBest);
    setLastMedal(medalFor(finalScore));
    setCelebrate(true);
    setHasClearedThisAttempt(true);

    const beatsRecord = oldBest == null || finalScore > oldBest;
    playSound(beatsRecord ? "record" : "target", { score: finalScore });
    if (beatsRecord) {
      saveBest(seed, finalScore);
      setInitials("AAA");
      setPendingScore({ map, seed, score: finalScore, time: Date.now() });
    }
  }, [hasInteracted, trace.hit, finalScore, seed, map, pendingScore, hasClearedThisAttempt, isMobile, best]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const fit = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);

      if (isMobile) {
        const maxW = Math.max(260, window.innerWidth - 16);
        const maxH = Math.max(360, window.innerHeight - 78);
        const cssW = Math.floor(Math.min(maxW, maxH * (W / H)));
        const cssH = Math.floor(cssW * (H / W));
        canvas.style.width = cssW + "px";
        canvas.style.height = cssH + "px";
        document.documentElement.style.setProperty("--mirror-frame-h", `${cssH + 20}px`);
      } else {
        const panelWidth = 224 * 2;
        const gaps = 16 * 2;
        const pagePad = 32;
        const frameChrome = 20;
        const maxW = Math.max(300, window.innerWidth - panelWidth - gaps - pagePad - frameChrome);
        const maxH = Math.max(520, window.innerHeight - 32 - frameChrome);
        const cssH = Math.floor(Math.min(maxH, maxW * (H / W)));
        const cssW = Math.floor(cssH * (W / H));
        canvas.style.width = cssW + "px";
        canvas.style.height = cssH + "px";
        document.documentElement.style.setProperty("--mirror-frame-h", `${cssH + frameChrome}px`);
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    };
    fit();
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);

    let raf = 0;
    const draw = () => {
      const t = performance.now();
      paintBackground(ctx, t);
      drawSource(ctx, sourceAngle, drag?.type === "source-rotate");
      drawBeam(ctx, trace, t);
      drawImpactSparks(ctx, trace.hitPoints, t);
      drawWallSparks(ctx, trace.wallHits || [], t, trace.reflections);
      for (let i = 0; i < mirrors.length; i++) drawMirror(ctx, mirrors[i], drag?.idx === i, hoverMirror === i);
      drawTarget(ctx, target, trace.hit, t, hasInteracted);
      drawHUD(ctx, map, trace, best, hasInteracted, isMobile);
      if (!isMobile && celebrate && lastMedal && !pendingScore && hasInteracted && hasClearedThisAttempt) {
        const bestLine = prevBest != null ? `best ${prevBest}` : "no record";
        drawMedal(ctx, lastMedal.name, lastMedal.color, `${finalScore} pts • ${bestLine}`);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
    };
  }, [mirrors, target, sourceAngle, trace, celebrate, lastMedal, prevBest, hoverMirror, drag, best, map, finalScore, pendingScore, hasInteracted, hasClearedThisAttempt, isMobile]);

  const getLocal = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: ((p.clientX - rect.left) / rect.width) * W, y: ((p.clientY - rect.top) / rect.height) * H };
  };

  const onDown = (e) => {
    e.preventDefault();
    primeSound();
    const p = getLocal(e);
    if (len(sub(p, sourceHandlePos(sourceAngle))) < 11) {
      playSound("select");
      setDrag({ type: "source-rotate" });
      return;
    }
    for (let i = mirrors.length - 1; i >= 0; i--) {
      const m = mirrors[i];
      if (len(sub(p, mirrorHandlePos(m))) < 11) {
        playSound("select");
        setDrag({ type: "mirror-rotate", idx: i });
        return;
      }
      if (pointSegDist(p, m.a, m.b) < 11) {
        playSound("select");
        setDrag({ type: "mirror-move", idx: i, x: p.x, y: p.y });
        return;
      }
    }
  };

  const onMove = (e) => {
    const p = getLocal(e);
    let hovered = null;
    for (let i = mirrors.length - 1; i >= 0; i--) {
      if (pointSegDist(p, mirrors[i].a, mirrors[i].b) < 11 || len(sub(p, mirrorHandlePos(mirrors[i]))) < 11) {
        hovered = i;
        break;
      }
    }
    setHoverMirror(hovered);
    if (!drag) return;
    e.preventDefault();
    setHasInteracted(true);
    setCelebrate(false);
    const now = performance.now();
    if (now - dragSoundAtRef.current > 115) {
      const name = drag.type === "source-rotate" ? "aim" : drag.type === "mirror-rotate" ? "rotate" : "move";
      playSound(name, { value: p.x + p.y + sourceAngle * 100 });
      dragSoundAtRef.current = now;
    }

    if (drag.type === "source-rotate") {
      setSourceAngle(angleOf(sub(p, SOURCE)));
      return;
    }

    if (drag.type === "mirror-move") {
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      setMirrors((ms) => ms.map((m, i) => i === drag.idx ? rebuildMirror({ ...m, cx: m.cx + dx, cy: m.cy + dy }) : m));
      setDrag({ ...drag, x: p.x, y: p.y });
      return;
    }

    if (drag.type === "mirror-rotate") {
      setMirrors((ms) => ms.map((m, i) => {
        if (i !== drag.idx) return m;
        const targetAngle = angleOf(sub(p, { x: m.cx, y: m.cy }));
        const ease = e.shiftKey ? 0.16 : 0.42;
        return rebuildMirror({ ...m, angle: easeAngle(m.angle, targetAngle, ease) });
      }));
    }
  };

  const onUp = () => setDrag(null);

  const nextMap = () => {
    playSound("button");
    setPendingScore(null);
    setMap((m) => (m + 1) % MAX_MAPS);
  };

  const resetMap = () => {
    playSound("button");
    setPendingScore(null);
    setMapAttempt((a) => a + 1);
  };

  const submitInitials = () => {
    if (!pendingScore) return;
    playSound("button");
    const name = cleanInitials(initials) || "AAA";
    const entry = { initials: name, score: pendingScore.score, map: pendingScore.map, seed: pendingScore.seed, time: pendingScore.time };
    addScore(pendingScore.seed, entry);
    saveBest(pendingScore.seed, pendingScore.score);
    setScoreVersion((v) => v + 1);
    if (SCORE_API_ENABLED) {
      setScoreStatus("SYNCING");
      submitOnlineScore(entry)
        .then((ok) => setScoreStatus(ok ? "ONLINE" : "OFFLINE"))
        .catch(() => setScoreStatus("OFFLINE"));
    }
    setPendingScore(null);
    setMap((pendingScore.map + 1) % MAX_MAPS);
  };

  const skipInitials = () => {
    if (!pendingScore) return;
    playSound("button");
    saveBest(pendingScore.seed, pendingScore.score);
    setPendingScore(null);
    setMap((pendingScore.map + 1) % MAX_MAPS);
  };

  if (isMobile) {
    return (
      <div className="w-full h-screen bg-[#07070d] flex flex-col items-center justify-start select-none overflow-hidden p-2 gap-2">
        <MobileTopBar map={map} score={finalScore} best={best} hasInteracted={hasInteracted} nextMap={nextMap} resetMap={resetMap} soundOn={soundOn} toggleSound={toggleSound} />

        <div className="relative border-2 border-[#61543a] bg-[#100d14] p-2 shadow-[0_0_0_2px_#09070d] flex items-center justify-center">
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            className="block bg-black cursor-crosshair touch-none"
            style={{ imageRendering: "auto" }}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onMouseLeave={onUp}
            onTouchStart={onDown}
            onTouchMove={onMove}
            onTouchEnd={onUp}
          />
        </div>

        {hasClearedThisAttempt && !pendingScore && (
          <MobileRecordsOverlay map={map} scores={scores} best={best} score={finalScore} nextMap={nextMap} resetMap={resetMap} scoreStatus={scoreStatus} />
        )}

        <InitialsModal pendingScore={pendingScore} initials={initials} setInitials={setInitials} submitInitials={submitInitials} skipInitials={skipInitials} />
        {introOpen && <SplashScreen enterGame={enterGame} />}
      </div>
    );
  }

  return (
    <div className="mirror-desktop w-full h-screen bg-[#07070d] flex items-center justify-center select-none overflow-hidden">
      <div className="mirror-layout flex items-stretch gap-4">
        <ScoreboardPanel
          map={map}
          scores={scores}
          currentScore={finalScore}
          best={best}
          hasInteracted={hasInteracted}
          nextMap={nextMap}
          resetMap={resetMap}
          scoreStatus={scoreStatus}
          soundOn={soundOn}
          toggleSound={toggleSound}
        />

        <div className="mirror-stage relative border-2 border-[#61543a] bg-[#100d14] p-2 shadow-[0_0_0_2px_#09070d] flex items-center">
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            className="block bg-black cursor-crosshair"
            style={{ imageRendering: "auto" }}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onMouseLeave={onUp}
            onTouchStart={onDown}
            onTouchMove={onMove}
            onTouchEnd={onUp}
          />
        </div>

        <InstructionsPanel />
      </div>

      {hasClearedThisAttempt && !pendingScore && (
        <ClearModal map={map} score={finalScore} best={best} nextMap={nextMap} resetMap={resetMap} />
      )}

      <InitialsModal pendingScore={pendingScore} initials={initials} setInitials={setInitials} submitInitials={submitInitials} skipInitials={skipInitials} />
      {introOpen && <SplashScreen enterGame={enterGame} />}
    </div>
  );
}
