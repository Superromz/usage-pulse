#!/usr/bin/env node
// What you're working on: the branch, the issue it belongs to, its pull
// request and CI, and the issue's milestone, from GitHub through `gh`.
//
//   Orchestrator  superromz/usage-pulse · ⎇ feat/19-orchestrator
//   Stage      In review · CI passing
//   Issue      #19 Orchestrator: open a live pane showing the current issue…
//   PR         #22 Orchestrator pane (open)
//   Milestone  0.4.0: See what you're working on  ■■■□□□□ 3/7
//   Next       #20 Orchestrator: show the pipeline step…
//
// GitHub is only ever asked in the background (`--refresh`, behind a lock),
// and what it said is kept in ~/.claude/pulse/work/. Everything else, the
// pane included, only reads that cache.
//
//   work.js                 print once for the current folder
//   work.js --live          keep it open and up to date (q to quit)
//   work.js --refresh       ask GitHub now and update the cache
//   --dir <folder>          follow that repository instead of the current folder
'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { paint } = L;

const WORK_DIR = path.join(L.HOME, 'work');
const STALE_MS = 60000;
const LOCK_MS = 2 * 60000;
// A pipeline step recorded longer ago than this no longer counts.
const RECENT_MS = 2 * 3600000;
const label = (s) => paint('gray', s);

