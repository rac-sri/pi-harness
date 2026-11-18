#!/usr/bin/env node
// Summarise harness/metrics/dispatches.jsonl per role and model, to set per-model limits in
// agents/runtime.json from data. Usage: node agent/scripts/dispatch-stats.mjs [--since YYYY-MM-DD] [--file PATH]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const file = arg("--file") ?? path.join(agentDir, "harness/metrics/dispatches.jsonl");
const since = arg("--since");

export function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

export function summarise(records) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.role} ${r.model ?? "default"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups].sort().map(([key, rows]) => {
    const ok = rows.filter(r => r.outcome === "ok");
    const stops = {};
    for (const r of rows) if (r.stop) stops[r.stop] = (stops[r.stop] ?? 0) + 1;
    return {
      group: key, runs: rows.length, ok: ok.length,
      turnsP50: quantile(rows.map(r => r.turns), 0.5), turnsP90: quantile(rows.map(r => r.turns), 0.9),
      peakCtxP90: quantile(rows.map(r => r.peakContextTokens), 0.9),
      toolCallsPerOk: ok.length ? +(ok.reduce((n, r) => n + r.toolCalls, 0) / ok.length).toFixed(1) : null,
      reEditsPerRun: +(rows.reduce((n, r) => n + r.reEdits, 0) / rows.length).toFixed(2),
      failedCallShare: +(rows.reduce((n, r) => n + r.failedToolCalls, 0) / Math.max(1, rows.reduce((n, r) => n + r.toolCalls, 0))).toFixed(2),
      cost: +rows.reduce((n, r) => n + (r.cost ?? 0), 0).toFixed(3), stops,
    };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(file)) { console.log(`No dispatch metrics yet (${file}).`); process.exit(0); }
  const records = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter(r => !since || r.at >= since);
  const rows = summarise(records);
  if (!rows.length) { console.log("No dispatches in range."); process.exit(0); }
  console.table(Object.fromEntries(rows.map(({ group, stops, ...row }) => [group, { ...row, stops: Object.entries(stops).map(([k, v]) => `${k}:${v}`).join(" ") || "-" }])));
  console.log("Hints: max-turns stops with turnsP90 near maxTurns → raise that role/model's limit in agents/runtime.json.");
  console.log("       peakCtxP90 above ~60% of the model's window → context elision is worth adding; below it, it isn't.");
  console.log("       high reEditsPerRun on a strong model → try the lean executor arm in tests/domain-eval.mjs.");
}
