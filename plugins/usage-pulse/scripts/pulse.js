#!/usr/bin/env node
// CLI behind the /usage-pulse:* commands.
//   pulse.js setup            install the status line and spinner tips into ~/.claude/settings.json
//   pulse.js uninstall        restore the settings that setup replaced
//   pulse.js dashboard        print the usage dashboard
//   pulse.js recap            last week at a glance, compared with the week before
//   pulse.js doctor           check the usual reasons it looks wrong, and say how to fix each
//   pulse.js export           save daily usage as CSV and JSON in ~/.claude/pulse/exports
//   pulse.js share            make an SVG card of your year of activity and open it
//   pulse.js live             open the live dashboard (split pane where the terminal allows it)
//   pulse.js orchestrator     open what you're working on (issue, PR, milestone) next to Claude
//   pulse.js settings [name] [value]  list every setting, or change one
//   pulse.js colors <name>    colors of the activity grid (green, red, blue, purple)
//   pulse.js activity         open the activity page in the browser
//   pulse.js plain <on|off>   plain text only, for fonts without block and line symbols
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const BIN = path.join(L.HOME, 'bin');
const BACKUP = path.join(L.HOME, 'settings-backup.json');
const BACKED_UP = ['statusLine', 'spinnerTipsOverride'];
const node = (file, args = '') => `node "${path.join(BIN, file).replace(/\\/g, '/')}"${args}`;

// Shown under the spinner while Claude works, next to Claude Code's own tips.
const TIPS = [
  'Context above 60%? /compact frees room for the rest of the task',
  'Switching tasks? /clear starts fresh, so old context stops costing tokens',
  'A warm cache makes your next message cheaper and faster. The status line shows how long it lasts',
  '"↑ out by 4:10pm" on a limit is when you\'d reach it at your current pace, before it resets',
  '/usage-pulse:dashboard shows where your usage went this week',
  '/usage-pulse:live keeps your usage dashboard open next to Claude',
  'Change the activity grid colors with /usage-pulse:colors',
];

// Copy scripts to a stable path: the plugin dir changes on every update.
function installScripts() {
  fs.mkdirSync(BIN, { recursive: true });
  for (const f of fs.readdirSync(__dirname)) if (f.endsWith('.js') && f !== 'pulse.js') fs.copyFileSync(path.join(__dirname, f), path.join(BIN, f));
}

// A `usage-pulse` command on PATH that opens the live dashboard. Windows: a
// .cmd next to npm's global shims (already on PATH with Node). macOS/Linux:
// ~/.local/bin/usage-pulse. Returns where it went, or null if no PATH dir fit.
// Every place a command may be, including `claude-pulse`, its name before 0.1.0.
const commandFiles = () => ['usage-pulse', 'claude-pulse'].flatMap((n) => [path.join(process.env.APPDATA || '', 'npm', n + '.cmd'), path.join(os.homedir(), '.local', 'bin', n)]);
const removeCommands = () => { for (const f of commandFiles()) try { fs.unlinkSync(f); } catch {} };

function installCommand() {
  removeCommands();
  const dash = path.join(BIN, 'dash.js');
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const onPath = (d) => dirs.some((p) => path.resolve(p).toLowerCase() === path.resolve(d).toLowerCase());
  try {
    if (process.platform === 'win32') {
      const npmDir = path.join(process.env.APPDATA || '', 'npm');
      if (!process.env.APPDATA || !fs.existsSync(npmDir) || !onPath(npmDir)) return null;
      const target = path.join(npmDir, 'usage-pulse.cmd');
      fs.writeFileSync(target, `@echo off\r\nnode "${dash}" --live %*\r\n`);
      return target;
    }
    const local = path.join(os.homedir(), '.local', 'bin');
    fs.mkdirSync(local, { recursive: true });
    const target = path.join(local, 'usage-pulse');
    fs.writeFileSync(target, `#!/bin/sh\nexec node "${dash}" --live "$@"\n`, { mode: 0o755 });
    return onPath(local) ? target : null;
  } catch { return null; }
}

