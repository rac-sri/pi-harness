import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import register, { nearestLines } from "../extensions/edit-mismatch.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-mismatch-"));
const file = path.join(dir, "goal.md");
fs.writeFileSync(file, "# Goal\n## Checklist\n- [x] T1: first | verify: a\n- [x] T2: second task | verify: b\n- [ ] T3: third | verify: c\n");
let handler;
register({ on: (_event, fn) => { handler = fn; } });
const message = `Could not find edits[1] in ${file}. The oldText must match exactly including all whitespace and newlines.`;
const run = input => handler({ toolName: "edit", isError: true, content: [{ type: "text", text: message }], input }, { cwd: dir });

const result = await run({ path: "goal.md", edits: [{ oldText: "## Checklist" }, { oldText: "- [ ] T2: second task | verify: b" }] });
const text = result.content[0].text;
assert.ok(text.startsWith(message), "keeps the original error");
assert.match(text, /^4: - \[x\] T2: second task/m, "shows the line the failing edit was aimed at, with its line number");
assert.match(text, /not a failed task: do not redo the work/, "tells the model not to redo the task");
assert.deepEqual(nearestLines("alpha\nbeta\n", "zzz unrelated text"), [], "unrelated files suggest nothing");
assert.equal(await handler({ toolName: "edit", isError: false, content: [], input: { path: "goal.md" } }, { cwd: dir }), undefined, "successful edits pass through");
assert.equal(await handler({ toolName: "edit", isError: true, content: [{ type: "text", text: "Permission denied" }], input: { path: "goal.md" } }, { cwd: dir }), undefined, "other edit errors pass through");
fs.rmSync(dir, { recursive: true });
console.log("Passed 6 edit-mismatch checks.");
