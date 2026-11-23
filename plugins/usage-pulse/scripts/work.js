#!/usr/bin/env node
// What you're working on: the branch, the issue it belongs to, its pull
// request and CI, and the issue's milestone as a board (see render below),
// from GitHub through `gh`.
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

// The issues referenced ("Refs #N", "Closes #N", "Fixes #N") by the commits on
// this branch that aren't on the default branch yet, newest first. Runs git,
// so only from the background refresh.
function issuesFromCommits(repo) {
  const { execFileSync } = require('child_process');
  const git = (args) => execFileSync('git', args, { cwd: repo.root, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  let base = null;
  try { base = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']); } catch {}
  for (const b of [base, 'origin/main', 'origin/master', 'main', 'master']) {
    if (!b || b === repo.branch) continue;
    try { git(['rev-parse', '--verify', '--quiet', b]); base = b; break; } catch { base = null; }
  }
  if (!base) return [];
  let log = '';
  try { log = git(['log', '--format=%B%x00', `${base}..HEAD`]); } catch { return []; }
  const out = [];
  for (const m of log.matchAll(/\b(?:refs|close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
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

  let n = issueFromBranch(repo.branch) || (p && issueFromText(p.body)) || hint;
  // Nothing names an issue (a branch shared by a milestone): the issues this
  // branch's own commits reference, if they all share one milestone.
  if (!n) {
    const refs = issuesFromCommits(repo);
    const milestones = new Map();
    for (const r of refs.slice(0, 10)) {
      try { const i = gh(['issue', 'view', String(r), '--json', 'number,milestone'], repo.root); milestones.set(r, i.milestone ? i.milestone.title : null); } catch {}
    }
    const titles = new Set(milestones.values());
    if (milestones.size && titles.size === 1 && !titles.has(null)) n = refs.find((r) => milestones.has(r));
  }
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
    // Issues with an open pull request count as in progress on the board.
    try {
      const open = gh(['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,body,headRefName'], repo.root);
      facts.milestone.withOpenPr = [...new Set(open.flatMap((o) => [issueFromBranch(o.headRefName), issueFromText(o.body)]).filter(Boolean))];
    } catch {}
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

// The repository to show for a folder: the one it's in, or for a folder that
// isn't in one (like Desktop\Projects), the repository below it where a
// pipeline skill ran most recently, marked `followed`.
function resolveRepo(dir, now = Date.now()) {
  const own = repoInfo(dir);
  if (own) return own;
  let rec = null;
  try { rec = require('./hook').latestBelow(dir, RECENT_MS, now); } catch {}
  const repo = rec && repoInfo(rec.root);
  return repo ? { ...repo, followed: true } : null;
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
  // The board: Done when closed; In progress while being worked on (the
  // current issue, or one with an open pull request); To do otherwise.
  const withPr = (facts.milestone && facts.milestone.withOpenPr) || [];
  const cards = v.milestone ? v.milestone.issues : v.issue ? [{ ...v.issue, current: true, blocked: false, waitsOn: [] }] : [];
  v.columns = { todo: [], doing: [], done: [] };
  for (const i of cards) {
    const col = i.state === 'closed' ? 'done' : i.current || withPr.includes(i.number) ? 'doing' : 'todo';
    v.columns[col].push({ ...i, openPr: withPr.includes(i.number) });
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

// Word-wrap pieces of text to `width` columns. Each piece is [text, style];
// words are styled one by one, so a wrapped line never loses its color, and
// a word longer than the line is split. ['\n'] starts a new line.
function wrapPieces(pieces, width) {
  const lines = [];
  let line = '', w = 0;
  const push = () => { lines.push(line); line = ''; w = 0; };
  for (const [text, style = (s) => s] of pieces) {
    if (text === '\n') { push(); continue; }
    for (let word of String(text).split(' ')) {
      if (!word) continue;
      // Too long for a line: split it (only plain words; colored ones are short).
      while (!word.includes('\x1b') && [...word].length > width) {
        if (w) push();
        lines.push(style([...word].slice(0, width).join('')));
        word = [...word].slice(width).join('');
      }
      if (!word) continue;
      const n = L.visWidth(word);
      if (w && w + 1 + n > width) push();
      line += (w ? ' ' : '') + style(word);
      w += (w ? 1 : 0) + n;
    }
  }
  if (w || !lines.length) push();
  return lines;
}

// Lines inside a box exactly `width` wide.
function boxed(lines, width, ch, color) {
  const edge = (s) => paint(color, s);
  return [
    edge(ch.tl + ch.h.repeat(width - 2) + ch.tr),
    ...lines.map((l) => `${edge(ch.v)} ${L.padVis(l, width - 4)} ${edge(ch.v)}`),
    edge(ch.bl + ch.h.repeat(width - 2) + ch.br),
  ];
}

// The pane: a header box with where you are, then the milestone as a board.
//
//   ╭──────────────────────────────────────────────────────────────╮
//   │ Orchestrator · Superromz/usage-pulse · ⎇ feat/x · 12s ago     │
//   │ 0.4.0: See what you're working on ■■□ 2/3                     │
//   │ Step lab-it ▶ plan-it ▶ [implement-it] ▶ review-it ▶ ship-it  │
//   │ PR none yet · Next #23 Board                                  │
//   ╰──────────────────────────────────────────────────────────────╯
//   To do (1)            In progress (1)      Done (2)
//   ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
//   │ #23 Board        │ │ #21 Status line  │ │ #19 Live pane    │
//   …
// Three columns side by side when there's room, stacked otherwise. Every
// line fits `width`; nothing is cut off.
function render(v, { width = 100, now = Date.now(), cfg = L.loadConfig(), moved = new Set() } = {}) {
  const a = cfg.ascii;
  width = Math.max(20, width);
  const HEAD = a ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' } : { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
  const CARD = a ? HEAD : { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
  const gray = (s) => label(s), bold = (s) => paint('bold', s), cyan = (s) => paint('cyan', s);
  const dot = [a ? '-' : '·', gray];
  const CI = { passing: 'green', failing: 'red', pending: 'yellow' };

  // Header.
  const head = [['Orchestrator', bold]];
  if (v.repo) {
    head.push(dot, [v.repo.name || path.basename(v.repo.root), bold]);
    if (v.repo.branch) head.push(dot, [`${a ? 'branch' : '⎇'} ${v.repo.branch}`, (s) => paint('magenta', s)]);
  }
  if (v.facts && v.facts.at) head.push(dot, [ago(v.facts.at, now), gray]);
  if (v.repo && v.repo.followed) head.push(['\n'], [`Following ${path.basename(v.repo.root)}, where a pipeline skill ran last (this folder isn't a repository)`, gray]);
  if (v.milestone) {
    const m = v.milestone;
    head.push(['\n'], [m.title]);
    // Done and left as one word, so they stay together.
    if (m.total <= 30) head.push([paint('green', (a ? '#' : '■').repeat(m.done)) + gray((a ? '.' : '□').repeat(m.total - m.done))]);
    head.push([`${m.done}/${m.total}`, (s) => paint('white', s)]);
  }
  if (v.step) {
    head.push(['\n'], ['Step', gray]);
    require('./hook').STEPS.forEach((s, i) => {
      if (i) head.push([a ? '>' : '▶', gray]);
      head.push(s === v.step ? [`[${s}]`, (x) => bold(paint('yellow', x))] : [s, gray]);
    });
    head.push(dot, v.nextStep ? ['next', gray] : ['last step', gray]);
    if (v.nextStep) head.push([v.nextStep, (s) => paint('white', s)]);
  } else if (v.stage) head.push(['\n'], ['Stage', gray], [v.stage, bold]);
  if (v.stage) {
    head.push(['\n'], ['PR', gray]);
    if (v.pr) {
      head.push([`#${v.pr.number}`, cyan], [v.pr.title], [`(${v.pr.state})`, gray]);
      if (v.pr.state === 'open' && v.pr.ci !== 'none') head.push(dot, [`CI ${v.pr.ci}`, (s) => paint(CI[v.pr.ci], s)]);
    } else head.push(['none yet', gray]);
    if (!v.milestone && v.issue) head.push(['\n'], ['Issue', gray], [`#${v.issue.number}`, cyan], [v.issue.title]);
    if (v.next) head.push(['\n'], [v.step ? 'Next issue' : 'Next', gray], [`#${v.next.number}`, cyan], [v.next.title]);
  }
  const lines = boxed(wrapPieces(head, width - 4), width, HEAD, 'gray');
  if (v.missing) lines.push('', ...wrapPieces([[MISSING[v.missing], gray]], width));

  // Board.
  const cols = v.columns;
  if (cols && cols.todo.length + cols.doing.length + cols.done.length) {
    const three = width >= 3 * 22 + 2;
    const colW = three ? Math.floor((width - 2) / 3) : width;
    const card = (i, col) => {
      const status = col === 'done' ? [a ? 'x done' : '✓ done', (s) => paint('green', s)]
        : i.current ? [`${a ? '>' : '▶'} ${v.step || v.stage || 'in progress'}`, (s) => paint('yellow', s)]
        : i.openPr ? ['pull request open', (s) => paint('cyan', s)]
        : i.blocked ? [i.waitsOn && i.waitsOn.length ? `waits on ${i.waitsOn.map((n) => `#${n}`).join(', ')}` : 'blocked', (s) => paint('red', s)]
        : ['ready', gray];
      // A card that just changed column says so, with a green edge, for a few seconds.
      const fresh = moved.has(i.number);
      const body = wrapPieces([[`#${i.number}`, cyan], [i.title || '', col === 'done' ? gray : (s) => s], ['\n'], status, ...(fresh ? [dot, ['just moved', (s) => paint('green', s)]] : [])], colW - 4);
      return boxed(body, colW, CARD, fresh ? 'green' : col === 'doing' ? 'yellow' : 'gray');
    };
    const columns = [['To do', 'todo'], ['In progress', 'doing'], ['Done', 'done']].map(([name, key]) => [
      bold(`${name} (${cols[key].length})`),
      ...cols[key].flatMap((i) => card(i, key)),
    ]);
    lines.push('');
    if (three) {
      const rows = Math.max(...columns.map((c) => c.length));
      for (let r = 0; r < rows; r++) lines.push(columns.map((c, k) => (k < 2 ? L.padVis(c[r] || '', colW) : c[r] || '')).join(' ').replace(/\s+$/, ''));
    } else columns.forEach((c, k) => lines.push(...(k ? [''] : []), ...c));
  }
  return lines.join('\n');
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

const WEEK_MS = 7 * 86400000;

// Repositories worked in with Claude in the last 7 days, most recent first:
// where sessions ran or are working now (the session records) and where a
// pipeline skill ran (hook.js). Folders that aren't repositories don't count.
function recentProjects(now = Date.now()) {
  const found = new Map();
  const add = (dir, at) => {
    if (!dir || !at || now - at > WEEK_MS) return;
    const repo = repoInfo(dir);
    if (!repo) return;
    const had = found.get(repo.root);
    if (!had || at > had.at) found.set(repo.root, { repo, at });
  };
  for (const s of L.loadSessions(8)) { add(s.cwd, s.seen); add(s.project, s.seen); }
  try {
    const { PIPELINE_DIR } = require('./hook');
    for (const f of fs.readdirSync(PIPELINE_DIR)) {
      const r = f.endsWith('.json') && L.readJSON(path.join(PIPELINE_DIR, f), null);
      if (r) add(r.root, r.at);
    }
  } catch {}
  return [...found.values()].sort((x, y) => y.at - x.at).map((x) => x.repo);
}

// Note which cards changed column since the last look at this project, and
// return the ones that moved in the last few seconds (to highlight them).
// `state.seen` and `state.movedAt` persist between redraws.
function trackMoves(state, root, columns, now = Date.now()) {
  const col = {};
  for (const [name, cards] of Object.entries(columns || {})) for (const c of cards) col[c.number] = name;
  state.seen = state.seen || {};
  state.movedAt = state.movedAt || {};
  const before = state.seen[root];
  const moved = (state.movedAt[root] = state.movedAt[root] || {});
  if (before) for (const [n, c] of Object.entries(col)) if (before[n] && before[n] !== c) moved[n] = now;
  state.seen[root] = col;
  return new Set(Object.keys(moved).filter((n) => now - moved[n] < 5000).map(Number));
}

// One frame of the pane: the project row, the Board/Usage tabs, then the
// board or the usage dashboard, then the keys.
//   state: { view: 'board' | 'usage', root, seen, movedAt }
// The projects the pane offers: the recent ones, plus the one it was opened
// for when that isn't among them. Numbered in this order.
function paneProjects(dir, now = Date.now()) {
  const start = resolveRepo(dir, now);
  const projects = recentProjects(now);
  if (start && !projects.some((p) => p.root === start.root)) projects.unshift(start);
  return { start, projects };
}

// `hits`, when given, collects where each activity grid square is drawn
// ({ line, col, day }, 0-based in this frame) for hovering in the usage view.
function paneFrame(dir, state, { width = 100, now = Date.now(), cfg = L.loadConfig(), hits = null } = {}) {
  const a = cfg.ascii;
  const { start, projects } = paneProjects(dir, now);
  if (!state.root || !projects.some((p) => p.root === state.root)) state.root = start ? start.root : projects[0] && projects[0].root;
  state.view = state.view || 'board';
  const shown = projects.find((p) => p.root === state.root) || null;
  const repo = shown && start && shown.root === start.root ? start : shown;

  const top = [];
  projects.forEach((p, i) => {
    const name = `${i < 9 ? `${i + 1} ` : ''}${path.basename(p.root)}`;
    top.push(p.root === state.root ? [`[${name}]`, (s) => paint('bold', paint('yellow', s))] : [name, label]);
  });
  if (!projects.length) top.push(['no recent projects', label]);
  top.push(['\n']);
  for (const [key, name] of [['board', 'Board'], ['usage', 'Usage']]) top.push(state.view === key ? [`[${name}]`, (s) => paint('bold', s)] : [name, label]);
  const lines = wrapPieces(top, width);

  let body;
  // The dashboard needs 70 columns; on a narrower pane its lines are trimmed.
  if (state.view === 'usage') {
    const squares = [];
    body = require('./dash').render({ width, now, hits: squares }).split('\n').map((l) => fit(l, width, a)).join('\n');
    // The dashboard starts below the project row, the tabs and a blank line.
    if (hits) for (const h of squares) if (h.col < width) hits.push({ ...h, line: h.line + lines.length + 1 });
  } else {
    const v = view(repo, loadFacts(repo), pipelineFor(repo));
    const moved = repo ? trackMoves(state, repo.root, v.columns, now) : new Set();
    body = render(v, { width, now, cfg, moved });
  }
  const keys = a ? 'up/down: board or usage - left/right or 1-9: project - q: quit' : '↑/↓ board or usage · ←/→ or 1–9 project · q quit';
  return [...lines, '', body, '', ...wrapPieces([[keys, label]], width)].join('\n');
}

// The live pane. `/usage-pulse:orchestrator` opens it on the board,
// `/usage-pulse:live` and the `usage-pulse` command on the usage dashboard.
function live(dir, { view: first = 'board' } = {}) {
  const state = { view: first };
  const asked = {};
  let lastScan = 0;
  let frame = '', hits = [], hover = null;
  // Hovering a square of the activity grid shows that day's usage in a small
  // box just below and right of the pointer, kept on screen.
  const repaint = () => {
    let out = `\x1b[H\x1b[2J${frame}`;
    if (hover && state.view === 'usage') {
      const text = ` ${require('./dash').dayTip(hover.day)} `;
      const cols = process.stdout.columns || 100;
      const x = Math.max(1, Math.min(hover.x + 2, cols - L.visWidth(text)));
      out += `\x1b[${hover.y + 1};${x}H\x1b[48;2;40;44;52m\x1b[38;2;235;235;235m${text}\x1b[0m`;
    }
    process.stdout.write(out);
  };
  const draw = () => {
    const width = process.stdout.columns || 100;
    hits = [];
    try { frame = paneFrame(dir, state, { width, hits }); } catch { frame = 'Orchestrator'; }
    // Keep the shown project's GitHub data fresh, and the usage numbers.
    try {
      const repo = state.root && repoInfo(state.root);
      const facts = loadFacts(repo);
      if (repo && repo.branch && (!facts || Date.now() - facts.at > STALE_MS) && Date.now() - (asked[repo.root] || 0) > 15000) {
        asked[repo.root] = Date.now();
        refreshInBackground(repo.root);
      }
      if (state.view === 'usage' && Date.now() - lastScan > 30000) {
        lastScan = Date.now();
        require('child_process').spawn(process.execPath, [path.join(__dirname, 'scan.js'), '--quiet'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    } catch {}
    repaint();
  };
  const quit = () => { process.stdout.write('\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b[?1049l'); process.exit(0); };
  const go = (step) => {
    const list = paneProjects(dir).projects;
    const at = list.findIndex((p) => p.root === state.root);
    if (list.length) state.root = list[(at + step + list.length) % list.length].root;
  };
  // Alternate screen, hidden cursor, and mouse motion reports (SGR format).
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h');
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (b) => {
      const k = b.toString();
      if (k === 'q' || k === '\x1b' || k === '\x03') return quit();
      // Pointer at (x, y), 1-based terminal cells: which day's square is under it?
      const m = [...k.matchAll(/\x1b\[<(\d+);(\d+);(\d+)[mM]/g)].pop();
      if (m) {
        const x = Number(m[2]), y = Number(m[3]);
        const h = hits.find((s) => s.line === y - 1 && s.col === x - 1);
        const next = h ? { day: h.day, x, y } : null;
        if ((next && next.day) !== (hover && hover.day)) { hover = next; repaint(); }
        return;
      }
      hover = null;
      if (k === '\x1b[A' || k === '\x1b[B') state.view = state.view === 'board' ? 'usage' : 'board';
      else if (k === '\x1b[C') go(1);
      else if (k === '\x1b[D') go(-1);
      else if (/^[1-9]$/.test(k)) { const p = paneProjects(dir).projects[Number(k) - 1]; if (p) state.root = p.root; }
      else return;
      draw();
    });
  }
  process.on('SIGINT', quit);
  process.stdout.on('resize', draw);
  draw();
  setInterval(draw, 2000);
}

module.exports = { live, paneFrame, paneProjects, recentProjects, trackMoves, statusRows, repoInfo, resolveRepo, issuesFromCommits, issueFromBranch, issueFromText, dependsOn, ciStatus, fetchFacts, refresh, view, render, loadFacts, cacheFile, pipelineFor };

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--dir');
  const dir = i >= 0 && args[i + 1] ? args[i + 1] : process.cwd();
  if (args.includes('--live')) live(dir);
  else if (args.includes('--refresh')) { try { refresh(resolveRepo(dir)); } catch {} }
  // One frame of the live pane, as after pressing that project's number and
  // ↑/↓ to that view: --frame [--project N] [--view usage]
  else if (args.includes('--frame')) {
    const opt = (name) => { const k = args.indexOf(name); return k >= 0 ? args[k + 1] : null; };
    const state = { view: opt('--view') === 'usage' ? 'usage' : 'board' };
    const n = Number(opt('--project'));
    if (n) { const p = paneProjects(dir).projects[n - 1]; if (p) state.root = p.root; }
    process.stdout.write(paneFrame(dir, state, { width: Number(process.env.COLUMNS) || process.stdout.columns || 100 }) + '\n');
  }
  else {
    try {
      const repo = resolveRepo(dir);
      process.stdout.write(render(view(repo, loadFacts(repo), pipelineFor(repo)), { width: Number(process.env.COLUMNS) || process.stdout.columns || 100 }) + '\n');
    } catch { process.stdout.write('Orchestrator\n'); }
  }
}
