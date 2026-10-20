# 事前に潰した設計争点と故障原因

**NORMATIVE decision log — 2026-10-20。** 本文は[Goal](../goals/ATLAS-V1.md)の派生Decision。新機能を後から要求する意図ではなく、無用な再発見・手戻り防止。

| Issue | 固定した対処 | してはいけないこと |
| --- | --- | --- |
| 同モノレポで相互密結合 | AtlasとStoryを独立Plugin/公開exportsにし、Host Brokerだけで結線 | Story→Atlas描画import、Atlas→Story private domain import |
| Scriptorium SDK未実装 | Standalone HostとFuture Adapterを分け、未実装HostはUNAVAILABLE | 新規APIをScriptoriumに実装済みと仮定 |
| Arcadia LoomのGraph資産 | ReactFlow+d3-forceの参考/既存MIT源を必要な範囲で利用し、純Graphを汎用化 | Arcadia UIをそのまま大規模コピー・不適合依存同梱 |
| 同一local IDの衝突 | providerId+localIdをidentityにする | 単一 `id: string` を全Providerで共用 |
| Snapshotの混合 | SourceRevision+ProviderRevision+Epochを常に照合 | 新旧のGraphを黙ってmerge |
| Provider Edge方向 | Source Field方向を保持しprovenance付与 | UI都合でStory関係を反転・dedupによる出典消失 |
| 元のduplicate entity | Diagnosticsと編集拒否を優先 | `Map.set` last-wins |
| Source fidelity | YAML AST/frontmatter本文を原文保持、対象Field変更のみ | `trim()`、コメント全消去、未知Field喪失 |
| Canvasの意味と位置 | Graph semantic SourceとManual Pin/Visual Edgeを分離 | drawn arrowを元Story意味関係へ自動書込み |
| 未保存データ | IndexedDB strict Journal/ReceiptをHost所有、Save/Commit/Publish区別 | 画面上の描画だけ、LocalStorage-only、見せかけGit sync |
| 旧Scriptorium安全境界 | plugin proposalは承認権限なし、Git内部/credential不可 | SDKを作った体でGit CLI/host Path直書き |
| Browser plugin crash | 可能な限り別originのisolated frameとBroker、Worker Crashに絞った保証 | 一緒のwindowで`try/catch`だけで完全隔離と称する |
| Opaque originとCanvas worker | 必要な場合のみ別origin `allow-same-origin` を独立Host制限下で受入 | Hostと同originの `allow-scripts allow-same-origin` |
| Unknown Schema | 読取り・原文ダウンロード・編集拒否 | 他Versionに無言でcast、破壊的上書き |
| ZIP / SVG / Asset | サイズ、Path、hash、scriptの検証を先に全件実施 | 検証前の直接workspace import・SVG script実行 |
| 大量Graph | Page/Index/LOD/Worker/Cache、Manual Pin保持 | 完全性を捨てて上限で黙って切る |
| レイアウト性能 | 変更時/明示操作時にだけWorkerで再計算、取消/epoch照合 | hover/zoom毎にO(n²) force |
| Timelineは曖昧な時間 | Explicit Axis、未明示dateはUnknown | scene順を暦へ推測変換 |
| Story削除の参照整合 | Incoming参照を列挙、Cascadeは明示transactionのみ | 該当Entityだけ消してdangling refsを作る |
| Goal 7時間に対し広い | Goalを凍結し、並列領域・縦slice・checkpoint・真実報告で進める | 時計で品質Gate/機能を削る、未実装をPASSとする |
| Generated assetsのrepo膨張 | 要約+Manifest/hash、rawは外部アーティファクト | 128個のgzipや巨大fixtureをGit追跡 |
| Library/Dependency採択 | Stable互換Versionとlicense/asset確認後exact pin | 未検証latest、再実装、単なる見た目で採択 |
| Program vs proof | UI・IndexedDB・Packの本物の実行で検証 | Unit MockだけでE2E/隔離認証を宣言 |

## 意図的に未完成として扱う外部接続

Scriptorium Plugin Platformは **ドキュメントとして承認済みで、SDK・Host Sandboxは未実装**。このGoalの技術選択はそれを尊重しつつ、無関係なCore性能Waveとコード共有しない。Standaloneの実作業とAdapter Shellは完了判定できるが、Production Scriptorium Plugin Install/Publishは独立Gate。

## 変更許容

実装手段を観測に基づいて代替することは許可。**User-facing outcomes、identity、data persistence、grant/faultの境界、F/Q受入条件**は変更しない。ライブラリの制限で本来の機能が成立しない場合は解決策の実物を作るか `DECISION_REQUIRED` を提出し、完了と偽らない。
