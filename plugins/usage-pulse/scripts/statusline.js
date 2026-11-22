#!/usr/bin/env node
// Status line under Claude's prompt. Gauges and session details come first;
// when the terminal is wide enough, a GitHub-style contribution grid sits on
// the right with a lifetime summary under the gauges (8 rows in all). A
// warning row goes on top while a plan limit or the context window is nearly
// full (alerts.js).
//
//   Context ━━━━╸─────── 27%   5-hour ━━━━━──── 34% resets 1h12m   Weekly …          Sep     Oct     Nov
//   Opus 5.5 · medium   This session $3.20 · 1h05m   Today $12.10   ⎇ dev        ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■
//                                                                           Mon  ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■
//   Lifetime   7.5B tokens since Jan 23, 2026                                    ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■
//   Past year  7.4B tokens · 39 active days                                 Wed  ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■
//   Streak     11 days · best 13                                                 ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■
//   Busiest day Sep 25 · 920M tokens                                        Fri  ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■
//                                                                                ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■
'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./lib');
const G = require('./grid');
const P = require('./page');
const A = require('./alerts');
const { paint } = L;

const label = (s) => paint('gray', s);
const GAP = '    ';
const GAUGE_W = 14;

function gaugeItem(name, pct, cfg, extra = '') {
  const color = L.heat(pct);
  return `${label(name)} ${L.gauge(pct / 100, GAUGE_W, color, cfg.ascii)} ${paint('bold', paint(color, `${String(Math.round(pct)).padStart(3)}%`))}${extra}`;
}

function gaugesRow(input, cfg, now, compact) {
  const parts = [];
  const cw = input.context_window;
  if (cw && cw.used_percentage != null) {
    const of = !compact && cw.total_input_tokens != null ? label(` ${L.fmtTokens(cw.total_input_tokens)} of ${L.fmtTokens(cw.context_window_size)}`) : '';
    parts.push(gaugeItem('Context', cw.used_percentage, cfg, of));
  }
  const rl = input.rate_limits || {};
  for (const [key, name] of [['five_hour', '5-hour'], ['seven_day', 'Weekly']]) {
    const w = L.windowInfo(key, rl[key], now);
    if (!w) continue;
    const reset = w.left != null ? label(` ${compact ? (cfg.ascii ? 'reset' : '↻') : 'resets'} ${L.fmtDur(w.left)}`) : '';
    const up = cfg.ascii ? '^' : '↑';
    // On a fast pace, when it would run out; narrow terminals keep just the arrow.
    const pace = w.outAt ? paint('yellow', compact ? ` ${up}` : ` ${up} out by ${L.clockAt(w.outAt, now)}`) : '';
    parts.push(gaugeItem(name, w.used, cfg, reset + pace));
  }
  return parts;
}

function detailsRow(input, cfg, now) {
  const parts = [];
  const model = input.model && input.model.display_name;
  const effort = input.effort && input.effort.level;
  if (model) parts.push(paint('bold', model) + (effort ? label(` · ${effort}`) : ''));

  const c = input.cost;
  if (c && c.total_cost_usd != null) {
    const bits = [paint('white', L.fmtUsd(c.total_cost_usd))];
    if (c.total_duration_ms) bits.push(label(L.fmtDur(c.total_duration_ms / 1000)));
    if (c.total_lines_added || c.total_lines_removed) bits.push(paint('green', `+${L.fmtTokens(c.total_lines_added || 0)}`) + ' ' + paint('red', `${cfg.ascii ? '-' : '−'}${L.fmtTokens(c.total_lines_removed || 0)}`));
    parts.push(`${label('This session')} ${bits.join(label(' · '))}`);
  }

  // With a daily budget, how much of it today has used, colored like the gauges.
  const today = L.spentOn(L.loadSessions(2), L.dayKey(now));
  const budget = cfg.budgetDaily;
  if (budget > 0) parts.push(`${label('Today')} ${paint(L.heat((today / budget) * 100), L.fmtUsd(today))} ${label(`of ${L.fmtUsd(budget)}`)}`);
  else if (today > 0) parts.push(`${label('Today')} ${paint('white', L.fmtUsd(today))}`);

  // A warm prompt cache makes the next message cheaper and faster.
  const pc = input.prompt_cache;
  if (pc && pc.expires_at) {
    const left = pc.expires_at - now / 1000;
    parts.push(`${label('Cache')} ${left > 0 ? paint(left < 300 ? 'yellow' : 'cyan', `warm ${L.fmtDur(left)}`) : label('cold')}`);
  }

  const dir = (input.workspace && input.workspace.current_dir) || input.cwd;
  const branch = cfg.branch !== false && dir && L.gitBranch(dir);
  if (branch) parts.push(paint('magenta', `${cfg.ascii ? 'branch' : '⎇'} ${branch}`));
  return parts;
}

