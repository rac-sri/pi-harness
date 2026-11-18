import assert from "node:assert/strict";
import path from "node:path";
import { root, jiti } from "./lib/loader.mjs";

const { callKey, createStreakTracker, REMIND_AFTER, STOP_AFTER_FAILURES } = await jiti.import(path.join(root, "extensions/lib/stuck.ts"));
const { default: register } = await jiti.import(path.join(root, "extensions/stuck/tool.ts"));
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };

check(callKey("bash", { a: 1, b: { c: 2, d: 3 } }) === callKey("bash", { b: { d: 3, c: 2 }, a: 1 }), "argument key order does not matter");
check(callKey("bash", { a: 1 }) !== callKey("read", { a: 1 }), "tool name is part of the key");

{
  const t = createStreakTracker();
  const verdicts = Array.from({ length: STOP_AFTER_FAILURES }, () => t.record("bash", { command: "make" }, true));
  check(verdicts.filter(v => v.remind).length === 1 && verdicts[REMIND_AFTER - 1].remind, "one reminder, at the 5th identical call");
  check(verdicts.slice(0, -1).every(v => !v.stop) && verdicts.at(-1).stop, "stop only at the 8th identical failure");
}
{
  const t = createStreakTracker();
  for (let i = 0; i < 7; i++) t.record("bash", { command: "make" }, true);
  check(!t.record("bash", { command: "make" }, false).stop, "a success breaks the failing streak");
  check(t.record("bash", { command: "make" }, true).failing === 1, "failing count restarts after a success");
}
{
  const t = createStreakTracker();
  for (let i = 0; i < 20; i++) t.record(i % 2 ? "read" : "bash", { n: 1 }, true);
  check(!t.record("bash", { n: 1 }, true).stop, "alternating calls are not a streak");
}
{
  const t = createStreakTracker();
  const ok = Array.from({ length: 20 }, () => t.record("bash", { command: "git status" }, false));
  check(ok.filter(v => v.remind).length === 1 && ok.every(v => !v.stop), "identical successes remind once and never stop");
}
{
  let handler;
  register({ on: (_event, fn) => { handler = fn; } });
  const event = isError => ({ toolName: "bash", input: { command: "cargo test" }, isError, content: [{ type: "text", text: "error[E0308]" }] });
  const results = [];
  for (let i = 0; i < REMIND_AFTER; i++) results.push(await handler(event(true)));
  check(results.slice(0, -1).every(r => r === undefined), "earlier results pass through unchanged");
  const last = results.at(-1).content;
  check(last[0].text === "error[E0308]" && /same bash call.*5 times in a row, the last 5 failed/.test(last[1].text), "the 5th result keeps the output and adds the reminder");
}
console.log(`Passed ${checks} stuck-detection checks.`);
