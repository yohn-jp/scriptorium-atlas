# `@scriptorium-atlas/graph`

Snapshot-bound, domain-neutral graph indexing and analysis. Graph values use the generated contract types from `@scriptorium-atlas/contracts`.

`nodeKey(ref)` encodes identity as `JSON.stringify([providerId, localId])`. Page ingestion and delta application reject duplicate identities and mixed snapshots. An endpoint without a corresponding node remains an unresolved reference; the index never invents a node for it.

```ts
import { beginGraphSnapshot } from '@scriptorium-atlas/graph';
import { createGraphWorkerClient } from '@scriptorium-atlas/graph/worker';

const builder = beginGraphSnapshot(snapshot);
for (const page of nodePages) builder.addNodesPage(page);
for (const page of edgePages) builder.addEdgesPage(page);
const index = builder.build();

const worker = createGraphWorkerClient();
await worker.replaceSnapshot(index.snapshot, index.nodes, index.edges);
const results = await worker.search({ query: '青い鳥' }, abortController.signal);
const nearby = await worker.neighbors({ from, direction: 'both', depth: 2 });
const path = await worker.shortestPath({ from, to, direction: 'out', maxHops: 8 });
const components = await worker.weakComponents();
worker.close();
```

The worker is created on the first operation and terminated by `close()`. The client posts at most four requests at once and accepts at most 64 additional queued requests; snapshot and delta transitions are limited to 64 pending operations, and query admission is bounded to the same total request budget. `maxInFlight` and `maxQueued` can lower these limits, but cannot raise them. A 30-second default Worker request deadline (`timeoutMs`, validated from 1 ms through 5 minutes) covers local request-queue wait and Worker execution. Overflow rejects with `GraphWorkerClientError` code `QUEUE_FULL`; an expired queued request rejects with `TIMEOUT`. A Worker request timeout terminates the Worker and rejects other outstanding requests as failed. Aborting an active operation also terminates the synchronous calculation worker, while aborting a queued request removes only that request. The accepted snapshot stays cached after timeout or cancellation and reloads on the next request. Every reply is checked against its request ID and full snapshot identity. `applyGraphDelta` builds a replacement index atomically; a base gap throws `GraphError` with code `RESYNC_REQUIRED` so the caller can fetch a complete snapshot.

Search checks label/name, local ID, aliases, tags, kind/type, and source path with NFC-normalized substring matching. Results and graph traversals use stable provider/local ID ordering. Neighbor depth is limited to 1–3. Shortest path is breadth-first and unweighted; `maxHops` and `maxVisited` bound work. Weak components include unresolved edge endpoints and list them separately.