function setup() {
  // PULSE_NODE_VERSION stands in for the real version in tests.
  const version = process.env.PULSE_NODE_VERSION || process.versions.node;
  if (Number(version.split('.')[0]) < 20) {
    console.log(`Usage Pulse needs Node.js 20 or newer, and this computer has ${version}. Install the current version from https://nodejs.org, then run /usage-pulse:setup again. Nothing was changed.`);
    return;
  }
  installScripts();
  L.saveConfig(L.loadConfig());

  const settings = L.readJSON(SETTINGS, {});
  const ours = String((settings.statusLine && settings.statusLine.command) || '').includes('.claude/pulse/');
  if (!ours && !fs.existsSync(BACKUP)) L.writeJSON(BACKUP, Object.fromEntries(BACKED_UP.map((k) => [k, settings[k] ?? null])), true);
  settings.statusLine = { type: 'command', command: node('statusline.js'), refreshInterval: 1, padding: 0 };
  settings.spinnerTipsOverride = { tips: TIPS, excludeDefault: false };
  L.writeJSON(SETTINGS, settings, true);

  // Read the history now so the first dashboard opens instantly.
  try { require('./scan').scanLocked(); } catch {}

  console.log('Usage Pulse is installed. Context, plan limits, cost and your activity now show under the prompt.');
  console.log(`Previous settings saved to ${BACKUP}.`);
  const cmd = installCommand();
  console.log(cmd ? 'Live dashboard: split your terminal and run: usage-pulse' : `Live dashboard: run /usage-pulse:live, or in any terminal: ${node('dash.js', ' --live')}`);
}

function uninstall() {
  const settings = L.readJSON(SETTINGS, {});
  const backup = L.readJSON(BACKUP, {});
  for (const k of BACKED_UP) {
    if (backup[k]) settings[k] = backup[k];
    else delete settings[k];
  }
  L.writeJSON(SETTINGS, settings, true);
  try { fs.unlinkSync(BACKUP); } catch {}
  removeCommands();
  console.log(backup.statusLine ? 'Usage Pulse removed. Your previous status line is back.' : 'Usage Pulse removed.');
}

function dashboard() {
  installScripts();
  try { require('./scan').scanLocked(); } catch {}
  const { render } = require('./dash');
  // Slash commands capture output, so leave the colors out.
  process.env.NO_COLOR = '1';
  process.stdout.write(render({ width: 96 }));
}

function recap() {
  try { require('./scan').scanLocked(); } catch {}
  const R = require('./recap');
  console.log(R.formatRecap(R.weekRecap()));
}

// Only reads: no setup, no scan, no saved settings.
function doctor() {
  const D = require('./doctor');
  console.log(D.format(D.checks()));
}

function exportUsage() {
  try { require('./scan').scanLocked(); } catch {}
  const r = require('./export').exportUsage();
  if (!r.days) return console.log('Nothing to export yet. Send Claude a message first.');
  console.log(`Exported ${r.days} days of usage (from ${r.from}):`);
  console.log(`  ${r.csv}   one row per day, for spreadsheets`);
  console.log(`  ${r.json}  the same days, plus each project and model`);
}

function share() {
  const scan = require('./scan');
  try { scan.scanLocked(); } catch {}
  const lt = scan.loadLifetime();
  if (!lt || !lt.tokens) return console.log('No activity yet. Send Claude a message first.');
  const file = require('./share').writeCard(lt);
  require('./page').openPage(file);
  console.log(`Opened your activity card: ${file}`);
  console.log('It shows your activity grid, tokens, active days and streaks; no cost or project names.');
}

