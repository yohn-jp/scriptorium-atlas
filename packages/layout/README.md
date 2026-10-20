# `@scriptorium-atlas/layout`

Explicit layout calculations for Atlas Board nodes. The package root exports computational types only. Browser consumers create the dedicated Worker client from `@scriptorium-atlas/layout/worker`; importing the package does not create a Worker.

```ts
import { createLayoutWorkerClient } from '@scriptorium-atlas/layout/worker';

const layout = createLayoutWorkerClient();
const result = await layout.calculate({
  kind: 'force',
  boardRevision: board.revision,
  snapshot,
  nodes: board.nodes,
  edges: board.edges,
  pins: view.pins,
  seed: 41,
});
// Apply result.positions only while result.boardRevision and SnapshotRef are still current.
layout.close();
```

The client starts its module Worker on demand and terminates it on cancellation, Board/SnapshotRef change, failure, timeout, or close. It uses one calculation at a time; a newer explicit calculation invalidates and terminates the older Worker. Replies must match both generation and the Board revision plus SnapshotRef. Call `updateRevision({ boardRevision, snapshot })` when the current Board changes. Aborting rejects with `AbortError` after terminating the active Worker, so the expensive force or ELK work stops instead of merely hiding its reply. Calculations have a validated 30-second default deadline (`timeoutMs` can be set from 1 ms through 5 minutes); an expired calculation rejects with `LayoutError` code `TIMEOUT` and the Worker is terminated.

`boardRevision` is the canonical numeric `BoardDocument.revision`. `force` uses seeded `d3-force`, `layered` uses ELK's layered algorithm and its cycle handling, `timeline` consumes the selected View's canonical `axis`, `range`, and `entries`, and `manual` returns saved positions. Timeline entries use canonical `itemId` and numeric `value`; null or missing values, and all entries on the `unknown` axis, appear in a separate lane. A saved range supplies the horizontal scale and remains unchanged. Every mode preserves explicit manual pins. Edges with absent Board endpoints are reported in `unresolvedEdgeIds` and are omitted from calculation without adding synthetic nodes.

Pinned versions were checked against the npm registry on 2026-10-20: `d3-force@3.0.0` (ISC), `elkjs@0.12.0` (EPL-2.0 OR GPL-3.0-or-later), and `@types/d3-force@3.0.10` (MIT). Their direct dependency notices ship in `THIRD_PARTY_NOTICES.md` and `licenses/`.
