import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { zipSync } from 'fflate';

const seed = 'atlas-v1-perf-20261021';
const STORY_PROVIDER_ID = 'scriptorium.story-knowledge';

function optionsFrom(argv) {
  const result = { nodes: 1_000, edges: 2_000, cards: 0, layoutNodes: 0, sceneElements: 0, output: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const [key, inline] = argument.slice(2).split('=', 2);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    if (key === 'output') result.output = resolve(value);
    else if (key === 'report') result.report = resolve(value);
    else if (['nodes', 'edges', 'cards', 'layout-nodes', 'scene-elements'].includes(key)) {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0) throw new Error(`--${key} must be a non-negative integer.`);
      if (key === 'layout-nodes') result.layoutNodes = number;
      else if (key === 'scene-elements') result.sceneElements = number;
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

function stableJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite values cannot be serialized into a bundle manifest.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value;
    const keys = Object.keys(object).filter(key => object[key] !== undefined).sort(compareStrings);
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  throw new Error('Unsupported value in deterministic bundle manifest.');
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedInventory(records) {
  return [...records].sort((left, right) => compareStrings(left.path, right.path));
}

function workspaceRevision(records) {
  const inventory = sortedInventory(records).map(record => [record.path, record.revision]);
  return sha256(Buffer.from(stableJson(inventory), 'utf8'));
}

function createBundleArchive(records, workspaceId, name, sourceRevision) {
  const sortedRecords = sortedInventory(records);
  const manifest = {
    schema: 'atlas.bundle/v1',
    workspaceId,
    name,
    sourceRevision,
    files: sortedRecords.map(file => ({ path: file.path, sha256: file.revision, bytes: file.bytes.byteLength }))
  };
  const manifestBytes = Buffer.from(`${stableJson(manifest)}\n`, 'utf8');
  const entryCount = sortedRecords.length + 1;
  const expandedBytes = sortedRecords.reduce((total, file) => total + file.bytes.byteLength, manifestBytes.byteLength);
  if (entryCount > 100_000) throw new Error('Performance dataset exceeds the 100,000-entry bundle limit including manifest.json.');
  if (expandedBytes > 256 * 1024 * 1024) throw new Error('Performance dataset exceeds the 256 MiB expanded bundle limit including manifest.json.');

  const entries = Object.create(null);
  entries['manifest.json'] = [new Uint8Array(manifestBytes), { os: 3, attrs: 0o100644 << 16 }];
  for (const file of sortedRecords) {
    entries[`workspace/${file.path}`] = [new Uint8Array(file.bytes), { os: 3, attrs: 0o100644 << 16 }];
  }
  const archive = zipSync(entries, { level: 6, mtime: new Date('1980-01-01T00:00:00.000Z'), os: 3 });
  if (archive.byteLength > 512 * 1024 * 1024) throw new Error('Performance dataset exceeds the 512 MiB compressed archive limit.');
  return { archive: Buffer.from(archive), manifestBytes, entryCount, expandedBytes };
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

function deterministicExcalidrawScene(elementCount) {
  const elements = Array.from({ length: elementCount }, (_, index) => ({
    id: `perf-excalidraw-${String(index).padStart(4, '0')}`,
    type: 'rectangle',
    x: 280 + (index % 8) * 120,
    y: 150 + Math.floor(index / 8) * 96,
    width: 72,
    height: 48,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: '#ffffff',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `a${index.toString(36)}`,
    roundness: { type: 3 },
    seed: index + 100,
    version: 1,
    versionNonce: index + 1_000,
    isDeleted: false,
    boundElements: null,
    updated: 0,
    link: null,
    locked: false,
  }));
  return {
    type: 'excalidraw',
    version: 2,
    source: 'scriptorium-atlas-performance-fixture',
    elements,
    appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: '#ffffff' },
    files: {},
  };
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
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

  if (options.nodes || options.layoutNodes || options.cards || options.sceneElements) {
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

  if (options.sceneElements) {
    const sceneText = JSON.stringify(deterministicExcalidrawScene(options.sceneElements), null, 2);
    const bytes = encoder.encode(sceneText);
    records.push({
      workspaceId: 'perf-workspace-v1',
      path: 'documents/performance.excalidraw',
      revision: sha256(bytes),
      bytes: arrayBuffer(bytes),
      contentType: 'application/vnd.excalidraw+json',
      updatedAt: '2026-10-21T00:00:00.000Z',
    });
  }

  const workspaceId = 'perf-workspace-v1';
  const name = `Atlas deterministic performance dataset ${options.nodes}/${options.edges}`;
  const sourceRevision = workspaceRevision(records);
  const { archive, manifestBytes, entryCount, expandedBytes } = createBundleArchive(records, workspaceId, name, sourceRevision);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, archive);
  const report = {
    schemaVersion: 'atlas.performance-dataset/v1',
    seed,
    generatorHeadSha: process.env.ATLAS_GENERATOR_HEAD_SHA ?? null,
    nodes: options.nodes,
    edges: options.edges,
    layoutBoardNodes: options.layoutNodes,
    layoutBoardEdges: options.layoutNodes ? options.edges * options.layoutNodes / options.nodes : 0,
    canvasCards: options.cards,
    canvasExcalidrawObjects: options.sceneElements,
    sourceFileCount: options.nodes,
    payloadFileCount: records.length,
    bundleEntryCountIncludingManifest: entryCount,
    payloadBytes: expandedBytes - manifestBytes.byteLength,
    manifestBytes: manifestBytes.byteLength,
    manifestSha256: sha256(manifestBytes),
    expandedBytesIncludingManifest: expandedBytes,
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
