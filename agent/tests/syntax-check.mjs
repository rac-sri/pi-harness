import assert from "node:assert/strict";
import path from "node:path";
import { root, jiti } from "./lib/loader.mjs";

const { syntaxErrors } = await jiti.import(path.join(root, "extensions/lib/syntax-check.ts"));
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };

check((await syntaxErrors("/r/a.ts", "let x: number = ;", "src/a.ts"))?.checker === "node parser", "TypeScript syntax error is reported");
check(await syntaxErrors("/r/a.ts", "enum E { A }\nnamespace N { export const x = 1 }\nclass C { constructor(private x: number) {} }") === undefined, "valid TS that strip mode can't run is not reported");
check(await syntaxErrors("/r/a.mjs", "import x from 'y';\nexport default x;") === undefined, "valid ESM passes");
check(await syntaxErrors("/r/a.tsx", "const a = <div/>;") === undefined, "unchecked extensions are silent");
check(await syntaxErrors("/r/lib.rs", "mod missing;\nfn main() { let v = vec![1]; }\n") === undefined, "rustfmt does not follow mod declarations");
const rs = await syntaxErrors("/r/lib.rs", "fn main() {\n    let x = ;\n}\n", "src/lib.rs");
check(rs?.checker === "rustfmt" && /src\/lib\.rs:2:/.test(rs.message) && !rs.message.includes("<stdin>"), "Rust errors cite the file path and line");
check((await syntaxErrors("/r/m.go", "package x\nfunc f( {\n"))?.checker === "gofmt", "Go syntax error is reported");
check(await syntaxErrors("/r/m.go", "package x\n\nfunc f() {}\n") === undefined, "valid Go passes");
check(/m\.py:1:/.test((await syntaxErrors("/r/m.py", "def f(:\n", "m.py"))?.message ?? ""), "Python syntax error is reported with its line");
const long = await syntaxErrors("/r/a.go", "package x\n" + "func f( {\n".repeat(40));
check(long && long.message.split("\n").length <= 16, "long output is clipped");
console.log(`Passed ${checks} syntax-check checks.`);
