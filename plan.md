# Orchestrator: what we're working on, in the CLI

> This section is the source of truth for the `plan-it` pass that turns the orchestrator
> initiative into a milestone and issues. Implementation details still need verifying against the
> codebase when each issue is built.

## Summary

Usage Pulse gets an **orchestrator**: a view of the work itself, alongside the view of your usage.
It answers "what are we working on right now, and where is it in the flow from issue to shipped
code?"

- **Two places to see it.** A live pane next to Claude (`/usage-pulse:orchestrator`), like
  `/usage-pulse:live`, with the full picture. And an orchestrator view of the status line under the
  prompt.
- **The status line switches by itself.** It shows usage as it does today. While one of the
  `*-it` pipeline skills is active in the session, it shows the orchestrator view, then switches
  back after a while idle. A setting can pin either view.
- **For everyone, and pipeline-aware.** Anyone gets the branch's issue, its milestone and the PR,
  with a stage worked out from Git and GitHub. When the `lab-it → plan-it → implement-it →
  review-it → ship-it` skills are in use, the stage comes from them instead.
- **Nothing gets slower.** The current stage is recorded by a plugin hook, and GitHub state is
  cached by a background job. The status line only reads files, as it does today.
- **What doesn't change:** the usage view, the existing commands and settings, and the pipeline
  skills themselves (they are not edited).

## Current state (verified)

| Fact | Evidence |
|---|---|
| The status line runs every second. It must stay fast (no spawning git, no rescanning in the foreground), must never throw, and must write to disk only when something changed. | `CLAUDE.md` "Code"; `scripts/statusline.js` `main()` wraps everything in `try … catch` |
| Slow work runs detached in the background behind a lock file, and the status line reads only its cached output. | `statusline.js` `refreshInBackground()` spawns `scan.js --quiet` with `scan.lock` (10 min); `loadLifetime()` reads `~/.claude/pulse/lifetime.json` |
| The branch is read from `.git/HEAD` without spawning git, including in worktrees. | `scripts/lib.js` `gitBranch()` |
| Every row must fit within `COLUMNS` minus the margin, which the tests check. | `CLAUDE.md`; `statusline.js` `cols`; `test/pulse.test.js` |
| What the status line shows is already configurable (`layout compact`, `grid`, `summary`, `branch`). Settings are defined in one place. | `scripts/options.js` `OPTIONS`; `statusline.js` `show` |
| A live pane already exists: `pulse.js live` splits Windows Terminal (`wt.exe sp`) or tells you to run `usage-pulse` / `dash.js --live`. `dash.js --live` refreshes every 2 seconds. | `scripts/pulse.js` `live()`; `scripts/dash.js` header |
| Commands are `commands/*.md` files that run `pulse.js <cmd>` and relay its output. | `commands/live.md` |
| The plugin ships no hooks today. | `plugins/usage-pulse/` has only `commands/` and `scripts/` |
| Zero runtime dependencies, Node 20+. | `CLAUDE.md`; `package.json` `engines` |
| The pipeline skills persist no state: stage, milestone and active issue live only in the conversation and on GitHub. Branch names are free-form (derived from the milestone), so the issue can't be read from the branch reliably. | `~/.claude/skills/implement-it/SKILL.md`; `implement-it/rules/sequencing.md` (branch recommendation) |
| Skill invocations show up as `Skill` tool calls in the session transcript, and the status line input carries the transcript path and session id. | Session transcript JSONL; status line stdin (`session_id`, `transcript_path`, `workspace`) |

## Locked decisions (approved by the user)

1. **Audience: generic, pipeline-aware.** It works for any user and repo. The `*-it` pipeline
   skills enrich it when they are in use. It lives inside Usage Pulse, not in a separate plugin.
2. **Surfaces: both.** A live orchestrator pane opened by a command (like `/usage-pulse:live`),
   **and** an orchestrator view of the status line.
3. **Status line switching: automatic, with an override.** Default is the usage view. While a
   pipeline skill is active in the session, the status line shows the orchestrator view instead,
   and goes back to usage after about 10 minutes without pipeline activity. A setting pins it:
   `mode usage | orchestrator | auto` (default `auto`).
