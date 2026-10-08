import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = fs.readFileSync(path.join(root, "install/current-version"), "utf8").trim();
const modules = path.join(root, "install/releases", version, "node_modules");
const paths = Object.fromEntries(["pi-coding-agent", "pi-agent-core", "pi-tui", "pi-ai"].map(name => [`@earendil-works/${name}`, [path.join(modules, "@earendil-works", name, "dist", name === "pi-ai" ? "compat.d.ts" : "index.d.ts")]]));
paths.typebox = [path.join(modules, "typebox/build/index.d.mts")];
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-typecheck-"));
try {
  const config = path.join(fixture, "tsconfig.json");
  fs.writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ES2023", module: "ESNext", moduleResolution: "Bundler", noEmit: true, allowImportingTsExtensions: true, strict: true, skipLibCheck: true, types: ["node"], typeRoots: [path.join(modules, "@types")], baseUrl: root, paths }, include: [path.join(root, "extensions/**/*.ts")] }));
  try {
    execFileSync("tsc", ["-p", config], { stdio: "inherit" });
    console.log("Strict extension type checking passed.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log("SKIPPED strict extension type checking: tsc not found on PATH (npm i -g typescript).");
  }
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
