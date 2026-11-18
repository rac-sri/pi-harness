// Domain evaluation for the executor harness.
//
// Offline (default): validates every task before it may be used (HF harness-adapters, 2026):
// the reference passes twice; the broken version, an empty-export stub and a missing source all
// fail; and mutation testing confirms the tests catch injected bugs in the reference. Tasks that
// fail validation are dropped from live runs with the reason recorded.
//
// Live (--agent): runs each valid task through one or more arms, --runs times, and reports
// per-arm success, cost and behaviour (turns, tool calls per solved task, re-edits, peak context),
// a difficulty label per task, and exact McNemar tests between arms on matched runs.
// Arms (Fan et al. 2026 vary the action space per model):
//   baseline  plain agent, native edit, no harness prompt or checks
//   harness   executor prompt, hashline_edit, harness_check, grep/find/ls
//   lean      harness without grep/find/ls: read, write, hashline_edit, bash, harness_check
//   full      the production executor's whole tool list from agents/executor.md, Lens loaded
//
// Flags: --agent  --arms a,b  --baseline (= --arms baseline,harness)  --runs N  --hidden-tests
//        --case <id>  --include-weak  --mutation-threshold 0.8  --model provider/id  --thinking level
//        --merge a.json,b.json   summarise reports of separate (e.g. parallel per-arm) runs together
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
    fixed: "export async function send(server, key, value) { for(let attempt=1;;attempt++){try{return await server(key,value)}catch(e){if(attempt>=3)throw e}} }",
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
    request: "Allocate a unique integer nonce from a persisted state object, starting at 0 for empty state. Reserve it durably before calling the injected exposure callback, which may throw to simulate a crash. New allocators share the persisted state. Reject exhaustion at Number.MAX_SAFE_INTEGER and a corrupted persisted value (negative or not an integer).",
    broken: "export function allocator(state){let next=0;return expose=>{const value=next++;expose(value);state.next=next;return value;};}",
    fixed: "export function allocator(state){return expose=>{const value=state.next??0;if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)throw Error('exhausted');state.next=value+1;expose(value);return value;};}",
    tests: `const state={next:0};const exposed=[];let allocate=mod.allocator(state);assert.equal(allocate(n=>exposed.push(n)),0);
assert.throws(()=>allocate(n=>{exposed.push(n);throw Error('crash')}));allocate=mod.allocator(state);assert.equal(allocate(n=>exposed.push(n)),2);assert.equal(new Set(exposed).size,exposed.length);
assert.throws(()=>mod.allocator({next:Number.MAX_SAFE_INTEGER})(()=>{}));
assert.equal(mod.allocator({})(()=>{}),0,'empty state starts at 0');
for(const next of [-1,1.5,'3'])assert.throws(()=>mod.allocator({next})(()=>{}),undefined,'corrupted '+next);`,
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
  {
    id: "raft-append",
    request: "Fix Raft follower log handling in appendEntries(log, prevLogIndex, prevLogTerm, entries). log is an array of {term} with 1-based indices (log[0] is index 1); entries go at prevLogIndex+1 onward. Return false and leave the log unchanged if prevLogIndex is negative or the log has no entry at prevLogIndex with term prevLogTerm (index 0 always matches). Otherwise, for each entry: if an existing entry at that index has a different term, delete it and everything after it, then append; skip entries already present. A stale, duplicate or empty (heartbeat) request must never truncate entries after the request's own entries. Mutate log in place and return true.",
    broken: "export function appendEntries(log,prevLogIndex,prevLogTerm,entries){if(prevLogIndex>0&&(log.length<prevLogIndex||log[prevLogIndex-1].term!==prevLogTerm))return false;log.splice(prevLogIndex,log.length-prevLogIndex,...entries);return true;}",
    fixed: "export function appendEntries(log,prevLogIndex,prevLogTerm,entries){if(prevLogIndex<0)return false;if(prevLogIndex>0&&(log.length<prevLogIndex||log[prevLogIndex-1].term!==prevLogTerm))return false;for(let i=0;i<entries.length;i++){const at=prevLogIndex+i;if(at<log.length){if(log[at].term===entries[i].term)continue;log.length=at;}log.push(entries[i]);}return true;}",
    tests: `const t=terms=>terms.map(term=>({term}));const terms=log=>log.map(e=>e.term);
let log=t([1,1,2]);
assert.equal(mod.appendEntries(log,3,2,t([3])),true);assert.deepEqual(terms(log),[1,1,2,3]);
assert.equal(mod.appendEntries(log,1,1,t([1])),true);assert.deepEqual(terms(log),[1,1,2,3],'stale duplicate must not truncate');
assert.equal(mod.appendEntries(log,2,1,t([3,3])),true);assert.deepEqual(terms(log),[1,1,3,3],'conflict truncates');
assert.equal(mod.appendEntries(log,4,2,t([4])),false);assert.deepEqual(terms(log),[1,1,3,3],'prev term mismatch');
assert.equal(mod.appendEntries(log,9,3,t([4])),false);assert.deepEqual(terms(log),[1,1,3,3],'prev beyond end');
assert.equal(mod.appendEntries(log,-1,0,[]),false);
assert.equal(mod.appendEntries(log,2,1,[]),true);assert.deepEqual(terms(log),[1,1,3,3],'heartbeat keeps entries');
assert.equal(mod.appendEntries(log,2,1,t([3,4])),true);assert.deepEqual(terms(log),[1,1,3,4],'partial overlap');
assert.equal(mod.appendEntries(log,4,4,t([4,5])),true);assert.deepEqual(terms(log),[1,1,3,4,4,5]);
const empty=[];assert.equal(mod.appendEntries(empty,0,0,t([1,1])),true);assert.deepEqual(terms(empty),[1,1]);
assert.equal(mod.appendEntries(empty,0,7,t([2])),true);assert.deepEqual(terms(empty),[2],'index 0 matches any term');`,
  },
  {
    id: "anti-replay",
    request: "Fix the anti-replay window (RFC 4303 style, 64 packets). createWindow() returns check(seq), which returns true and records seq if it is new, and false otherwise. Sequence numbers are positive safe integers; reject anything else. Accept a seq above the highest seen, sliding the window forward (including jumps larger than the window); accept an unseen seq inside the window; reject duplicates and anything at or below highest - 64.",
    broken: "export function createWindow(){const seen=new Set();return seq=>{if(seen.has(seq))return false;seen.add(seq);return true;};}",
    fixed: "export function createWindow(){const W=64n,mask=(1n<<W)-1n;let top=0,bits=0n;return seq=>{if(!Number.isSafeInteger(seq)||seq<=0)return false;if(seq>top){const shift=BigInt(seq-top);bits=shift>=W?1n:((bits<<shift)|1n)&mask;top=seq;return true;}const offset=BigInt(top-seq);if(offset>=W)return false;const bit=1n<<offset;if(bits&bit)return false;bits|=bit;return true;};}",
    tests: `let w=mod.createWindow();
for(const bad of [0,-3,1.5,NaN,'5',Number.MAX_SAFE_INTEGER+1])assert.equal(w(bad),false,'invalid '+bad);
assert.equal(w(1),true);assert.equal(w(1),false);
assert.equal(w(100),true);assert.equal(w(37),true,'oldest in window');assert.equal(w(36),false,'just below window');assert.equal(w(37),false);
assert.equal(w(99),true);assert.equal(w(99),false);assert.equal(w(100),false);
assert.equal(w(1000),true);assert.equal(w(937),true);assert.equal(w(936),false);assert.equal(w(100),false);
assert.equal(w(1001),true);assert.equal(w(1000),false,'seen before the slide');assert.equal(w(938),true);
w=mod.createWindow();assert.equal(w(10),true);assert.equal(w(74),true);assert.equal(w(10),false,'jump of exactly 64');assert.equal(w(11),true);
const a=mod.createWindow(),b=mod.createWindow();assert.equal(a(5),true);assert.equal(b(5),true,'windows are independent');`,
  },
  {
    id: "merkle-proof",
    request: "Fix this RFC 6962 Merkle tree module (SHA-256 over Buffers). Leaf hash is H(0x00 || data), interior node hash is H(0x01 || left || right). rootOf(leaves) is the Merkle Tree Hash: H() of nothing for no leaves, and for n > 1 split at k, the largest power of two below n. verify(leaf, index, size, proof, root) checks an RFC 6962/9162 audit path and returns a boolean; it must reject index >= size, wrong indices, proofs that are too short or too long, and an interior node presented as a leaf.",
    broken: "import {createHash} from 'node:crypto';const H=(...b)=>createHash('sha256').update(Buffer.concat(b)).digest();export const leafHash=d=>H(d);export function rootOf(leaves){if(!leaves.length)return H();let level=leaves.map(leafHash);while(level.length>1){const next=[];for(let i=0;i<level.length;i+=2)next.push(i+1<level.length?H(level[i],level[i+1]):level[i]);level=next;}return level[0];}export function verify(leaf,index,size,proof,root){let r=leafHash(leaf),i=index;for(const p of proof){r=i%2?H(p,r):H(r,p);i=Math.floor(i/2);}return r.equals(root);}",
    fixed: "import {createHash} from 'node:crypto';const H=(...b)=>createHash('sha256').update(Buffer.concat(b)).digest();export const leafHash=d=>H(Buffer.from([0]),d);const node=(l,r)=>H(Buffer.from([1]),l,r);export function rootOf(leaves){const n=leaves.length;if(n===0)return H();if(n===1)return leafHash(leaves[0]);let k=1;while(k*2<n)k*=2;return node(rootOf(leaves.slice(0,k)),rootOf(leaves.slice(k)));}export function verify(leaf,index,size,proof,root){if(!Number.isSafeInteger(index)||!Number.isSafeInteger(size)||index<0||index>=size)return false;let fn=index,sn=size-1,r=leafHash(leaf);for(const p of proof){if(sn===0)return false;if(fn%2===1||fn===sn){r=node(p,r);while(fn%2===0&&fn!==0){fn=Math.floor(fn/2);sn=Math.floor(sn/2);}}else r=node(r,p);fn=Math.floor(fn/2);sn=Math.floor(sn/2);}return sn===0&&Buffer.isBuffer(root)&&r.equals(root);}",
    tests: `const {createHash}=await import('node:crypto');const H=(...b)=>createHash('sha256').update(Buffer.concat(b)).digest();
const L=d=>H(Buffer.from([0]),d),N=(a,b)=>H(Buffer.from([1]),a,b);
const mth=d=>{if(d.length===0)return H();if(d.length===1)return L(d[0]);let k=1;while(k*2<d.length)k*=2;return N(mth(d.slice(0,k)),mth(d.slice(k)));};
const audit=(m,d)=>{if(d.length<=1)return[];let k=1;while(k*2<d.length)k*=2;return m<k?[...audit(m,d.slice(0,k)),mth(d.slice(k))]:[...audit(m-k,d.slice(k)),mth(d.slice(0,k))];};
assert.ok(mod.rootOf([]).equals(H()),'empty tree');
for(let n=1;n<=9;n++){const d=Array.from({length:n},(_,i)=>Buffer.from('leaf'+i));const root=mth(d);assert.ok(mod.rootOf(d).equals(root),'root n='+n);
  for(let m=0;m<n;m++){const p=audit(m,d);assert.equal(mod.verify(d[m],m,n,p,root),true,'valid '+m+'/'+n);
    assert.equal(mod.verify(Buffer.from('forged'),m,n,p,root),false);
    if(n>1){assert.equal(mod.verify(d[m],(m+1)%n,n,p,root),false,'wrong index');assert.equal(mod.verify(d[m],m,n,p.slice(1),root),false,'short proof');}
    assert.equal(mod.verify(d[m],m,n,[...p,root],root),false,'long proof');}
  assert.equal(mod.verify(d[0],n,n,audit(0,d),root),false,'index >= size');}
const d4=['a','b','c','d'].map(s=>Buffer.from(s));
assert.equal(mod.verify(Buffer.concat([L(d4[0]),L(d4[1])]),0,2,[N(L(d4[2]),L(d4[3]))],mth(d4)),false,'interior node as leaf');`,
  },
];