// Lifetime totals and the day-by-day history, kept fresh by a background scan
// of Claude Code's history.
function loadLifetime(now) {
  const lt = L.readJSON(path.join(L.HOME, 'lifetime.json'), null);
  if (!lt || now - (lt.at || 0) > 10 * 60000) refreshInBackground();
  return lt && lt.tokens ? lt : null;
}

// Four lines under the gauges: lifetime, past year, streak, busiest day.
function summary(lt) {
  const key = (k) => label(k.padEnd(12));
  const year = Object.values(lt.daily || {}).reduce((s, n) => s + n, 0);
  const since = lt.since ? ` ${label('since')} ${G.shortDate(lt.since)}, ${lt.since.slice(0, 4)}` : '';
  return [
    `${key('Lifetime')}${paint('bold', paint('cyan', L.fmtTokens(lt.tokens)))} ${label('tokens')}${since}`,
    `${key('Past year')}${paint('white', L.fmtTokens(year))} ${label('tokens ·')} ${paint('white', lt.activeDays)} ${label('active days')}`,
    `${key('Streak')}${paint('white', `${lt.streak || 0} ${lt.streak === 1 ? 'day' : 'days'}`)}${lt.longest ? label(` · best ${lt.longest}`) : ''}`,
    lt.best ? `${key('Busiest day')}${paint('white', G.shortDate(lt.best.day))} ${label(`· ${L.fmtTokens(lt.best.tokens)} tokens`)}` : '',
  ];
}

