/**
 * Plinko — Provably Fair Demo
 *
 * README (quick edit guide):
 * - Change default payout tables: edit PAYOUT_TABLES below. Keep symmetry.
 * - Starting balance: change DEFAULTS.startingBalance.
 * - Default seeds: change DEFAULTS.clientSeed; server seed is generated then hashed; use reveal/rotate in UI.
 *
 * Architecture modules:
 *  - state: persistent state (balance, seeds, config, history)
 *  - rng: HMAC-SHA256 to uniform [0,1) floats; deterministic per seeds+nonce+drop index
 *  - payouts: risk/rows multiplier tables and helpers
 *  - engine: drop resolution, balance, history, stats
 *  - render: canvas board, animations
 *  - ui: wire controls, tabs, hotkeys, localStorage
 *  - fairness: verify and seed rotation
 */

// -------------------- Config --------------------
const DEFAULTS = {
  startingBalance: 10000,
  rows: 12,
  risk: 'low',
  bet: 1.0,
  sound: false,
  animSpeed: 1,
  instant: false,
};

/**
 * Multiplier tables. Symmetric arrays of length rows+1.
 * Values roughly tuned for demo; center ~1x except high risk more extreme.
 */
export const PAYOUT_TABLES = {
  low: {
    8:  [0.5,0.7,0.9,1,1.1,0.9,0.7,0.5,0.3],
    12: [0.3,0.5,0.7,0.9,1,1.1,1.1,1,0.9,0.7,0.5,0.3,0.2],
    16: [0.2,0.3,0.4,0.6,0.8,0.9,1,1.05,1.05,1,0.9,0.8,0.6,0.4,0.3,0.2,0.1]
  },
  medium: {
    8:  [0.2,0.5,0.8,1,2,1,0.8,0.5,0.2],
    12: [0.1,0.3,0.5,0.8,1,2,3,2,1,0.8,0.5,0.3,0.1],
    16: [0.1,0.2,0.3,0.5,0.8,1,2,4,4,2,1,0.8,0.5,0.3,0.2,0.1,0.05]
  },
  high: {
    8:  [0.2,0.3,0.5,1,5,1,0.5,0.3,0.2],
    12: [0.1,0.2,0.3,0.5,1,5,15,5,1,0.5,0.3,0.2,0.1],
    16: [0.05,0.1,0.15,0.3,0.5,1,5,25,100,25,5,1,0.5,0.3,0.15,0.1,0.05]
  }
};

// -------------------- Utilities --------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
const fmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function showToast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, 2000);
}

// Canvas helpers
function pathRoundRect(ctx, x, y, w, h, r = 6) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
  ctx.lineTo(x + rr, y + h);
  ctx.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + rr);
  ctx.arc(x + rr, y + rr, rr, Math.PI, 1.5 * Math.PI);
}

// -------------------- Persistence --------------------
const STORAGE_KEY = 'plinko-demo-v1';
function loadPersisted() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}
function savePersisted(partial) {
  const prev = loadPersisted();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prev, ...partial }));
}

// -------------------- State --------------------
const state = {
  balance: DEFAULTS.startingBalance,
  risk: DEFAULTS.risk,
  rows: DEFAULTS.rows,
  bet: DEFAULTS.bet,
  instant: DEFAULTS.instant,
  animSpeed: DEFAULTS.animSpeed,
  sound: DEFAULTS.sound,
  serverSeed: null,        // secret
  serverSeedHash: null,    // shown
  clientSeed: Math.random().toString(36).slice(2),
  nonce: 0,
  dropIndex: 0,            // increments per drop overall
  history: [],             // newest first
  totals: { bets: 0, wagered: 0, won: 0 },
  seedHistory: [],         // [{seed, hash, revealedAt}]
};

