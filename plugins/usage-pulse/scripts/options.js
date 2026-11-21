// Every setting Usage Pulse has, in one place. /usage-pulse:settings lists and
// changes them, and lib.js takes the defaults from here, so a new setting is
// one entry below. `key` is its name in ~/.claude/pulse/config.json.
'use strict';

const onOff = {
  values: ['on', 'off'],
  show: (v) => (v ? 'on' : 'off'),
  parse: (s) => (s === 'on' ? true : s === 'off' ? false : undefined),
};

const percent = {
  values: ['50 to 99'],
  parse: (s) => (/^\d+$/.test(s) && Number(s) >= 50 && Number(s) <= 99 ? Number(s) : undefined),
};

// A dollar amount like 20, 12.50 or $20; off (stored as 0) turns it off.
const money = {
  values: ['off', 'an amount like 20'],
  show: (v) => (v > 0 ? '$' + (Number.isInteger(v) ? v : v.toFixed(2)) : 'off'),
  parse: (s) => {
    if (s === 'off' || s === '0') return 0;
    const m = /^\$?(\d{1,6}(\.\d{1,2})?)$/.exec(s);
    return m && Number(m[1]) > 0 ? Number(m[1]) : undefined;
  },
};

const OPTIONS = [
  {
    name: 'colors', key: 'palette', default: 'green', values: ['red', 'green', 'blue', 'purple'],
    help: 'Colors of the activity grid and the activity page.',
    done: (v) => `The activity grid is now ${v}.`,
  },
  {
    name: 'plain', key: 'ascii', default: false, ...onOff,
    help: 'Plain text only: ASCII bars and symbols, for fonts that show boxes instead.',
    done: (v) => (v ? 'Plain text is on: bars, squares and symbols are now ASCII.' : 'Plain text is off: bars, squares and symbols are back.'),
  },
  {
    name: 'activity', key: 'lifetime', default: true, ...onOff,
    help: 'Lifetime summary and activity grid in the status line (off hides both).',
  },
  {
    name: 'layout', key: 'layout', default: 'auto', values: ['auto', 'compact'],
    help: 'auto fits as much as the terminal allows; compact keeps the status line to its two main rows.',
  },
  {
    name: 'mode', key: 'mode', default: 'auto', values: ['auto', 'usage', 'orchestrator'],
    help: 'What the status line shows: usage, or what you\'re working on (orchestrator). auto shows the orchestrator while a lab-it to ship-it skill is active in the session.',
  },
  {
    name: 'grid', key: 'grid', default: true, ...onOff,
    help: 'The activity grid in the status line.',
  },
  {
    name: 'summary', key: 'summary', default: true, ...onOff,
    help: 'The lifetime summary (lifetime, past year, streak, busiest day) in the status line.',
  },
  {
    name: 'branch', key: 'branch', default: true, ...onOff,
    help: 'The git branch in the status line.',
  },
  {
    name: 'color-depth', key: 'color', default: 'auto', values: ['auto', 'truecolor', '256'],
    help: 'auto uses 256 colors in terminals that can\'t show exact shades, such as macOS Terminal.',
  },
  {
    name: 'alerts', key: 'alerts', default: true, ...onOff,
    help: 'Warn when a plan limit or the context window passes its threshold.',
  },
  {
    name: 'desktop-alerts', key: 'desktopAlerts', default: true, ...onOff,
    help: 'Also show each warning once as a desktop notification.',
  },
  {
    name: 'limit-alert', key: 'limitAlert', default: 80, ...percent,
    help: 'How full (%) the 5-hour or weekly limit gets before the warning.',
  },
  {
    name: 'context-alert', key: 'contextAlert', default: 70, ...percent,
    help: 'How full (%) the context window gets before the warning.',
  },
  {
    name: 'budget-daily', key: 'budgetDaily', default: 0, ...money,
    help: 'Daily budget in dollars: "Today" shows how much of it is used. Spending is Claude Code\'s own cost figure.',
  },
  {
    name: 'budget-monthly', key: 'budgetMonthly', default: 0, ...money,
    help: 'Monthly budget in dollars, shown against this month\'s spending on the dashboard.',
  },
  {
    name: 'margin', key: 'margin', default: 6, values: ['0 to 40'],
    parse: (s) => (/^\d+$/.test(s) && Number(s) <= 40 ? Number(s) : undefined),
    help: 'Columns kept free at the right of the status line, where Claude Code cuts it off.',
  },
];

for (const o of OPTIONS) {
  o.show = o.show || String;
  o.parse = o.parse || ((s) => (o.values.includes(s) ? s : undefined));
  o.done = o.done || ((v) => `${o.name} is now ${o.show(v)}.`);
}

const DEFAULT_CONFIG = Object.fromEntries(OPTIONS.map((o) => [o.key, o.default]));
const option = (name) => OPTIONS.find((o) => o.name === name);

module.exports = { OPTIONS, DEFAULT_CONFIG, option };
