import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphNode, SnapshotRef } from '@scriptorium-atlas/contracts';
import { GraphWorkerClientError, createGraphWorkerClient } from '../worker/client.js';
import type { GraphWorkerRequest, GraphWorkerResponse, WorkerPort } from '../worker/protocol.js';

const snapshot: SnapshotRef = { workspaceId: 'workspace', sourceRevision: 'source-1', providerRevision: 'provider-1', epoch: 1 };
const node: GraphNode = { ref: { providerId: 'story.test', localId: 'a' }, kind: 'story.character', label: 'A' };

test('graph worker is created lazily and abort terminates calculation then reloads its accepted snapshot', async () => {
  const firstWorker = new FakeGraphWorker(false);
  const secondWorker = new FakeGraphWorker(true);
  const workers = [firstWorker, secondWorker];
  let created = 0;
  const client = createGraphWorkerClient({ workerFactory: () => workers[created++]! });
  assert.equal(created, 0);

  await client.replaceSnapshot(snapshot, [node], []);
  assert.equal(created, 1);
  const controller = new AbortController();
  const pending = client.search({ query: 'A' }, controller.signal);
  await waitFor(() => firstWorker.requests.some((request) => request.type === 'search'));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(firstWorker.terminateCount, 1);

  const result = await client.search({ query: 'A' });
  assert.deepEqual(result.items, []);
  assert.deepEqual(secondWorker.requests.map((request) => request.type), ['replace', 'search']);
  client.close();
});

test('graph worker rejects replies made stale by snapshot replacement', async () => {
  const worker = new FakeGraphWorker(false);
  const client = createGraphWorkerClient({ workerFactory: () => worker });
  await client.replaceSnapshot(snapshot, [node], []);

  const pending = client.search({ query: 'A' });
  await waitFor(() => worker.requests.some((request) => request.type === 'search'));
  const nextSnapshot = { ...snapshot, sourceRevision: 'source-2', providerRevision: 'provider-2' };
  const replacement = client.replaceSnapshot(nextSnapshot, [node], []);
  await assert.rejects(pending, (error: unknown) => error instanceof GraphWorkerClientError && error.code === 'STALE_RESULT');
  await replacement;

  const staleSearch = worker.requests.find((request) => request.type === 'search')!;
  worker.respond({
    id: staleSearch.id,
    snapshotKey: staleSearch.type === 'search' ? staleSearch.snapshotKey : null,
    ok: true,
    value: { items: [], totalMatches: 0, complete: true },
  });
  const currentSearch = client.search({ query: 'A' });
  await waitFor(() => worker.requests.filter((request) => request.type === 'search').length === 2);
  const latest = worker.requests.filter((request) => request.type === 'search')[1]!;
  worker.respond({ id: latest.id, snapshotKey: latest.type === 'search' ? latest.snapshotKey : null, ok: true, value: { items: [], totalMatches: 0, complete: true } });
  assert.deepEqual((await currentSearch).items, []);
  client.close();
});

class FakeGraphWorker implements WorkerPort {
  readonly requests: GraphWorkerRequest[] = [];
  terminateCount = 0;
  private readonly autoRespondQueries: boolean;
  private readonly messageListeners = new Set<(event: MessageEvent<GraphWorkerResponse>) => void>();
  private readonly failureListeners = new Set<(event: Event) => void>();

  constructor(autoRespondQueries: boolean) {
    this.autoRespondQueries = autoRespondQueries;
  }

  postMessage(message: GraphWorkerRequest): void {
    this.requests.push(message);
    if (message.type === 'replace') {
      queueMicrotask(() => this.respond({ id: message.id, snapshotKey: graphSnapshotKey(message.snapshot), ok: true }));
      return;
    }
    if (message.type === 'delta') {
      queueMicrotask(() => this.respond({ id: message.id, snapshotKey: graphSnapshotKey(message.delta.snapshot), ok: true }));
      return;
    }
    if (!this.autoRespondQueries) return;
    const value = message.type === 'search' ? { items: [], totalMatches: 0, complete: true } : [];
    queueMicrotask(() => this.respond({ id: message.id, snapshotKey: message.snapshotKey, ok: true, value }));
  }

  addEventListener(type: 'message' | 'error' | 'messageerror', listener: ((event: MessageEvent<GraphWorkerResponse>) => void) | ((event: Event) => void)): void {
    if (type === 'message') this.messageListeners.add(listener as (event: MessageEvent<GraphWorkerResponse>) => void);
    else this.failureListeners.add(listener as (event: Event) => void);
  }

  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: ((event: MessageEvent<GraphWorkerResponse>) => void) | ((event: Event) => void)): void {
    if (type === 'message') this.messageListeners.delete(listener as (event: MessageEvent<GraphWorkerResponse>) => void);
    else this.failureListeners.delete(listener as (event: Event) => void);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  respond(data: GraphWorkerResponse): void {
    const event = { data } as MessageEvent<GraphWorkerResponse>;
    for (const listener of this.messageListeners) listener(event);
  }
}

function graphSnapshotKey(value: SnapshotRef): string {
  return JSON.stringify([value.workspaceId, value.sourceRevision, value.providerRevision, value.epoch]);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for fake Worker request');
}
