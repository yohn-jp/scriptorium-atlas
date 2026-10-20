import { createGraphWorkerClient } from '../dist/worker/client.js';
import { createLayoutWorkerClient } from '../../layout/dist/worker/client.js';

const sampleCount = Number(new URLSearchParams(location.search).get('samples') ?? 30);
const sizes = (new URLSearchParams(location.search).get('sizes') ?? '1000,10000').split(',').map(Number);
const output = document.querySelector('#result');

void run().then((report) => {
  output.textContent = JSON.stringify(report, null, 2);
  document.body.dataset.status = 'complete';
}, (error) => {
  output.textContent = JSON.stringify({ error: String(error), stack: error?.stack }, null, 2);
  document.body.dataset.status = 'failed';
});

async function run() {
  if (!Number.isInteger(sampleCount) || sampleCount < 1 || !sizes.every((size) => Number.isInteger(size) && size >= 2 && size <= 10_000)) {
    throw new RangeError('samples must be a positive integer and sizes must be integers from 2 through 10000');
  }
  const cases = [];
  for (const nodeCount of sizes) cases.push(await runSize(nodeCount));
  return {
    title: 'Atlas worker task timings',
    scope: 'Real Chromium module Workers only. These measurements exclude browser UI, canvas rendering, frame time, and quality-gate evaluation.',
    browser: navigator.userAgent,
    sampleCount,
    cases,
  };
}

async function runSize(nodeCount) {
  const snapshot = { workspaceId: 'worker-benchmark', sourceRevision: `source-${nodeCount}`, providerRevision: `provider-${nodeCount}`, epoch: 1 };
  const graph = makeGraph(nodeCount);
  const graphClient = createGraphWorkerClient({ timeoutMs: 120_000 });
  const indexStart = performance.now();
  await graphClient.replaceSnapshot(snapshot, graph.nodes, graph.edges);
  const indexMs = performance.now() - indexStart;

  const middle = Math.floor(nodeCount / 2);
  const search = await measure(sampleCount, () => graphClient.search({ query: '銀狐', limit: 25 }));
  const neighbors = await measure(sampleCount, () => graphClient.neighbors({ from: nodeRef(middle), direction: 'both', depth: 3 }));
  const shortestPath = await measure(sampleCount, () => graphClient.shortestPath({
    from: nodeRef(0),
    to: nodeRef(nodeCount - 1),
    direction: 'out',
    maxHops: nodeCount - 1,
    maxVisited: nodeCount,
  }));
  graphClient.close();

  const layoutClient = createLayoutWorkerClient({ timeoutMs: 120_000 });
  const layoutStart = performance.now();
  const controller = new AbortController();
  const force = layoutClient.calculate({
    kind: 'force',
    boardRevision: 1,
    snapshot,
    seed: 'atlas-worker-benchmark',
    iterations: 10_000,
    nodes: graph.boardNodes,
    edges: graph.boardEdges,
  }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  let forceCancellation;
  try {
    await force;
    forceCancellation = { outcome: 'completed-before-abort' };
  } catch (error) {
    forceCancellation = {
      outcome: error?.name === 'AbortError' ? 'aborted' : 'rejected',
      error: error?.name === 'AbortError' ? undefined : String(error),
    };
  }
  forceCancellation.elapsedMs = performance.now() - layoutStart;
  layoutClient.close();

  return {
    nodeCount,
    edgeCount: graph.edges.length,
    indexBuildMs: round(indexMs),
    searchJapaneseSubstring: summarize(search),
    neighborsDepth3: summarize(neighbors),
    shortestPath: summarize(shortestPath),
    forceCancellation,
  };
}

async function measure(count, operation) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  return samples;
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    minMs: round(sorted[0]),
    medianMs: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted[sorted.length - 1]),
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value) {
  return Number(value.toFixed(2));
}

function makeGraph(count) {
  const nodes = Array.from({ length: count }, (_, index) => {
    const id = nodeId(index);
    return {
      ref: nodeRef(index),
      kind: index % 2 === 0 ? 'story.character' : 'story.place',
      label: `人物ノード ${id} 銀狐`,
      aliases: [`alias-${id}`],
      tags: [`group-${index % 20}`, '物語'],
      source: { workspaceId: 'worker-benchmark', path: `stories/${index % 100}/chapter-${index}.yaml`, revision: 'r1' },
    };
  });
  const edges = Array.from({ length: count - 1 }, (_, index) => ({
    ref: { providerId: 'bench.edge', localId: `edge-${index}` },
    from: nodeRef(index),
    to: nodeRef(index + 1),
    kind: 'relationship',
    directed: true,
  }));
  const boardNodes = nodes.map((node, index) => ({
    id: node.ref.localId,
    origin: 'provider',
    ref: node.ref,
    kind: node.kind,
    label: node.label,
    position: { x: (index % 100) * 20, y: Math.floor(index / 100) * 20 },
  }));
  const boardEdges = edges.map((edge, index) => ({
    id: `board-edge-${index}`,
    from: edge.from.localId,
    to: edge.to.localId,
    meaning: 'semantic',
    ref: edge.ref,
  }));
  return { nodes, edges, boardNodes, boardEdges };
}

function nodeId(index) {
  return `node-${String(index).padStart(5, '0')}`;
}

function nodeRef(index) {
  return { providerId: 'bench', localId: nodeId(index) };
}