const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
function testSource(source, tests) { return `import assert from 'node:assert/strict';\nimport * as mod from ${JSON.stringify(pathToFileURL(source).href)};\n${tests}\n`; }
function evaluate(file, cwd, timeout = 15000) { return spawnSync(process.execPath, [file], { cwd, encoding: "utf8", timeout }); }

// ---------- Offline task validation ----------

// One mutant per match: each operator site is flipped on its own.
const OPERATORS = [
  [/===/g, "!=="], [/!==/g, "==="], [/<=/g, "<"], [/>=/g, ">"],
  [/(?<![<=>!-])<(?![<=])/g, "<="], [/(?<![=>-])>(?![>=])/g, ">="],
  [/&&/g, "||"], [/\|\|/g, "&&"], [/\btrue\b/g, "false"], [/\bfalse\b/g, "true"],
  [/(?<![\w.])\d+(?![\w.])/g, match => String(Number(match) + 1)],
  [/!(?=[\w(])/g, ""], [/\+\+/g, "--"], [/(?<![+])\+(?![+=])/g, "-"], [/\bcontinue\b/g, "break"],
];
export function mutants(source) {
  const out = [];
  for (const [pattern, replacement] of OPERATORS) for (const match of source.matchAll(pattern)) {
    const text = typeof replacement === "function" ? replacement(match[0]) : replacement;
    const code = source.slice(0, match.index) + text + source.slice(match.index + match[0].length);
    if (code !== source) out.push({ op: `${match[0]}→${text || "∅"} @${match.index}`, code });
  }
  return out;
}

export function validateCase(item, threshold) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-domain-validate-"));
  try {
    const repo = path.join(fixture, "repo"); fs.mkdirSync(repo);
    const source = path.join(repo, "source.mjs");
    const tests = path.join(fixture, "tests.mjs"); fs.writeFileSync(tests, testSource(source, item.tests));
    const passes = (code, timeout) => { if (code === null) fs.rmSync(source, { force: true }); else fs.writeFileSync(source, code); return evaluate(tests, repo, timeout).status === 0; };
    const reasons = [];
    if (!passes(item.fixed) || !passes(item.fixed)) reasons.push("reference does not pass twice");
    if (passes(item.broken)) reasons.push("broken version passes");
    if (passes("export {};\n")) reasons.push("empty-export stub passes");
    if (passes(null)) reasons.push("missing source passes");
    let valid = 0; const survivors = [];
    for (const mutant of mutants(item.fixed)) {
      fs.writeFileSync(source, mutant.code);
      if (spawnSync(process.execPath, ["--check", source]).status !== 0) continue; // Syntax errors are not informative mutants.
      valid++;
      if (passes(mutant.code, 5000)) survivors.push(mutant.op);
    }
    const killRate = valid ? (valid - survivors.length) / valid : 1;
    if (killRate < threshold) reasons.push(`weak tests: ${survivors.length}/${valid} mutants survive (${survivors.slice(0, 4).join(", ")}${survivors.length > 4 ? ", …" : ""})`);
    return { id: item.id, ok: !reasons.length, reasons, mutants: valid, killRate: +killRate.toFixed(2), survivors };
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}

// ---------- Live arms ----------

function executorTools() {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(path.join(root, "agents/executor.md"), "utf8"))?.[1] ?? "";
  return /^tools:\s*(.+)$/m.exec(frontmatter)?.[1].split(",").map(tool => tool.trim()).filter(Boolean).join(",") ?? "";
}
const HARNESS_EXT = ["extensions/hashline/tool.ts", "extensions/stuck/tool.ts"];
export const ARMS = {
  baseline: { tools: "read,write,edit,bash,grep,find,ls", extensions: [], harness: false },
  harness: { tools: "read,write,hashline_edit,bash,grep,find,ls,harness_check", extensions: HARNESS_EXT, harness: true },
  lean: { tools: "read,write,hashline_edit,bash,harness_check", extensions: HARNESS_EXT, harness: true },
  full: { tools: executorTools(), extensions: [...HARNESS_EXT, "npm/node_modules/pi-lens/dist/index.js"], harness: true },
};