// Open a live view next to Claude. Windows Terminal can split itself; other
// terminals get the command on the clipboard.
function openPane(what, file, args, cmd) {
  const { spawn, execSync } = require('child_process');
  if (process.env.WT_SESSION) {
    spawn('wt.exe', ['-w', '0', 'sp', '-V', '-s', '0.45', 'node', path.join(BIN, file), ...args], { detached: true, stdio: 'ignore' }).unref();
    console.log(`Opened the ${what} in a Windows Terminal split pane.`);
    return;
  }
  let copied = false;
  if (!process.env.PULSE_NO_CLIPBOARD) try {
    const clip = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
    execSync(clip, { input: cmd, stdio: ['pipe', 'ignore', 'ignore'] });
    copied = true;
  } catch {}
  const split = process.env.TERM_PROGRAM === 'WarpTerminal'
    ? (process.platform === 'darwin' ? 'Cmd+D' : 'Ctrl+Shift+D') + ' in Warp'
    : 'your terminal\'s split-pane shortcut';
  console.log(`Split the window with ${split}, then paste and run${copied ? ' (already copied to your clipboard)' : ''}:`);
  console.log(`  ${cmd}`);
}

function live() {
  installScripts();
  openPane('live dashboard', 'dash.js', ['--live', '--dir', process.cwd()], installCommand() ? 'usage-pulse' : node('dash.js', ' --live'));
}

// What you're working on in this repository, next to Claude. Asking GitHub
// starts now, so the pane has something to show when it opens.
function orchestrator() {
  installScripts();
  const dir = process.cwd();
  try { require('child_process').spawn(process.execPath, [path.join(BIN, 'work.js'), '--refresh', '--dir', dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
  openPane('orchestrator', 'work.js', ['--live', '--dir', dir], node('work.js', ` --live --dir "${dir.replace(/\\/g, '/')}"`));
}

// /usage-pulse:settings: list every setting, show one, or change one.
function settings(name, value) {
  const { OPTIONS, option } = require('./options');
  const cfg = L.loadConfig();
  if (!name) {
    const width = Math.max(...OPTIONS.map((o) => o.name.length)) + 2;
    console.log('Usage Pulse settings. Change one with /usage-pulse:settings <name> <value>.\n');
    for (const o of OPTIONS) {
      console.log(`${o.name.padEnd(width)}${o.show(cfg[o.key]).padEnd(10)} ${o.values.join(', ')}`);
      console.log(`${' '.repeat(width)}${o.help}`);
    }
    return;
  }
  const o = option(name);
  if (!o) return console.log(`There's no setting called "${name}". Settings: ${OPTIONS.map((x) => x.name).join(', ')}.`);
  if (value === undefined) return console.log(`${o.name} is ${o.show(cfg[o.key])} (${o.values.join(', ')}). ${o.help}`);
  const v = o.parse(value);
  if (v === undefined) return console.log(`Pick one of: ${o.values.join(', ')}. Now: ${o.show(cfg[o.key])}.`);
  cfg[o.key] = v;
  L.saveConfig(cfg);
  // The activity page has the grid colors baked in.
  if (o.key === 'palette') {
    const lt = require('./scan').loadLifetime();
    if (lt) try { require('./page').writePage(lt, cfg); } catch {}
  }
  console.log(o.done(v));
}

const colors = (name) => settings('colors', name || '');

function activity() {
  const P = require('./page');
  const lt = require('./scan').scanLocked() && require('./scan').loadLifetime();
  if (lt && lt.tokens) P.writePage(lt);
  if (!fs.existsSync(P.PAGE_FILE)) return console.log('No activity yet. Send Claude a message first.');
  P.openPage();
  console.log(`Opened your activity page: ${P.PAGE_FILE}`);
}

// With no on/off, plain flips the current setting.
const plain = (arg) => settings('plain', arg === 'on' || arg === 'off' ? arg : (L.loadConfig().ascii ? 'off' : 'on'));

const [cmd, arg, value] = process.argv.slice(2);
const commands = { setup, uninstall, dashboard, recap, doctor, export: exportUsage, share, live, orchestrator, activity, plain: () => plain(arg), colors: () => colors(arg), settings: () => settings(arg, value) };
(commands[cmd] || (() => console.log('Usage: pulse.js setup|uninstall|dashboard|recap|doctor|export|share|live|orchestrator|activity|settings [name] [value]|plain <on|off>|colors <name>')))();
