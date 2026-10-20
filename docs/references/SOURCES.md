# 設計の根拠・参照と検証された事実

- **S0:** [scriptorium-atlas main e774208](https://github.com/yohn-jp/scriptorium-atlas/tree/e774208f768057bd5754bb40a704b90846c85b03) は初期READMEのみ。これまでPlugin SDK/Canvas/Graph完成済みではない。
- **S1:** [Scriptorium Plugin Platform Architecture](https://github.com/yohn-jp/scriptorium/blob/eaa52ce09e2e5217e55e68b139a578a313a5ea0b/docs/architecture/PLUGIN-PLATFORM.md) — Core/Git/Recovery正本、公開SDKは将来設計、別origin iframeとOS Sandbox原則。
- **S2:** [Scriptorium Story parser](https://github.com/yohn-jp/scriptorium/blob/eaa52ce09e2e5217e55e68b139a578a313a5ea0b/modules/story/src/snapshot.ts) / [domain/graph](https://github.com/yohn-jp/scriptorium/blob/eaa52ce09e2e5217e55e68b139a578a313a5ea0b/modules/story/src/domain/graph.ts) — YAML/Markdownの既存パス・ドメイン・関係。実装はMIT [license](https://github.com/yohn-jp/scriptorium/blob/eaa52ce09e2e5217e55e68b139a578a313a5ea0b/LICENSE)、同等行為と誤りもあるため必要部分のみ再利用。
- **S3:** [Arcadia Loom GraphCanvas](https://github.com/yohn-jp/arcadia-loom/blob/main/app/src/components/graph/GraphCanvas.tsx) — 既にReact Flow + d3-forceを組み合わせたGraph、[Graph View](https://github.com/yohn-jp/arcadia-loom/blob/main/app/src/features/zukan/GraphView.tsx) は人物等の可視化。Arcadiaの旧コードをAtlas APIへ直接公開しない。
- **S4:** [Scriptorium Core性能監査](https://github.com/yohn-jp/scriptorium/blob/eaa52ce09e2e5217e55e68b139a578a313a5ea0b/docs/performance/BASELINE.md) — 実測はCore/Browserの前提であり、Atlasの性能保証値ではない。
- **S5:** [GraphCanvasの元モデル](https://github.com/yohn-jp/arcadia-loom/blob/main/packages/schema/src/graph.ts) — 旧 `{id,type,name}`/`{from,to,kind}` の3field構造では複数Provider、Snapshot、Source Provenance、手動Canvasが表現できないため、本設計ではV1拡張。
- **S6:** [Excalidraw](https://github.com/excalidraw/excalidraw)、[React Flow](https://reactflow.dev/)、[elkjs](https://github.com/kieler/elkjs)、[d3-force](https://github.com/d3/d3-force) — 描画/レイアウトの利用候補。Compatibility/API/Asset/Font/Licenseは実装時にExact Pinと実Browserビルドで確認。
- **S7:** [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) — BrowserのTransaction/Storage Limit/Quota. strict durabilityはブラウザに依存し、アプリはOS電源断の完全保証を宣言しない。
- **S8:** [iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#sandbox)、[postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage) — 別Origin＋Channel/Brokerの必要性。ブラウザ全体の完全分離ではない。

## Provenance条件

他Repoからコードを利用した場合、実装者は `docs/implementation/PROVENANCE.md` に `source repo/SHA/path/license/変更箇所` を必ず残す。Privateデータ、原稿、秘匿設定を取り込まない。元の構造的バグ（duplicate ID上書き、本文trim、関係の向き）をそのまま持ち込まない。

最終仕様は本RepoのGoal/Contractであり、外部Sourceを参照したことを理由にスコープを拡大しない。
