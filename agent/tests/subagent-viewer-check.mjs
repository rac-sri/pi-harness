import assert from "node:assert/strict";
import { createViewer, transcript } from "../extensions/subagent/viewer.ts";

const theme = { fg: (_color, text) => text, bold: text => text };
const formatCall = (name, args) => `${name} ${JSON.stringify(args)}`;
const finished = { id: "a", agent: "executor", task: "Do T1", exitCode: 0, elapsedMs: 2000, messages: [
	{ role: "assistant", content: [{ type: "thinking", thinking: "consider" }, { type: "toolCall", name: "bash", arguments: { command: "cargo test" } }] },
	{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "test result: ok. 4 passed" }] },
	{ role: "assistant", content: [{ type: "text", text: "## Completed\nT1 done" }] },
] };
const live = { id: "b", agent: "reviewer", task: "Review C1", exitCode: -1, startedAt: Date.now(), phase: "tool bash", messages: [], liveTool: { name: "bash", args: { command: "git diff" } }, liveToolOutput: "diff --git" };

const text = transcript(finished, theme, formatCall).join("\n");
assert.match(text, /Do T1/); assert.match(text, /consider/); assert.match(text, /bash \{"command":"cargo test"\}/);
assert.match(text, /4 passed/, "tool output is shown, not just the call");
assert.match(text, /T1 done/);
assert.match(transcript(live, theme, formatCall).join("\n"), /git diff[\s\S]*diff --git/, "live tool call and its partial output are shown");

let closed = false;
const runs = [finished, live];
const viewer = createViewer(() => runs, theme, formatCall, () => { closed = true; }, () => {}, () => 12);
assert.match(viewer.render(60).join("\n"), /› ⏳ reviewer/, "the newest run is selected first");
viewer.handleInput("\x1b[A"); viewer.handleInput("\r");
const opened = viewer.render(60);
assert.ok(opened.length <= 12, "transcript fits the terminal height");
assert.match(opened.join("\n"), /T1 done/, "opens at the end of the transcript");
viewer.handleInput("g");
assert.match(viewer.render(60).join("\n"), /executor · done/, "g jumps to the top");
viewer.handleInput("\x1b");
assert.match(viewer.render(60).join("\n"), /Subagents \(2\)/, "Esc returns to the list");
viewer.handleInput("\x1b");
assert.ok(closed, "Esc on the list closes the viewer");
console.log("Passed 12 subagent viewer checks.");