/** Exact two-sided McNemar test on discordant pairs. */
export function mcnemar(onlyA, onlyB) {
  const n = onlyA + onlyB;
  if (!n) return 1;
  let tail = 0, choose = 1;
  for (let i = 0; i <= Math.min(onlyA, onlyB); i++) { tail += choose; choose = choose * (n - i) / (i + 1); }
  return Math.min(1, 2 * tail / 2 ** n);
}

export function difficulty(rate) { return rate >= 0.8 ? "easy" : rate <= 0.2 ? "hard" : "medium"; }

async function agentRun(repo, request, armName, hidden, metricsLib) {
  const arm = ARMS[armName];
  const model = JSON.parse(fs.readFileSync(path.join(root, "agents/models.json"), "utf8"));
  const prompt = fs.readFileSync(path.join(root, "agents/executor.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "");
  const promptFile = path.join(path.dirname(repo), "executor.md"); fs.writeFileSync(promptFile, prompt);
  // All arms share the model, sandbox, guard and task; arms differ in prompt, tools and extensions.
  const scope = hidden ? "No tests are provided: write your own checks in new test files, run them, and modify source.mjs only if they show it is wrong." : "Modify only source.mjs if needed. Tests are in verify.mjs.";
  const verify = arm.harness ? (hidden ? " Register your own test files as harness_check checks; define an immutable contract before changes. End with harness_check complete." : " Verify with node verify.mjs using harness_check; define an immutable contract before changes. End with harness_check complete.") : " Run the tests before finishing.";
  const args = ["--mode", "json", "-p", "--no-session", "--no-prompt-templates", "--no-extensions", "-e", path.join(root, "extensions/creds-guard.ts"), "-e", path.join(root, "extensions/sandbox/index.ts"),
    ...arm.extensions.flatMap(file => ["-e", path.join(root, file)]), "--model", arg("--model") ?? model.executor ?? model.default, "--thinking", arg("--thinking") ?? "medium",
    "--tools", arm.tools, ...(arm.harness ? ["--append-system-prompt", promptFile] : []),
    `Task: ${request}\nRepo: ${repo}. ${scope}${verify} Do not commit. Correct code should remain unchanged. This is a bounded engineering evaluation, not a production cryptographic design.`];
  const started = Date.now();
  const metrics = metricsLib.createDispatchMetrics();
  return await new Promise(resolve => {
    const child = spawn(path.join(root, "bin/pi"), args, { cwd: repo, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_SUBAGENT_CHILD: "1" } });
    let buffer = "", stderr = "", outputTokens = 0, cost = 0, turns = 0, completed = false, stuckReminders = 0, syntaxNotes = 0;
    const toolArgs = new Map();
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 1200000);
    const event = line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.type === "message_end" && value.message?.role === "assistant") { turns++; outputTokens += value.message.usage?.output ?? 0; cost += value.message.usage?.cost?.total ?? 0; metrics.context(value.message.usage?.totalTokens ?? 0); }
      if (value.type === "tool_execution_start") { toolArgs.set(value.toolCallId, value.args); metrics.toolStart(value.toolName, value.args); }
      if (value.type === "tool_execution_start" && ["write", "edit", "hashline_edit", "bash"].includes(value.toolName)) completed = false;
      if (value.type === "tool_execution_end") {
        metrics.toolEnd(Boolean(value.isError));
        const text = (value.result?.content ?? []).map(part => part.text ?? "").join("\n");
        if (text.includes("[harness] This is the same")) stuckReminders++;
        if (text.includes("Syntax check (")) syntaxNotes++;
        if (value.toolName === "harness_check" && toolArgs.get(value.toolCallId)?.action === "complete") completed = !value.isError && value.result?.details?.phase === "verified";
      }
    };
    child.stdout.on("data", data => { buffer += data; const lines = buffer.split("\n"); buffer = lines.pop(); lines.forEach(event); });
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
    child.on("error", error => { clearTimeout(timer); resolve({ exitCode: 1, error: error.message, elapsedMs: Date.now() - started, completed: false, ...metrics.snapshot() }); });
    child.on("close", code => { clearTimeout(timer); if (buffer) event(buffer); resolve({ exitCode: code, elapsedMs: Date.now() - started, outputTokens, reportedCost: cost, turns, completed, stuckReminders, syntaxNotes, stderr, ...metrics.snapshot() }); });
  });
}

