import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(packageDirectory, "dist");
const tscEntry = resolve(packageDirectory, "node_modules/typescript/bin/tsc");

await rm(outputDirectory, { recursive: true, force: true });
const result = spawnSync(process.execPath, [tscEntry, "-p", resolve(packageDirectory, "tsconfig.json")], {
  cwd: packageDirectory,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await import("./copy-build-assets.mjs");
