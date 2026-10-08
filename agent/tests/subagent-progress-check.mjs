import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { root, jiti } from "./lib/loader.mjs";

if (process.argv.includes("--mode")) {
  const task = process.argv.find(arg => arg.startsWith("Task: "))?.slice(6);
  const emit = value => console.log(JSON.stringify(value));
  // Real pi events: args only on tool_execution_start; the end event has toolCallId but no args.
  let callId = 0;
  const harness = (action, run, phase) => { const toolCallId = `h${++callId}`; emit({ type: "tool_execution_start", toolCallId, toolName: "harness_check", args: { action, run } }); emit({ type: "tool_execution_end", toolCallId, toolName: "harness_check", result: { details: { phase } }, isError: false }); };
  if (task === "WAIT") { setInterval(() => {}, 1000); }
  else {
    emit({ type: "message_start", message: { role: "assistant" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" }, message: { role: "assistant", content: [{ type: "thinking", thinking: "Checking recovery invariant" }] } });
    await new Promise(resolve => setTimeout(resolve, 30));
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta" }, message: { role: "assistant", content: [{ type: "text", text: "Live response" }] } });
    emit({ type: "tool_execution_start", toolName: "read", args: { path: "src/state.ts" } });
    emit({ type: "tool_execution_end", toolName: "read", args: {}, isError: false });
    if (["EVIDENCE", "MULTI", "STALE", "debug", "ast_grep_replace", "lsp_navigation"].includes(task)) {
      for (const action of ["define", "complete"]) harness(action, "C1", action === "complete" ? "verified" : "pending");
    }
    if (task === "MULTI") {
      harness("define", "C2", "pending");
      emit({ type: "tool_execution_start", toolName: "write", args: { path: "new-source" } });
      harness("complete", "C2", "verified");
    }
    if (["debug", "ast_grep_replace", "lsp_navigation"].includes(task)) emit({ type: "tool_execution_start", toolName: task, args: {} });
    if (task === "STALE") emit({ type: "tool_execution_start", toolName: "bash", args: { command: "touch source" } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Provider reasoning completed" }, { type: "text", text: "Done" }], usage: { output: task === "TOKENS" ? 50 : 1 }, stopReason: "stop" } });
  }
} else {
  const subagent = await jiti.import(path.join(root, "extensions/subagent/index.ts"));
  let tool; subagent.default({ registerTool: definition => { tool = definition; } });
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-progress-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fixture;
  fs.mkdirSync(path.join(fixture, "agents"));
  const config = value => fs.writeFileSync(path.join(fixture, "agents/runtime.json"), JSON.stringify(value));
  const agent = { name: "test", source: "user", systemPrompt: "", tools: [] };
  const details = results => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results });
  let checks = 0;
  try {
    config({ updateIntervalMs: 1 });
    const updates = [];
    const result = await subagent.runSingleAgent(fixture, {}, [agent], "test", "STREAM", undefined, undefined, undefined, partial => {
      const state = partial.details.results[0];
      const theme = { fg: (_color, text) => text, bold: text => text };
      const rendered = tool.renderResult(partial, { expanded: false, isPartial: true }, theme, {}).render(120).join("\n");
      updates.push({ phase: state.phase, thinking: state.liveThinking, text: state.liveText, tool: state.liveTool, rendered, exitCode: state.exitCode });
    }, details);
    assert.equal(result.exitCode, 0); checks++;
    assert.ok(result.usage.outputRate > 0); checks++;
    const finalTheme = { fg: (_color, text) => text, bold: text => text };
    const finalRendered = tool.renderResult({ content: [{ type: "text", text: "Done" }], details: details([result]) }, { expanded: true, isPartial: false }, finalTheme, {}).render(120).join("\n");
    assert.ok(finalRendered.includes("Recent provider thinking") && finalRendered.includes("Provider reasoning completed")); checks++;
    assert.ok(finalRendered.includes("tok/s avg")); checks++;
    assert.ok(updates.some(value => value.thinking?.includes("recovery") && value.rendered.includes("Thinking"))); checks++;
    assert.ok(updates.some(value => value.text === "Live response")); checks++;
    assert.ok(updates.some(value => value.tool?.name === "read" && value.rendered.includes("src/state.ts"))); checks++;
    assert.ok(updates.filter(value => value.phase !== "completed").every(value => value.exitCode === -1 && !value.rendered.includes("✓"))); checks++;
    config({ timeoutSeconds: 1 });
    const deadline = await subagent.runSingleAgent(fixture, {}, [agent], "test", "WAIT", undefined, undefined, undefined, undefined, details);
    assert.equal(deadline.stopReason, "error"); assert.match(deadline.errorMessage, /deadline/); checks++;
    config({ maxOutputTokens: 10 });
    const limited = await subagent.runSingleAgent(fixture, {}, [agent], "test", "TOKENS", undefined, undefined, undefined, undefined, details);
    assert.equal(limited.stopReason, "error"); assert.match(limited.errorMessage, /output tokens/); checks++;
    config({});
    const executor = { ...agent, name: "executor", tools: [] };
    const rejected = await subagent.runSingleAgent(fixture, {}, [executor], "executor", "STREAM", undefined, undefined, undefined, undefined, details);
    assert.match(rejected.errorMessage, /completion rejected/); checks++;
    const accepted = await subagent.runSingleAgent(fixture, {}, [executor], "executor", "EVIDENCE", undefined, undefined, undefined, undefined, details);
    assert.equal(accepted.stopReason, "stop"); checks++;
    const multi = await subagent.runSingleAgent(fixture, {}, [executor], "executor", "MULTI", undefined, undefined, undefined, undefined, details);
    assert.equal(multi.stopReason, "stop"); checks++;
    const stale = await subagent.runSingleAgent(fixture, {}, [executor], "executor", "STALE", undefined, undefined, undefined, undefined, details);
    assert.match(stale.errorMessage, /completion rejected/); checks++;
    for (const task of ["debug", "ast_grep_replace", "lsp_navigation"]) {
      const changed = await subagent.runSingleAgent(fixture, {}, [executor], "executor", task, undefined, undefined, undefined, undefined, details);
      assert.match(changed.errorMessage, /completion rejected/); checks++;
    }
    config({ maxTurns: 1 });
    const turns = await subagent.runSingleAgent(fixture, {}, [agent], "test", "STREAM", undefined, undefined, undefined, undefined, details);
    assert.match(turns.errorMessage, /turns/); checks++;
    console.log(`Passed ${checks} streaming, rendering, budget, and completion checks.`);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