function summarise(results, arms, runs) {
  const lines = [];
  const mean = (rows, key) => rows.length ? rows.reduce((n, r) => n + (r[key] ?? 0), 0) / rows.length : 0;
  for (const arm of arms) {
    const rows = results.filter(r => r.arm === arm), solved = rows.filter(r => r.independentTestsPassed);
    const peaks = rows.map(r => r.peakContextTokens ?? 0).sort((a, b) => a - b);
    lines.push(`${arm}: ${solved.length}/${rows.length} pass hidden grader, ${rows.filter(r => r.unnecessaryCleanEdit).length} clean-code edits, ${Math.round(mean(rows, "elapsedMs") / 1000)}s/run, $${(mean(rows, "reportedCost")).toFixed(3)}/run, ${solved.length ? (solved.reduce((n, r) => n + r.toolCalls, 0) / solved.length).toFixed(1) : "-"} tool calls per solve, ${mean(rows, "reEdits").toFixed(2)} re-edits/run, peak ctx p90 ${peaks[Math.max(0, Math.ceil(0.9 * peaks.length) - 1)] ?? 0}, ${rows.reduce((n, r) => n + (r.stuckReminders ?? 0), 0)} stuck reminders, ${rows.reduce((n, r) => n + (r.syntaxNotes ?? 0), 0)} syntax notes`);
  }
  const reference = arms.find(arm => arm !== "baseline") ?? arms[0];
  for (const id of [...new Set(results.map(r => r.case))]) {
    const rows = results.filter(r => r.arm === reference && r.case === id && r.variant === "broken");
    const rate = rows.length ? rows.filter(r => r.independentTestsPassed).length / rows.length : 0;
    lines.push(`difficulty ${id} (${reference}, ${rows.length} broken runs): ${difficulty(rate)} (${Math.round(rate * 100)}%)`);
  }
  for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
    const key = r => `${r.case}|${r.variant}|${r.run}`;
    const a = new Map(results.filter(r => r.arm === arms[i]).map(r => [key(r), r.independentTestsPassed]));
    let onlyA = 0, onlyB = 0;
    for (const r of results.filter(r => r.arm === arms[j])) { if (!a.has(key(r))) continue; if (a.get(key(r)) && !r.independentTestsPassed) onlyA++; if (!a.get(key(r)) && r.independentTestsPassed) onlyB++; }
    lines.push(`McNemar ${arms[i]} vs ${arms[j]}: ${onlyA} only ${arms[i]}, ${onlyB} only ${arms[j]}, p=${mcnemar(onlyA, onlyB).toFixed(3)}${runs * 2 < 10 ? " (too few runs to separate arms; use --runs)" : ""}`);
  }
  return lines;
}

