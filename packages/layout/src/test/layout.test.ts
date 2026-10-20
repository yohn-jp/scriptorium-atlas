import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoardEdge, BoardNode, Pin, SnapshotRef } from '@scriptorium-atlas/contracts';
import { calculateLayout } from '../compute.js';
import { LayoutError, type LayoutInput, type LayoutResult } from '../types.js';
import { createLayoutWorkerClient } from '../worker/client.js';
import type { LayoutWorkerPort, LayoutWorkerRequest, LayoutWorkerResponse } from '../worker/protocol.js';

const snapshot: SnapshotRef = {
  workspaceId: 'workspace',
  sourceRevision: 'source-1',
  providerRevision: 'provider-1',
  epoch: 1,
};

function boardNode(id: string, x = 0, y = 0): BoardNode {
  return { id, origin: 'manual', kind: 'story.character', label: id, position: { x, y } };
}

function boardEdge(id: string, from: string, to: string): BoardEdge {
  return { id, from, to, meaning: 'semantic' };
}

function layoutInput(): LayoutInput {
  return {
    kind: 'manual',
    boardRevision: 1,
    snapshot,
    nodes: [boardNode('a'), boardNode('b', 100, 30)],
    edges: [boardEdge('ab', 'a', 'b')],
  };
}

test('manual layout keeps saved coordinates and explicit manual pins', async () => {
  const pins: readonly Pin[] = [{ nodeId: 'b', x: 512, y: -32, mode: 'manual' }];
  const result = await calculateLayout({ ...layoutInput(), pins });
  assert.deepEqual(result.positions, [
    { nodeId: 'a', position: { x: 0, y: 0 } },
    { nodeId: 'b', position: { x: 512, y: -32 } },
  ]);
  assert.deepEqual(result.unresolvedEdgeIds, []);
});

test('force layout is seeded, retains pins, and reports edges with missing endpoints', async () => {
  const base: LayoutInput = {
    kind: 'force',
    boardRevision: 1,
    snapshot,
    seed: 'layout-test',
    iterations: 80,
    pins: [{ nodeId: 'a', x: 41, y: 72, mode: 'manual' }],
    nodes: [boardNode('a'), boardNode('b', 100, 30)],
    edges: [boardEdge('ab', 'a', 'b'), boardEdge('missing', 'b', 'outside')],
  };
  const first = await calculateLayout(base);
  const second = await calculateLayout(base);
  assert.deepEqual(first.positions, second.positions);
  assert.deepEqual(first.positions[0], { nodeId: 'a', position: { x: 41, y: 72 } });
  assert.deepEqual(first.unresolvedEdgeIds, ['missing']);
});

test('layered layout returns finite positions for a directed cycle', async () => {
  const result = await calculateLayout({
    boardRevision: 1,
    snapshot,
    kind: 'layered',
    direction: 'RIGHT',
    nodes: [boardNode('a'), boardNode('b', 100, 30)],
    edges: [boardEdge('ab', 'a', 'b'), boardEdge('ba', 'b', 'a')],
  });
  assert.deepEqual(result.positions.map((item) => item.nodeId), ['a', 'b']);
  for (const item of result.positions) {
    assert.ok(Number.isFinite(item.position.x));
    assert.ok(Number.isFinite(item.position.y));
  }
});

test('timeline uses the saved numeric range and places null or missing entries in an unknown lane', async () => {
  const result = await calculateLayout({
    boardRevision: 1,
    snapshot,
    kind: 'timeline',
    axis: 'story.time',
    range: { start: 0, end: 100 },
    nodes: [boardNode('a'), boardNode('b', 100, 30)],
    edges: [boardEdge('ab', 'a', 'b')],
    entries: [
      { itemId: 'a', value: 25 },
      { itemId: 'b', value: null },
    ],
  });
  assert.deepEqual(result.positions.map((item) => [item.nodeId, item.lane]), [['a', 'main'], ['b', 'unknown']]);
  assert.equal(result.positions[0]?.position.x, 300);
  assert.equal(result.positions[1]?.position.y, 192);
  const unknownAxis = await calculateLayout({
    boardRevision: 1,
    snapshot,
    kind: 'timeline',
    axis: 'unknown',
    entries: [{ itemId: 'a', value: 25 }],
    nodes: [boardNode('a')],
    edges: [],
  });
  assert.equal(unknownAxis.positions[0]?.lane, 'unknown');
});

test('layout worker is lazy and cancellation terminates its active worker', async () => {
  const fake = new FakeLayoutWorker();
  let creations = 0;
  const client = createLayoutWorkerClient({ workerFactory: () => { creations += 1; return fake; } });
  assert.equal(creations, 0);

  const controller = new AbortController();
  const pending = client.calculate({ ...layoutInput(), kind: 'force' }, controller.signal);
  assert.equal(creations, 1);
  assert.equal(fake.requests.length, 1);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(fake.terminateCount, 1);
  client.close();
});

test('layout worker rejects a reply after the board revision changes', async () => {
  const fake = new FakeLayoutWorker();
  const client = createLayoutWorkerClient({ workerFactory: () => fake });
  const pending = client.calculate({ ...layoutInput(), kind: 'force' });
  const request = fake.requests[0]!;
  client.updateRevision({ boardRevision: 2, snapshot });
  await assert.rejects(pending, (error: unknown) => error instanceof LayoutError && error.code === 'STALE_RESULT');
  assert.equal(fake.terminateCount, 1);
  fake.respond({
    requestId: request.requestId,
    generation: request.generation,
    snapshotKey: request.snapshotKey,
    boardRevision: request.boardRevision,
    ok: true,
    result: resultFor(request.input),
  });
  client.close();
});

class FakeLayoutWorker implements LayoutWorkerPort {
  readonly requests: LayoutWorkerRequest[] = [];
  terminateCount = 0;
  private readonly messageListeners = new Set<(event: MessageEvent<LayoutWorkerResponse>) => void>();
  private readonly failureListeners = new Set<(event: Event) => void>();

  postMessage(message: LayoutWorkerRequest): void {
    this.requests.push(message);
  }

  addEventListener(type: 'message' | 'error' | 'messageerror', listener: ((event: MessageEvent<LayoutWorkerResponse>) => void) | ((event: Event) => void)): void {
    if (type === 'message') this.messageListeners.add(listener as (event: MessageEvent<LayoutWorkerResponse>) => void);
    else this.failureListeners.add(listener as (event: Event) => void);
  }

  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: ((event: MessageEvent<LayoutWorkerResponse>) => void) | ((event: Event) => void)): void {
    if (type === 'message') this.messageListeners.delete(listener as (event: MessageEvent<LayoutWorkerResponse>) => void);
    else this.failureListeners.delete(listener as (event: Event) => void);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  respond(data: LayoutWorkerResponse): void {
    const event = { data } as MessageEvent<LayoutWorkerResponse>;
    for (const listener of this.messageListeners) listener(event);
  }
}

function resultFor(input: LayoutInput): LayoutResult {
  return {
    kind: input.kind,
    boardRevision: input.boardRevision,
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    positions: input.nodes.map((node) => ({ nodeId: node.id, position: node.position })),
    unresolvedEdgeIds: [],
  };
}
