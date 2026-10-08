import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [
  {
    id: "lost-ack",
    request: "Recover from one lost acknowledgement by retrying the same idempotency key, with at most three attempts. The server deduplicates keys. Exhausted retries must throw.",
    broken: "export async function send(server, key, value) { return server(key, value); }",
    fixed: "export async function send(server, key, value) { for(let i=0;i<3;i++){try{return await server(key,value)}catch(e){if(i===2)throw e}} }",
    tests: `let applications=0, calls=0; const seen=new Set();
const server=async(key,value)=>{calls++;if(!seen.has(key)){seen.add(key);applications+=value;}if(calls===1)throw Error('lost ack');return applications;};
assert.equal(await mod.send(server,'request-1',7),7);assert.equal(applications,7);assert.equal(calls,2);
let failures=0; await assert.rejects(mod.send(async()=>{failures++;throw Error('offline')},'request-2',1));assert.equal(failures,3);`,
  },
  {
    id: "duplicate-apply",
    request: "Apply each message id once in a persisted state object, including after constructing a new handler with that same state. Distinct ids with equal payloads must each apply.",
    broken: "export function handler(state){return msg=>{state.total+=msg.value;return state.total;};}",
    fixed: "export function handler(state){state.seen??=[];return msg=>{if(!state.seen.includes(msg.id)){state.seen.push(msg.id);state.total+=msg.value;}return state.total;};}",
    tests: `const state={total:0};let apply=mod.handler(state);assert.equal(apply({id:'a',value:3}),3);assert.equal(apply({id:'a',value:3}),3);
apply=mod.handler(state);assert.equal(apply({id:'a',value:3}),3);assert.equal(apply({id:'b',value:3}),6);`,
  },
  {
    id: "nonce-restart",
    request: "Allocate a unique integer nonce from a persisted state object. Reserve it durably before calling the injected exposure callback, which may throw to simulate a crash. New allocators share the persisted state. Reject exhaustion at Number.MAX_SAFE_INTEGER.",
    broken: "export function allocator(state){let next=0;return expose=>{const value=next++;expose(value);state.next=next;return value;};}",
    fixed: "export function allocator(state){return expose=>{const value=state.next??0;if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)throw Error('exhausted');state.next=value+1;expose(value);return value;};}",
    tests: `const state={next:0};const exposed=[];let allocate=mod.allocator(state);assert.equal(allocate(n=>exposed.push(n)),0);
assert.throws(()=>allocate(n=>{exposed.push(n);throw Error('crash')}));allocate=mod.allocator(state);assert.equal(allocate(n=>exposed.push(n)),2);assert.equal(new Set(exposed).size,exposed.length);
assert.throws(()=>mod.allocator({next:Number.MAX_SAFE_INTEGER})(()=>{}));`,
  },
  {
    id: "malformed-signature",
    request: "Wrap Node's Ed25519 signature verification. Accept only a 64-byte Buffer signature; return false for malformed signatures, invalid keys, and modified messages. Preserve acceptance of a valid signature. Use the established crypto library.",
    broken: "import {verify} from 'node:crypto';export function valid(key,message,signature){return verify(null,message,key,signature);}",
    fixed: "import {verify} from 'node:crypto';export function valid(key,message,signature){if(!Buffer.isBuffer(signature)||signature.length!==64)return false;try{return verify(null,message,key,signature)}catch{return false}}",
    tests: `const {createPrivateKey,createPublicKey,sign}=await import('node:crypto');
const key=createPrivateKey({key:Buffer.from('302e020100300506032b657004220420'+'01'.repeat(32),'hex'),format:'der',type:'pkcs8'});const pub=createPublicKey(key);const msg=Buffer.from('test-message');const sig=sign(null,msg,key);
assert.equal(mod.valid(pub,msg,sig),true);assert.equal(mod.valid(pub,Buffer.from('modified'),sig),false);
for(const bad of [null,undefined,'invalid',Buffer.alloc(0),Buffer.alloc(63),Buffer.alloc(65),Buffer.alloc(64)])assert.equal(mod.valid(pub,msg,bad),false);
assert.equal(mod.valid('invalid-key',msg,sig),false);`,
  },
];

function testSource(source, tests) { return `import assert from 'node:assert/strict';\nimport * as mod from ${JSON.stringify(pathToFileURL(source).href)};\n${tests}\n`; }
function evaluate(file, cwd) { return spawnSync(process.execPath, [file], { cwd, encoding: "utf8", timeout: 15000 }); }

