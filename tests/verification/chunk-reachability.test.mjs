import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeChunkReachability, inspectLazyDependency } from '../../scripts/verification/chunk-reachability.mjs';

test('follows nested dynamic imports and explicit Worker entries without making them eager', () => {
  const chunks = new Map([
    ['entry.js', { file: 'entry.js', imports: ['shell.js'], dynamicImports: [], workerImports: [], modules: ['entry'] }],
    ['shell.js', { file: 'shell.js', imports: [], dynamicImports: ['ui-lazy.js'], workerImports: ['graph-worker.js'], modules: ['shell'] }],
    ['ui-lazy.js', { file: 'ui-lazy.js', imports: ['ui-core.js'], dynamicImports: ['locale-lazy.js'], workerImports: [], modules: ['ui-lazy'] }],
    ['ui-core.js', { file: 'ui-core.js', imports: [], dynamicImports: [], workerImports: [], modules: ['ui-core'] }],
    ['locale-lazy.js', { file: 'locale-lazy.js', imports: ['locale-core.js'], dynamicImports: [], workerImports: [], modules: ['locale-lazy'] }],
    ['locale-core.js', { file: 'locale-core.js', imports: ['excalidraw-lazy.js'], dynamicImports: [], workerImports: [], modules: ['locale-core'] }],
    ['excalidraw-lazy.js', { file: 'excalidraw-lazy.js', imports: [], dynamicImports: [], workerImports: [], modules: ['node_modules/@excalidraw/excalidraw/index.js'] }],
    ['graph-worker.js', { file: 'graph-worker.js', imports: ['graph-worker-core.js'], dynamicImports: [], workerImports: ['nested-worker.js'], modules: ['graph-worker'] }],
    ['graph-worker-core.js', { file: 'graph-worker-core.js', imports: [], dynamicImports: [], workerImports: [], modules: ['graph-worker-core'] }],
    ['nested-worker.js', { file: 'nested-worker.js', imports: [], dynamicImports: [], workerImports: [], modules: ['nested-worker'] }],
    ['orphan.js', { file: 'orphan.js', imports: [], dynamicImports: [], workerImports: [], modules: ['node_modules/@excalidraw/excalidraw/orphan.js'] }]
  ]);

  const reachability = computeChunkReachability(['entry.js'], chunks);
  assert.deepEqual([...reachability.staticReachable].sort(), ['entry.js', 'shell.js']);
  assert.deepEqual([...reachability.lazyReachable].sort(), [
    'excalidraw-lazy.js',
    'graph-worker-core.js',
    'graph-worker.js',
    'locale-core.js',
    'locale-lazy.js',
    'nested-worker.js',
    'ui-core.js',
    'ui-lazy.js'
  ]);

  const report = inspectLazyDependency(/@excalidraw\/excalidraw\//, chunks, reachability);
  assert.deepEqual(report, {
    chunks: ['excalidraw-lazy.js', 'orphan.js'],
    eager: [],
    unreachable: ['orphan.js']
  });
});

test('still classifies a heavy package statically imported by an HTML entry as eager', () => {
  const chunks = new Map([
    ['entry.js', { file: 'entry.js', imports: ['heavy.js'], dynamicImports: [], workerImports: [], modules: ['entry'] }],
    ['heavy.js', { file: 'heavy.js', imports: [], dynamicImports: [], workerImports: [], modules: ['node_modules/@xyflow/react/dist/index.js'] }]
  ]);
  const reachability = computeChunkReachability(['entry.js'], chunks);
  const report = inspectLazyDependency(/@xyflow\/react\//, chunks, reachability);
  assert.deepEqual(report, { chunks: ['heavy.js'], eager: ['heavy.js'], unreachable: [] });
});
