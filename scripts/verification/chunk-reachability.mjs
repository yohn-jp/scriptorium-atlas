function traverse(startFiles, chunks, edgeNames) {
  const visited = new Set();
  const pending = [...startFiles];
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const chunk = chunks.get(file);
    if (!chunk) continue;
    for (const edgeName of edgeNames) {
      for (const dependency of chunk[edgeName] ?? []) pending.push(dependency);
    }
  }
  return visited;
}

/** Keep static entry reachability separate from all transitive lazy and Worker edges. */
export function computeChunkReachability(entryFiles, chunks) {
  const staticReachable = traverse(entryFiles, chunks, ['imports']);
  const lazyRoots = [...staticReachable].flatMap(file => {
    const chunk = chunks.get(file);
    return [...(chunk?.dynamicImports ?? []), ...(chunk?.workerImports ?? [])];
  });
  const lazyReachable = traverse(lazyRoots, chunks, ['imports', 'dynamicImports', 'workerImports']);
  return { staticReachable, lazyReachable };
}

export function inspectLazyDependency(pattern, chunks, { staticReachable, lazyReachable }) {
  const dependencyChunks = [...chunks.values()].filter(chunk => chunk.modules.some(module => pattern.test(module)));
  const allReachable = new Set([...staticReachable, ...lazyReachable]);
  return {
    chunks: dependencyChunks.map(chunk => chunk.file),
    eager: dependencyChunks.filter(chunk => staticReachable.has(chunk.file)).map(chunk => chunk.file),
    unreachable: dependencyChunks.filter(chunk => !allReachable.has(chunk.file)).map(chunk => chunk.file)
  };
}