function refreshInBackground() {
  const lock = path.join(L.HOME, 'scan.lock');
  try { if (Date.now() - fs.statSync(lock).mtimeMs < 10 * 60000) return; } catch {}
  try {
    require('child_process').spawn(process.execPath, [path.join(__dirname, 'scan.js'), '--quiet'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}

// What you're working on, in place of usage: always with `mode orchestrator`,
// and with `mode auto` for 10 minutes after this session last started a
// lab-it … ship-it skill (hook.js records it). Only files are read: the
// session's record and the GitHub cache the orchestrator pane keeps.
function workRows(input, cfg, now, cols) {
  if (cfg.mode === 'usage') return null;
  const H = require('./hook');
  const rec = H.sessionRecord(input.session_id);
  if (cfg.mode !== 'orchestrator' && !(rec && now - rec.at < 10 * 60000)) return null;
  const W = require('./work');
  const dir = (input.workspace && input.workspace.current_dir) || input.cwd || process.cwd();
  // Claude started in a parent folder (like Desktop\Projects): the repository
  // below it where this session last used a pipeline skill.
  const repo = W.repoInfo(dir) || (rec && H.isBelow(dir, rec.root) ? W.repoInfo(rec.root) : null);
  // Only this session's own step, and only while it still counts (2 hours).
  const pipeline = rec && repo && rec.root === repo.root && now - rec.at < 2 * 3600000 ? rec : null;
  return W.statusRows(W.view(repo, W.loadFacts(repo), pipeline), { width: cols || 200, cfg });
}

// Line the two rows up in columns: each cell is as wide as the widest cell
// above or below it.
function columns(rows) {
  const n = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: n }, (_, i) => Math.max(...rows.map((r) => (r[i] && i < r.length - 1 ? L.visWidth(r[i]) : 0))));
  return rows.map((r) => r.map((cell, i) => (i < r.length - 1 ? L.padVis(cell, widths[i]) : cell)).join(GAP));
}

// Put the right panel against the right edge, on every row or none.
function withRight(lefts, rights, cols) {
  if (!rights.some(Boolean)) return lefts;
  if (!cols) return lefts.map((l, i) => (rights[i] ? `${l}${GAP}${rights[i]}` : l));
  if (lefts.some((l, i) => cols - L.visWidth(l) - L.visWidth(rights[i]) < 4)) return lefts;
  return lefts.map((l, i) => l + ' '.repeat(cols - L.visWidth(l) - L.visWidth(rights[i])) + rights[i]);
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8').replace(/^﻿/, ''); } catch {}
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch {}
  const cfg = L.loadConfig();
  const now = Date.now();
  L.recordSession(input, now);

  // Claude Code passes the terminal width in COLUMNS but draws the status line
  // a few cells narrower and cuts the rest with "…", so keep a margin.
  const cols = Math.max(0, (Number(process.env.COLUMNS) || 0) - (cfg.margin ?? 6));

  const rows = [];
  // Anything going wrong there leaves the usage view as it was.
  let work = null;
  try { work = workRows(input, cfg, now, cols); } catch {}
  if (work) rows.push(...work);
  else {
    let base = columns([gaugesRow(input, cfg, now), detailsRow(input, cfg, now)]);
    // Too narrow: shorter wording, no column alignment.
    if (cols && base.some((r) => L.visWidth(r) > cols)) base = [gaugesRow(input, cfg, now, true).join('  '), detailsRow(input, cfg, now).join('  ')];
    // What to show beyond the two main rows: `activity` switches the grid and
    // summary off together, `grid` and `summary` one at a time, and the compact
    // layout keeps just the two main rows.
    const extra = cfg.lifetime !== false && cfg.layout !== 'compact';
    const show = { grid: extra && cfg.grid !== false, summary: extra && cfg.summary !== false };
    const lt = show.grid || show.summary ? loadLifetime(now) : null;
    rows.push(...(lt && cols ? withActivity(base, lt, cols, cfg, now, show) : base));
  }
  // A plan limit or the context window close to full: a warning on top, and
  // a desktop notification the first time.
  const over = A.crossings(input, cfg, now);
  rows.unshift(A.warningRow(over, cfg, cols));
  try { A.notifyNew(over, input, cfg, now); } catch {}
  // Claude Code trims leading spaces from each row, which slides a row with
  // nothing on the left over to the left edge. A braille blank looks like a
  // space but isn't trimmed.
  process.stdout.write(rows.filter(Boolean).map((r) => r.replace(/^ /, '⠀')).join('\n'));
}

// Add the lifetime summary and the contribution grid (month names plus a row
// per weekday) to the two main rows, in whichever layout shows more weeks:
//   beside: grid against the right edge of all 8 rows, summary under the gauges
//   below:  the two main rows, then summary and grid side by side under them
// On a terminal too narrow for either, just the two main rows. `show` turns
// the grid or the summary off; the summary alone goes under the main rows.
function withActivity(base, lt, cols, cfg, now, show = { grid: true, summary: true }) {
  const sum = show.summary ? summary(lt) : ['', '', '', ''];
  const sumW = Math.max(0, ...sum.map(L.visWidth));
  if (!show.grid) return sumW + 1 <= cols ? [...base, ...sum] : base;
  const besideLefts = [base[0], base[1], '', ...sum, ''];
  const besideWeeks = G.weeksFor(cols - Math.max(...besideLefts.map(L.visWidth)) - 6);
  const belowWeeks = G.weeksFor(cols - sumW - 4);
  // Hovering an active square shows its day's usage (terminals that preview
  // links on hover show the link target, which is that text).
  const link = cfg.links === false ? null : (day) => P.dayHover(day, lt);
  if (besideWeeks && besideWeeks >= belowWeeks) return withRight(besideLefts, G.weekGrid(lt.daily, besideWeeks, cfg, now, link), cols);
  if (!belowWeeks) return base;
  // Summary next to the Mon..Thu rows, so it sits in the middle of the grid.
  const grid = G.weekGrid(lt.daily, belowWeeks, cfg, now, link);
  const lefts = ['', '', ...sum, '', ''];
  return [...base, ...grid.map((g, i) => `${L.padVis(lefts[i] || '', sumW)}    ${g}`)];
}

try { main(); } catch { process.stdout.write('Usage Pulse'); }
