// Usage Pulse: status line, spend ledger, transcript scan and setup, each in a
// throwaway HOME. Run with: node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'usage-pulse', 'scripts');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;[^\x07]*\x07/g, '');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-test-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, PULSE_NO_CLIPBOARD: '1', PULSE_NO_OPEN: '1', PULSE_NOTIFY_LOG: path.join(home, 'notifications.log'), NO_COLOR: '', COLUMNS: '' };
  const run = (file, args = [], input = '', extra = {}) => execFileSync(process.execPath, [path.join(SCRIPTS, file), ...args], { input, env: { ...env, ...extra }, encoding: 'utf8' });
  // Run lib/scan code inside the sandbox (they resolve HOME when they load).
  const js = (code) => JSON.parse(execFileSync(process.execPath, ['-e',
    `const L=require(${JSON.stringify(path.join(SCRIPTS, 'lib.js'))});const S=require(${JSON.stringify(path.join(SCRIPTS, 'scan.js'))});const G=require(${JSON.stringify(path.join(SCRIPTS, 'grid.js'))});const r=(()=>{${code}})();process.stdout.write(JSON.stringify(r===undefined?null:r));`],
  { env, encoding: 'utf8' }) || 'null');
  return { home, env, run, js };
}

const now = () => Date.now() / 1000;
const payload = (over = {}) => ({
  session_id: 'abc',
  cwd: os.tmpdir(),
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  effort: { level: 'high' },
  cost: { total_cost_usd: 1.5, total_duration_ms: 60000, total_lines_added: 120, total_lines_removed: 8 },
  context_window: { total_input_tokens: 275000, context_window_size: 1000000, used_percentage: 27 },
  prompt_cache: { expires_at: now() + 1800 },
  rate_limits: { five_hour: { used_percentage: 34, resets_at: now() + 3600 }, seven_day: { used_percentage: 20, resets_at: now() + 5 * 86400 } },
  ...over,
});

test('status line: gauges on top, details below, in plain words', () => {
  const { run } = sandbox();
  const out = strip(run('statusline.js', [], JSON.stringify(payload())));
  const [a, b] = out.split('\n');
  assert.match(a, /^Context .* 27% 275k of 1M/);
  assert.match(a, /5-hour .* 34% resets (59m|1h00m)/);
  assert.match(a, /Weekly .* 20% resets/);
  assert.match(b, /^Opus 5\.5 · high/);
  assert.match(b, /This session \$1\.50 · 1m · \+120 −8/);
  assert.match(b, /Today \$1\.50/);
  assert.match(b, /Cache warm (29|30)m/);
  // Columns line up: the session cost starts right under the 5-hour gauge.
  assert.strictEqual(a.indexOf('5-hour'), b.indexOf('This session'));
});

// A lifetime file as the background scan writes it: active the last 5 days.
function writeLifetime(home) {
  const daily = {};
  for (let i = 0; i < 5; i++) daily[new Date(Date.now() - i * 86400000).toLocaleDateString('en-CA')] = (i + 1) * 1e8;
  fs.mkdirSync(path.join(home, '.claude', 'pulse'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'pulse', 'lifetime.json'), JSON.stringify({
    tokens: 7.5e9, activeDays: 39, since: '2026-01-23', streak: 5, longest: 13, best: { day: '2026-09-25', tokens: 9.2e8 }, daily, at: Date.now(),
  }));
}

test('wide terminal: contribution grid on the right, lifetime summary under the gauges', () => {
  const { home, run } = sandbox();
  writeLifetime(home);
  const rows = strip(run('statusline.js', [], JSON.stringify(payload()), { COLUMNS: '255' })).split('\n');
  assert.strictEqual(rows.length, 8); // month names + one row per weekday
  assert.match(rows[0], /^Context .* Weekly .* {2}[A-Z][a-z]{2} .*[A-Z][a-z]{2}\s*$/);
  assert.match(rows[1], /^Opus 5\.5 .* ■/);
  assert.match(rows[2], / Mon {2}■/);
  assert.match(rows[3], /^Lifetime {4}7\.5B tokens since Jan 23, 2026 .* ■/);
  assert.match(rows[4], /^Past year {3}1\.5B tokens · 39 active days .* Wed {2}■/);
  assert.match(rows[5], /^Streak {6}5 days · best 13 .* ■/);
  assert.match(rows[6], /^Busiest day Sep 25 · 920M tokens .* Fri {2}■/);
  // Claude Code cuts the last few cells with "…", so the rows stop 6 short of COLUMNS.
  for (const r of rows) assert.ok([...r].length <= 249, r);
  // The grid is a solid block on the right: every weekday row starts in the same column.
  const starts = rows.slice(1).map((r) => r.search(/ {2}■|■ ■/));
  assert.ok(new Set(rows.slice(1).map((r) => r.indexOf('■', r.length - 120))).size <= 2, starts.join());
});

test('medium terminals: summary and grid move under the two main rows', () => {
  const { home, run } = sandbox();
  writeLifetime(home);
  const at = (cols) => strip(run('statusline.js', [], JSON.stringify(payload()), { COLUMNS: String(cols) })).split('\n');
  const weeks = (rows, line) => (rows[line].match(/■/g) || []).length;
  const mid = at(175);
  assert.strictEqual(mid.length, 10); // 2 main rows + month names + 7 weekdays
  assert.match(mid[0], /^Context /);
  assert.match(mid[1], /^Opus 5\.5/);
  assert.match(mid[2], /^⠀ +[A-Z][a-z]{2} /); // month names
  assert.match(mid[4], /^Lifetime {4}7\.5B tokens since Jan 23, 2026 {4}Mon {2}■/);
  // Count weeks on the Sunday row: every week has its Sunday, but on a Sunday
  // the newest week has no Monday yet.
  assert.strictEqual(weeks(mid, 3), 53); // the full year fits
  for (const r of mid) assert.ok([...r].length <= 169, r);
  // Narrower: fewer weeks, same layout.
  const narrow = at(110);
  assert.strictEqual(narrow.length, 10);
  assert.ok(weeks(narrow, 3) >= 8 && weeks(narrow, 3) < 53, String(weeks(narrow, 3)));
  // Too narrow for any grid: just the two main rows.
  const tiny = at(60);
  assert.strictEqual(tiny.length, 2);
  assert.doesNotMatch(tiny.join('\n'), /Lifetime|■/);
});

