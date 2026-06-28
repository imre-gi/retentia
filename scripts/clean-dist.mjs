#!/usr/bin/env node
import { rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetArg = process.argv[2] || "dist";
const targetPath = resolve(rootDir, targetArg);

if (targetPath !== rootDir && !targetPath.startsWith(`${rootDir}${sep}`)) {
  throw new Error(`Refusing to remove path outside repository: ${targetPath}`);
}

rmSync(targetPath, { recursive: true, force: true });
