import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const source = resolve(packageDirectory, "src/ui/styles.css");
const destination = resolve(packageDirectory, "dist/ui/styles.css");

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
