# ATLAS-V1 — 不変Goal・完成条件

**Status: ACCEPTED GOAL / implementation pending.** 2026-10-20。製品・達成条件は本ファイルに固定する。

## Goal

`yohn-jp/scriptorium-atlas` に、**Atlas単体・Story Knowledge単体・両者併用**のいずれも、独立してbuild・起動・実操作・保存/復元できるGit-native Plugin製品のStandalone V1を実装する。

成果は設計資料や画面モックではなく、実際に使用できる製品・再現可能な証拠とする。Goalの達成を経過時間やコミット数で判定しない。途中停止しても作業を失わずに再開できること。開始時刻や7時間という想定は予定であり、**完成条件の緩和・虚偽報告の根拠にしない**。

## 実装前に凍結するAuthority

1. ユーザーの今回までの明示的製品合意: Atlasは汎用、Story Knowledgeは独立。monorepo内の別Plugin、3profile、将来別repoへ分離可。
2. 本Goal + [architecture](../architecture/ATLAS-V1.md)、[functions](../architecture/FEATURES-V1.md)、[Story](../architecture/STORY-KNOWLEDGE-V1.md)、[Provider](../contracts/GRAPH-PROVIDER-V1.md)、[Documents](../contracts/DOCUMENTS-V1.md)、[Host Port](../contracts/HOST-PORT-V1.md)、[Quality](../quality/ACCEPTANCE-V1.md)。
3. [設計解決台帳](../references/DESIGN-RESOLUTIONS.md)および参照ソース。
4. `scriptorium` の `PLUGIN-PLATFORM.md` は**方向とSecurity境界の上位制約**。その公開SDKは実装されていないため、未存在APIへ直接依存してはいけない。
5. 現行実コード・スキーマ・組織ガバナンス。既存ソースからの参照は必要箇所だけ読み、旧実装の誤動作まで移植する義務はない。

**仕様の解釈:** 機能の名前でなく[機能台帳 F01–F31](../architecture/FEATURES-V1.md)の実操作と[Q01–Q15](../quality/ACCEPTANCE-V1.md)で評価する。必須項目を「将来対応」に移動しない。矛盾/物理的不能が見つかったら `DECISION_REQUIRED` と具体的な選択肢を報告し、関連しない可実装タスクは継続する。

## 最初から確定するもの

- pnpm workspace / strict TypeScript / ESM / React + Vite。
- 共有するのはVersion付きSchemaとBroker/Host Portだけ。AtlasやStoryの内部実装には相互依存しない。
- Graph/DataはSnapshot・Provider・Stable IDでidentityを区切り、手動Canvas位置と元意味データを混ぜない。
- SourceはYAML/Markdown、Canvasは `.atlas.json` と `.excalidraw`、Derived Indexはいつでも破棄できる。
- 保存: StandaloneはIndexedDBによる復旧記録・CAS・明示Commit/Bundle export、Plugin単独のLocalStorageを唯一の原稿にしない。Scriptorium本番保存はCore Adapter境界でのみ処理する。
- Freeform: Excalidraw公式library採用。Graph: React Flow + d3-force + elkjs等の検証済みlibraryを再利用。重い処理はWorkerでオンデマンド。
- 一般化しすぎない。認可/外部Plugin OS Sandbox/Registryは本Goalの成果ではない。

## Phaseと作業境界

**G0 — Contract/Bootstrap:** package graphとSchemaを確定し、検証可能なScript/lockfileを作る。Schemaを二重に持たない。最小の3profile実buildを早期に通す。レビュー不能な大変更を先に積み上げない。

**G1 — Provider & Storage:** Graph Provider契約・Host Broker、Graph Engineとindex、Host-owned IndexedDB journal/CAS、再読込を、実操作の最小縦スライスで完了。選択・保存・reloadを端から端まで実証。

**G2 — Atlas:** Manual Graph → Graph ViewとLayout → Freeform Excalidraw → Source Card → Board/Timeline。各機能を保存・再読込・Undo/Redoと接続し、表示だけの機能を残さない。

