import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
const { mineSession, redact } = await import("../scripts/mine-sessions.mjs");
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };

const cwd = path.join(os.homedir(), "repo");
let id = 0;
const step = (name, args, isError, text = "") => { const callId = `c${++id}`; return [
  { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }] } },
  { type: "message", timestamp: `t${id}`, message: { role: "toolResult", toolCallId: callId, isError, content: [{ type: "text", text }] } },
]; };
const entries = [{ type: "session", cwd },
  ...step("bash", { command: "cargo  test" }, true, `failed at ${cwd}/src/lib.rs for dev@example.com\nCommand exited with code 101`),
  ...step("hashline_edit", { path: "src/lib.rs" }, false),
  ...step("bash", { command: "cargo test" }, false, "ok"),
  ...step("bash", { command: "make lint" }, true, "Command exited with code 2"),
  ...step("bash", { command: "make lint" }, false, "ok"),
  ...step("bash", { command: "cat ~/.ssh/id" }, true, "Credential access blocked by creds-guard."),
  ...step("write", { path: "x" }, false),
  ...step("bash", { command: "cat ~/.ssh/id" }, false, ""),
];
const found = mineSession(entries);
check(found.length === 1, "only a failure fixed by an edit is a repair episode");
check(found[0].check === "bash:cargo test" && found[0].files.join() === "src/lib.rs" && found[0].toolCallsBetween === 1, "the episode names the check and the edited files");
check(!found[0].failureTail.includes(os.homedir()) && found[0].failureTail.includes("~/repo") && found[0].failureTail.includes("<email>") && found[0].cwd === "~/repo", "home directory and emails are redacted");
const token = "ghp" + "_" + "a".repeat(36);
check(redact(`curl -H "Authorization: ${token}" x`).includes("<secret>") && !redact(token).includes("ghp_"), "credential formats are redacted");
check(redact(`--${os.homedir().replace(/\//g, "-")}-proj--/s.jsonl`) === "--~-proj--/s.jsonl", "dash-encoded session directories are redacted");
console.log(`Passed ${checks} session-mining checks.`);
