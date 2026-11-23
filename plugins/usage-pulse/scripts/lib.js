// Shared paths, ANSI helpers, formatting and the per-session spend ledger for
// Usage Pulse. Everything lives in ~/.claude/pulse so the status line (user
// settings) and the commands (plugin root) read the same files across updates.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = path.join(os.homedir(), '.claude', 'pulse');
const CONFIG_FILE = path.join(HOME, 'config.json');
const SESSIONS_DIR = path.join(HOME, 'sessions');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// ---------- io ----------

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Atomic write. On Windows the rename fails (EPERM/EBUSY) while another
// process reads the file, so retry briefly and never leave tmp files behind.
function writeJSON(file, data, pretty = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, pretty ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      sleep(5 + i);
    }
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '') || '{}'); } catch { return {}; }
}

// Every setting and its default is described in options.js.
const { DEFAULT_CONFIG } = require('./options');

function loadConfig() { return { ...DEFAULT_CONFIG, ...readJSON(CONFIG_FILE, {}) }; }
function saveConfig(cfg) { writeJSON(CONFIG_FILE, cfg); }

// ---------- ansi ----------

const COLORS = {
  reset: 0, bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, gray: 90,
};
const paint = (c, s) => (process.env.NO_COLOR ? String(s) : `\x1b[${COLORS[c]}m${s}\x1b[0m`);

// Whether the terminal shows exact (24-bit) colors. Most modern terminals do
// but don't always say so (Warp sets no COLORTERM), so assume yes unless the
// terminal is known not to: macOS Terminal, or a TERM without 256 colors.
function truecolor(env = process.env, setting = loadConfig().color) {
  if (setting === 'truecolor') return true;
  if (setting === '256') return false;
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM || '')) return true;
  if (env.TERM_PROGRAM === 'Apple_Terminal') return false;
  return !env.TERM || /256color|direct|truecolor/.test(env.TERM);
}
let exact = null;

// Nearest color in the standard 256-color palette (6x6x6 cube or gray ramp).
function to256([r, g, b]) {
  const LEVELS = [0, 95, 135, 175, 215, 255];
  const near = (v) => LEVELS.reduce((best, l, i) => (Math.abs(l - v) < Math.abs(LEVELS[best] - v) ? i : best), 0);
  const [ri, gi, bi] = [near(r), near(g), near(b)];
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const dist = (x, y, z) => (r - x) ** 2 + (g - y) ** 2 + (b - z) ** 2;
  const gi2 = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + gi2 * 10;
  return dist(gv, gv, gv) < dist(LEVELS[ri], LEVELS[gi], LEVELS[bi]) ? 232 + gi2 : cube;
}