async function agentRun(repo, request, arm, hidden) {
  const model = JSON.parse(fs.readFileSync(path.join(root, "agents/models.json"), "utf8"));
  const prompt = fs.readFileSync(path.join(root, "agents/executor.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "");
  const promptFile = path.join(path.dirname(repo), "executor.md"); fs.writeFileSync(promptFile, prompt);
  // Both arms get the same model, sandbox, guard and task; only the harness prompt and harness_check differ.
  const scope = hidden ? "No tests are provided: write your own checks in new test files, run them, and modify source.mjs only if they show it is wrong." : "Modify only source.mjs if needed. Tests are in verify.mjs.";
  const verify = arm === "harness" ? (hidden ? " Register your own test files as harness_check checks; define an immutable contract before changes. End with harness_check complete." : " Verify with node verify.mjs using harness_check; define an immutable contract before changes. End with harness_check complete.") : " Run the tests before finishing.";
  const args = ["--mode", "json", "-p", "--no-session", "--no-prompt-templates", "--no-extensions", "-e", path.join(root, "extensions/creds-guard.ts"), "-e", path.join(root, "extensions/sandbox/index.ts"), ...(arm === "harness" ? ["-e", path.join(root, "extensions/hashline/tool.ts")] : []), "--model", model.executor ?? model.default, "--thinking", "medium",
    "--tools", arm === "harness" ? "read,write,hashline_edit,bash,grep,find,ls,harness_check" : "read,write,edit,bash,grep,find,ls", ...(arm === "harness" ? ["--append-system-prompt", promptFile] : []),
    `Task: ${request}\nRepo: ${repo}. ${scope}${verify} Do not commit. Correct code should remain unchanged. This is a bounded engineering evaluation, not a production cryptographic design.`];
  const started = Date.now();
  return await new Promise(resolve => {
    const child = spawn(path.join(root, "bin/pi"), args, { cwd: repo, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_SUBAGENT_CHILD: "1" } });
    let buffer = "", stderr = "", outputTokens = 0, cost = 0, completed = false;
    const toolArgs = new Map();
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 1200000);
    const event = line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.type === "message_end" && value.message?.role === "assistant") { outputTokens += value.message.usage?.output ?? 0; cost += value.message.usage?.cost?.total ?? 0; }
      if (value.type === "tool_execution_start") toolArgs.set(value.toolCallId, value.args);
      if (value.type === "tool_execution_start" && ["write", "edit", "bash"].includes(value.toolName)) completed = false;
      if (value.type === "tool_execution_end" && value.toolName === "harness_check" && toolArgs.get(value.toolCallId)?.action === "complete") completed = !value.isError && value.result?.details?.phase === "verified";
    };
    child.stdout.on("data", data => { buffer += data; const lines = buffer.split("\n"); buffer = lines.pop(); lines.forEach(event); });
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
    child.on("error", error => { clearTimeout(timer); resolve({ exitCode: 1, error: error.message, elapsedMs: Date.now() - started, completed: false }); });
    child.on("close", code => { clearTimeout(timer); if (buffer) event(buffer); resolve({ exitCode: code, elapsedMs: Date.now() - started, outputTokens, reportedCost: cost, completed, stderr }); });
  });
}

const selected = process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : undefined;
if (selected && !cases.some(item => item.id === selected)) throw new Error(`Unknown case: ${selected}`);
const live = process.argv.includes("--agent");
const hidden = process.argv.includes("--hidden-tests");
const arms = process.argv.includes("--baseline") ? ["baseline", "harness"] : ["harness"];
const results = [];
for (const item of cases.filter(item => !selected || item.id === selected)) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-domain-eval-"));
  try {
    const repo = path.join(fixture, "repo"); fs.mkdirSync(repo);
    const source = path.join(repo, "source.mjs");
    const independent = path.join(fixture, "independent.mjs"); fs.writeFileSync(independent, testSource(source, item.tests));
    for (const arm of live ? arms : ["harness"]) for (const [variant, code] of [["broken", item.broken], ["clean", item.fixed]]) {
      // Fresh repository per run so arms and variants cannot see each other's files.
      fs.rmSync(repo, { recursive: true, force: true }); fs.mkdirSync(repo);
      fs.writeFileSync(source, code);
      if (!hidden) fs.writeFileSync(path.join(repo, "verify.mjs"), testSource(source, item.tests));
      const baseline = evaluate(independent, repo).status === 0;
      assert.equal(baseline, variant === "clean", `${item.id}: evaluation distinguishes broken and reference code`);
      if (!live) { results.push({ case: item.id, variant, expectedPass: baseline }); continue; }
      for (const args of [["init"], ["config", "user.name", "Harness Eval"], ["config", "user.email", "eval@example.invalid"]]) execFileSync("git", args, { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-m", `baseline ${variant}`], { cwd: repo, stdio: "ignore" });
      console.log(`Running ${arm} ${item.id}/${variant}…`);
      const agent = await agentRun(repo, item.request + (arm === "harness" ? ` Use unique harness run id eval-${item.id}-${variant}.` : ""), arm, hidden);
      const passed = evaluate(independent, repo).status === 0;
      const changed = fs.readFileSync(source, "utf8") !== code;
      results.push({ arm, hidden, case: item.id, variant, independentTestsPassed: passed, unnecessaryCleanEdit: variant === "clean" && changed, ...agent, stderr: agent.exitCode ? agent.stderr : undefined });
      console.log(`${arm} ${item.id}/${variant}: tests ${passed ? "pass" : "fail"}${variant === "clean" && changed ? " (edited clean code)" : ""}, evidence ${agent.completed ? "complete" : "missing"}, ${Math.round(agent.elapsedMs / 1000)}s, ${agent.outputTokens ?? 0} tok, exit ${agent.exitCode}`);
    }
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}
if (live) {
  const directory = path.join(root, "harness/evals"); fs.mkdirSync(directory, { recursive: true });
  const report = path.join(directory, `${Date.now()}.json`);
  fs.writeFileSync(report, JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2) + "\n");
  for (const arm of arms) {
    const rows = results.filter(r => r.arm === arm);
    const sum = key => rows.reduce((n, r) => n + (r[key] ?? 0), 0);
    console.log(`${arm}: ${rows.filter(r => r.independentTestsPassed).length}/${rows.length} pass hidden grader, ${rows.filter(r => r.unnecessaryCleanEdit).length} clean-code edits, ${Math.round(sum("elapsedMs") / 1000)}s, ${sum("outputTokens")} output tokens, $${sum("reportedCost").toFixed(3)}`);
  }
  console.log(`Evaluation report: ${report}`);
} else console.log(`Passed ${results.length} domain evaluation fixture checks. Use --agent to measure live executor correctness, clean-case edits, latency, tokens, and reported cost; --baseline adds a plain-agent arm; --hidden-tests withholds verify.mjs; --case <id> selects one pair.`);