test('grid colors follow the chosen palette', () => {
  const { home, run } = sandbox();
  writeLifetime(home);
  assert.match(run('pulse.js', ['colors', 'pink']), /Pick one of: red, green, blue, purple/);
  run('pulse.js', ['colors', 'red']);
  const out = run('statusline.js', [], JSON.stringify(payload()), { COLUMNS: '255' });
  assert.match(out, /\x1b\[38;2;255;104;124m■/); // brightest red for the busiest day
  assert.doesNotMatch(out, /\x1b\[38;2;57;211;83m■/); // no GitHub green
});

test('streaks, busiest day and activity levels', () => {
  const { js } = sandbox();
  const r = js(`
    const day = (i) => L.dayKey(Date.now() - i * 86400000);
    const models = (n) => ({ models: { m: { input: n, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    // Active yesterday and the 2 days before (today not yet): streak 3. A 4-day run earlier.
    const days = { [day(1)]: models(10), [day(2)]: models(50), [day(3)]: models(10),
      [day(10)]: models(1), [day(11)]: models(1), [day(12)]: models(1), [day(13)]: models(1) };
    const lt = S.lifetime({ days }, 'missing.json');
    const level = G.levels(Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['d' + i, i + 1])));
    return { streak: lt.streak, longest: lt.longest, best: lt.best.tokens, levels: [0, 1, 5, 10, 15, 20].map(level) };
  `);
  assert.deepStrictEqual(r, { streak: 3, longest: 4, best: 50, levels: [0, 1, 1, 2, 3, 4] });
});

test('dashboard shows a GitHub-style year grid with streaks', () => {
  const { home, js } = sandbox();
  writeLifetime(home);
  // Render without rescanning, which would replace the lifetime file above.
  const out = strip(js(`return require(${JSON.stringify(path.join(SCRIPTS, 'dash.js'))}).render({ width: 120 });`));
  assert.match(out, /Your activity/);
  const grid = out.split('\n').filter((l) => /^ {2}(Mon|Wed|Fri| {3}) {2}■/.test(l));
  assert.strictEqual(grid.length >= 6, true); // 7 weekday rows (Saturday may end early)
  assert.match(out, /current streak 5 days · {2}longest 13 days|current streak 5 days {2}· {2}longest 13 days/);
  assert.match(out, /busiest day Sep 25/);
  assert.match(out, /Less ■ ■ ■ ■ ■ More/);
});

test('lifetime adds Claude Code\'s stats cache for days older than the transcripts', () => {
  const { home, js } = sandbox();
  const stats = path.join(home, 'stats.json');
  fs.writeFileSync(stats, JSON.stringify({ firstSessionDate: '2026-01-23T10:00:00Z', dailyModelTokens: [
    { date: '2026-01-23', tokensByModel: { a: 100 } }, { date: '2026-10-05', tokensByModel: { a: 999 } },
  ] }));
  const usage = { days: { '2026-10-05': { models: { m: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } } } };
  const lt = js(`return S.lifetime(${JSON.stringify(usage)}, ${JSON.stringify(stats)});`);
  assert.strictEqual(lt.tokens, 110); // 100 from the stats cache + 10 from transcripts; 10-05 not counted twice
  assert.strictEqual(lt.activeDays, 2);
  assert.strictEqual(lt.since, '2026-01-23');
});

test('status line copes with an empty or partial payload', () => {
  const { run } = sandbox();
  assert.doesNotThrow(() => run('statusline.js', [], ''));
  const out = strip(run('statusline.js', [], JSON.stringify({ session_id: 'x', rate_limits: { seven_day: { used_percentage: 50, resets_at: now() + 86400 } } })));
  assert.doesNotMatch(out, /5-hour/);
  assert.match(out, /Weekly/);
});

test('fast pace warning when usage runs ahead of the clock', () => {
  const { run } = sandbox();
  // 80% used with 4 of 5 hours still left.
  const out = strip(run('statusline.js', [], JSON.stringify(payload({ rate_limits: { five_hour: { used_percentage: 80, resets_at: now() + 4 * 3600 } } }))));
  // 80% in the first hour: the last 20% goes in 15 minutes.
  const m = /↑ out by (\d{1,2}):(\d\d)(am|pm)?/.exec(out);
  assert.ok(m, out);
  let h = Number(m[1]) % (m[3] ? 12 : 24);
  if (m[3] === 'pm') h += 12;
  const at = new Date(); at.setHours(h, Number(m[2]), 0, 0);
  const mins = ((at - Date.now()) / 60000 + 1440) % 1440;
  assert.ok(mins >= 13 && mins <= 16, `${mins} minutes`);
});

test('daily spend: counts only new cost and survives a counter restart', () => {
  const { js } = sandbox();
  const r = js(`
    const t = new Date(); t.setHours(12, 0, 0, 0); const at = t.getTime();
    const p = (c) => ({ session_id: 's', cost: { total_cost_usd: c, total_duration_ms: 1000 } });
    L.recordSession(p(0), at); L.recordSession(p(2), at + 20000); L.recordSession(p(3.5), at + 40000);
    L.recordSession(p(0.5), at + 60000); // resumed session: counter restarted
    return L.spentOn(L.loadSessions(), L.dayKey(at));
  `);
  assert.strictEqual(Math.round(r * 100) / 100, 4);
});

test('a session already running before midnight only counts today\'s share', () => {
  const { js } = sandbox();
  const r = js(`
    const t = new Date(); t.setHours(6, 0, 0, 0); const at = t.getTime();
    // 12 hours long, $12 spent: half of it after midnight.
    L.recordSession({ session_id: 'old', cost: { total_cost_usd: 12, total_duration_ms: 12 * 3600000 } }, at);
    return L.spentOn(L.loadSessions(), L.dayKey(at));
  `);
  assert.strictEqual(Math.round(r), 6);
});

test('transcript scan counts each reply once, by the project it started in', () => {
  const { home, js } = sandbox();
  const dir = path.join(home, '.claude', 'projects', 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 };
  const line = (id, cwd) => JSON.stringify({ type: 'assistant', timestamp: ts, cwd, message: { id, model: 'claude-opus-5-5', usage } });
  const repo = path.join(home, 'work', 'shop');
  fs.writeFileSync(path.join(dir, 'a.jsonl'), [
    line('m1', repo), line('m1', repo), // one reply, two content blocks
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    line('m2', path.join(repo, 'src')), // Claude cd'd into a subfolder
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), line('m3', path.join(repo, '.claude', 'worktrees', 'agent-1')) + '\n' + line('m4', repo).slice(0, 40));

  const first = js(`const u = S.scan(); return S.totals(u, [L.dayKey()]);`);
  assert.deepStrictEqual(Object.keys(first.models), ['Opus 5.5']);
  assert.deepStrictEqual(Object.keys(first.projects), ['shop']);
  assert.strictEqual(first.all.messages, 3);
  assert.strictEqual(first.all.output, 300);

  // The partial last line is finished later and picked up once.
  fs.appendFileSync(path.join(dir, 'b.jsonl'), line('m4', repo).slice(40) + '\n');
  const second = js(`const u = S.scan(); return S.totals(u, [L.dayKey()]).all.messages;`);
  assert.strictEqual(second, 4);
});

test('dashboard renders with no data and with data', () => {
  const { run } = sandbox();
  const empty = strip(run('dash.js'));
  assert.match(empty, /Plan limits/);
  assert.match(empty, /No Claude Code session active/);
  run('statusline.js', [], JSON.stringify(payload()));
  const full = strip(run('dash.js'));
  assert.match(full, /5-hour limit .* 34%/);
  assert.match(full, /Open sessions \(1\)/);
  assert.match(full, /Today \$1\.50/);
});

test('setup installs the status line and usage tips; uninstall restores what was there', () => {
  const { home, run } = sandbox();
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'old' }, spinnerVerbs: { mode: 'append', verbs: ['Mine'] }, other: 1 }));
  run('pulse.js', ['setup']);
  let s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.match(s.statusLine.command, /\.claude\/pulse\/bin\/statusline\.js/);
  assert.ok(s.spinnerTipsOverride.tips.some((t) => /\/compact/.test(t)));
  assert.strictEqual(s.spinnerTipsOverride.excludeDefault, false); // Claude Code's own tips stay
  assert.deepStrictEqual(s.spinnerVerbs, { mode: 'append', verbs: ['Mine'] }); // not ours to touch
  assert.strictEqual(s.other, 1);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'pulse', 'bin', 'statusline.js')));
  run('pulse.js', ['setup']); // running it twice keeps the original backup
  run('pulse.js', ['uninstall']);
  s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.strictEqual(s.statusLine.command, 'old');
  assert.strictEqual(s.spinnerTipsOverride, undefined);
  assert.strictEqual(s.other, 1);
});

