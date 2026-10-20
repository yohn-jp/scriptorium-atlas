/** Resolve emitted native Worker URLs, including Vite's nested-worker annotation. */
export function collectWorkerImports(code, fromFile, workerFiles) {
  const base = new URL(fromFile, 'https://atlas.invalid/');
  const targets = new Set();
  const pattern = /\bnew\s+Worker\s*\(\s*new\s+URL\s*\((?:\s|\/\*[\s\S]*?\*\/)*(['"`])([^'"`]+)\1/g;
  for (const match of code.matchAll(pattern)) {
    if (match[2].includes('${')) continue;
    const target = new URL(match[2], base);
    if (target.origin === base.origin) targets.add(target.pathname.slice(1));
  }
  return workerFiles.filter(file => targets.has(file)).sort();
}