// hydrate from storage
(function initStateFromStorage() {
  const stored = loadPersisted();
  if (stored.balance != null) state.balance = stored.balance;
  if (stored.risk) state.risk = stored.risk;
  if (stored.rows) state.rows = stored.rows;
  if (stored.bet) state.bet = stored.bet;
  if (stored.instant != null) state.instant = stored.instant;
  if (stored.animSpeed) state.animSpeed = stored.animSpeed;
  if (stored.sound != null) state.sound = stored.sound;
  if (stored.serverSeed) state.serverSeed = stored.serverSeed;
  if (stored.serverSeedHash) state.serverSeedHash = stored.serverSeedHash;
  if (stored.clientSeed) state.clientSeed = stored.clientSeed;
  if (stored.nonce != null) state.nonce = stored.nonce;
  if (stored.dropIndex != null) state.dropIndex = stored.dropIndex;
  if (Array.isArray(stored.history)) state.history = stored.history;
  if (stored.totals) state.totals = stored.totals;
  if (Array.isArray(stored.seedHistory)) state.seedHistory = stored.seedHistory;
})();

// -------------------- Crypto RNG --------------------
async function hmacSha256Hex(keyBytes, message) {
  // Prefer Web Crypto; fall back to JS implementation if unavailable or failing
  try {
    if (!crypto?.subtle) throw new Error('subtle unavailable');
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
    const bytes = new Uint8Array(sig);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return hmacSha256HexFallback(keyBytes, message);
  }
}

// Minimal SHA-256 and HMAC-SHA256 fallback (bytes-based)
function sha256BytesFallback(bytes) {
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ]);
  function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }
  const ml = bytes.length * 8;
  const withOne = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  withOne.set(bytes);
  withOne[bytes.length] = 0x80;
  const dv = new DataView(withOne.buffer);
  dv.setUint32(withOne.length - 4, ml >>> 0);
  dv.setUint32(withOne.length - 8, Math.floor(ml / 2 ** 32));
  const w = new Uint32Array(64);
  let a=0x6a09e667,b=0xbb67ae85,c=0x3c6ef372,d=0xa54ff53a,e=0x510e527f,f=0x9b05688c,g=0x1f83d9ab,h=0x5be0cd19;
  for (let i = 0; i < withOne.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(7, w[j - 15]) ^ rotr(18, w[j - 15]) ^ (w[j - 15] >>> 3);
      const s1 = rotr(17, w[j - 2]) ^ rotr(19, w[j - 2]) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let A=a,B=b,C=c,D=d,E=e,F=f,G=g,H=h;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(6,E) ^ rotr(11,E) ^ rotr(25,E);
      const ch = (E & F) ^ ((~E) & G);
      const temp1 = (H + S1 + ch + K[j] + w[j]) >>> 0;
      const S0 = rotr(2,A) ^ rotr(13,A) ^ rotr(22,A);
      const maj = (A & B) ^ (A & C) ^ (B & C);
      const temp2 = (S0 + maj) >>> 0;
      H=G; G=F; F=E; E=(D + temp1) >>> 0; D=C; C=B; B=A; A=(temp1 + temp2) >>> 0;
    }
    a=(a+A)>>>0; b=(b+B)>>>0; c=(c+C)>>>0; d=(d+D)>>>0; e=(e+E)>>>0; f=(f+F)>>>0; g=(g+G)>>>0; h=(h+H)>>>0;
  }
  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(0,a); outDv.setUint32(4,b); outDv.setUint32(8,c); outDv.setUint32(12,d);
  outDv.setUint32(16,e); outDv.setUint32(20,f); outDv.setUint32(24,g); outDv.setUint32(28,h);
  return out;
}
function hmacSha256HexFallback(keyBytes, message) {
  const enc = new TextEncoder();
  let key = new Uint8Array(keyBytes);
  if (key.length > 64) key = sha256BytesFallback(key);
  const ipad = new Uint8Array(64); ipad.fill(0x36);
  const opad = new Uint8Array(64); opad.fill(0x5c);
  const k = new Uint8Array(64); k.fill(0); k.set(key);
  for (let i = 0; i < 64; i++) { ipad[i] ^= k[i]; opad[i] ^= k[i]; }
  const innerMsg = new Uint8Array(ipad.length + enc.encode(message).length);
  innerMsg.set(ipad); innerMsg.set(enc.encode(message), 64);
  const innerHash = sha256BytesFallback(innerMsg);
  const outerMsg = new Uint8Array(opad.length + innerHash.length);
  outerMsg.set(opad); outerMsg.set(innerHash, 64);
  const out = sha256BytesFallback(outerMsg);
  return Array.from(out).map(b => b.toString(16).padStart(2,'0')).join('');
}

function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