4. **Source of stage and active issue: a hook plus a GitHub cache.** A plugin hook records which
   pipeline skill ran (and the issue it touched, when it can tell). A background job caches
   milestone, issue and PR state from `gh`. The pipeline skills are not modified.
5. **Stage without the pipeline: inferred from Git and GitHub.** The branch leads to its issue (a
   number in the branch name, or the PR's `Closes #N`) and that issue's milestone. Stage comes from
   facts: no PR means **Implementing**, an open PR means **In review** (with CI status), merged
   means **Shipped**.

## Derived constraints

- **The status line never calls `gh` or the network.** GitHub state comes only from a cache file
  that a detached background refresh writes, reusing the `refreshInBackground` lock pattern.
  *Premises:* the status line speed rule, plus decision 4.
- **Stage detection doesn't read the transcript every second.** The hook writes a small per-session
  state file and the status line reads it. *Premises:* decision 4, plus the status line running
  every second.
- **Hook data is keyed by session and repo.** Several Claude sessions, often in different repos or
  worktrees, run at once. One session's pipeline stage must not show in another. *Premises:* the
  per-session files that already exist (`~/.claude/pulse/sessions/`), plus decision 3 ("active in
  the session").
- **Degrade to nothing, never to wrong.** Without `gh`, without auth, outside a repo, or with no
  issue found, the orchestrator shows only what it knows (branch, recorded stage) and hides the
  rest. The usage view is never affected. *Premises:* the never-throw rule, plus decision 1 (any
  user).
- **When a pipeline stage was recorded recently, it wins over the inferred stage.** The inferred
  stage is the fallback. *Premises:* decisions 1 and 5.
- **The orchestrator status line view follows the same width and margin rules** and needs test
  coverage like the existing rows. *Premises:* the `COLUMNS` rule and the existing tests.
- **The new setting lives in `options.js`**, so `/usage-pulse:settings` lists and changes it.
  *Premises:* settings are defined in one place.
- **The docs land with each change** (README plus a `CHANGELOG.md` Unreleased line). *Premise:* the
  repo's `CLAUDE.md` "Docs as we go".

## What stays unchanged

- The usage view of the status line, when it is showing, renders exactly as today.
- Existing commands, settings and their defaults. `mode auto` only changes the status line while a
  pipeline skill is active.
- The `*-it` pipeline skills (no edits). No runtime dependencies.

## Change boundary (conceptual)

- **New:** a plugin hook that records pipeline activity, a background GitHub refresh with its cache
  file, an orchestrator model that merges recorded stage, inferred stage, issue, milestone and PR,
  an orchestrator status line view, a live orchestrator pane plus its command, and a `mode`
  setting.
- **Changed:** `statusline.js` picks a view based on `mode` and recent pipeline activity. `pulse.js`
  gets the new command. README and CHANGELOG are updated.
- **Not touched:** the usage rendering, scan/lifetime, alerts, the pipeline skills.

## Contents of the views (as approved in the previews)

- **Live pane:** the pipeline map with the current stage highlighted (`lab-it ▶ plan-it ▶
  [implement-it] ▶ review-it ▶ ship-it`, or Implementing / In review / Shipped when inferred), the
  milestone with progress (done/total), the current issue, the next step, blocked issues, PR and CI
  status, and the milestone's issues with their state.
- **Status line view:** one or two rows with the stage, the current issue (number and title),
  milestone progress, next step, and PR/CI.

## Open implementation details

- **Which hook events.** PostToolUse on `Skill` gives the stage. Detecting the active issue may
  also need Bash calls like `gh issue view|close N` or the skill's arguments. Any choice is fine as
  long as it can't record another session's issue and shows nothing rather than a wrong issue.
- **Where "next step" comes from:** a fixed pipeline order (stage n → n+1), plus milestone facts
  like the next open, unblocked issue. How "blocked" is read from GitHub (labels, "blocked by" in
  the issue body, task lists) is open, as long as an unknown means it isn't shown as blocked.
- **GitHub refresh cadence and cache shape.** It should run often enough that the pane feels live
  (on the order of a minute), within the lock pattern.
- **Live pane implementation:** a new mode of `dash.js` or its own script, reusing `pulse.js live`'s
  pane opening.
- **Exact wording, colors and row layout**, within the existing style and the plain/ASCII mode.
