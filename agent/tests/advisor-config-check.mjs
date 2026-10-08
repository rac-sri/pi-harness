import fs from "node:fs";
import path from "node:path";

import { root, modules, jiti } from "./lib/loader.mjs";
const pkg = path.join(root, "npm/node_modules/pi-advisor-flow/src/config");
const { validateConfig, unknownConfigKeys } = await jiti.import(path.join(pkg, "validation.ts"));
const raw = JSON.parse(fs.readFileSync(path.join(root, "advisor.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(root, "advisor.json"), "utf8"));
validateConfig(config);
const unknown = unknownConfigKeys(config);
console.log("advisor.json:", JSON.stringify(raw));
console.log("validateConfig:", "accepted");
console.log("unknown keys:", unknown.length ? unknown : "(none)");
if (raw.advisor === raw.executor) throw new Error("advisor equals executor — same-model guard would skip every consultation");
console.log("advisor !== executor:", raw.executor, "->", raw.advisor);