function rgb(c, s) {
  if (process.env.NO_COLOR) return String(s);
  if (exact === null) exact = truecolor();
  return exact ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[0m` : `\x1b[38;5;${to256(c)}m${s}\x1b[0m`;
}

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;[^\x07]*\x07/g, '');
// Terminal cell width: emoji and wide symbols take two cells.
const visWidth = (s) => [...stripAnsi(s)].reduce((w, ch) => w + (/\p{Extended_Pictographic}/u.test(ch) && ch.codePointAt(0) > 0x2bff ? 2 : 1), 0);
const padVis = (s, w) => s + ' '.repeat(Math.max(0, w - visWidth(s)));

// Smooth bar with eighth-block precision: ▏▎▍▌▋▊▉█
function bar(frac, width, ascii) {
  frac = Math.max(0, Math.min(1, Number(frac) || 0));
  if (ascii) { const n = Math.round(frac * width); return '#'.repeat(n) + '-'.repeat(width - n); }
  const eighths = Math.round(frac * width * 8);
  const full = Math.floor(eighths / 8), rest = eighths % 8;
  const part = rest ? '▏▎▍▌▋▊▉'[rest - 1] : '';
  return '█'.repeat(full) + part + '·'.repeat(Math.max(0, width - full - (part ? 1 : 0)));
}

// Thin-line gauge: the filled part in `color`, the rest as a dim track.
// Half-cell precision with ╸ so small changes still show.
function gauge(frac, width, color, ascii) {
  frac = Math.max(0, Math.min(1, Number(frac) || 0));
  if (ascii) { const n = Math.round(frac * width); return paint(color, '='.repeat(n)) + paint('gray', '-'.repeat(width - n)); }
  const halves = Math.round(frac * width * 2);
  const full = Math.floor(halves / 2), half = halves % 2;
  return paint(color, '━'.repeat(full) + (half ? '╸' : '')) + paint('gray', '━'.repeat(Math.max(0, width - full - half)).replace(/━/g, '─'));
}

// Green → yellow → red as a share of a limit gets used up.
const heat =(pct) => (pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : 'green');

const SPARKS = '▁▂▃▄▅▆▇█';
function spark(values) {
  const max = Math.max(...values, 0);
  return values.map((v) => (max ? SPARKS[Math.min(7, Math.floor((v / max) * 7.999))] : SPARKS[0])).join('');
}

// ---------- formatting ----------

function fmtTokens(n) {
  n = Number(n) || 0;
  const short = (v, unit) => `${v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, '')}${unit}`;
  if (n >= 1e9) return short(n / 1e9, 'B');
  if (n >= 1e6) return short(n / 1e6, 'M');
  if (n >= 1e3) return short(n / 1e3, 'k');
  return String(Math.round(n));
}

const fmtUsd = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// 47s, 12m, 1h05m, 3d 4h
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// Local calendar day, so "today" matches the user's clock.
function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function lastDays(n, t = Date.now()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(t - i * 86400000));
  return out;
}

// ---------- plan limits ----------

const WINDOWS = { five_hour: 5 * 3600, seven_day: 7 * 86400 };

// How a rate-limit window is going: used share, time left, and whether usage
// runs ahead of the clock (on pace to hit the limit before it resets).
function windowInfo(key, w, now = Date.now()) {
  if (!w || w.used_percentage == null) return null;
  const len = WINDOWS[key];
  const left = w.resets_at ? Math.max(0, w.resets_at - now / 1000) : null;
  const elapsed = left == null ? null : Math.min(1, Math.max(0, 1 - left / len));
  const used = Number(w.used_percentage) || 0;
  // Projected use at reset if the current rate holds.
  const projected = elapsed && elapsed > 0.05 ? used / elapsed : null;
  const fast = projected != null && projected > 100;
  // On a fast pace: when (epoch ms) the current rate reaches 100%, which is
  // always before the reset.
  const outAt = fast && used < 100 ? now + Math.min(((100 - used) * elapsed * len) / used, left) * 1000 : null;
  return { used, left, elapsed, projected, fast, outAt };
}

// A clock time in the computer's usual format ("4:10pm" or "16:10"), with the
// weekday in front when it isn't today ("Thu 4:10pm").
function clockAt(t, now = Date.now()) {
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .replace(/\s*([AaPp])\.?\s*[Mm]\.?$/, (_, a) => `${a.toLowerCase()}m`)
    .replace(/\s/g, ' ');
  return dayKey(t) === dayKey(now) ? time : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}

// ---------- session ledger ----------
// Each session's status line keeps its own file (no write contention between
// sessions): latest snapshot plus spend per day. Claude Code reports a running
// total cost per session; the ledger turns that into money spent per day.

const sessionFile = (sid) => path.join(SESSIONS_DIR, `${String(sid).replace(/[^\w.-]/g, '_')}.json`);

function recordSession(input, now = Date.now()) {
  const sid = input.session_id;
  if (!sid) return null;
  const file = sessionFile(sid);
  const prev = readJSON(file, null);
  const rec = prev ? JSON.parse(JSON.stringify(prev)) : { sid, days: {}, lastCost: 0 };
  const cost = input.cost && Number(input.cost.total_cost_usd);
  const today = dayKey(now);
  if (Number.isFinite(cost)) {
    const d = rec.days[today] || (rec.days[today] = { spent: 0 });
    if (!prev && cost > 0) {
      // First time this session is seen but it already has spend (it was open
      // before Usage Pulse was installed): count only the share that falls
      // after midnight, assuming it was spent evenly over the session.
      const dur = (input.cost.total_duration_ms || 0) / 1000;
      const sinceMidnight = (now - new Date(now).setHours(0, 0, 0, 0)) / 1000;
      rec.lastCost = dur > sinceMidnight ? cost * (1 - sinceMidnight / dur) : 0;
    }
    // A cost lower than the last one means Claude Code restarted the counter
    // (a resumed session), so everything reported now is new spend.
    d.spent += cost >= rec.lastCost ? cost - rec.lastCost : cost;
    rec.lastCost = cost;
  }
  const cw = input.context_window || {};
  rec.seen = now;
  rec.project = (input.workspace && input.workspace.project_dir) || input.cwd || rec.project;
  // Where Claude is working now, which can be below where it started (the
  // orchestrator lists these as recent projects).
  rec.cwd = (input.workspace && input.workspace.current_dir) || input.cwd || rec.cwd;
  rec.name = input.session_name || rec.name;
  rec.model = (input.model && input.model.display_name) || rec.model;
  rec.ctx = cw.used_percentage != null ? { pct: cw.used_percentage, used: cw.total_input_tokens, size: cw.context_window_size } : rec.ctx;
  rec.cost = Number.isFinite(cost) ? cost : rec.cost;
  rec.lines = input.cost ? { add: input.cost.total_lines_added || 0, del: input.cost.total_lines_removed || 0 } : rec.lines;
  rec.cache = input.prompt_cache ? { expires: input.prompt_cache.expires_at, hit: input.prompt_cache.hit_ratio, warm: input.prompt_cache.warm } : rec.cache;
  if (input.rate_limits) rec.limits = { ...input.rate_limits, at: now };

  // The status line runs every second: only touch disk when something moved.
  const changed = !prev || prev.lastCost !== rec.lastCost || now - (prev.seen || 0) > 15000
    || JSON.stringify(prev.ctx) !== JSON.stringify(rec.ctx) || JSON.stringify(prev.limits && { ...prev.limits, at: 0 }) !== JSON.stringify(rec.limits && { ...rec.limits, at: 0 });
  if (changed) try { writeJSON(file, rec); } catch {}
  return rec;
}

function loadSessions(maxAgeDays = 35) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(SESSIONS_DIR); } catch { return out; }
  const cutoff = Date.now() - maxAgeDays * 86400000;
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const f = path.join(SESSIONS_DIR, n);
    try { if (fs.statSync(f).mtimeMs < cutoff) continue; } catch { continue; }
    const r = readJSON(f, null);
    if (r) out.push(r);
  }
  return out;
}

const spentOn = (sessions, day) => sessions.reduce((s, r) => s + ((r.days && r.days[day] && r.days[day].spent) || 0), 0);

// Plan limits are account-wide: the freshest snapshot from any session wins.
const latestLimits = (sessions) => sessions.map((s) => s.limits).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;

// ---------- git ----------

// Branch from .git/HEAD without spawning git (the status line runs every second).
function gitBranch(dir) {
  for (let d = dir, i = 0; d && i < 30; i++) {
    const g = path.join(d, '.git');
    try {
      let head;
      if (fs.statSync(g).isFile()) {
        // Worktree: ".git" is a file pointing at the real git dir.
        const real = fs.readFileSync(g, 'utf8').match(/gitdir:\s*(.+)/);
        head = real && fs.readFileSync(path.resolve(d, real[1].trim(), 'HEAD'), 'utf8');
      } else head = fs.readFileSync(path.join(g, 'HEAD'), 'utf8');
      if (!head) return null;
      const m = head.match(/ref: refs\/heads\/(.+)/);
      return m ? m[1].trim() : head.trim().slice(0, 7);
    } catch {}
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

module.exports = {
  HOME, CONFIG_FILE, SESSIONS_DIR, PROJECTS_DIR,
  readJSON, writeJSON, readStdin, loadConfig, saveConfig, sleep,
  paint, rgb, truecolor, to256, stripAnsi, visWidth, padVis, bar, gauge, heat, spark,
  fmtTokens, fmtUsd, fmtDur, dayKey, lastDays,
  WINDOWS, windowInfo, clockAt,
  sessionFile, recordSession, loadSessions, spentOn, latestLimits,
  gitBranch,
};
