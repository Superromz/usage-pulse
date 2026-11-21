# Usage Pulse

**Your Claude usage at a glance, right where you work.** Usage Pulse is a Claude Code plugin that
puts your context window, plan limits, session cost and a GitHub-style activity grid under the
prompt, and gives you a usage dashboard one command away.

![Usage Pulse under the Claude Code prompt: context, 5-hour and weekly gauges, session cost, and a year of activity as a red grid](docs/statusline.png)

- **Live:** the numbers come straight from Claude Code every second.
- **Plain words:** "Context 27%", "5-hour 34% resets 1h12m", "This session $3.20".
- **Local and private:** everything stays in `~/.claude/pulse/`. Nothing is sent anywhere.
- **Zero dependencies:** plain Node 20+, MIT licensed.

## Install

You need Claude Code and Node.js 20 or newer. In Claude Code:

```
/plugin marketplace add superromz/usage-pulse
/plugin install usage-pulse@usage-pulse
/usage-pulse:setup
```

To update later: `/plugin marketplace update usage-pulse`, then `/plugin update usage-pulse@usage-pulse`
and restart Claude Code. What changed in each version is in [CHANGELOG.md](CHANGELOG.md) and on the
[Releases](https://github.com/superromz/usage-pulse/releases) page.

### Moving from claude-pulse

Usage Pulse used to be called Claude Pulse. If you installed it under that name, switch over once
(your settings and history in `~/.claude/pulse/` carry over):

```
/plugin uninstall claude-pulse@claude-pulse
/plugin marketplace remove claude-pulse
/plugin marketplace add superromz/usage-pulse
/plugin install usage-pulse@usage-pulse
/usage-pulse:setup
```

Setup replaces your status line, adds a few usage tips under the spinner, and saves what was there
before, so `/usage-pulse:uninstall` can put it back.

| Command | What it does |
|---|---|
| `/usage-pulse:setup` | Install the status line and spinner tips. |
| `/usage-pulse:dashboard` | Print the full usage dashboard. |
| `/usage-pulse:recap` | Last week at a glance (Monday to Sunday): tokens, replies, cost, active days, busiest day, top project and model, each compared with the week before. |
| `/usage-pulse:live` | Keep the dashboard open next to Claude (also: `usage-pulse` in any terminal). |
| `/usage-pulse:orchestrator` | Keep what you're working on open next to Claude: the branch's issue, pull request and CI, its milestone and the next step. See [The orchestrator](#the-orchestrator). |
| `/usage-pulse:activity` | Open your activity page in the browser. |
| `/usage-pulse:settings` | See every setting, or change one, like `/usage-pulse:settings colors red`. See [Settings](#settings). |
| `/usage-pulse:colors red` | Shortcut for the activity grid colors: `green` (default), `red`, `blue` or `purple`. |
| `/usage-pulse:plain on` | Shortcut for plain text only (ASCII bars and symbols), for fonts that lack block and line characters. `off` turns it back. |
| `/usage-pulse:doctor` | Something looks wrong? Checks Node, the status line setting, its scripts, Claude Code's history, plan limits, colors and symbols, and says how to fix anything that's off. It changes nothing. |
| `/usage-pulse:export` | Save your daily usage to `~/.claude/pulse/exports/`: a CSV with one row per day (each kind of token, replies, cost) for spreadsheets, and a JSON file with the same days plus each project and model. |
| `/usage-pulse:share` | Make an image of your year of activity to post. See [Your activity page](#your-activity-page). |
| `/usage-pulse:uninstall` | Put your previous status line and tips back. |

### Settings

`/usage-pulse:settings` lists every setting with its current value and what it can be, and
`/usage-pulse:settings <name> <value>` changes one. Changes show up in the status line within a
second, with no restart.

| Setting | Values | What it does |
|---|---|---|
| `colors` | `green` (default), `red`, `blue`, `purple` | Colors of the activity grid and the activity page. |
| `plain` | `on`, `off` (default) | Plain text only: ASCII bars and symbols, for fonts that show boxes instead. |
| `activity` | `on` (default), `off` | The lifetime summary and activity grid in the status line (`off` hides both). |
| `layout` | `auto` (default), `compact` | `compact` keeps the status line to its two main rows at any width. |
| `mode` | `auto` (default), `usage`, `orchestrator` | What the status line shows. `auto` shows usage, and what you're working on while a `lab-it` … `ship-it` skill is active. See [The orchestrator](#the-orchestrator). |
| `grid` | `on` (default), `off` | The activity grid on its own. |
| `summary` | `on` (default), `off` | The lifetime summary (lifetime, past year, streak, busiest day) on its own. |
| `branch` | `on` (default), `off` | The git branch. |
| `color-depth` | `auto` (default), `truecolor`, `256` | `auto` uses 256 colors in terminals that can't show exact shades, such as macOS Terminal. |
| `alerts` | `on` (default), `off` | Warn when a plan limit or the context window passes its threshold. See [Alerts](#alerts). |
| `desktop-alerts` | `on` (default), `off` | Also show each warning once as a desktop notification. |
| `limit-alert` | `50` to `99` (default `80`) | How full (%) the 5-hour or weekly limit gets before the warning. |
| `context-alert` | `50` to `99` (default `70`) | How full (%) the context window gets before the warning. |
| `budget-daily` | `off` (default) or an amount like `20` | Daily budget in dollars. See [Budgets](#budgets). |
| `budget-monthly` | `off` (default) or an amount like `300` | Monthly budget in dollars, shown on the dashboard. |
| `margin` | `0` to `40` (default `6`) | Columns kept free at the right of the status line, where Claude Code cuts it off. |

Settings are saved in `~/.claude/pulse/config.json`.

## The status line

The screenshot above shows it on a wide terminal (with demo numbers).

The top row holds the three gauges that matter most. Each one turns yellow at 60% and red at 85%.
On a wide terminal your activity grid sits on the right, with a lifetime summary under the gauges.

| Item | What it means |
|---|---|
| Context | How full the conversation's context window is. |
| 5-hour, Weekly | Your plan's usage windows (Pro and Max plans) and when each one resets. **↑ out by 4:10pm** means that at the current rate you'd reach the limit at that time, before it resets (on a narrow terminal, just **↑**). |
| Model · effort | The model answering and the effort level it uses. |
| This session | What this session has cost, how long it has been open, and the lines added and removed. |
| Today | What all your Claude Code sessions have cost today, and how much of your daily budget that is if you set one (see [Budgets](#budgets)). |
| Cache | Claude Code keeps your conversation cached for a while after each message, which makes the next message faster and cheaper. "Warm 47m" is how long that lasts; "cold" means the next message rebuilds it. |
| ⎇ | The git branch of the folder you're working in. |
| Activity grid | Like the contribution graph on GitHub: a column per week, a row per weekday, a square per day. The brighter the square, the busier the day; dim squares are days off. It shows as many weeks as fit, up to a year. Pick its colors with `/usage-pulse:colors red` (or `green`, `blue`, `purple`). Hover an active day to see its usage, like `Thu, Nov 19 | 259M tokens | 565 replies` (in terminals that preview links on hover, such as Warp). |
| Lifetime | Every token Claude has read and written for you. Mostly context re-read from the cache, so the number gets big fast. |
| Past year | Tokens in the last 12 months and how many days you used Claude. |
| Streak | Days in a row you've used Claude, and your best run. Today doesn't break it until it's over. |
| Busiest day | The day you used the most tokens. |

On a medium-width terminal the summary and grid move under the two main rows instead, side by
side, so the full year still fits from about 165 columns. Narrower still, the grid shows fewer weeks,
then steps aside (leaving two rows), and the wording gets shorter, so the rows never wrap. Anything Claude Code doesn't report (for example plan limits on an API key) is simply left out.

Want less? `/usage-pulse:settings layout compact` keeps it to the two main rows, and `grid`, `summary`
and `branch` turn those parts off one at a time. An alert still shows above the rows in any layout.

### Alerts

When the 5-hour or weekly limit passes 80%, or the context window passes 70%, a warning appears
above the gauges, like `⚠ 5-hour limit 82% used (resets 1h12m)` or
`⚠ Context 72% full: /compact soon frees room`. It stays while you're over the threshold.

The first time each one happens you also get a desktop notification (Windows, macOS, and Linux with
`notify-send`): once per limit window, and once per session for the context window, so it never
nags. Change the thresholds or turn either part off with `/usage-pulse:settings` (`limit-alert`,
`context-alert`, `desktop-alerts`, `alerts`).

### Budgets

Set a daily budget, a monthly budget, or both, in dollars:

```
/usage-pulse:settings budget-daily 20
/usage-pulse:settings budget-monthly 300
```

With a daily budget, "Today" in the status line shows how much of it is used (`Today $12.40 of $20.00`),
turning yellow at 60% and red at 85% like the gauges. With a monthly budget, the dashboard's Spending
section shows this month so far against it. `off` removes either one. Type plain numbers (`20`, not
`$20`), since `$` means something else to the command line.

The spending figure is Claude Code's own cost figure. With an API key it's what you pay; on Pro and
Max plans it estimates what the same use would cost on the API, not what you're billed, so a budget
there is a way to pace yourself rather than a bill. It only counts days since Usage Pulse was
installed.

## Your activity page

`/usage-pulse:activity` opens `~/.claude/pulse/activity.html` in your browser: the past year as a
GitHub-style grid, with a tooltip on every day (tokens and replies). It updates every 10 minutes and
never leaves your computer.

To share it, `/usage-pulse:share` makes `~/.claude/pulse/activity-card.svg` and opens it: the same
grid in your colors with your lifetime tokens, active days, streaks and busiest day. It leaves out
cost and project names, and needs nothing from the internet to display. Post the file, or screenshot it.

## The dashboard

`/usage-pulse:dashboard` prints the full picture. `/usage-pulse:live` opens it next to Claude
and keeps it up to date (in Windows Terminal it splits the window for you; elsewhere it copies the
`usage-pulse` command so you can paste it into a split pane). In the live view, hover any square in
the activity grid to see that day's tokens and replies.

- **Plan limits**: both windows with reset times and whether you're on track.
- **Spending**: today, yesterday, the last 7 and 30 days, and this month against your monthly budget if you set one.
- **Your activity**: the past year as a GitHub-style grid, in the colors you picked, with lifetime
  tokens, active days, your current and longest streak, and your busiest day.
- **Open sessions**: every Claude Code window active in the last 10 minutes, with its context
  and cost.
- **Activity, last 14 days**: tokens and replies per day, and a "Last week" line with the headline
  figures from `/usage-pulse:recap`.
- **Projects** and **Models**: where your usage went this week, and how much input came from the
  cache. Each project also shows what it cost in the last 7 days and this month (a dash where no
  cost was recorded, such as before Usage Pulse was installed).

## The orchestrator

`/usage-pulse:orchestrator` opens what you're working on next to Claude, the same way
`/usage-pulse:live` opens the dashboard, and keeps it up to date while you work. For the repository
Claude is in, it shows:

- **Stage**: Implementing (no pull request yet), In review (pull request open, with its CI:
  passing, failing or pending) or Shipped (merged).
- **Issue**: the issue the branch belongs to. It finds it from a number in the branch name (like
  `feat/42-search`) or from "Closes #42" in the branch's pull request.
- **PR**: the branch's pull request.
- **Milestone**: the issue's milestone, how many of its issues are closed, and each issue with its
  state. An issue counts as blocked only when GitHub clearly says so: a `blocked` label, or
  "Depends on #N" where #N is still open in the same milestone.
- **Next**: the next open issue in the milestone that isn't blocked.

It asks GitHub through the [`gh` command](https://cli.github.com), in the background and about once a
minute; the status line never does. Without `gh`, signed out, or outside a repository, it shows
what it knows and says what's missing.

If you work through the `lab-it` → `plan-it` → `implement-it` → `review-it` → `ship-it` skills,
the orchestrator follows along. Usage Pulse adds a small hook that notes which of these skills each
Claude session runs, and the issue when it's clear (one issue number in what the skill was asked).
The pane then shows **Step** instead of Stage, with the current skill in brackets, and **Next step**:

```
Step       lab-it ▶ plan-it ▶ [implement-it] ▶ review-it ▶ ship-it
Next step  review-it
```

Each repository shows the step of the session working in it, and nothing from other sessions. That
issue also finds the milestone when the branch name doesn't say, such as a branch shared by a whole
milestone. After two hours without one of these skills, the pane goes back to the stage from GitHub.
The hook only writes to `~/.claude/pulse/pipeline/`, and never slows down or stops what Claude is doing.

### In the status line

While one of these skills is active in a session, that session's status line shows what you're
working on instead of usage, in two rows:

```
Step [implement-it] next review-it   #20 Orchestrator: show the pipeline step…
Milestone 0.4.0: See what you're working on ■□□ 1/3   PR #22 open · CI passing   Next #21 …
```

It goes back to usage about 10 minutes after the last of these skills started. Other sessions keep
showing usage. Starting one of the skills also asks GitHub in the background, so the issue and
milestone are there without opening the pane.

`/usage-pulse:settings mode` chooses: `auto` (the default, as above), `usage` (always usage) or
`orchestrator` (always what you're working on, with the stage from GitHub when no skill is active).
The status line still only reads files: it never asks GitHub itself.

## Where the numbers come from

- The status line numbers come straight from Claude Code, every second.
- Spending is Claude Code's own cost figure, recorded per session per day from the moment
  Usage Pulse is installed. A session that was already open before midnight only counts the part of its
  cost since midnight (spread evenly over the session).
- Lifetime totals, activity, projects and models are read from Claude Code's history in `~/.claude/projects`, so
  they go back as far as that history does. Older days come from Claude Code's own stats. Only new lines are read after the first time.
- `/usage-pulse:export` covers the days Usage Pulse has read from that history, which has the
  breakdown by kind of token, project and model. Cost is left empty for days before it was recorded.

Everything stays in `~/.claude/pulse/`. Nothing is sent anywhere. The orchestrator only reads from
GitHub, through your own `gh`.

## Where it works

Usage Pulse is a Claude Code plugin, so it runs inside Claude Code: on Windows, macOS and Linux,
with Node.js 20 or newer. It doesn't work in other AI command-line tools.

**Something looks wrong?** Run `/usage-pulse:doctor`: it checks the usual causes below and tells you
the fix for each.

- **Colors:** exact shades in Warp, Windows Terminal, iTerm2, Kitty, WezTerm, VS Code and most Linux
  terminals. Terminals that can't show them, such as macOS Terminal, automatically get the nearest
  of 256 colors. To force one or the other, run `/usage-pulse:settings color-depth truecolor` or
  `/usage-pulse:settings color-depth 256`.
- **Symbols:** if your font shows boxes instead of bars and squares, run `/usage-pulse:plain on`.
- **Hover in the status line:** needs a terminal that previews links on hover, such as Warp. SSH
  and tmux can strip it.
- **Hover in the live dashboard:** needs mouse support, which almost every terminal has (in tmux,
  turn on `set -g mouse on`).
- **Plan limits:** Claude Code reports the 5-hour and weekly limits on Pro and Max plans. With an
  API key those gauges are left out.

## Development

```sh
npm test
```

Tests run on Windows, macOS and Linux with Node 20 and 24 on every push (`.github/workflows/test.yml`).

The plugin lives in `plugins/usage-pulse/`: `statusline.js` (the status line), `dash.js` (the
dashboard), `grid.js` (the activity grid), `page.js` (the activity page), `scan.js` (reads Claude
Code's history), `lib.js` (shared helpers and the spend ledger) and `pulse.js` (the commands).

`node tools/screenshot.js` redraws `docs/statusline.png` from made-up demo data (needs Python with
Pillow), so update it whenever the status line looks different.

## Releasing

Versions follow [Semantic Versioning](https://semver.org/). Claude Code offers an update only when
the version changes, so every release bumps it.

1. Move the lines under `## Unreleased` in `CHANGELOG.md` into a new `## x.y.z - YYYY-MM-DD` section.
2. Set the same version in `plugins/usage-pulse/.claude-plugin/plugin.json`, the plugin entry in
   `.claude-plugin/marketplace.json` and `package.json` (a test fails if they disagree).
3. Commit "Release x.y.z" on a branch and open a pull request into `main`. `main` only accepts
   pull requests whose tests all pass ("All tests passed"), so merge it once they do.
4. Pull `main`, then run `claude plugin tag --push` from the repository folder. It checks the
   manifests and pushes the tag `usage-pulse--vx.y.z`.

The tag starts the Release workflow (`.github/workflows/release.yml`): it runs the tests, checks
the tag matches `plugin.json` and publishes the GitHub Release with that version's changelog
section as its notes.

## Contributors

- [Superromz](https://github.com/Superromz)
- [Claude](https://claude.com/claude-code), Anthropic's AI, through Claude Code

## License

MIT