function bytesToFloats(bytes) {
  // Convert consecutive 4 bytes to uint32 then to float in [0,1)
  const floats = [];
  for (let i = 0; i + 4 <= bytes.length; i += 4) {
    const v = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    // >>> 0 ensures unsigned
    floats.push(((v >>> 0) / 2 ** 32));
  }
  return floats;
}

async function deriveFloats({ serverSeed, clientSeed, nonce, dropIndex }, needCount) {
  const keyBytes = new TextEncoder().encode(serverSeed);
  const msg = `${serverSeed}:${clientSeed}:${nonce}:${dropIndex}`;
  const hex = await hmacSha256Hex(keyBytes, msg);
  const floats = bytesToFloats(hexToBytes(hex));
  // If not enough, chain again by appending a counter
  let out = floats.slice(0, needCount);
  let counter = 1;
  while (out.length < needCount) {
    const hex2 = await hmacSha256Hex(keyBytes, msg + `:${counter++}`);
    out = out.concat(bytesToFloats(hexToBytes(hex2)));
  }
  return out.slice(0, needCount);
}

async function sha256Hex(str) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function ensureServerSeed() {
  if (!state.serverSeed) {
    const seed = crypto.getRandomValues(new Uint32Array(4)).join('-');
    state.serverSeed = seed;
    state.serverSeedHash = await sha256Hex(seed);
    savePersisted({ serverSeed: state.serverSeed, serverSeedHash: state.serverSeedHash });
  }
}

// -------------------- Payouts --------------------
function getPayoutArray(risk, rows) {
  const table = PAYOUT_TABLES[risk] && PAYOUT_TABLES[risk][rows];
  if (!table) throw new Error(`Missing payout table for ${risk}/${rows}`);
  return table;
}

// -------------------- Engine --------------------
function computeFinalSlotIndexFromFloats(rows, floats) {
  // Discrete model: number of rights out of rows
  let rights = 0;
  for (let i = 0; i < rows; i++) rights += (floats[i] >= 0.5 ? 1 : 0);
  return rights; // 0..rows
}

async function resolveDrop({ instant = state.instant } = {}) {
  await ensureServerSeed();
  const rows = state.rows;
  const floats = await deriveFloats({
    serverSeed: state.serverSeed,
    clientSeed: state.clientSeed,
    nonce: state.nonce,
    dropIndex: state.dropIndex,
  }, rows + 2);

  const slotIndex = computeFinalSlotIndexFromFloats(rows, floats);
  const payoutArray = getPayoutArray(state.risk, rows);
  const multiplier = payoutArray[slotIndex];
  const bet = state.bet;
  const winAmount = bet * multiplier;

  // Balance: deduct bet then add win
  state.balance = +(state.balance - bet + winAmount).toFixed(2);
  state.totals.bets += 1;
  state.totals.wagered = +(state.totals.wagered + bet).toFixed(2);
  state.totals.won = +(state.totals.won + winAmount).toFixed(2);

  const historyItem = {
    id: Date.now(),
    bet: +bet.toFixed(2),
    multiplier: +multiplier.toFixed(2),
    win: +winAmount.toFixed(2),
    slotIndex,
    risk: state.risk,
    rows,
    seeds: {
      serverSeedHash: state.serverSeedHash,
      clientSeed: state.clientSeed,
      nonce: state.nonce,
      dropIndex: state.dropIndex,
    },
  };
  state.history.unshift(historyItem);
  if (state.history.length > 100) state.history.pop();

  // increment counters
  state.nonce += 1;
  state.dropIndex += 1;

  savePersisted({
    balance: state.balance,
    totals: state.totals,
    history: state.history,
    risk: state.risk,
    rows: state.rows,
    bet: state.bet,
    clientSeed: state.clientSeed,
    nonce: state.nonce,
    dropIndex: state.dropIndex,
    serverSeed: state.serverSeed,
    serverSeedHash: state.serverSeedHash,
    instant: state.instant,
    animSpeed: state.animSpeed,
    sound: state.sound,
  });

  // Update UI and animation
  updateHeaderAndStats();
  updateHistoryUI();
  updateLastResultUI(historyItem);
  if (!instant) await animatePath(rows, slotIndex);
  if (multiplier >= 25) showToast(`Big win! ${multiplier}×`);
  maybePlaySound(multiplier);

  return historyItem;
}