// The repository a folder belongs to: its top folder, branch and GitHub name.
function repoInfo(dir) {
  for (let d = path.resolve(dir), i = 0; i < 30; i++) {
    const g = path.join(d, '.git');
    let st = null;
    try { st = fs.statSync(g); } catch {}
    if (st) {
      let gitDir = g;
      // Worktree: ".git" is a file pointing at its own git dir, whose
      // "commondir" leads back to the main one with the config.
      if (st.isFile()) try {
        const own = path.resolve(d, fs.readFileSync(g, 'utf8').match(/gitdir:\s*(.+)/)[1].trim());
        let common = own;
        try { common = path.resolve(own, fs.readFileSync(path.join(own, 'commondir'), 'utf8').trim()); } catch {}
        gitDir = common;
      } catch {}
      let name = null;
      try {
        const cfg = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
        const origin = cfg.split(/^\[/m).find((s) => s.startsWith('remote "origin"'));
        const url = origin && (origin.match(/url\s*=\s*(.+)/) || [])[1];
        const m = url && url.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
        name = m ? m[1] : null;
      } catch {}
      return { root: d, branch: L.gitBranch(d), name };
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

const cacheFile = (repo) => path.join(WORK_DIR, `${`${repo.root}@${repo.branch}`.replace(/[^\w.-]+/g, '_').slice(-150)}.json`);
const loadFacts = (repo) => (repo && repo.branch ? L.readJSON(cacheFile(repo), null) : null);

// The issue number a branch name carries: feat/42-search, 42-search, issue-42.
// Version-like endings (chore/expo-sdk-58) don't count.
function issueFromBranch(branch) {
  const m = String(branch || '').match(/^(?:[^/]+\/)?(?:issue[-_]?)?(\d+)(?:[-_]|$)/i);
  return m ? Number(m[1]) : null;
}

// "Closes #42", "fixes #42", "resolved #42" in a pull request's description.
function issueFromText(text) {
  const m = String(text || '').match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

// The issues a body says it depends on: "Depends on #19".
const dependsOn = (body) => [...String(body || '').matchAll(/depends on #(\d+)/gi)].map((m) => Number(m[1]));

// One word for a pull request's checks: passing, failing, pending or none.
function ciStatus(checks) {
  if (!Array.isArray(checks) || !checks.length) return 'none';
  const results = checks.map((c) => String(c.conclusion || c.state || '').toUpperCase());
  if (results.some((r) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(r))) return 'failing';
  if (checks.some((c) => (c.status && String(c.status).toUpperCase() !== 'COMPLETED') || ['PENDING', 'EXPECTED', ''].includes(String(c.conclusion || c.state || '').toUpperCase()))) return 'pending';
  return 'passing';
}

// `gh` with a time limit. PULSE_GH stands in for it in tests (a .js file is
// run with node).
function gh(args, cwd) {
  const { execFileSync } = require('child_process');
  const fake = process.env.PULSE_GH;
  const [cmd, pre] = fake ? (fake.endsWith('.js') ? [process.execPath, [fake]] : [fake, []]) : ['gh', []];
  const out = execFileSync(cmd, [...pre, ...args], { cwd, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  return JSON.parse(out || 'null');
}

// Ask GitHub about the branch: its pull request, its issue, the issue's
// milestone and that milestone's issues. Returns what to cache. `hint` is the
// issue a pipeline skill was last asked about here, for branches whose name
// and pull request don't say.
function fetchFacts(repo, hint = null) {
  const facts = { at: Date.now(), branch: repo.branch };
  let prs;
  try { prs = gh(['pr', 'list', '--head', repo.branch, '--state', 'all', '--limit', '1', '--json', 'number,title,state,body,milestone,statusCheckRollup'], repo.root); } catch (e) {
    return { ...facts, error: e.code === 'ENOENT' ? 'no-gh' : 'gh-failed' };
  }
  const p = (prs || [])[0];
  if (p) facts.pr = { number: p.number, title: p.title, state: String(p.state).toLowerCase(), ci: ciStatus(p.statusCheckRollup) };

  const n = issueFromBranch(repo.branch) || (p && issueFromText(p.body)) || hint;
  if (n) try {
    const i = gh(['issue', 'view', String(n), '--json', 'number,title,state,milestone'], repo.root);
    facts.issue = { number: i.number, title: i.title, state: String(i.state).toLowerCase() };
    if (i.milestone) facts.milestoneTitle = i.milestone.title;
  } catch {}
  if (!facts.milestoneTitle && p && p.milestone) facts.milestoneTitle = p.milestone.title;

  if (facts.milestoneTitle) try {
    const list = gh(['issue', 'list', '--milestone', facts.milestoneTitle, '--state', 'all', '--limit', '200', '--json', 'number,title,state,labels,body'], repo.root);
    facts.milestone = {
      title: facts.milestoneTitle,
      issues: list.map((i) => ({
        number: i.number, title: i.title, state: String(i.state).toLowerCase(),
        dependsOn: dependsOn(i.body),
        blockedLabel: (i.labels || []).some((l) => /^blocked\b/i.test(l.name)),
      })).sort((a, b) => a.number - b.number),
    };
  } catch {}
  delete facts.milestoneTitle;
  return facts;
}

// Ask GitHub and write the cache, unless another refresh is already running.
function refresh(repo) {
  if (!repo || !repo.branch) return null;
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const file = cacheFile(repo);
  const lock = file.replace(/\.json$/, '.lock');
  try { if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_MS) return null; } catch {}
  try { fs.writeFileSync(lock, String(process.pid)); } catch {}
  try {
    const rec = pipelineFor(repo);
    const facts = fetchFacts(repo, rec && rec.issue);
    L.writeJSON(file, facts);
    return facts;
  } finally { try { fs.unlinkSync(lock); } catch {} }
}

function refreshInBackground(dir) {
  try {
    require('child_process').spawn(process.execPath, [__filename, '--refresh', '--dir', dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}

// The latest pipeline step recorded in this repository (hook.js), if recent.
function pipelineFor(repo, now = Date.now()) {
  if (!repo) return null;
  try { return require('./hook').latestFor(repo.root, RECENT_MS, now); } catch { return null; }
}

// Blocked only when GitHub clearly says so: a "blocked" label, or a
// "Depends on #N" whose issue is in this milestone and still open.
function isBlocked(issue, all) {
  if (issue.state !== 'open') return false;
  if (issue.blockedLabel) return true;
  return (issue.dependsOn || []).some((d) => { const x = all.find((i) => i.number === d); return x && x.state === 'open'; });
}

// Everything the pane shows, worked out from the cached facts and the
// recorded pipeline step. A recent step wins over the stage worked out from
// GitHub.
function view(repo, facts, pipeline = null) {
  const v = { repo, facts };
  if (!repo) return { ...v, missing: 'not-a-repo' };
  if (!repo.branch) return { ...v, missing: 'no-branch' };
  if (pipeline) {
    const { STEPS } = require('./hook');
    v.step = pipeline.step;
    v.nextStep = STEPS[STEPS.indexOf(pipeline.step) + 1] || null;
  }
  if (!facts) return { ...v, missing: 'checking' };
  if (facts.error) return { ...v, missing: facts.error };
  const listed = (n) => ((facts.milestone && facts.milestone.issues) || []).find((i) => i.number === n);
  v.issue = facts.issue || (pipeline && pipeline.issue ? listed(pipeline.issue) || { number: pipeline.issue, title: '', state: 'open' } : null);
  v.pr = facts.pr || null;
  v.stage = v.pr && v.pr.state === 'merged' ? 'Shipped' : v.pr && v.pr.state === 'open' ? 'In review' : 'Implementing';
  if (facts.milestone) {
    const all = facts.milestone.issues || [];
    const current = v.issue && v.issue.number;
    v.milestone = {
      title: facts.milestone.title,
      done: all.filter((i) => i.state === 'closed').length,
      total: all.length,
      issues: all.map((i) => ({ ...i, blocked: isBlocked(i, all), current: i.number === current, waitsOn: (i.dependsOn || []).filter((d) => (all.find((x) => x.number === d) || {}).state === 'open') })),
    };
    v.next = v.milestone.issues.find((i) => i.state === 'open' && !i.blocked && !i.current) || null;
  }
  if (!v.issue && !v.pr && !v.step) v.missing = 'no-issue';
  return v;
}

const MISSING = {
  'not-a-repo': 'This folder is not in a Git repository.',
  'no-branch': 'No branch is checked out.',
  checking: 'Checking GitHub...',
  'no-gh': 'Install GitHub\'s gh command to see issues, pull requests and milestones: https://cli.github.com',
  'gh-failed': 'gh couldn\'t reach GitHub. Signed in? Run: gh auth login',
  'no-issue': 'No issue or pull request found for this branch. Put the issue number in the branch name (like feat/42-search) or write "Closes #42" in its pull request.',
};

function ago(t, now) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

// Keep a line within `width`; colors make it longer than it looks.
function fit(s, width, ascii) {
  if (L.visWidth(s) <= width) return s;
  let out = '', w = 0;
  for (const ch of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (ch.startsWith('\x1b')) { out += ch; continue; }
    for (const c of ch) { if (w >= width - 1) break; out += c; w++; }
  }
  return `${out}${ascii ? '~' : '…'}${s.includes('\x1b') ? '\x1b[0m' : ''}`;
}

function render(v, { width = 100, now = Date.now(), cfg = L.loadConfig() } = {}) {
  const a = cfg.ascii;
  const key = (k) => label(k.padEnd(11));
  const cut = (s) => fit(s, width, a);
  // Explanations wrap at word boundaries instead of being cut.
  const wrap = (text) => text.split(' ').reduce((rows, word) => {
    const last = rows[rows.length - 1];
    if (last && (last + ' ' + word).length <= width) rows[rows.length - 1] = `${last} ${word}`;
    else rows.push(word);
    return rows;
  }, []);
  const ref = (i) => `${paint('cyan', `#${i.number}`)} ${i.title}`;
  const lines = [];
  const where = v.repo ? `${paint('bold', v.repo.name || path.basename(v.repo.root))}${v.repo.branch ? ` ${label('·')} ${paint('magenta', `${a ? 'branch' : '⎇'} ${v.repo.branch}`)}` : ''}` : '';
  const updated = v.facts && v.facts.at ? label(`  updated ${ago(v.facts.at, now)}`) : '';
  lines.push(`${paint('bold', 'Orchestrator')}  ${where}${updated}`, '');

  // The pipeline with the current step in brackets.
  const pipelineMap = () => require('./hook').STEPS.map((s) => (s === v.step ? paint('bold', paint('yellow', `[${s}]`)) : label(s))).join(label(a ? ' > ' : ' ▶ '));
  const nextStep = () => `${key('Next step')}${v.nextStep ? paint('white', v.nextStep) : label(`${v.step} is the last step`)}`;
  if (v.step && !v.stage) lines.push(`${key('Step')}${pipelineMap()}`, nextStep());
  if (v.stage) {
    const ci = v.pr && v.pr.state === 'open' && v.pr.ci !== 'none' ? ` ${label('·')} ${paint({ passing: 'green', failing: 'red', pending: 'yellow' }[v.pr.ci], `CI ${v.pr.ci}`)}` : '';
    if (v.step) lines.push(`${key('Step')}${pipelineMap()}${ci}`, nextStep());
    else lines.push(`${key('Stage')}${paint('bold', v.stage)}${ci}`);
    lines.push(`${key('Issue')}${v.issue ? ref(v.issue) : label('none found')}`);
    lines.push(`${key('PR')}${v.pr ? `${ref(v.pr)} ${label(`(${v.pr.state})`)}` : label('none yet')}`);
    if (v.milestone) {
      const m = v.milestone;
      const boxes = m.total <= 30 ? ` ${paint('green', (a ? '#' : '■').repeat(m.done))}${label((a ? '.' : '□').repeat(m.total - m.done))}` : '';
      lines.push(`${key('Milestone')}${m.title} ${boxes} ${paint('white', `${m.done}/${m.total}`)}`);
      const cur = m.issues.find((i) => i.current && i.state === 'open');
      const none = m.done === m.total ? 'nothing left in this milestone' : cur ? `none besides #${cur.number}` : 'every open issue is waiting on another';
      lines.push(`${key(v.step ? 'Next issue' : 'Next')}${v.next ? ref(v.next) : label(none)}`);
    }
  }
  if (v.missing) lines.push('', ...wrap(MISSING[v.missing]).map(label));

  if (v.milestone && v.milestone.issues.length) {
    lines.push('', label('Issues'));
    for (const i of v.milestone.issues) {
      const mark = i.state === 'closed' ? paint('green', a ? 'x' : '✓') : i.current ? paint('yellow', a ? '>' : '▶') : i.blocked ? paint('red', a ? '!' : '⊘') : label(a ? '-' : '·');
      const waits = i.blocked && i.waitsOn.length ? label(` (waits on ${i.waitsOn.map((n) => `#${n}`).join(', ')})`) : i.blocked ? label(' (blocked)') : '';
      lines.push(` ${mark} ${i.state === 'closed' ? label(`#${i.number} ${i.title}`) : ref(i)}${waits}`);
    }
  }
  return lines.map(cut).join('\n');
}

// Short forms of MISSING for the status line.
const MISSING_SHORT = {
  'not-a-repo': 'not in a Git repository',
  'no-branch': 'no branch checked out',
  checking: 'checking GitHub...',
  'no-gh': 'install gh to see issues and pull requests',
  'gh-failed': 'gh can\'t reach GitHub (gh auth login)',
  'no-issue': 'no issue or pull request for this branch',
};

// The orchestrator as up to two status line rows, each within `width`:
//   Step [implement-it] next review-it   #20 Orchestrator: show the pipeline step…
//   Milestone 0.4.0: See what… ■□□ 1/3   PR #22 open · CI passing   Next #21 Status line…
function statusRows(v, { width = 200, cfg = L.loadConfig() } = {}) {
  const a = cfg.ascii;
  const GAP = '   ';
  const ref = (i) => `${paint('cyan', `#${i.number}`)}${i.title ? ` ${i.title}` : ''}`;
  const top = [];
  if (v.step) top.push(`${label('Step')} ${paint('bold', paint('yellow', `[${v.step}]`))}${label(v.nextStep ? ` next ${v.nextStep}` : ' last step')}`);
  else if (v.stage) top.push(`${label('Stage')} ${paint('bold', v.stage)}`);
  else top.push(paint('bold', 'Orchestrator'));
  if (v.issue) top.push(ref(v.issue));
  else if (v.repo && v.repo.branch) top.push(paint('magenta', `${a ? 'branch' : '⎇'} ${v.repo.branch}`));

  const bottom = [];
  if (v.missing) bottom.push(label(MISSING_SHORT[v.missing]));
  if (v.milestone) {
    const m = v.milestone;
    const boxes = m.total <= 12 ? ` ${paint('green', (a ? '#' : '■').repeat(m.done))}${label((a ? '.' : '□').repeat(m.total - m.done))}` : '';
    bottom.push(`${label('Milestone')} ${m.title}${boxes} ${paint('white', `${m.done}/${m.total}`)}`);
  }
  if (v.pr) {
    const ci = v.pr.state === 'open' && v.pr.ci !== 'none' ? ` ${label('·')} ${paint({ passing: 'green', failing: 'red', pending: 'yellow' }[v.pr.ci], `CI ${v.pr.ci}`)}` : '';
    bottom.push(`${label('PR')} ${paint('cyan', `#${v.pr.number}`)} ${v.pr.state}${ci}`);
  } else if (v.stage) bottom.push(`${label('PR')} ${label('none yet')}`);
  if (v.next) bottom.push(`${label('Next')} ${ref(v.next)}`);
  return [top, bottom].filter((r) => r.length).map((r) => fit(r.join(GAP), width, a));
}

function live(dir) {
  const footer = label('  Refreshes while you work. Press q to quit.');
  let asked = 0;
  const draw = () => {
    const repo = repoInfo(dir);
    const facts = loadFacts(repo);
    // Stale: ask GitHub again, but not on every redraw while it's answering.
    if (repo && repo.branch && (!facts || Date.now() - facts.at > STALE_MS) && Date.now() - asked > 15000) {
      asked = Date.now();
      refreshInBackground(dir);
    }
    let body;
    try { body = render(view(repo, facts, pipelineFor(repo)), { width: process.stdout.columns || 100 }); } catch { body = 'Orchestrator'; }
    process.stdout.write(`\x1b[H\x1b[2J${body}\n\n${footer}`);
  };
  const quit = () => { process.stdout.write('\x1b[?25h\x1b[?1049l'); process.exit(0); };
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (b) => { const k = b.toString(); if (k === 'q' || k === '\x1b' || k === '\x03') quit(); });
  }
  process.on('SIGINT', quit);
  process.stdout.on('resize', draw);
  draw();
  setInterval(draw, 2000);
}

module.exports = { statusRows, repoInfo, issueFromBranch, issueFromText, dependsOn, ciStatus, fetchFacts, refresh, view, render, loadFacts, cacheFile, pipelineFor };

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--dir');
  const dir = i >= 0 && args[i + 1] ? args[i + 1] : process.cwd();
  if (args.includes('--live')) live(dir);
  else if (args.includes('--refresh')) { try { refresh(repoInfo(dir)); } catch {} }
  else {
    try {
      const repo = repoInfo(dir);
      process.stdout.write(render(view(repo, loadFacts(repo), pipelineFor(repo)), { width: Number(process.env.COLUMNS) || process.stdout.columns || 100 }) + '\n');
    } catch { process.stdout.write('Orchestrator\n'); }
  }
}
