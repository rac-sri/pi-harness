import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// This file also acts as a harmless fake Pi child for dispatch/cancellation tests.
if (process.argv.includes("--mode")) {
	const task = process.argv.find(a => a.startsWith("Task: "))?.slice(6);
	if (task === "IGNORE_TERM") {
		process.on("SIGTERM", () => {});
		setInterval(() => {}, 1000);
	} else {
		console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: task === "RETURN_LITERALS" ? "$& $` $'" : JSON.stringify(process.argv.slice(2)) }], stopReason: "stop" } }));
	}
} else {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const version = fs.readFileSync(path.join(root, "install/current-version"), "utf8").trim();
	const modules = path.join(root, "install/releases", version, "node_modules");
	const require = createRequire(path.join(modules, "@earendil-works/pi-coding-agent/package.json"));
	const { createJiti } = require("jiti");
	const alias = Object.fromEntries(["compat", "oauth", "providers/all"].map(name => [`@earendil-works/pi-ai/${name}`, path.join(modules, "@earendil-works/pi-ai/dist", name + ".js")]));
	Object.assign(alias, Object.fromEntries(["pi-coding-agent", "pi-agent-core", "pi-tui", "pi-ai"].map(name => [`@earendil-works/${name}`, path.join(modules, "@earendil-works", name, "dist", name === "pi-ai" ? "compat.js" : "index.js")])));
	alias.typebox = require.resolve("typebox");
	const jiti = createJiti(import.meta.url, { alias, fsCache: false, moduleCache: false });
	const guard = await jiti.import(path.join(root, "extensions/creds-guard.ts"));
	const { isReadOnlyCommand } = await jiti.import(path.join(root, "extensions/lib/read-only.ts"));
	const { parseToolList, configuredModel, loadModelOverrides, discoverAgents } = await jiti.import(path.join(root, "extensions/subagent/agents.ts"));
	const subagent = await jiti.import(path.join(root, "extensions/subagent/index.ts"));
	const { runSingleAgent } = subagent;
	let checks = 0;
	const check = (condition, label) => { assert.ok(condition, label); checks++; };
	const modelConfig = { default: "provider/default", reviewer: null, planner: "provider/planner:high" };
	check(configuredModel(modelConfig, "reviewer") === "provider/default", "null role uses JSON default");
	check(configuredModel(modelConfig, "scout") === "provider/default", "missing role uses JSON default");
	check(configuredModel(modelConfig, "planner") === "provider/planner:high", "explicit JSON role wins");
	check(discoverAgents(root, "user").agents.find(a => a.name === "reviewer").model === loadModelOverrides().default, "discovery applies JSON default to reviewer");
	assert.throws(() => loadModelOverrides(path.join(root, "missing-model-file.json")), /Cannot load/); checks++;
	const launchFixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launch-test-"));
	try {
		for (const dir of ["bin", "agents", "install/releases/test/node_modules/.bin"]) fs.mkdirSync(path.join(launchFixture, dir), { recursive: true });
		const launcher = path.join(launchFixture, "bin/pi");
		fs.copyFileSync(path.join(root, "bin/pi"), launcher);
		fs.writeFileSync(path.join(launchFixture, "install/current-version"), "test\n");
		const modelFile = path.join(launchFixture, "agents/models.json");
		fs.writeFileSync(modelFile, JSON.stringify(modelConfig));
		const fakePi = path.join(launchFixture, "install/releases/test/node_modules/.bin/pi");
		fs.writeFileSync(fakePi, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
		const env = { ...process.env, PATH: path.dirname(process.execPath) + ":" + process.env.PATH, PI_CODING_AGENT_DIR: launchFixture };
		const launch = args => JSON.parse(execFileSync(launcher, args, { env, encoding: "utf8" }));
		assert.deepEqual(launch(["--version"]), ["--model", "provider/default", "--version"]); checks++;
		assert.deepEqual(launch(["--model", "other/model"]), ["--model", "other/model"]); checks++;
		assert.deepEqual(launch(["--provider", "other", "--model", "model"]), ["--provider", "other", "--model", "model"]); checks++;
		assert.deepEqual(launch(["--models", "other/*"]), ["--models", "other/*"]); checks++;
		fs.writeFileSync(modelFile, JSON.stringify({ default: "provider/changed" }));
		check(launch([])[1] === "provider/changed", "launcher reloads edited JSON");
		fs.writeFileSync(modelFile, "{}");
		assert.throws(() => launch([])); checks++;
	} finally { fs.rmSync(launchFixture, { recursive: true, force: true }); }
	for (const command of ["git branch new-name", "git remote add x https://example.invalid", "sort -o result input", "sort --compress-program=./script input", "rg --pre=./script needle .", "find . -delete", "find . -fprint result", "uniq input output", "date 100512002026", "node", "node --version script.js", "echo $(touch x)", "echo `touch x`", "echo x > result", "git show --textconv", "git diff --no-ext-diff --no-textconv --output=result", "cat <(touch x)", "git 'branch' new-name"]) check(!isReadOnlyCommand(command), `reject ${command}`);
	for (const command of ["git status", "git diff --no-ext-diff --no-textconv", "git show --no-ext-diff --no-textconv HEAD", "rg 'a;b' src", "find . -name '*.ts'", "sort input | uniq -c", "date +%F", "node --version", "pwd && ls"]) check(isReadOnlyCommand(command), `allow ${command}`);
	for (const command of ["sort -noresult input", "git cat-file --filters HEAD:file"]) check(!isReadOnlyCommand(command), `reject ${command}`);
	for (const value of [false, 42, {}, [42], "", []]) { assert.deepEqual(parseToolList(value), []); checks++; }
	check(parseToolList(undefined) === undefined, "omitted tools inherit");
	assert.deepEqual(parseToolList(["read", 42]), []); checks++;
	assert.deepEqual(parseToolList("read, bash"), ["read", "bash"]); checks++;
	for (const p of ["agent/auth.json", "agent/models-store.json", "agent/../agent/auth.json", guard.VAULT_ROOT + "/Agents/../private.md", ".env.example.local", ".env.sample-secret"]) check(Boolean(guard.pathDenied(p, path.dirname(root))), `deny ${p}`);
	for (const p of ["agent/HARNESS.md", ".env.example", guard.VAULT_ROOT + "/Agents/project/plan.md"]) check(!guard.pathDenied(p, path.dirname(root)), `allow ${p}`);
	check(Boolean(guard.pathDenied(".", path.dirname(root), true)), "recursive search cannot include credentials");
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-test-"));
	try {
		fs.symlinkSync(path.join(root, "auth.json"), path.join(scratch, "alias"));
		check(Boolean(guard.pathDenied("alias", scratch)), "credential symlink denied");
	} finally { fs.rmSync(scratch, { recursive: true, force: true }); }

	const hooks = new Map(); const commands = new Map();
	let active = ["read", "grep", "find", "ls", "write", "edit", "bash", "subagent", "web_search"];
	const modes = await jiti.import(path.join(root, "extensions/modes/index.ts"));
	modes.default({ on: (n, fn) => hooks.set(n, fn), registerCommand: (n, def) => commands.set(n, def), registerShortcut() {}, getActiveTools: () => active, setActiveTools: names => { active = names; } });
	const { CombinedAutocompleteProvider, SelectList } = await import(path.join(modules, "@earendil-works/pi-tui/dist/index.js"));
	const completion = commands.get("mode").getArgumentCompletions;
	assert.deepEqual(completion(""), ["discuss", "plan", "execute"].map(value => ({ value, label: value }))); checks++;
	assert.deepEqual(completion("p"), [{ value: "plan", label: "plan" }]); checks++;
	assert.deepEqual(completion("EX"), [{ value: "execute", label: "execute" }]); checks++;
	assert.deepEqual(completion("unknown"), []); checks++;
	const provider = new CombinedAutocompleteProvider([{ name: "mode", ...commands.get("mode") }], root);
	for (const line of ["/mode ", "/mode p", "/mode EX"]) {
		const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		check(Boolean(suggestions?.items.length), `suggestions for ${line}`);
		const identity = text => text;
		const list = new SelectList(suggestions.items, 5, { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity });
		check(list.render(80).every(row => typeof row === "string"), `autocomplete renders for ${line}`);
	}
	const ctx = { cwd: path.dirname(root), ui: { notify() {} } };
	const first = await hooks.get("before_agent_start")({});
	check(!active.includes("grep") && !active.includes("ls"), "discuss removes all file tools");
	const second = await hooks.get("before_agent_start")({});
	const filtered = await hooks.get("context")({ messages: [{ role: "custom", ...first.message }, { role: "user", content: "hello" }, { role: "custom", ...second.message }] });
	check(filtered.messages.length === 2 && filtered.messages[1].content.includes("[MODE: DISCUSS]"), "only fresh mode instructions retained");
	await commands.get("mode").handler("plan", ctx);
	check((await hooks.get("tool_call")({ toolName: "bash", input: { command: "sort -o result input" } })).block, "plan blocks write command");
	check((await hooks.get("tool_call")({ toolName: "subagent", input: { agent: "discuss", agentScope: "both" } })).block, "project agent cannot replace restricted role");
	await commands.get("mode").handler("execute", ctx);
	check(active.includes("write") && active.includes("grep"), "execute restores tools");

	const agent = { name: "test", source: "user", systemPrompt: "", tools: [] };
	const result = await runSingleAgent(root, {}, [agent], "test", "literal $& $` $'", undefined, undefined, undefined, undefined, results => ({ results }));
	const args = JSON.parse(result.messages[0].content[0].text);
	check(args[args.indexOf("--tools") + 1] === "", "zero-tool dispatch uses hard empty allowlist");
	check(args.includes("Task: literal $& $` $'"), "task literals preserved");
	let subagentTool;
	subagent.default({ registerTool: tool => { subagentTool = tool; } });
	const chainResult = await subagentTool.execute("test", { chain: [{ agent: "discuss", task: "RETURN_LITERALS" }, { agent: "discuss", task: "Prior: {previous}" }] }, undefined, undefined, { cwd: root, hasUI: false });
	check(JSON.parse(chainResult.content[0].text).includes("Task: Prior: $& $` $'"), "chain replacement preserves dollar tokens");
	const controller = new AbortController();
	const started = Date.now();
	const pending = runSingleAgent(root, {}, [agent], "test", "IGNORE_TERM", undefined, undefined, controller.signal, undefined, results => ({ results }));
	const timer = setTimeout(() => controller.abort(), 1000);
	try { await assert.rejects(pending, /aborted/); checks++; }
	finally { clearTimeout(timer); }
	check(Date.now() - started < 9000, "SIGTERM-ignoring child is force-killed");

	const sandbox = await jiti.import(path.join(root, "extensions/sandbox/index.ts"));
	const trusted = { enabled: true, network: { allowedDomains: ["github.com"], deniedDomains: [] }, filesystem: { allowWrite: ["."], denyRead: ["~/.ssh"], denyWrite: [".env"] } };
	for (const policy of [{ enabled: false }, { enableWeakerNestedSandbox: true }, { ignoreViolations: { "*": ["~/.ssh"] } }, { filesystem: { allowWrite: ["/"] } }, { network: { allowedDomains: ["evil.invalid"] } }]) { assert.throws(() => sandbox.mergeProjectConfig(trusted, policy)); checks++; }
	const tightened = sandbox.mergeProjectConfig(trusted, { filesystem: { denyRead: ["private"], denyWrite: ["extra"] }, network: { allowedDomains: [] } });
	assert.deepEqual(tightened.filesystem.denyRead, ["~/.ssh", "private"]); checks++;
	assert.deepEqual(tightened.filesystem.denyWrite, [".env", "extra"]); checks++;
	let bashTool; const sandboxHooks = new Map();
	sandbox.default({ registerTool: tool => { bashTool = tool; }, on: (name, handler) => sandboxHooks.set(name, handler), registerFlag() {}, registerCommand() {} });
	await assert.rejects(bashTool.execute("test", { command: "true" }), /Sandbox unavailable/); checks++;
	await assert.rejects(sandboxHooks.get("user_bash")().operations.exec(), /Sandbox unavailable/); checks++;

	const loader = await import(path.join(modules, "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"));
	const loaded = await loader.loadExtensions(["creds-guard.ts", "modes/index.ts", "subagent/index.ts", "sandbox/index.ts"].map(p => path.join(root, "extensions", p)), root);
	assert.deepEqual(loaded.errors, []); checks++;
	console.log(`Passed ${checks} harness regression checks; all four extensions load.`);
}
