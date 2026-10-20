import { basename, dirname, resolve } from "node:path";
import { copyCanvasAssets } from "./copy-canvas-assets.mjs";

const destinationArgument = process.argv[2];
if (!destinationArgument) {
  process.stderr.write("Usage: pnpm --filter @scriptorium-atlas/canvas copy-fonts -- <public-fonts-directory>\n");
  process.exitCode = 2;
} else {
  const destination = resolve(process.cwd(), destinationArgument);
  if (basename(destination) !== "fonts") {
    throw new Error("The fonts directory must be named 'fonts'.");
  }
  const copied = await copyCanvasAssets(dirname(destination));
  process.stdout.write(
    `Copied ${copied.fileCount} Excalidraw font files (${copied.totalBytes} bytes); manifest: ${copied.manifestPath}\n`,
  );
}
