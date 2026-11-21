#!/usr/bin/env node
// Claude Code hook: records which step of the lab-it → plan-it → implement-it
// → review-it → ship-it skills each session is on, for the orchestrator.
// Runs after Claude uses the Skill tool and when you send a prompt (to catch
// /implement-it typed by hand). It never prints and never fails the call it
// watches.
//
//   ~/.claude/pulse/pipeline/<session>.json  { session, root, step, issue, at }
'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const PIPELINE_DIR = path.join(L.HOME, 'pipeline');
const STEPS = ['lab-it', 'plan-it', 'implement-it', 'review-it', 'ship-it'];

// "implement-it", "/implement-it", "some-plugin:implement-it" → "implement-it".
function stepOf(name) {
  const s = String(name || '').trim().replace(/^\//, '').split(':').pop().toLowerCase();
  return STEPS.includes(s) ? s : null;
}

// The issue a skill was asked about, only when that's unambiguous: exactly one
// issue number in its arguments ("implement #42", "issue 42").
function issueOf(text) {
  const nums = new Set([...String(text || '').matchAll(/(?:#|\bissues?\s+#?)(\d+)\b/gi)].map((m) => Number(m[1])));
  return nums.size === 1 ? [...nums][0] : null;
}

// What a hook payload says about the pipeline, or null.
function fromPayload(p) {
  if (!p || !p.session_id) return null;
  let step = null, args = '';
  if (p.hook_event_name === 'UserPromptSubmit' || (p.prompt != null && !p.tool_name)) {
    const m = String(p.prompt || '').match(/^\s*\/([\w:-]+)\s*([\s\S]*)$/);
    if (m) { step = stepOf(m[1]); args = m[2]; }
  } else if (p.tool_name === 'Skill' && p.tool_input) {
    step = stepOf(p.tool_input.skill || p.tool_input.command || p.tool_input.name);
    args = p.tool_input.args || '';
  }
  return step ? { step, issue: issueOf(args) } : null;
}

const recordFile = (sid) => path.join(PIPELINE_DIR, `${String(sid).replace(/[^\w.-]/g, '_')}.json`);

function record(p, now = Date.now()) {
  const hit = fromPayload(p);
  if (!hit) return null;
  const repo = require('./work').repoInfo(p.cwd || process.cwd());
  if (!repo) return null;
  const rec = { session: String(p.session_id), root: repo.root, step: hit.step, issue: hit.issue, at: now };
  // A new step without a clear issue keeps the issue this session was on.
  const prev = L.readJSON(recordFile(p.session_id), null);
  if (!rec.issue && prev && prev.root === rec.root && prev.issue) rec.issue = prev.issue;
  L.writeJSON(recordFile(p.session_id), rec);
  prune(now);
  return rec;
}

// Records older than two days no longer count anywhere: remove them so the
// folder stays small (the pane reads all of it).
function prune(now = Date.now()) {
  let files = [];
  try { files = fs.readdirSync(PIPELINE_DIR); } catch { return; }
  for (const f of files) {
    const file = path.join(PIPELINE_DIR, f);
    try { if (now - fs.statSync(file).mtimeMs > 2 * 86400000) fs.unlinkSync(file); } catch {}
  }
}

// The latest step recorded in this repository within `maxAge`, from any session.
function latestFor(root, maxAge, now = Date.now()) {
  let best = null;
  let files = [];
  try { files = fs.readdirSync(PIPELINE_DIR); } catch { return null; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const r = L.readJSON(path.join(PIPELINE_DIR, f), null);
    if (!r || r.root !== root || !STEPS.includes(r.step) || !(now - r.at <= maxAge)) continue;
    if (!best || r.at > best.at) best = r;
  }
  return best;
}

module.exports = { STEPS, stepOf, issueOf, fromPayload, record, latestFor, PIPELINE_DIR };

if (require.main === module) {
  try {
    const raw = fs.readFileSync(0, 'utf8').replace(/^﻿/, '');
    record(JSON.parse(raw || '{}'));
  } catch {}
  process.exit(0);
}
