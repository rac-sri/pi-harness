#!/usr/bin/env node
// Find repair episodes in saved pi sessions: a check (bash command or harness_check verify)
// fails, files are edited, and the same check later passes. Sessions where something breaks and
// gets fixed are the most useful source of eval tasks (HF harness-adapters, 2026). Each candidate
// records where to look; turning one into a domain-eval task still needs the repository at that
// point and a human to write the request, broken/fixed code and tests (then validateCase checks it).
// Output is redacted: home directory → ~, emails, and known credential formats.
// Usage: node agent/scripts/mine-sessions.mjs [--sessions DIR] [--out FILE]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { root, jiti } from "../tests/lib/loader.mjs";

const { secretIn } = await jiti.import(path.join(root, "extensions/lib/url-guard.ts"));
const EDIT_TOOLS = new Set(["write", "edit", "hashline_edit", "ast_grep_replace"]);
const GUARD_BLOCK = /creds-guard|url-guard|Read-only subagent|vault access is disabled/;

export function redact(text) {
  // Session directories encode the cwd with "/" as "-", so the home directory appears in that form too.
  let out = String(text).split(os.homedir()).join("~").split(os.homedir().replace(/\//g, "-")).join("~").replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>");
  for (let i = 0; i < 20; i++) {
    const found = secretIn(out);
    if (!found) break;
    out = out.replace(/\S*(?:AKIA|ASIA|gh[pousr]_|github_pat_|sk-|[rs]k_live_|xox[abprs]-|AIza|-----BEGIN|eyJ)\S*/, "<secret>");
  }
  return out;
}

/** The check a tool call runs, if it is one: normalized bash command or harness verify id. */
function checkKey(name, args) {
  if (name === "bash" && typeof args?.command === "string") return "bash:" + args.command.trim().replace(/\s+/g, " ");
  if (name === "harness_check" && args?.action === "verify" && args.check) return `harness_check:${args.run}/${args.check}`;
}

export function mineSession(entries) {
  const cwd = entries.find(e => e.type === "session")?.cwd ?? "";
  const calls = new Map();
  const timeline = [];
  for (const e of entries) {
    const m = e.message;
    if (e.type !== "message" || !m) continue;
    if (m.role === "assistant" && Array.isArray(m.content)) for (const block of m.content) if (block?.type === "toolCall") calls.set(block.id, block);
    if (m.role === "toolResult") {
      const call = calls.get(m.toolCallId);
      if (!call) continue;
      const text = (m.content ?? []).map(b => b?.text ?? "").join("\n");
      timeline.push({ name: call.name, args: call.arguments ?? {}, isError: Boolean(m.isError), text, at: e.timestamp });
    }
  }
  const candidates = [];
  const open = new Map(); // check key → { index, failing step }
  timeline.forEach((step, index) => {
    const key = checkKey(step.name, step.args);
    if (!key) return;
    if (step.isError && !GUARD_BLOCK.test(step.text)) { if (!open.has(key)) open.set(key, { index, step }); return; }
    const failed = open.get(key);
    if (!step.isError && failed) {
      open.delete(key);
      const between = timeline.slice(failed.index + 1, index);
      const files = [...new Set(between.filter(s => EDIT_TOOLS.has(s.name) && typeof s.args.path === "string").map(s => path.relative(cwd, path.resolve(cwd, s.args.path))))];
      if (!files.length) return; // Passed again without an edit: flaky or environmental, not a repair.
      candidates.push({ cwd: redact(cwd), check: redact(key), files: files.map(redact), toolCallsBetween: between.length, failedAt: failed.step.at, fixedAt: step.at, failureTail: redact(failed.step.text.slice(-400)) });
    }
  });
  return candidates;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
  const sessions = arg("--sessions") ?? path.join(root, "sessions");
  const out = arg("--out") ?? path.join(root, "harness", "evals", "candidates.jsonl");
  const files = fs.existsSync(sessions) ? fs.readdirSync(sessions, { recursive: true }).filter(f => String(f).endsWith(".jsonl")).map(f => path.join(sessions, String(f))) : [];
  const found = [];
  for (const file of files) {
    const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    for (const candidate of mineSession(entries)) found.push({ session: redact(path.relative(sessions, file)), ...candidate });
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, found.map(c => JSON.stringify(c)).join("\n") + (found.length ? "\n" : ""));
  const byRepo = {};
  for (const c of found) byRepo[c.cwd] = (byRepo[c.cwd] ?? 0) + 1;
  console.log(`Found ${found.length} repair episodes in ${files.length} sessions → ${out}`);
  for (const [repo, n] of Object.entries(byRepo).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${n}  ${repo}`);
}
