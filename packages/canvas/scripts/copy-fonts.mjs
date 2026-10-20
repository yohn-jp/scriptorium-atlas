import { cp, mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const destinationArgument = process.argv[2];
if (!destinationArgument) {
  process.stderr.write("Usage: pnpm --filter @scriptorium-atlas/canvas copy-fonts -- <public-fonts-directory>\n");
  process.exitCode = 2;
} else {
  const require = createRequire(import.meta.url);
  const excalidrawEntry = require.resolve("@excalidraw/excalidraw");
  const source = resolve(dirname(excalidrawEntry), "fonts");
  const sourceStat = await stat(source);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Expected Excalidraw production fonts directory at ${source}`);
  }

  const destination = resolve(process.cwd(), destinationArgument);
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}
