import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const seed = 'atlas-v1-perf-20261021';
const STORY_PROVIDER_ID = 'scriptorium.story-knowledge';

function optionsFrom(argv) {
  const result = { nodes: 1_000, edges: 2_000, cards: 0, layoutNodes: 0, output: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const [key, inline] = argument.slice(2).split('=', 2);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    if (key === 'output') result.output = resolve(value);
    else if (key === 'report') result.report = resolve(value);
    else if (['nodes', 'edges', 'cards', 'layout-nodes'].includes(key)) {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0) throw new Error(`--${key} must be a non-negative integer.`);
      if (key === 'layout-nodes') result.layoutNodes = number;
      else result[key] = number;
    } else throw new Error(`Unknown option: --${key}`);
  }
  if (!result.output) throw new Error('An output path is required: --output /tmp/atlas-perf.zip');
  if (!result.report) result.report = `${result.output}.summary.json`;
  if (!result.nodes && result.edges) throw new Error('Edges require at least one node.');
  if (result.nodes && result.edges % result.nodes !== 0) throw new Error('For this deterministic ring dataset, edges must be divisible by nodes.');
  if (result.edges > result.nodes * Math.max(0, result.nodes - 1)) throw new Error('The requested edge count would create duplicate edges.');
  if (result.layoutNodes > result.nodes) throw new Error('--layout-nodes cannot exceed --nodes.');
  return result;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function arrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function deterministicBoard({ nodeCount, edgeCount, cardCount }) {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `perf-node-${String(index).padStart(5, '0')}`,
    origin: 'provider',
    kind: 'story.character',
    label: `計測対象 ${String(index).padStart(5, '0')}`,
    ref: { providerId: STORY_PROVIDER_ID, localId: `perf-node-${String(index).padStart(5, '0')}` },
    position: { x: (index % 40) * 220, y: Math.floor(index / 40) * 120 },
  }));
  const edges = Array.from({ length: edgeCount }, (_, edgeIndex) => {
    const degree = nodeCount ? edgeCount / nodeCount : 0;
    const source = Math.floor(edgeIndex / degree);
    const offset = edgeIndex % degree + 1;
    const sourceId = `perf-node-${String(source).padStart(5, '0')}`;
    const targetId = `perf-node-${String((source + offset) % nodeCount).padStart(5, '0')}`;
    const relationId = `perf-edge-${String(source).padStart(5, '0')}-${String(offset - 1).padStart(3, '0')}`;
    return {
      id: `perf-board-${relationId}`,
      from: sourceId,
      to: targetId,
      meaning: 'semantic',
      ref: { providerId: STORY_PROVIDER_ID, localId: relationId },
    };
  });
  const cards = Array.from({ length: cardCount }, (_, index) => ({
    id: `perf-card-${String(index).padStart(4, '0')}`,
    kind: 'text',
    position: { x: 80 + (index % 25) * 300, y: 80 + Math.floor(index / 25) * 210 },
    width: 260,
    height: 160,
    text: `Deterministic Canvas card ${String(index).padStart(4, '0')}`,
  }));

  return {
    schema: 'atlas.board/v1',
    boardId: 'perf-board-v1',
    name: 'Deterministic performance board',
    revision: 0,
    views: [
      { id: 'perf-graph-view', kind: 'graph', name: 'Graph', viewport: { x: 0, y: 0, zoom: 1 }, pins: [] },
      { id: 'perf-canvas-view', kind: 'freeform', name: 'Canvas', viewport: { x: 0, y: 0, zoom: 1 } },
    ],
    nodes,
    edges,
    cards,
    assets: [],
  };
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  const persistenceModule = resolve(repoRoot, 'packages/persistence/dist/bundle.js');
  try {
    await stat(persistenceModule);
  } catch {
    throw new Error('Production persistence build is missing. Run the workspace build before generating measured bundles.');
  }
  const { createBundle, workspaceRevision } = await import(`file://${persistenceModule}`);
  const records = [];
  const encoder = new TextEncoder();
  const degree = options.nodes ? options.edges / options.nodes : 0;
  for (let index = 0; index < options.nodes; index += 1) {
    const localId = `perf-node-${String(index).padStart(5, '0')}`;
    const relations = Array.from({ length: degree }, (_, relationIndex) => ({
      id: `perf-edge-${String(index).padStart(5, '0')}-${String(relationIndex).padStart(3, '0')}`,
      target: `perf-node-${String((index + relationIndex + 1) % options.nodes).padStart(5, '0')}`,
      kind: 'benchmark-link',
    }));
    const source = JSON.stringify({
      id: localId,
      type: 'character',
      name: `計測対象 ${String(index).padStart(5, '0')}`,
      aliases: [`別名 ${String(index).padStart(5, '0')}`, `perf-alias-${String(index).padStart(5, '0')}`],
      tags: ['benchmark', `group-${String(index % 100).padStart(2, '0')}`],
      relations,
    }, null, 2);
    const bytes = encoder.encode(source);
    records.push({
      workspaceId: 'perf-workspace-v1',
      path: `bible/characters/${localId}/profile.yaml`,
      revision: sha256(bytes),
      bytes: arrayBuffer(bytes),
      contentType: 'application/yaml',
      updatedAt: '2026-10-21T00:00:00.000Z',
    });
  }

  if (options.nodes || options.layoutNodes || options.cards) {
    const boardText = JSON.stringify(deterministicBoard({
      nodeCount: options.layoutNodes,
      edgeCount: options.layoutNodes ? options.edges * options.layoutNodes / options.nodes : 0,
      cardCount: options.cards,
    }), null, 2);
    const bytes = encoder.encode(boardText);
    records.push({
      workspaceId: 'perf-workspace-v1',
      path: 'documents/performance.atlas.json',
      revision: sha256(bytes),
      bytes: arrayBuffer(bytes),
      contentType: 'application/json',
      updatedAt: '2026-10-21T00:00:00.000Z',
    });
  }

  const sourceRevision = await workspaceRevision(records);
  const archive = Buffer.from(await (await createBundle({
    workspaceId: 'perf-workspace-v1',
    name: `Atlas deterministic performance dataset ${options.nodes}/${options.edges}`,
    sourceRevision,
    files: records,
  })).arrayBuffer());
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, archive);
  const expandedBytes = records.reduce((total, file) => total + file.bytes.byteLength, 0);
  const report = {
    schemaVersion: 'atlas.performance-dataset/v1',
    seed,
    generatorHeadSha: process.env.ATLAS_GENERATOR_HEAD_SHA ?? null,
    nodes: options.nodes,
    edges: options.edges,
    layoutBoardNodes: options.layoutNodes,
    layoutBoardEdges: options.layoutNodes ? options.edges * options.layoutNodes / options.nodes : 0,
    canvasCards: options.cards,
    sourceFileCount: options.nodes,
    payloadFileCount: records.length,
    bundleEntryCountIncludingManifest: records.length + 1,
    payloadBytes: expandedBytes,
    archiveBytes: archive.byteLength,
    archiveSha256: sha256(archive),
    workspaceSourceRevision: sourceRevision,
    output: options.output,
  };
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`${JSON.stringify({ status: 'NOT_CHECKED', reason: message, exactCli: `${process.argv[0]} ${process.argv.slice(1).join(' ')}` }, null, 2)}\n`);
  process.exitCode = 2;
}