function maybePlaySound(multiplier) {
  if (!state.sound) return;
  try {
    const ctx = maybePlaySound.ctx || (maybePlaySound.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    osc.type = 'sine';
    const base = multiplier >= 1 ? 440 : 220;
    osc.frequency.setValueAtTime(base * Math.min(multiplier, 8), now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(now + 0.26);
  } catch {}
}

// -------------------- Render --------------------
const canvas = document.getElementById('boardCanvas');
const ctx = canvas.getContext('2d');
let boardResizeObserver;

function resizeCanvas() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(Math.max(rect.height, 420) * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBoard();
}

function getBoardLayout(rows) {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const marginX = 24;
  const marginY = 24;
  const pinRadius = 5;
  const rowGap = Math.max(28, (height - marginY * 2) / (rows + 4));
  const colGap = Math.max(24, (width - marginX * 2) / (rows + 2));
  return { width, height, marginX, marginY, pinRadius, rowGap, colGap };
}

function drawBoard() {
  const rows = state.rows;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const { marginX, marginY, pinRadius, rowGap, colGap } = getBoardLayout(rows);
  ctx.save();
  ctx.translate(marginX, marginY);
  ctx.fillStyle = '#22304a';
  ctx.strokeStyle = '#2a3b56';

  for (let r = 0; r < rows; r++) {
    const y = (r + 1) * rowGap;
    const cols = r + 1;
    const startX = (state.rows + 1 - cols) * 0.5 * colGap; // center
    for (let c = 0; c < cols; c++) {
      const x = startX + c * colGap;
      ctx.beginPath();
      ctx.arc(x, y, pinRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // bottom slots
  const payout = getPayoutArray(state.risk, rows);
  const baseY = (rows + 1.5) * rowGap;
  const startX = (rows + 1 - (rows + 1)) * 0.5 * colGap; // 0
  for (let i = 0; i < payout.length; i++) {
    const x = startX + i * colGap;
    const w = 46; const h = 22;
    ctx.fillStyle = i === Math.floor(rows / 2) ? 'rgba(49,208,170,.18)' : 'rgba(21,28,41,.9)';
    ctx.strokeStyle = '#2a3b56';
    pathRoundRect(ctx, x - w/2, baseY, w, h, 6);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#cfe0ff';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${payout[i]}×`, x, baseY + h/2);
  }
  ctx.restore();
}

async function animatePath(rows, slotIndex) {
  // Simple tweened path: alternating left/right moves with slight curve
  const steps = rows;
  const { marginX, marginY, pinRadius, rowGap, colGap } = getBoardLayout(rows);
  const points = [];
  // start at top center
  let x = marginX + (rows + 1) * 0.5 * colGap;
  let y = marginY + rowGap * 0.2;
  points.push({ x, y });
  // target rights determines final column index
  let rightsRemaining = slotIndex;
  for (let r = 0; r < steps; r++) {
    // choose move such that total rights equals target by end
    const leftsRemaining = (rows - r) - rightsRemaining;
    const goRight = rightsRemaining > 0 && (Math.random() < 0.5 || leftsRemaining === 0);
    if (goRight) rightsRemaining--;
    x += (goRight ? +1 : -1) * (colGap / 2);
    y += rowGap;
    points.push({ x, y });
  }
  // drop into slot
  points.push({ x, y: marginY + (rows + 1.4) * rowGap });

  const duration = 900 / state.animSpeed;
  const start = performance.now();
  return new Promise(resolve => {
    function frame(now) {
      const t = clamp((now - start) / duration, 0, 1);
      drawBoard();
      drawBallAlong(points, t);
      if (t < 1) requestAnimationFrame(frame); else resolve();
    }
    requestAnimationFrame(frame);
  });
}

function drawBallAlong(points, t) {
  // interpolate along piecewise segments
  const totalSegments = points.length - 1;
  const f = t * totalSegments;
  const i = Math.min(totalSegments - 1, Math.floor(f));
  const lt = f - i; // local t
  const p0 = points[i];
  const p1 = points[i + 1];
  const x = p0.x + (p1.x - p0.x) * lt;
  const y = p0.y + (p1.y - p0.y) * lt;
  drawBall(x, y);
}

function drawBall(x, y) {
  ctx.save();
  ctx.shadowColor = 'rgba(49,208,170,.6)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#31d0aa';
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// -------------------- UI --------------------
function updateHeaderAndStats() {
  $('#balance').textContent = fmt.format(state.balance);
  $('#lastBet').textContent = state.history[0] ? fmt.format(state.history[0].bet) : '–';
  $('#lastMultiplier').textContent = state.history[0] ? state.history[0].multiplier.toFixed(2) : '–';
  $('#lastWin').textContent = state.history[0] ? fmt.format(state.history[0].win) : '–';
  $('#totalBets').textContent = fmtInt.format(state.totals.bets);
  $('#totalWagered').textContent = fmt.format(state.totals.wagered);
  $('#totalWon').textContent = fmt.format(state.totals.won);
  const rtp = state.totals.wagered > 0 ? (100 * state.totals.won / state.totals.wagered) : 0;
  $('#rtp').textContent = `${rtp.toFixed(1)}%`;
}

function updateHistoryUI() {
  const list = $('#historyList');
  list.innerHTML = '';
  for (const h of state.history.slice(0, 20)) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${fmt.format(h.bet)}</span>
      <span>${h.multiplier.toFixed(2)}×</span>
      <span>${fmt.format(h.win)}</span>
      <span>#${h.slotIndex}</span>
      <span title="${h.seeds.serverSeedHash}|${h.seeds.clientSeed}|${h.seeds.nonce}|${h.seeds.dropIndex}">
        ${h.seeds.serverSeedHash.slice(0, 6)}…|${h.seeds.clientSeed.slice(0, 6)}…|${h.seeds.nonce}|${h.seeds.dropIndex}
      </span>`;
    list.appendChild(li);
  }
}

function updatePayoutStrip() {
  const ul = $('#payoutStrip');
  ul.innerHTML = '';
  const arr = getPayoutArray(state.risk, state.rows);
  arr.forEach((m, i) => {
    const li = document.createElement('li');
    const cls = m >= 10 ? 'good' : m >= 1 ? 'mid' : 'bad';
    li.className = cls;
    li.textContent = `${m}×`;
    ul.appendChild(li);
  });
}

function updateLastResultUI(h) {
  if (!h) return;
  $('#lastBet').textContent = fmt.format(h.bet);
  $('#lastMultiplier').textContent = h.multiplier.toFixed(2);
  $('#lastWin').textContent = fmt.format(h.win);
}

function wireTabs() {
  const tabs = $$('.tab');
  const panels = $$('.tabpanel');
  tabs.forEach(tab => tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.toggle('active', t === tab));
    panels.forEach(p => p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`));
  }));
}

function wireControls() {
  $('#betIncr').addEventListener('click', () => {
    state.bet = +(state.bet * 1.1).toFixed(2);
    $('#betInput').value = state.bet;
  });
  $('#betDecr').addEventListener('click', () => {
    state.bet = +(state.bet / 1.1).toFixed(2);
    state.bet = Math.max(0.01, state.bet);
    $('#betInput').value = state.bet;
  });
  $('#betInput').addEventListener('input', e => {
    state.bet = clamp(parseFloat(e.target.value) || 0, 0.01, 1e9);
  });

  $$('#riskLow, #riskMedium, #riskHigh').forEach(input => input.addEventListener('change', e => {
    if (!e.target.checked) return;
    state.risk = e.target.value;
    updatePayoutStrip();
    drawBoard();
    savePersisted({ risk: state.risk });
  }));

  $('#rowsSelect').addEventListener('input', e => {
    state.rows = parseInt(e.target.value, 10);
    $('#rowsValue').textContent = String(state.rows);
    updatePayoutStrip();
    drawBoard();
    savePersisted({ rows: state.rows });
  });

  $('#instantToggle').addEventListener('click', e => {
    state.instant = !state.instant;
    e.currentTarget.setAttribute('aria-pressed', String(state.instant));
    savePersisted({ instant: state.instant });
  });

  $('#animSpeed').addEventListener('input', e => {
    state.animSpeed = parseFloat(e.target.value);
    savePersisted({ animSpeed: state.animSpeed });
  });

  $('#soundToggle').addEventListener('change', e => {
    state.sound = !!e.target.checked;
    savePersisted({ sound: state.sound });
  });

  $('#dropBtn').addEventListener('click', async () => {
    if (state.bet <= 0 || state.bet > state.balance) return showToast('Invalid bet or insufficient balance');
    try {
      await resolveDrop({ instant: state.instant });
    } catch (err) {
      console.error(err);
      showToast('Drop failed. Check Fairness config.');
    }
  });

  // hotkeys
  document.addEventListener('keydown', async (e) => {
    if (e.key === ' ' && !e.repeat) { e.preventDefault(); $('#dropBtn').click(); }
    if (e.key.toLowerCase() === 'i') { $('#instantToggle').click(); }
    if (e.key.toLowerCase() === 'a') { $('#autoplayOn').click(); }
  });

  // autoplay
  $('#autoplayOn').addEventListener('change', async (e) => {
    if (e.target.checked) startAutoplay(); else stopAutoplay();
  });
  $('#resetBalanceBtn').addEventListener('click', () => {
    state.balance = DEFAULTS.startingBalance;
    state.totals = { bets: 0, wagered: 0, won: 0 };
    updateHeaderAndStats();
    savePersisted({ balance: state.balance, totals: state.totals });
  });
}

let autoplayAbort = { aborted: false };
async function startAutoplay() {
  const cfg = {
    runs: parseInt($('#autoplayRuns').value, 10) || 0,
    speed: parseInt($('#speedSlider').value, 10) || 60,
    onWinPercent: parseFloat($('#onWinPercent').value) || 0,
    onWinReset: $('#onWinReset').checked,
    onLosePercent: parseFloat($('#onLosePercent').value) || 0,
    onLoseReset: $('#onLoseReset').checked,
    stopLoss: parseFloat($('#stopLoss').value) || 0,
    takeProfit: parseFloat($('#takeProfit').value) || 0,
  };
  autoplayAbort = { aborted: false };
  let baseBet = state.bet;
  const status = $('#autoplayStatus');
  for (let i = 0; i < cfg.runs; i++) {
    if (autoplayAbort.aborted) break;
    // stop conditions
    const pl = state.balance - DEFAULTS.startingBalance;
    if (cfg.stopLoss > 0 && pl <= -cfg.stopLoss) break;
    if (cfg.takeProfit > 0 && pl >= cfg.takeProfit) break;

    if (state.bet <= 0 || state.bet > state.balance) { showToast('Invalid bet'); break; }
    const beforeBalance = state.balance;
    const result = await resolveDrop({ instant: true });
    const won = result.win >= result.bet;

    // adjust bet
    if (won) {
      if (cfg.onWinReset) state.bet = baseBet;
      else state.bet = +(state.bet * (1 + cfg.onWinPercent / 100)).toFixed(2);
    } else {
      if (cfg.onLoseReset) state.bet = baseBet;
      else state.bet = +(state.bet * (1 + cfg.onLosePercent / 100)).toFixed(2);
    }

    // speed pacing (skip if instant mode)
    if (!state.instant) await new Promise(r => setTimeout(r, clamp(1000 - cfg.speed * 8, 0, 1000)));
    status.textContent = `Running ${i + 1}/${cfg.runs}`;
  }
  status.textContent = '';
  $('#autoplayOn').checked = false;
}
function stopAutoplay() { autoplayAbort.aborted = true; $('#autoplayStatus').textContent = ''; }

// -------------------- Fairness --------------------
function renderSeedHistory() {
  const list = document.getElementById('seedHistoryList');
  if (!list) return;
  list.innerHTML = '';
  for (const item of state.seedHistory.slice().reverse()) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${item.hash.slice(0,8)}…</span><span>${item.seed}</span><span>${new Date(item.revealedAt).toLocaleString()}</span>`;
    list.appendChild(li);
  }
}

function updateFairnessUI() {
  $('#serverSeedHash').textContent = state.serverSeedHash || '–';
  $('#clientSeed').value = state.clientSeed;
  $('#nonce').value = state.nonce;
  $('#dropIndex').value = state.dropIndex;
  renderSeedHistory();
}

function wireFairness() {
  const clientSeedEl = document.getElementById('clientSeed');
  const nonceEl = document.getElementById('nonce');
  const dropIndexEl = document.getElementById('dropIndex');
  const verifyBtn = document.getElementById('verifyBtn');
  const serverSeedInput = document.getElementById('serverSeedInput');
  const revealBtn = document.getElementById('revealRotateBtn');

  if (clientSeedEl) clientSeedEl.addEventListener('change', (e) => {
    state.clientSeed = String(e.target.value || '').trim();
    savePersisted({ clientSeed: state.clientSeed });
  });
  if (nonceEl) nonceEl.addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) { state.nonce = v; savePersisted({ nonce: state.nonce }); }
  });
  if (dropIndexEl) dropIndexEl.addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) { state.dropIndex = v; savePersisted({ dropIndex: state.dropIndex }); }
  });
  if (verifyBtn) verifyBtn.addEventListener('click', async () => {
    try {
      await ensureServerSeed();
      const rows = state.rows;
      const serverSeedForVerify = (serverSeedInput && serverSeedInput.value.trim()) || state.serverSeed;
      const floats = await deriveFloats({ serverSeed: serverSeedForVerify, clientSeed: state.clientSeed, nonce: state.nonce, dropIndex: state.dropIndex }, rows + 2);
      const slot = computeFinalSlotIndexFromFloats(rows, floats);
      $('#fairnessResult').textContent = `Final slot #${slot}`;
    } catch {
      $('#fairnessResult').textContent = 'Error';
    }
  });
  if (revealBtn) revealBtn.addEventListener('click', async () => {
    await ensureServerSeed();
    const prevSeed = state.serverSeed;
    const prevHash = state.serverSeedHash;
    showToast(`Revealed previous server seed: ${prevSeed}`);
    state.seedHistory.push({ seed: prevSeed, hash: prevHash, revealedAt: Date.now() });
    // rotate
    const seed = crypto.getRandomValues(new Uint32Array(4)).join('-');
    state.serverSeed = seed;
    state.serverSeedHash = await sha256Hex(seed);
    state.nonce = 0;
    savePersisted({ serverSeed: state.serverSeed, serverSeedHash: state.serverSeedHash, nonce: state.nonce, seedHistory: state.seedHistory });
    updateFairnessUI();
  });
}