test('rows with nothing on the left keep their indent (Claude Code trims leading spaces)', () => {
  const { home, run } = sandbox();
  writeLifetime(home);
  const rows = strip(run('statusline.js', [], JSON.stringify(payload()), { COLUMNS: '255' })).split('\n');
  for (const r of rows) assert.doesNotMatch(r, /^ /, r);
  assert.match(rows[2], /^⠀ +Mon {2}■/);
  assert.match(rows[7], /^⠀ +■/);
});

test('hovering an active square shows its usage, and the hover links take no space', () => {
  const { home, run } = sandbox();
  writeLifetime(home);
  const out = run('statusline.js', [], JSON.stringify(payload()), { COLUMNS: '255' });
  const links = [...out.matchAll(/\x1b\]8;;([^\x07]+)\x07/g)].map((m) => m[1]);
  assert.strictEqual(links.length, 5); // one per active day
  for (const l of links) assert.match(l, /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+ \| \d+M tokens$/);
  assert.ok(links.every((l) => /^[\x20-\x7e]+$/.test(l))); // OSC 8 targets: printable ASCII only
  for (const r of strip(out).replace(/\x1b\]8;[^\x07]*\x07/g, '').split('\n')) assert.ok([...r].length <= 249);
});

test('activity page: every day of the year, with a tooltip each', () => {
  const { home, js } = sandbox();
  writeLifetime(home);
  const file = js(`return require(${JSON.stringify(path.join(SCRIPTS, 'page.js'))}).writePage(S.loadLifetime());`);
  const html = fs.readFileSync(file, 'utf8');
  assert.ok((html.match(/<i id="d\d{4}-\d{2}-\d{2}"/g) || []).length >= 365);
  assert.match(html, /data-tip="500M tokens on [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+"/);
  assert.match(html, /data-tip="No activity on /);
});

test('live view knows which day is under each screen cell', () => {
  const { home, js } = sandbox();
  writeLifetime(home);
  const r = js(`
    const D = require(${JSON.stringify(path.join(SCRIPTS, 'dash.js'))});
    const hits = []; const lines = D.render({ width: 120, hits }).split('\\n');
    const misplaced = hits.filter((h) => [...L.stripAnsi(lines[h.line])][h.col] !== '■').length;
    const today = hits.find((h) => h.day === L.dayKey());
    return { n: hits.length, misplaced, tip: D.dayTip(today.day) };
  `);
  assert.ok(r.n >= 300);
  assert.strictEqual(r.misplaced, 0);
  assert.match(r.tip, /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+ · 100M tokens$/);
});

test('terminals without exact colors get the nearest 256-color shades', () => {
  const { home, run } = sandbox();
  writeLifetime(home);
  run('pulse.js', ['colors', 'red']);
  const term = (extra) => run('statusline.js', [], JSON.stringify(payload()), { COLUMNS: '255', COLORTERM: '', ...extra });
  const mac = term({ TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' });
  assert.doesNotMatch(mac, /\x1b\[38;2;/);
  assert.match(mac, /\x1b\[38;5;204m■/); // bright pink, nearest in the 256-color palette
  const warp = term({ TERM: 'xterm-256color', TERM_PROGRAM: 'WarpTerminal' });
  assert.match(warp, /\x1b\[38;2;255;104;124m■/);
  // The setting wins over detection.
  fs.writeFileSync(path.join(home, '.claude', 'pulse', 'config.json'), JSON.stringify({ palette: 'red', color: 'truecolor' }));
  assert.match(term({ TERM_PROGRAM: 'Apple_Terminal' }), /\x1b\[38;2;255;104;124m■/);
});

test('plain mode: no block, line or arrow symbols anywhere', () => {
  const { home, run } = sandbox();
  writeLifetime(home);
  assert.match(run('pulse.js', ['plain', 'on']), /Plain text is on/);
  const fast = payload({ rate_limits: { five_hour: { used_percentage: 80, resets_at: now() + 4 * 3600 } } });
  const out = strip(run('statusline.js', [], JSON.stringify(fast), { COLUMNS: '255' }));
  // Only ASCII, the middle dot separator and the invisible row-start blank.
  assert.doesNotMatch(out.replace(/[·⠀\n]/g, ''), /[^\x20-\x7e]/);
  assert.match(out, /Context =+-+ +27%/);
  assert.match(out, /\^ out by /);
  assert.match(out, /Mon {2}[.\-+*#]( [.\-+*#])+/);
  const dash = strip(run('dash.js'));
  assert.doesNotMatch(dash.replace(/[·\n]/g, ''), /[^\x20-\x7e]/);
  assert.match(run('pulse.js', ['plain', 'off']), /Plain text is off/);
});

test('a release has one version everywhere and notes in the changelog', () => {
  const root = path.join(__dirname, '..');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const version = read('plugins/usage-pulse/.claude-plugin/plugin.json').version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(read('.claude-plugin/marketplace.json').plugins[0].version, version);
  assert.strictEqual(read('package.json').version, version);
  const { notes } = require(path.join(root, 'tools', 'release-notes.js'));
  assert.ok(notes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version), `CHANGELOG.md needs a "## ${version}" section`);
});

test('settings: one command lists every setting and changes any of them', () => {
  const { home, run } = sandbox();
  const { OPTIONS } = require(path.join(SCRIPTS, 'options.js'));
  const config = path.join(home, '.claude', 'pulse', 'config.json');
  run('pulse.js', ['settings', 'colors', 'red']);
  const list = run('pulse.js', ['settings']);
  for (const o of OPTIONS) assert.match(list, new RegExp(`^${o.name} +[^ ]`, 'm'), o.name);
  assert.match(list, /^colors +red /m);
  // Grid colors offered by the setting are exactly the palettes that exist.
  assert.deepStrictEqual(OPTIONS.find((o) => o.name === 'colors').values, Object.keys(require(path.join(SCRIPTS, 'grid.js')).PALETTES));

  // Wrong names and values change nothing.
  const before = fs.readFileSync(config, 'utf8');
  assert.match(run('pulse.js', ['settings', 'colors', 'pink']), /Pick one of: red, green, blue, purple\. Now: red\./);
  assert.match(run('pulse.js', ['settings', 'margin', '99']), /Pick one of: 0 to 40\. Now: 6\./);
  assert.match(run('pulse.js', ['settings', 'nope', 'on']), /no setting called "nope"/);
  assert.strictEqual(fs.readFileSync(config, 'utf8'), before);

  // A change shows up on the status line's next run.
  writeLifetime(home);
  const rows = () => strip(run('statusline.js', [], JSON.stringify(payload()), { COLUMNS: '255' })).split('\n').length;
  assert.strictEqual(rows(), 8);
  assert.match(run('pulse.js', ['settings', 'activity', 'off']), /activity is now off/);
  assert.strictEqual(rows(), 2);

  // The old shortcuts still work the same way.
  assert.match(run('pulse.js', ['colors', 'blue']), /The activity grid is now blue\./);
  assert.match(run('pulse.js', ['plain']), /Plain text is on/);
  assert.match(run('pulse.js', ['plain', 'off']), /Plain text is off/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(config, 'utf8')), { ...require(path.join(SCRIPTS, 'options.js')).DEFAULT_CONFIG, palette: 'blue', ascii: false, lifetime: false });
});

test('settings: a config.json written by an older version keeps working', () => {
  const { home, run } = sandbox();
  fs.mkdirSync(path.join(home, '.claude', 'pulse'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'pulse', 'config.json'), JSON.stringify({ palette: 'purple', lifetime: false }));
  const list = run('pulse.js', ['settings']);
  assert.match(list, /^colors +purple /m);
  assert.match(list, /^activity +off /m);
  assert.match(list, /^margin +6 /m);
});

test('alerts: a warning on top and one desktop notification per crossing', () => {
  const { home, run } = sandbox();
  const log = path.join(home, 'notifications.log');
  const sent = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const reset = Math.round(now() + 3600);
  const hot = payload({ rate_limits: { five_hour: { used_percentage: 82, resets_at: reset }, seven_day: { used_percentage: 20, resets_at: now() + 5 * 86400 } } });
  const line = (p, cols = '255') => strip(run('statusline.js', [], JSON.stringify(p), { COLUMNS: cols })).split('\n')[0];

  // Below every threshold: no warning, nothing sent.
  assert.match(line(payload()), /^Context /);
  assert.strictEqual(sent().length, 0);

  // Over the limit threshold: the warning leads, and the notification goes out once.
  assert.match(line(hot), /^⚠ 5-hour limit 82% used \(resets (59m|1h00m)\)$/);
  for (let i = 0; i < 3; i++) line(hot);
  assert.strictEqual(sent().length, 1);
  assert.match(sent()[0].body, /5-hour limit 82% used\. It resets in/);

  // A new window (a different reset time) can alert again.
  const next = payload({ rate_limits: { five_hour: { used_percentage: 85, resets_at: reset + 5 * 3600 } } });
  line(next);
  assert.strictEqual(sent().length, 2);

  // The context window: once per session, with the fix in the wording.
  const full = payload({ context_window: { total_input_tokens: 720000, context_window_size: 1000000, used_percentage: 72 } });
  assert.match(line(full), /^⚠ Context 72% full: \/compact soon frees room$/);
  line(full);
  assert.strictEqual(sent().length, 3);
  assert.match(sent()[2].body, /Run \/compact soon/);
  line({ ...full, session_id: 'other' });
  assert.strictEqual(sent().length, 4);

  // Narrow terminals get shorter wording that fits, or no warning row at all.
  assert.match(line(full, '48'), /^⚠ Context 72% full: \/compact soon$/);
  assert.match(line(full, '30'), /^⚠ Context 72% full$/);
  assert.match(line(full, '20'), /^Context /);
  // Plain text mode stays ASCII.
  run('pulse.js', ['plain', 'on']);
  assert.match(line(hot), /^! 5-hour limit 82% used/);
});

test('alerts: thresholds and switches come from settings', () => {
  const { home, run } = sandbox();
  const log = path.join(home, 'notifications.log');
  const count = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  const p = (pct, sid) => JSON.stringify(payload({ session_id: sid, context_window: { total_input_tokens: 1, context_window_size: 1000000, used_percentage: pct } }));
  const first = (input) => strip(run('statusline.js', [], input)).split('\n')[0];

  run('pulse.js', ['settings', 'context-alert', '90']);
  assert.match(first(p(80, 'a')), /^Context /);
  assert.match(first(p(91, 'a')), /^⚠ Context 91% full/);
  assert.strictEqual(count(), 1);

  // Desktop off: the warning stays, nothing is sent.
  run('pulse.js', ['settings', 'desktop-alerts', 'off']);
  assert.match(first(p(91, 'b')), /^⚠ Context/);
  assert.strictEqual(count(), 1);

  // Alerts off: neither.
  run('pulse.js', ['settings', 'desktop-alerts', 'on']);
  run('pulse.js', ['settings', 'alerts', 'off']);
  assert.match(first(p(95, 'c')), /^Context /);
  assert.strictEqual(count(), 1);

  assert.match(run('pulse.js', ['settings', 'limit-alert', '30']), /Pick one of: 50 to 99/);
});

test('alerts: the status line still renders when notifications can\'t be shown', () => {
  const { home, run } = sandbox();
  const hot = JSON.stringify(payload({ rate_limits: { five_hour: { used_percentage: 90, resets_at: now() + 600 } } }));
  // Sending throws (the log path is a folder), and the status line carries on.
  const out = strip(run('statusline.js', [], hot, { PULSE_NOTIFY_LOG: home }));
  assert.match(out, /^⚠ 5-hour limit 90% used/);
  assert.match(out, /\nContext /);
});

test('budgets: "Today" against the daily budget, month to date on the dashboard', () => {
  const { home, run } = sandbox();
  const row = (cost) => run('statusline.js', [], JSON.stringify(payload({ cost: { total_cost_usd: cost, total_duration_ms: 60000 } })), { COLUMNS: '255' }).split('\n')[1];

  // No budget: unchanged.
  assert.match(strip(row(1.5)), /Today \$1\.50 {2,}/);
  assert.doesNotMatch(strip(row(1.5)), / of \$/);

  run('pulse.js', ['settings', 'budget-daily', '20']);
  assert.match(strip(row(1.5)), /Today \$1\.50 of \$20\.00/);
  // Colored like the gauges: green, then yellow from 60%, red from 85%.
  assert.match(row(1.5), /\x1b\[32m\$1\.50/);
  assert.match(row(13), /\x1b\[33m\$13\.00/);
  assert.match(row(18), /\x1b\[31m\$18\.00/);

  run('pulse.js', ['settings', 'budget-monthly', '300']);
  const dash = strip(run('dash.js'));
  assert.match(dash, /Today \$18\.00 of \$20\.00/);
  assert.match(dash, /This month .* 6% {2}\$18\.00 of \$300\.00 monthly budget/);
  // Tracking started today, so earlier days this month aren't counted (unless today is the 1st).
  if (new Date().getDate() > 1) assert.match(dash, /Only counts from \d{4}-\d\d-\d\d/);
  // A session from long ago means tracking started before this month: no note,
  // even though no recent session goes back to the 1st.
  const old = path.join(home, '.claude', 'pulse', 'sessions', 'old.json');
  fs.writeFileSync(old, JSON.stringify({ sid: 'old', days: { '2020-01-01': { spent: 5 } } }));
  fs.utimesSync(old, new Date('2020-01-02'), new Date('2020-01-02'));
  assert.doesNotMatch(strip(run('dash.js')), /Only counts from/);

  // Turned off again: back to how it was.
  run('pulse.js', ['settings', 'budget-daily', 'off']);
  run('pulse.js', ['settings', 'budget-monthly', 'off']);
  assert.doesNotMatch(strip(run('dash.js')), /This month|monthly budget/);
  assert.match(run('pulse.js', ['settings', 'budget-daily', 'lots']), /Pick one of: off, an amount like 20/);
});

test('"out by" time: only on a fast pace, never after the reset', () => {
  const { js, run } = sandbox();
  const r = js(`
    const n = Date.now(), s = n / 1000;
    const at = (used, left) => L.windowInfo('five_hour', { used_percentage: used, resets_at: s + left }, n);
    return {
      fast: (at(80, 3 * 3600).outAt - n) / 60000,
      slow: at(20, 3 * 3600).outAt,
      full: at(100, 3 * 3600).outAt,
      edge: (at(99.9, 600).outAt - n) / 1000 <= 600,
      weekly: L.clockAt(n + 3 * 86400000, n),
      today: L.clockAt(n + 60000, n),
    };`);
  assert.ok(Math.abs(r.fast - 30) < 0.01, String(r.fast));
  assert.strictEqual(r.slow, null);
  assert.strictEqual(r.full, null);
  assert.strictEqual(r.edge, true);
  assert.match(r.weekly, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d\d(am|pm)?$/);
  assert.match(r.today, /^\d{1,2}:\d\d(am|pm)?$/);

  // The dashboard says it too, and narrow terminals keep only the arrow.
  const hot = JSON.stringify(payload({ rate_limits: { five_hour: { used_percentage: 80, resets_at: now() + 3 * 3600 } } }));
  run('statusline.js', [], hot);
  assert.match(strip(run('dash.js')), /At this pace you'll run out by \d{1,2}:\d\d(am|pm)?, before it resets/);
  const narrow = strip(run('statusline.js', [], hot, { COLUMNS: '90' }));
  assert.match(narrow, /↑/);
  assert.doesNotMatch(narrow, /out by/);
  for (const row of narrow.split('\n')) assert.ok([...row].length <= 84, row);
});

test('setup on Node older than 20 explains what to do and changes nothing', () => {
  const { home, run } = sandbox();
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{"statusLine":{"type":"command","command":"mine"}}');
  const out = run('pulse.js', ['setup'], '', { PULSE_NODE_VERSION: '18.20.4' });
  assert.match(out, /needs Node\.js 20 or newer, and this computer has 18\.20\.4/);
  assert.strictEqual(fs.readFileSync(settings, 'utf8'), '{"statusLine":{"type":"command","command":"mine"}}');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'pulse', 'bin')));
  assert.match(run('pulse.js', ['setup'], '', { PULSE_NODE_VERSION: '20.0.0' }), /Usage Pulse is installed/);
});

test('dashboard: cost per project next to its tokens, a dash where none was recorded', () => {
  const { home, run, js } = sandbox();
  const dir = path.join(home, '.claude', 'projects', 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 };
  const line = (id, cwd) => JSON.stringify({ type: 'assistant', timestamp: ts, cwd, message: { id, model: 'claude-opus-5-5', usage } });
  const shop = path.join(home, 'work', 'shop');
  const blog = path.join(home, 'work', 'blog');
  // A transcript counts toward the project it started in, so each project has its own.
  fs.writeFileSync(path.join(dir, 'a.jsonl'), [line('m1', shop), line('m2', shop)].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), line('m3', blog) + '\n');
  js('S.scan(); return null;');

  // Cost recorded for shop, from a worktree of it: it still counts as shop.
  const wt = path.join(shop, '.claude', 'worktrees', 'agent-1');
  run('statusline.js', [], JSON.stringify(payload({ session_id: 's1', cwd: wt, workspace: { project_dir: wt, current_dir: wt }, cost: { total_cost_usd: 4.5 } })));
  // An older session earlier this month counts toward the month, not the 7 days.
  const d = new Date();
  if (d.getDate() > 8) {
    const early = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    fs.writeFileSync(path.join(home, '.claude', 'pulse', 'sessions', 'old.json'), JSON.stringify({ sid: 'old', project: shop, days: { [early]: { spent: 10 } } }));
  }
  const month = d.getDate() > 8 ? '\\$14\\.50' : '\\$4\\.50';

  const out = strip(run('dash.js'));
  assert.match(out, / 7 days +month\n/);
  assert.match(out, new RegExp(`^  shop .* replies +\\$4\\.50 +${month}$`, 'm'));
  assert.match(out, /^ {2}blog .* replies +— +—$/m);
  const projects = out.slice(out.indexOf('Projects, last 7 days'), out.indexOf('Models, last 7 days')).split('\n');
  for (const row of projects) assert.ok([...row].length <= 100, row);
});

test('recap: last Monday-to-Sunday week against the week before', () => {
  const { home, run, js } = sandbox();
  // "Last week" is always the previous complete Monday-to-Sunday, whatever today is.
  const weeks = js(`
    const R = require(${JSON.stringify(path.join(SCRIPTS, 'recap.js'))});
    return [0, 1, 2, 3, 4, 5, 6].map((i) => { const t = new Date(2026, 10, 16 + i, 9).getTime(); return R.weekOf(t, 1); });`);
  for (const w of weeks) assert.deepStrictEqual(w, ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);

  assert.match(run('pulse.js', ['recap']), /^No Claude Code activity last week \(Mon .* - Sun .*\)\.$/m);

  // Two replies on last week's Tuesday, one on its Thursday, one the week before.
  const last = js(`const R = require(${JSON.stringify(path.join(SCRIPTS, 'recap.js'))}); return [R.weekOf(Date.now(), 1), R.weekOf(Date.now(), 2)];`);
  const dir = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const usage = { input_tokens: 0, output_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };
  const at = (day) => `${day}T12:00:00`;
  const line = (id, day, cwd) => JSON.stringify({ type: 'assistant', timestamp: new Date(at(day)).toISOString(), cwd, message: { id, model: 'claude-opus-5-5', usage } });
  const shop = path.join(home, 'work', 'shop');
  fs.writeFileSync(path.join(dir, 'a.jsonl'), [line('a1', last[0][1], shop), line('a2', last[0][1], shop), line('a3', last[0][3], shop)].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), line('b1', last[1][2], path.join(home, 'work', 'blog')) + '\n');
  // Cost recorded from last week's Thursday only: tracking started partway through.
  fs.mkdirSync(path.join(home, '.claude', 'pulse', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'pulse', 'sessions', 's.json'), JSON.stringify({ sid: 's', project: shop, days: { [last[0][3]]: { spent: 7.25 } } }));

  const out = run('pulse.js', ['recap']);
  assert.match(out, /^Last week, Mon .* - Sun /m);
  assert.match(out, /^ {2}Tokens +3k +\+200% vs the week before$/m);
  assert.match(out, /^ {2}Replies +3 +\+200%$/m);
  assert.match(out, /^ {2}Cost +\$7\.25 \(tracked from [A-Z][a-z]{2} \d+\)$/m);
  assert.match(out, /^ {2}Active days +2 of 7 +\+100%$/m);
  assert.match(out, /^ {2}Busiest day +Tue [A-Z][a-z]{2} \d+ · 2k tokens$/m);
  assert.match(out, /^ {2}Top project +shop · 100% of tokens$/m);
  assert.match(out, /^ {2}Top model +Opus 5\.5 · 100% of replies$/m);

  // The dashboard's line agrees with the recap, and fits narrow dashboards.
  const weekLine = (width) => strip(js(`return require(${JSON.stringify(path.join(SCRIPTS, 'dash.js'))}).render({ width: ${width} });`)).split('\n').find((r) => r.includes('Last week:'));
  assert.match(weekLine(130), /^ {2}Last week: 3k tokens · 3 replies · \$7\.25 · 2 active days \(\+200% vs the week before\) {2}\(more: \/usage-pulse:recap\)$/);
  assert.match(weekLine(100), /^ {2}Last week: 3k tokens · 3 replies · \$7\.25 · 2 active days \(\+200% vs the week before\)$/);
  assert.match(weekLine(70), /^ {2}Last week: 3k tokens · 3 replies · \$7\.25 · 2 active days$/);
});

test('layout: compact, grid, summary and branch settings choose what the status line shows', () => {
  const { home, run } = sandbox();
  writeLifetime(home);
  // A project on a known branch.
  const repo = path.join(home, 'shop');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/dev\n');
  const input = JSON.stringify(payload({ cwd: repo }));
  const rows = (cols = '255') => strip(run('statusline.js', [], input, { COLUMNS: cols })).split('\n');
  const set = (name, value) => run('pulse.js', ['settings', name, value]);

  // Defaults: everything, as before.
  assert.strictEqual(rows().length, 8);
  assert.match(rows()[1], /⎇ dev/);

  set('layout', 'compact');
  for (const cols of ['255', '160', '100']) assert.strictEqual(rows(cols).length, 2, cols);
  set('layout', 'auto');

  set('summary', 'off');
  assert.strictEqual(rows().length, 8);
  assert.doesNotMatch(rows().join('\n'), /Lifetime|Streak/);
  assert.match(rows().join('\n'), /Mon {2}■/);

  set('summary', 'on');
  set('grid', 'off');
  assert.deepStrictEqual(rows().slice(2).map((r) => r.split(/ {2,}/)[0]), ['Lifetime', 'Past year', 'Streak', 'Busiest day Sep 25 · 920M tokens']);
  assert.doesNotMatch(rows().join('\n'), /■/);

  set('grid', 'on');
  set('branch', 'off');
  assert.doesNotMatch(rows()[1], /⎇/);
  assert.strictEqual(rows().length, 8);
});

test('doctor: each problem fails its own check with a fix, and it never changes a file', () => {
  const { home, run } = sandbox();
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  run('pulse.js', ['setup']);
  run('statusline.js', [], JSON.stringify(payload()));
  run('pulse.js', ['dashboard']);

  // Every file under ~/.claude, with its contents, to prove the doctor only reads.
  const snapshot = () => {
    const all = {};
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else all[p] = fs.readFileSync(p, 'utf8'); } };
    walk(path.join(home, '.claude'));
    return all;
  };
  const doctor = () => {
    const before = snapshot();
    const out = run('pulse.js', ['doctor']);
    assert.deepStrictEqual(snapshot(), before);
    return out;
  };

  const healthy = doctor();
  assert.doesNotMatch(healthy, /\[fix\]/);
  assert.match(healthy, /^\[ok\] {3}The status line is Usage Pulse$/m);
  assert.match(healthy, /^\[ok\] {3}Status line scripts match the installed plugin$/m);
  assert.match(healthy, /^\[ok\] {3}Plan limits are reported$/m);
  assert.match(healthy, /^Everything looks right\.$/m);

  // An outdated copy of a script.
  const bin = path.join(home, '.claude', 'pulse', 'bin');
  fs.appendFileSync(path.join(bin, 'lib.js'), '\n// old\n');
  assert.match(doctor(), /^\[fix\]  Status line scripts are out of date\n {7}They don't match the installed plugin \(lib\.js\)\. Run \/usage-pulse:setup\.$/m);
  // A missing one.
  fs.unlinkSync(path.join(bin, 'grid.js'));
  assert.match(doctor(), /^\[fix\]  Status line scripts are missing\n {7}Not found in .*: grid\.js\. Run \/usage-pulse:setup\.$/m);

  // Another tool took over the status line.
  const settings = path.join(home, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  s.statusLine.command = 'other-tool --status';
  fs.writeFileSync(settings, JSON.stringify(s));
  const out = doctor();
  assert.match(out, /^\[fix\]  Another tool replaced the status line\n {7}It runs: other-tool --status\. Run \/usage-pulse:setup to switch back\.$/m);
  assert.match(out, /^2 things to fix\.$/m);

  // An old Node, and plain text mode's own wording.
  assert.match(run('pulse.js', ['doctor'], '', { PULSE_NODE_VERSION: '18.1.0' }), /^\[fix\]  Node\.js 18\.1\.0 is too old$/m);
  run('pulse.js', ['plain', 'on']);
  assert.match(run('pulse.js', ['doctor']), /^\[info\] Plain text is on: symbols are ASCII$/m);
});

test('export: one CSV row per day and a JSON breakdown, cost blank before it was tracked', () => {
  const { home, run } = sandbox();
  assert.match(run('pulse.js', ['export']), /Nothing to export yet/);

  // Two days of history; cost recorded only on the second.
  const dir = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const usage = { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 };
  const line = (id, day, cwd) => JSON.stringify({ type: 'assistant', timestamp: new Date(`${day}T12:00:00`).toISOString(), cwd, message: { id, model: 'claude-opus-5-5', usage } });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), [line('a', '2026-11-02', '/w/shop'), line('b', '2026-11-03', '/w/shop'), line('c', '2026-11-03', '/w/shop')].join('\n') + '\n');
  fs.mkdirSync(path.join(home, '.claude', 'pulse', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'pulse', 'sessions', 's.json'), JSON.stringify({ sid: 's', project: '/w/shop', days: { '2026-11-03': { spent: 3.5 } } }));

  const out = run('pulse.js', ['export']);
  assert.match(out, /^Exported 2 days of usage \(from 2026-11-02\):$/m);
  const files = fs.readdirSync(path.join(home, '.claude', 'pulse', 'exports'));
  assert.deepStrictEqual(files.sort(), [`usage-${new Date().toLocaleDateString('en-CA')}.csv`, `usage-${new Date().toLocaleDateString('en-CA')}.json`]);

  const csvFile = path.join(home, '.claude', 'pulse', 'exports', files.find((f) => f.endsWith('.csv')));
  assert.strictEqual(fs.readFileSync(csvFile, 'utf8'), [
    'date,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,replies,cost_usd',
    '2026-11-02,5,100,1000,20,1125,1,',
    '2026-11-03,10,200,2000,40,2250,2,3.50',
    '',
  ].join('\n'));

  const json = JSON.parse(fs.readFileSync(csvFile.replace(/csv$/, 'json'), 'utf8'));
  assert.strictEqual(json.days[1].projects.shop.replies, 2);
  assert.strictEqual(json.days[1].models['Opus 5.5'].output, 200);
  assert.strictEqual(json.days[0].cost, null);

  // A second export the same day replaces the files instead of adding more.
  run('pulse.js', ['export']);
  assert.strictEqual(fs.readdirSync(path.join(home, '.claude', 'pulse', 'exports')).length, 2);
});

test('share: a self-contained SVG card with no cost or project names, colored like the activity page', () => {
  const { home, run, js } = sandbox();
  assert.match(run('pulse.js', ['share']), /No activity yet/);

  // History in a project with a telling name, and a recorded cost.
  const dir = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const usage = { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 };
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  fs.writeFileSync(path.join(dir, 'a.jsonl'), [0, 1, 1, 3, 9, 9, 9].map((n, i) => JSON.stringify({ type: 'assistant', timestamp: day(n), cwd: '/w/secret-client-project', message: { id: `m${i}`, model: 'claude-opus-5-5', usage } })).join('\n') + '\n');
  run('statusline.js', [], JSON.stringify(payload({ cost: { total_cost_usd: 42.17 } })));
  run('pulse.js', ['colors', 'purple']);

  assert.match(run('pulse.js', ['share']), /^Opened your activity card: .*activity-card\.svg$/m);
  const svg = fs.readFileSync(path.join(home, '.claude', 'pulse', 'activity-card.svg'), 'utf8');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
  assert.match(svg, /<\/svg>\n$/);
  // Nothing loaded from elsewhere: no links, images, scripts, styles or fonts.
  assert.doesNotMatch(svg.replace('xmlns="http://www.w3.org/2000/svg"', ''), /https?:|href|<image|<script|<style|@import|url\(/i);
  // Nothing private.
  assert.doesNotMatch(svg, /secret-client-project|42\.17|\$/);
  assert.match(svg, />My year with Claude</);

  // Same days, same colors as the activity page.
  js('S.scan(); return null;');
  run('pulse.js', ['activity']);
  const page = fs.readFileSync(path.join(home, '.claude', 'pulse', 'activity.html'), 'utf8');
  const colors = (text, re) => Object.fromEntries([...text.matchAll(re)].map((m) => [m[1], m[2]]));
  const onPage = colors(page, /id="d(\d{4}-\d\d-\d\d)" style="[^"]*background:(rgb\([^)]*\))/g);
  const onCard = colors(svg, /id="d(\d{4}-\d\d-\d\d)"[^>]* fill="(rgb\([^)]*\))"/g);
  assert.ok(Object.keys(onCard).length >= 365, String(Object.keys(onCard).length));
  assert.deepStrictEqual(onCard, onPage);
});
