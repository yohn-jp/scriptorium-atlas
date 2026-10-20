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

The worker is created on the first operation and terminated by `close()`. Aborting an operation terminates the synchronous calculation worker, rejects its outstanding requests, and reloads the last accepted snapshot on the next request. Every reply is checked against its request ID and full snapshot identity. `applyGraphDelta` builds a replacement index atomically; a base gap throws `GraphError` with code `RESYNC_REQUIRED` so the caller can fetch a complete snapshot.

Search checks label/name, local ID, aliases, tags, kind/type, and source path with NFC-normalized substring matching. Results and graph traversals use stable provider/local ID ordering. Neighbor depth is limited to 1–3. Shortest path is breadth-first and unweighted; `maxHops` and `maxVisited` bound work. Weak components include unresolved edge endpoints and list them separately.
