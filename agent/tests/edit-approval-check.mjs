import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { root, jiti } from "./lib/loader.mjs";

if (process.argv.includes("--mode")) {
  const hooks = new Map();
  const extension = await jiti.import(path.join(root, "extensions/edit-approval/tool.ts"));
  extension.default({ on: (name, handler) => hooks.set(name, handler) });
  const result = await hooks.get("tool_call")({ toolName: "write", input: { path: "edited.txt", content: "approved" } }, { cwd: process.cwd() });
  if (!result?.block) fs.writeFileSync("edited.txt", "approved");
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: result?.block ? "Skipped" : "Applied" }], stopReason: "stop" } }));
  await hooks.get("session_shutdown")();
} else {
  const { createEditApproval, EDIT_CHOICES, needsEditApproval } = await jiti.import(path.join(root, "extensions/lib/edit-approval.ts"));
  const request = { id: "1", toolName: "write", input: { path: "edited.txt" }, cwd: root };
  let calls = 0;
  let answer = EDIT_CHOICES[0];
  const policy = createEditApproval(async () => { calls++; return answer; });
  assert.equal(await policy.request(request), true);
  assert.equal(await policy.request(request), true);
  assert.equal(calls, 2, "ask before every edit by default");
  answer = EDIT_CHOICES[1];
  assert.equal(await policy.request(request), false);
  answer = undefined;
  assert.equal(await policy.request(request), false, "cancellation skips");
  answer = EDIT_CHOICES[2];
  assert.equal(await policy.request(request), true);
  const before = calls;
  assert.equal(await policy.request(request), true);
  assert.equal(calls, before, "session option bypasses later prompts");
  policy.reset();
  answer = EDIT_CHOICES[1];
  assert.equal(await policy.request(request), false);
  assert.equal(calls, before + 1, "new session asks again");
  const controller = new AbortController();
  controller.abort();
  assert.equal(await policy.request(request, controller.signal), false);
  assert.equal(calls, before + 1);

  let finish;
  let concurrent = 0;
  const queued = createEditApproval(async () => { concurrent++; return new Promise(resolve => { finish = resolve; }); });
  const first = queued.request(request);
  const second = queued.request(request);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(concurrent, 1, "parallel requests serialize their UI");
  finish(EDIT_CHOICES[2]);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(concurrent, 1);

  let resetFinish;
  const resetting = createEditApproval(() => new Promise(resolve => { resetFinish = resolve; }));
  const old = resetting.request(request);
  await new Promise(resolve => setImmediate(resolve));
  resetting.reset();
  resetFinish(EDIT_CHOICES[2]);
  assert.equal(await old, false, "old session response cannot enable automatic edits");
  for (const name of ["edit", "hashline_edit", "write", "ast_grep_replace"]) assert.equal(needsEditApproval(name, {}), true);
  assert.equal(needsEditApproval("lsp_navigation", { operation: "rename" }), true);
  for (const operation of ["definition", "typeDefinition", "documentSymbol", "references"]) assert.equal(needsEditApproval("lsp_navigation", { operation }), false);
  assert.equal(needsEditApproval("read", {}), false);
  assert.equal(needsEditApproval("bash", { command: "cat source.ts" }), false);
  assert.equal(needsEditApproval("bash", { command: "sed -i s/old/new/ source.ts" }), true);

  const subagent = await jiti.import(path.join(root, "extensions/subagent/index.ts"));
  const { runSingleAgent } = subagent;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-edit-approval-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fixture;
  fs.mkdirSync(path.join(fixture, "agents"));
  fs.writeFileSync(path.join(fixture, "agents/runtime.json"), JSON.stringify({ timeoutSeconds: 1 }));
  const agent = { name: "executor", source: "user", systemPrompt: "", tools: ["write"] };
  const details = results => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results });
  const run = approve => runSingleAgent(fixture, {}, [agent], "executor", "EDIT", undefined, undefined, undefined, undefined, details, approve);
  try {
    await run(undefined);
    assert.equal(fs.existsSync(path.join(fixture, "edited.txt")), false, "missing UI denies writes");
    await run(async () => false);
    assert.equal(fs.existsSync(path.join(fixture, "edited.txt")), false, "skip blocks the child before writing");
    let requested = false;
    const applied = await run(async edit => {
      requested = true;
      assert.equal(fs.existsSync(path.join(fixture, "edited.txt")), false, "prompt happens before mutation");
      assert.equal(edit.toolName, "write");
      await new Promise(resolve => setTimeout(resolve, 1200));
      return true;
    });
    assert.equal(requested, true);
    assert.equal(fs.readFileSync(path.join(fixture, "edited.txt"), "utf8"), "approved");
    assert.doesNotMatch(applied.errorMessage, /deadline/, "user wait pauses dispatch deadline");
    // Fake child intentionally has no verification evidence; approval never overrides verification.
    assert.match(applied.errorMessage, /completion rejected/);
    fs.writeFileSync(path.join(fixture, "agents/models.json"), JSON.stringify({ default: "test/model" }));
    fs.writeFileSync(path.join(fixture, "agents/executor.md"), "---\nname: executor\ndescription: Test\ntools: write\n---\nTest executor.");
    let tool;
    const mainHooks = new Map();
    subagent.default({ on: (name, handler) => mainHooks.set(name, handler), registerShortcut() {}, registerCommand() {}, registerTool: definition => { tool = definition; } });
    let prompts = 0;
    const ctx = { cwd: fixture, hasUI: true, ui: { select: async (title, choices) => {
      prompts++;
      assert.match(title, /Apply executor edit/);
      assert.deepEqual(choices, EDIT_CHOICES);
      return EDIT_CHOICES[2];
    } } };
    const dispatch = () => tool.execute("test", { agent: "executor", task: "EDIT" }, undefined, undefined, ctx);
    await dispatch();
    await dispatch();
    assert.equal(prompts, 1, "session opt-out spans separate tool dispatches");
    await mainHooks.get("session_start")({ reason: "new" }, ctx);
    await dispatch();
    assert.equal(prompts, 2, "main session event resets opt-out");
    console.log("Passed edit approval policy and real child pre-write gating checks.");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