**G3 — Story Knowledge:** parser/index/diagnostic → 独立UI → create/edit/delete/relations → Story-only保存 → Graph Provider。既存Scriptorium Story moduleの実装を必要な範囲で利用し、全Arcadia互換を目的化しない。

**G4 — Combination:** Provider discovery/lease、combined profile、Provider異常停止/欠落/復帰、source navigation、Atlas-only/Story-only依存Closureの実証。

**G5 — Quality & Packaging:** 全F×Q追跡、実ブラウザE2E、性能/メモリ/Worker/Fault、a11y、pack/consumer、再現ドキュメント。例示でなく完全な製品フローを検証。

Phaseは成果単位であり、厳密な時間割ではない。並列Workerは契約/所有を分離する。依存前のConsumer大量実装を禁止。各Phaseで動くvertical sliceを残し、分割してcommit/pushする。

## 並列所有と統合

- Worker Contracts/Storage: `packages/contracts`, `packages/persistence`, standalone HostのI/O契約。
- Worker Atlas UI: `packages/graph`, `packages/layout`, `packages/canvas`, `plugins/atlas`。
- Worker Story: `plugins/story-knowledge` のparser/domain/UI/provider。
- Coordinatorだけが `apps/standalone` の結線とrelease/最終報告を統合。共通公開Schemaの変更は契約Ownerだけが担い、消費側は明示Version/fixtureを参照。契約を勝手に拡張しない。

異なるworkerが同じbranch/worktreeに書かない。Issue/PRがある場合は実状態を調べ、既存担当・コミットを優先。統合の実装は許可された範囲のみ。未承認main merge、他repo変更、本番deployをしない。

## Non-goals（既に合意済み）

Scriptorium公開SDKの**実装そのもの**、他repoの旧Story module廃止、Scriptorium本番統合/Deployment、AI/NLP推論、リアルタイム複数ユーザーCRDT、無制限の巨大ファイル/画像、公開Marketplace、任意第三者JSの強隔離、Arcadia Loomの全機能をそのまま再現すること。

**Non-goalにしないもの:** Standaloneの本物のUI・保存・異常停止復旧、Story-only独立性、Atlas-only独立性、Combined実動作。

## 各Phaseのエビデンス

対応するF/Q、修正ファイル、Head SHA、実行commandと結果、Benchmark environment、残FAIL/NOT_CHECKEDを `docs/implementation/PROGRESS.md` に追加する。途中失敗は残すが古い結果を最終HEADのPASSに使わない。進捗更新はGoalそのものを変更しない。

**完了条件:** F01–F31の全要件が実装済みで、Q01–Q15の必須Gateを最終HEADでPASS。3 profileの実build、Standaloneの実操作、保存→reload、Story/Atlas切離し、故障注入、pack/consumerを確認し、実装PRを作成して差分と検証を報告する。未達は未達、障害は障害と報告する。PR発行はmerge許可ではない。

## /goal起動指示

```text
/goal
Repository: https://github.com/yohn-jp/scriptorium-atlas

このリポジトリの docs/goals/ATLAS-V1.md を不変Goalとして実行してください。
docs/architecture/ATLAS-V1.md、FEATURES-V1.md、STORY-KNOWLEDGE-V1.md、
docs/contracts/*、docs/quality/ACCEPTANCE-V1.md と AGENTS.md は実装の正本です。
実装・実際の保存/再読込・3つの独立Profile・結線・検証・commit/push・PRまで完遂。
Goalを縮小せず、契約や品質基準を緩めず、関連しない拡張へ逸脱しない。
他repo、本番、CI workflow、旧Scriptorium SDKを勝手に変更しない。
各有用段階でcommit/pushし、途中停止しても継続できるようにする。
テスト未実施・環境不足はPASS扱いせず、未完は未完と報告。
複数の独立実装Workerで進め、共通契約と結線は単一Ownerとする。
実装は隔離branch/worktree。mainへの無断直接commit/mergeは禁止。
完了/具体的ブロッカーに達したら最終HEADと実測/証拠を報告しSTOP。
```