// ---------- Main ----------

if (process.argv[1] === fileURLToPath(import.meta.url) && arg("--merge")) {
  const reports = arg("--merge").split(",").map(file => JSON.parse(fs.readFileSync(file, "utf8")));
  const models = [...new Set(reports.map(r => r.model))];
  if (models.length > 1) throw new Error(`Reports use different models (${models.join(", ")}); merge one model at a time`);
  const results = reports.flatMap(r => r.results);
  const arms = [...new Set(results.map(r => r.arm))];
  console.log(`Model ${models[0]}, ${results.length} runs`);
  summarise(results, arms, Math.max(...results.map(r => r.run))).forEach(line => console.log(line));
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const selected = arg("--case");
  if (selected && !cases.some(item => item.id === selected)) throw new Error(`Unknown case: ${selected}`);
  const live = process.argv.includes("--agent");
  const hidden = process.argv.includes("--hidden-tests");
  const runs = Number(arg("--runs") ?? 1);
  const threshold = Number(arg("--mutation-threshold") ?? 0.8);
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const arms = (arg("--arms") ?? (process.argv.includes("--baseline") ? "baseline,harness" : "harness")).split(",");
  for (const arm of arms) if (!ARMS[arm]) throw new Error(`Unknown arm: ${arm} (${Object.keys(ARMS).join(", ")})`);

  const validations = cases.filter(item => !selected || item.id === selected).map(item => validateCase(item, threshold));
  for (const v of validations) console.log(`${v.ok ? "valid  " : "INVALID"} ${v.id}: ${v.mutants} mutants, kill rate ${v.killRate}${v.reasons.length ? " — " + v.reasons.join("; ") : ""}`);
  const usable = validations.filter(v => v.ok || process.argv.includes("--include-weak")).map(v => cases.find(item => item.id === v.id));

  if (!live) {
    assert.ok(validations.every(v => v.ok), "every bundled task passes validation");
    assert.equal(mcnemar(0, 0), 1); assert.equal(mcnemar(5, 0), 0.0625); assert.equal(mcnemar(6, 0), 0.03125); assert.equal(mcnemar(3, 3), 1);
    assert.deepEqual([0.9, 0.5, 0.1].map(difficulty), ["easy", "medium", "hard"]);
    assert.ok(ARMS.full.tools.split(",").includes("lsp_navigation") && !ARMS.lean.tools.includes("grep"), "arms expose the intended tool sets");
    console.log(`Passed validation of ${validations.length} domain tasks. Use --agent to run them live (--arms ${Object.keys(ARMS).join(",")}, --runs N, --hidden-tests, --case <id>).`);
  } else {
    const { jiti } = await import("./lib/loader.mjs");
    const metricsLib = await jiti.import(path.join(root, "extensions/lib/dispatch-metrics.ts"));
    const results = [];
    for (const item of usable) for (let run = 1; run <= runs; run++) {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-domain-eval-"));
      try {
        const repo = path.join(fixture, "repo");
        const source = path.join(repo, "source.mjs");
        const independent = path.join(fixture, "independent.mjs"); fs.writeFileSync(independent, testSource(source, item.tests));
        for (const arm of arms) for (const [variant, code] of [["broken", item.broken], ["clean", item.fixed]]) {
          // Fresh repository per run so arms and variants cannot see each other's files.
          fs.rmSync(repo, { recursive: true, force: true }); fs.mkdirSync(repo);
          fs.writeFileSync(source, code);
          if (!hidden) fs.writeFileSync(path.join(repo, "verify.mjs"), testSource(source, item.tests));
          for (const gitArgs of [["init"], ["config", "user.name", "Harness Eval"], ["config", "user.email", "eval@example.invalid"]]) execFileSync("git", gitArgs, { cwd: repo, stdio: "ignore" });
          execFileSync("git", ["add", "."], { cwd: repo });
          execFileSync("git", ["commit", "-m", `baseline ${variant}`], { cwd: repo, stdio: "ignore" });
          console.log(`Running ${arm} ${item.id}/${variant} run ${run}…`);
          const agent = await agentRun(repo, item.request + (ARMS[arm].harness ? ` Use unique harness run id eval-${item.id}-${variant}-${run}-${Date.now()}.` : ""), arm, hidden, metricsLib);
          const passed = evaluate(independent, repo).status === 0;
          const changed = !fs.existsSync(source) || fs.readFileSync(source, "utf8") !== code;
          results.push({ arm, hidden, run, case: item.id, variant, independentTestsPassed: passed, unnecessaryCleanEdit: variant === "clean" && changed, ...agent, stderr: agent.exitCode ? agent.stderr : undefined });
          console.log(`${arm} ${item.id}/${variant} #${run}: tests ${passed ? "pass" : "fail"}${variant === "clean" && changed ? " (edited clean code)" : ""}, evidence ${agent.completed ? "complete" : "missing"}, ${Math.round(agent.elapsedMs / 1000)}s, ${agent.turns ?? 0} turns, ${agent.toolCalls ?? 0} tool calls, exit ${agent.exitCode}`);
        }
      } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
    }
    const directory = path.join(root, "harness/evals"); fs.mkdirSync(directory, { recursive: true });
    const report = path.join(directory, `${Date.now()}.json`);
    const summary = summarise(results, arms, runs);
    fs.writeFileSync(report, JSON.stringify({ createdAt: new Date().toISOString(), model: arg("--model") ?? "models.json executor", thinking: arg("--thinking") ?? "medium", arms, runs, hidden, validations, summary, results }, null, 2) + "\n");
    summary.forEach(line => console.log(line));
    console.log(`Evaluation report: ${report}`);
  }
}