// -------------------- Test Run --------------------
$('#testRunBtn')?.addEventListener('click', async () => {
  const rows = state.rows;
  const N = 1000;
  const counts = Array(rows + 1).fill(0);
  const backup = { ...state };
  await ensureServerSeed();
  state.nonce = 0; state.dropIndex = 0;
  for (let i = 0; i < N; i++) {
    const floats = await deriveFloats({ serverSeed: state.serverSeed, clientSeed: state.clientSeed, nonce: state.nonce, dropIndex: state.dropIndex }, rows + 2);
    const slot = computeFinalSlotIndexFromFloats(rows, floats);
    counts[slot]++;
    state.nonce++; state.dropIndex++;
  }
  // theoretical binomial probabilities for p=0.5
  const probs = [];
  const total = 2 ** rows;
  let c = 1;
  for (let k = 0; k <= rows; k++) {
    if (k > 0) c = c * (rows - k + 1) / k;
    probs.push(c / total);
  }
  const lines = counts.map((cnt, i) => `#${i}: ${fmtInt.format(cnt)} (~${(cnt / N * 100).toFixed(1)}%) | theo ${(probs[i] * 100).toFixed(1)}%`).join('\n');
  $('#testRunOutput').textContent = lines;
});

// -------------------- Boot --------------------
async function boot() {
  await ensureServerSeed();
  // controls init
  $('#betInput').value = state.bet;
  $('#rowsSelect').value = String(state.rows);
  $('#rowsValue').textContent = String(state.rows);
  $('#soundToggle').checked = state.sound;
  $('#animSpeed').value = String(state.animSpeed);
  if (state.risk === 'medium') $('#riskMedium').checked = true;
  else if (state.risk === 'high') $('#riskHigh').checked = true;
  else $('#riskLow').checked = true;

  wireTabs();
  wireControls();
  wireFairness();
  updatePayoutStrip();
  updateHeaderAndStats();
  updateHistoryUI();
  updateFairnessUI();

  boardResizeObserver = new ResizeObserver(resizeCanvas);
  boardResizeObserver.observe(canvas);
  resizeCanvas();
}

window.addEventListener('DOMContentLoaded', boot);