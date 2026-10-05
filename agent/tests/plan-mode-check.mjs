import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = "/Users/rachitsrivastava/.pi/agent";
const version = fs.readFileSync(path.join(root, "install/current-version"), "utf8").trim();
const modules = path.join(root, "install/releases", version, "node_modules");
const require = createRequire(path.join(modules, "@earendil-works/pi-coding-agent/package.json"));
const { createJiti } = require("jiti");
const alias = Object.fromEntries(["compat", "oauth", "providers/all"].map(name => [`@earendil-works/pi-ai/${name}`, path.join(modules, "@earendil-works/pi-ai/dist", name + ".js")]));
Object.assign(alias, Object.fromEntries(["pi-coding-agent", "pi-agent-core", "pi-tui", "pi-ai"].map(name => [`@earendil-works/${name}`, path.join(modules, "@earendil-works", name, "dist", name === "pi-ai" ? "compat.js" : "index.js")])));
alias.typebox = require.resolve("typebox");
const jiti = createJiti(import.meta.url, { alias, fsCache: false, moduleCache: false });

const hooks = new Map(); const commands = new Map();
const ALL = ["read", "grep", "find", "ls", "write", "edit", "bash", "subagent", "web_search", "lens_diagnostics", "pi_lens_activate_tools", "ast_grep_replace", "lens_diagnostic_mark", "symbol_search"];
let active = [...ALL];
const modes = await jiti.import(path.join(root, "extensions/modes/index.ts"));
modes.default({ on: (n, fn) => hooks.set(n, fn), registerCommand: (n, def) => commands.set(n, def), registerShortcut() {}, getActiveTools: () => active, setActiveTools: names => { active = names; } });
const call = (toolName, input = {}) => hooks.get("tool_call")({ toolName, input });
let checks = 0;
const check = (cond, label) => { assert.ok(cond, "FAIL: " + label); checks++; console.log("ok   " + label); };

const ctx = { cwd: path.dirname(root), ui: { notify() {} } };
await commands.get("mode").handler("plan", ctx);
check(active.includes("bash") && active.includes("read") && !active.includes("edit") && !active.includes("write"), "plan keeps read+bash, drops edit/write");
for (const tool of ["ast_grep_replace", "lens_diagnostic_mark", "pi_lens_activate_tools"]) {
  check(!active.includes(tool), `plan removes ${tool}`);
  check((await call(tool, { apply: true, tools: ["ast_grep_replace"] })).block === true, `plan gate blocks ${tool} even if reactivated`);
}
check(active.includes("lens_diagnostics") && active.includes("symbol_search"), "plan keeps read-only code intelligence");
check((await call("bash", { command: "sort -o result input" })).block === true, "plan blocks mutating bash");
check((await call("bash", { command: "ls" })) === undefined, "plan allows read-only bash");
check((await call("subagent", { agent: "executor" })).block === true, "plan blocks executor");
await commands.get("mode").handler("execute", ctx);
check(active.length === ALL.length, "execute restores the full tool set");
for (const tool of ["ast_grep_replace", "lens_diagnostic_mark", "pi_lens_activate_tools"]) {
  check((await call(tool, { apply: true })) === undefined, `execute allows ${tool}`);
}
check((await call("bash", { command: "git commit -m x" })) === undefined, "execute allows mutating bash");
console.log(`\nPassed ${checks} mode checks.`);
