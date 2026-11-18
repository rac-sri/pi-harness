#!/usr/bin/env node
// Replay every tool call in saved pi sessions through the current guards (creds-guard,
// url-guard) and report calls whose verdict changed. Run it after editing a guard rule:
// "newly blocked" calls are likely false positives on real work (HF harness-adapters: rescan
// real sessions after adding any rule). Exit 1 if any call is newly blocked.
// --accept records the current changes as known (deliberate tightenings), so later runs report
// only new ones. The baseline stores hashes, not arguments.
// Usage: node agent/scripts/guard-replay.mjs [--sessions DIR] [--verbose] [--accept]
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { root, jiti } from "../tests/lib/loader.mjs";

const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const verbose = process.argv.includes("--verbose");
const GUARD_MARK = /Blocked by creds-guard|Credential (?:access|glob) blocked|creds-guard could not|Blocked by url-guard|Use file tools for vault access|Harness evidence is managed/;

export async function loadGuards() {
  const handlers = [];
  for (const file of ["extensions/creds-guard.ts", "extensions/url-guard.ts"]) {
    const module = await jiti.import(path.join(root, file));
    module.default({ on: (event, fn) => { if (event === "tool_call") handlers.push({ name: path.basename(file, ".ts"), fn }); } });
  }
  return handlers;
}

/** Changed verdicts for one session file's entries. */
export async function replaySession(entries, guards) {
  const cwd = entries.find(e => e.type === "session")?.cwd ?? process.cwd();
  const results = new Map();
  for (const e of entries) if (e.type === "message" && e.message?.role === "toolResult") {
    const text = (e.message.content ?? []).map(b => b?.text ?? "").join("\n");
    results.set(e.message.toolCallId, { isError: Boolean(e.message.isError), guardBlocked: GUARD_MARK.test(text) });
  }
  const changes = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== "message" || e.message?.role !== "assistant" || !Array.isArray(e.message.content)) continue;
    for (const block of e.message.content) {
      if (block?.type !== "toolCall") continue;
      const ctx = { cwd, sessionManager: { getBranch: () => entries.slice(0, i + 1) } };
      let verdict;
      for (const guard of guards) {
        let result;
        try { result = await guard.fn({ toolName: block.name, input: block.arguments ?? {} }, ctx); } catch (error) { result = { block: true, reason: `guard threw: ${error}` }; }
        if (result?.block) { verdict = { guard: guard.name, reason: result.reason }; break; }
      }
      const then = results.get(block.id);
      if (!then) continue;
      const key = kind => createHash("sha256").update(JSON.stringify([kind, block.name, block.arguments, verdict?.reason])).digest("hex").slice(0, 24);
      if (verdict && !then.guardBlocked) changes.push({ key: key("blocked"), kind: "newly blocked", tool: block.name, args: block.arguments, ...verdict });
      if (!verdict && then.guardBlocked) changes.push({ key: key("allowed"), kind: "newly allowed", tool: block.name, args: block.arguments });
    }
  }
  return changes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sessions = arg("--sessions") ?? path.join(root, "sessions");
  const files = fs.existsSync(sessions) ? fs.readdirSync(sessions, { recursive: true }).filter(f => String(f).endsWith(".jsonl")).map(f => path.join(sessions, String(f))) : [];
  const guards = await loadGuards();
  const baselineFile = path.join(root, "harness", "guard-replay-baseline.json");
  const known = new Set(fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, "utf8")).accepted : []);
  const seen = [];
  let calls = 0, blocked = 0, allowed = 0, accepted = 0;
  for (const file of files) {
    const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    calls += entries.reduce((n, e) => n + (e.message?.role === "assistant" && Array.isArray(e.message.content) ? e.message.content.filter(b => b?.type === "toolCall").length : 0), 0);
    for (const change of await replaySession(entries, guards)) {
      seen.push(change.key);
      if (known.has(change.key)) { accepted++; continue; }
      if (change.kind === "newly blocked") blocked++; else allowed++;
      const args = JSON.stringify(change.args); const shown = verbose ? args : args.slice(0, 160) + (args.length > 160 ? "…" : "");
      console.log(`${change.kind.toUpperCase()} ${change.tool} ${shown}${change.reason ? `\n  ${change.guard}: ${change.reason}` : ""}\n  in ${path.relative(sessions, file)}`);
    }
  }
  console.log(`Replayed ${calls} tool calls from ${files.length} sessions: ${blocked} newly blocked, ${allowed} newly allowed, ${accepted} already accepted.`);
  if (process.argv.includes("--accept")) {
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, JSON.stringify({ updatedAt: new Date().toISOString(), accepted: [...new Set(seen)].sort() }, null, 2) + "\n");
    console.log(`Accepted ${new Set(seen).size} changes into ${baselineFile}.`);
  } else process.exit(blocked ? 1 : 0);
}
