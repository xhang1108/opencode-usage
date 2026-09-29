// extension/dashboard/views/decor.js
// Decorative neural-network canvas background. Self-contained: reads only the
// #neuralCanvas element and window size. The graph geometry is built by
// neural-layout.js (pure); this file owns the canvas, clock and highlights.

import { buildNeuralLayout } from "./neural-layout.js";

let _neuralRAF = 0;
let _neuralLayers = [];
let _neuralEdges = [];
let _neuralHighlights = [];
let _neuralW = 0;
let _neuralH = 0;
let _neuralNextHL = 0;
let _neuralRecentPaths = [];
// Load gate: while the dashboard is loading we stop scheduling frames so the
// decorative canvas does not compete with the main thread; `fps` caps the
// steady-state rate (0 disables the cap).
let _neuralPaused = false;
let _neuralFps = 30;
let _neuralFrame = 0;

function buildNeuralGraph() {
  const { layers, edges } = buildNeuralLayout(_neuralW, _neuralH);
  _neuralLayers = layers;
  _neuralEdges = edges;
  _neuralHighlights = [];
  _neuralNextHL = performance.now() + 300;
}

function startNeural() {
  const canvas = document.getElementById("neuralCanvas");
  if (!canvas) return;
  stopNeural();
  resizeNeural();
  buildNeuralGraph();
  window.addEventListener("resize", onNeuralResize);
  tickNeural();
}

function stopNeural() {
  if (_neuralRAF) cancelAnimationFrame(_neuralRAF);
  _neuralRAF = 0;
  window.removeEventListener("resize", onNeuralResize);
}

function onNeuralResize() {
  resizeNeural();
  buildNeuralGraph();
}

