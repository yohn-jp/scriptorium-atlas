import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const source = resolve(packageDirectory, "src/ui/styles.css");
const destination = resolve(packageDirectory, "dist/ui/styles.css");
const nodeAssetsTypes = resolve(packageDirectory, "src/assets-node.d.ts");
const nodeAssetsTypesDestination = resolve(packageDirectory, "dist/assets-node.d.ts");

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
await copyFile(nodeAssetsTypes, nodeAssetsTypesDestination);
