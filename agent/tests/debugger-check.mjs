import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, jiti } from './lib/loader.mjs';

const { debugCommand, registerDebugger } = await jiti.import(path.join(root, 'extensions/lib/debugger.ts'));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-debugger-check-'));
const source = path.join(fixture, 'main.c');
const program = path.join(fixture, "program 'quoted'");
try {
  fs.writeFileSync(source, 'int main(void) {\n  volatile int value = 42;\n  value += 1;\n  return value == 43 ? 0 : 1;\n}\n');
  execFileSync('clang', ['-g', '-O0', source, '-o', program]);
  assert.throws(() => debugCommand({ program: '/bin/ls' }, fixture), /workspace/);
  assert.throws(() => debugCommand({ program, commands: ['run\nquit'] }, fixture), /newlines/);
  assert.throws(() => debugCommand({ program, timeoutSeconds: 15, breakpoints: ['main.c:0'] }, fixture), /positive line/);
  const command = debugCommand({ program, args: ['literal $(touch nope)'], breakpoints: ['main.c:3'], commands: ['run', 'frame variable value', 'next', 'frame variable value', 'continue'] }, fixture);
  assert.ok(command.includes('--no-lldbinit'));
  let tool;
  registerDebugger({ registerTool: t => { tool = t; } }, () => { throw new Error('Sandbox unavailable'); });
  await assert.rejects(tool.execute('test', { program }, undefined, undefined, { cwd: fixture }), /Sandbox unavailable/);
  process.env.PI_SUBAGENT_READ_ONLY = '1';
  await assert.rejects(tool.execute('test', { program }, undefined, undefined, { cwd: fixture }), /read-only/);
  delete process.env.PI_SUBAGENT_READ_ONLY;

  if (process.argv.includes('--live')) {
    const sandbox = await jiti.import(path.join(root, 'extensions/sandbox/index.ts'));
    const hooks = new Map(); const tools = new Map();
    sandbox.default({ registerFlag() {}, getFlag: name => name === "debug-unsandboxed" && process.argv.includes("--unsandboxed"), registerTool: t => tools.set(t.name, t), registerCommand() {}, on: (name, fn) => hooks.set(name, fn) });
    assert.ok(tools.has('bash') && tools.has('debug'));
    const ctx = { cwd: fixture, ui: { setStatus() {}, theme: { fg: (_color, text) => text }, notify: (message, level) => { if (level === 'error') throw new Error(message); } } };
    await hooks.get('session_start')({}, ctx);
    assert.equal(process.env.PI_DEBUG_UNSANDBOXED, process.argv.includes('--unsandboxed') ? '1' : undefined);
    const result = await tools.get('debug').execute('live', { program, timeoutSeconds: 15, breakpoints: ['main.c:3'], commands: ['run', 'frame variable value', 'next', 'frame variable value', 'continue'] }, undefined, undefined, ctx);
    const output = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    console.log(output);
    assert.match(output, /value = 42/);
    assert.match(output, /value = 43/);
    assert.match(output, /exited with status = 0/);
    const runtime = await jiti.import(path.join(root, 'extensions/sandbox/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js'));
    await runtime.SandboxManager.reset();
  }
  console.log('Debugger checks passed.');
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