function resizeNeural() {
  const canvas = document.getElementById("neuralCanvas");
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  _neuralW = window.innerWidth;
  _neuralH = window.innerHeight;
  canvas.width = Math.floor(_neuralW * dpr);
  canvas.height = Math.floor(_neuralH * dpr);
  canvas.style.width = _neuralW + "px";
  canvas.style.height = _neuralH + "px";
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Build one random left-to-right path; returns its key and highlight segments.
function buildHighlightPath() {
  let aIdx = Math.floor(Math.random() * _neuralLayers[0].length);
  let key = String(aIdx);
  const segments = [];
  for (let li = 0; li < _neuralLayers.length - 1; li++) {
    const curY = _neuralLayers[li][aIdx].baseY;
    const pool = [];
    for (let b = 0; b < _neuralLayers[li + 1].length; b++) pool.push(b);
    pool.sort(() => Math.random() - 0.5);
    let best = pool[0];
    let bestScore = Infinity;
    for (const b of pool.slice(0, 4)) {
      const d = Math.abs(_neuralLayers[li + 1][b].baseY - curY) + Math.random() * 36;
      if (d < bestScore) {
        bestScore = d;
        best = b;
      }
    }
    segments.push({ li, a: aIdx, b: best, life: 0, maxLife: 420 + Math.random() * 280 });
    aIdx = best;
    key += "-" + aIdx;
  }
  return { key, segments };
}

function spawnHighlight(now) {
  if (now < _neuralNextHL) return;
  _neuralNextHL = now + 1100 + Math.random() * 1900;
  const count = 2 + Math.floor(Math.random() * 2);
  for (let k = 0; k < count; k++) {
    let path;
    let tries = 0;
    do {
      path = buildHighlightPath();
      tries++;
    } while (_neuralRecentPaths.includes(path.key) && tries < 8);
    _neuralRecentPaths.push(path.key);
    if (_neuralRecentPaths.length > 14) _neuralRecentPaths.shift();
    const delay = Math.round(k * 380 + Math.random() * 320);
    for (const seg of path.segments) _neuralHighlights.push({ ...seg, delay });
  }
}

function tickNeural() {
  const canvas = document.getElementById("neuralCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // Frame cap: render only every Nth frame, but keep the loop alive.
  const stride = _neuralFps > 0 && _neuralFps < 60 ? Math.round(60 / _neuralFps) : 1;
  if (stride > 1 && _neuralFrame++ % stride !== 0) {
    _neuralRAF = _neuralPaused ? 0 : requestAnimationFrame(tickNeural);
    return;
  }
  const now = performance.now();
  const tSec = now * 0.001;
  ctx.clearRect(0, 0, _neuralW, _neuralH);
  const glow = ctx.createRadialGradient(_neuralW * 0.5, _neuralH * 0.18, 0, _neuralW * 0.5, _neuralH * 0.18, _neuralW * 0.85);
  glow.addColorStop(0, "rgba(106,143,192,0.07)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, _neuralW, _neuralH);

  for (const layer of _neuralLayers) {
    for (const n of layer) {
      n.x =
        n.baseX +
        Math.sin(tSec * n.driftSpeed + n.driftPhase) * n.driftAmpX +
        Math.cos(tSec * n.driftSpeed * 0.62 + n.driftPhase * 1.3) * n.driftAmpX * 0.35;
      n.y =
        n.baseY +
        Math.sin(tSec * 0.55 + n.phase) * 7 +
        Math.cos(tSec * n.driftSpeed * 0.71 + n.driftPhase * 0.9) * n.driftAmpY * 0.5;
    }
  }

  spawnHighlight(now);

  for (const e of _neuralEdges) {
    const a = _neuralLayers[e.li][e.a];
    const bLayer = e.skip ? _neuralLayers[e.li + 2] : _neuralLayers[e.li + 1];
    const b = bLayer[e.b];
    if (!a || !b) continue;
    const alpha = e.skip ? 0.028 : 0.095;
    ctx.strokeStyle = `rgba(106,143,192,${alpha})`;
    ctx.lineWidth = e.skip ? 0.6 : 0.75;
    ctx.beginPath();
    if (e.skip) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 - 18;
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx, my, b.x, b.y);
    } else {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  // Pulse whole paths (line glow only, no flying dot).
  for (let i = _neuralHighlights.length - 1; i >= 0; i--) {
    const h = _neuralHighlights[i];
    if (h.delay > 0) {
      h.delay -= 16;
      continue;
    }
    h.life += 16;
    if (h.life > h.maxLife) {
      _neuralHighlights.splice(i, 1);
      continue;
    }
    const a = _neuralLayers[h.li][h.a];
    const b = _neuralLayers[h.li + 1][h.b];
    if (!a || !b) continue;
    const p = h.life / h.maxLife;
    const env = p < 0.15 ? p / 0.15 : p > 0.75 ? (1 - p) / 0.25 : 1;
    ctx.strokeStyle = `rgba(130,170,255,${(0.52 * env).toFixed(3)})`;
    ctx.lineWidth = 1.7;
    ctx.shadowColor = "rgba(106,143,192,0.95)";
    ctx.shadowBlur = 11;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(190,210,255,${(0.22 * env).toFixed(3)})`;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (let li = 0; li < _neuralLayers.length; li++) {
    for (let i = 0; i < _neuralLayers[li].length; i++) {
      const n = _neuralLayers[li][i];
      const pulse = 0.55 + 0.45 * Math.sin(tSec * 1.35 + n.phase * 1.7);
      const hl = _neuralHighlights.find((h) => (h.li === li && h.a === i) || (h.li === li - 1 && h.b === i));
      const env =
        hl && !(hl.delay > 0)
          ? (() => {
              const p = hl.life / hl.maxLife;
              return p < 0.15 ? p / 0.15 : p > 0.75 ? (1 - p) / 0.25 : 1;
            })()
          : 0;
      const isActive = env > 0.08;
      const baseA = isActive ? 0.32 + env * 0.18 : 0.18;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(106,143,192,${(baseA + pulse * 0.12).toFixed(3)})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(106,143,192,${(0.035 * pulse).toFixed(3)})`;
      ctx.fill();
      if (isActive) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 2.2, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(130,170,255,${(0.35 + env * 0.25).toFixed(2)})`;
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }
    }
  }

  _neuralRAF = _neuralPaused ? 0 : requestAnimationFrame(tickNeural);
}

// Pause/resume the animation loop. Pausing cancels the pending frame; resuming
// restarts it unless the tab is hidden (the visibilitychange handler owns that).
function setPaused(paused) {
  _neuralPaused = !!paused;
  if (_neuralPaused) {
    if (_neuralRAF) cancelAnimationFrame(_neuralRAF);
    _neuralRAF = 0;
  } else if (!_neuralRAF && !document.hidden) {
    tickNeural();
  }
}

export function initDecorBg({ paused = false, fps = 30 } = {}) {
  _neuralPaused = !!paused;
  _neuralFps = Number.isFinite(fps) ? fps : 30;
  _neuralFrame = 0;
  startNeural();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (_neuralRAF) cancelAnimationFrame(_neuralRAF);
      _neuralRAF = 0;
    } else if (!_neuralRAF && !_neuralPaused) {
      tickNeural();
    }
  });
  return { setPaused };
}
