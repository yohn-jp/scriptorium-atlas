import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { relative, join } from 'node:path';

export async function hashTree(directory) {
  const files = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await walk(directory);
  files.sort((left, right) => {
    const leftPath = relative(directory, left);
    const rightPath = relative(directory, right);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  const digest = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    const content = await readFile(file);
    const path = relative(directory, file).split('\\').join('/');
    bytes += content.byteLength;
    digest.update(path).update('\0').update(String(content.byteLength)).update('\0').update(content);
  }
  return { sha256: digest.digest('hex'), files: files.length, bytes };
}

export function currentHead(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
