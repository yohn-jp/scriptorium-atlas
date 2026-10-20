# V1 Quality Gate — Q01–Q15

**NORMATIVE。すべてPASSが完了の必要条件。** 対応機能は[FEATURES-V1](../architecture/FEATURES-V1.md)。実証不能は `NOT_CHECKED`、実行失敗は `FAIL`。Goal時間切れで阈値・試験項目を変更しない。

## 共通の証明条件

最終HEAD SHA、環境(Node/Browser/OS)、exact CLI、exit/status、測定サンプル数、Artifact hashと入力Datasetを `docs/implementation/VERIFICATION.md` に残す。E2Eは本物のbuild、実IndexedDB、実Canvas/Plugin UI、実browserを操作。単体MockだけでUI/E2Eに代わらない。検証中にコードが変わった場合、影響するGateを最終HEADで再実施する。

| Gate | Acceptance |
| --- | --- |
| **Q01** | atlas/story/combined をそれぞれbuild/serve/操作、AtlasだけはStory無導入、StoryだけはAtlas/Excalidraw無導入 |
| **Q02** | 空Workspaceから新規作成→ファイル追加→編集→Reload→一覧/詳細復元。Demo fixtureを暗黙使用しない |
| **Q03** | 正常ZIP/JSON/Excalidraw import/export実roundtrip。ZipSlip/bomb/hash/unknownVersion/duplicate pathを拒否し既存Workspace維持 |
| **Q04** | Atlas Graph/Canvas、Story Entity/Relation、multi-file ChangeIntent、strict IDB durable ACK/Commit/Reload。保存されたbytes/ID/位置が完全保持 |
| **Q05** | 競合2 Tab、QuotaError、write transaction Abort、Worker/Frame kill、Reload中にpending Journal、COMMIT_UNKNOWNでデータ損失なし・真実の状態表示 |
| **Q06** | Provider Page/Cursor、duplicate IDs、Snapshot/epoch整合、partial/missing、2Provider同localId、delta gap/resync、lease終了を検証 |
| **Q07** | Graph/UI機能（F08–F14、F19）をclick/keyboard/dragで操作、値を保存・再読込。Undo/Redo、Path、Group、Pin、View layout |
| **Q08** | AtlasなしStory-only: 各domain create/edit/delete/search、関係/伏線/appearance、POV/Location、source/diagnosticを実操作。combinedでも同じ元revision |
| **Q09** | Excalidraw shape/handdraw/text/image/group/arrow、Card、PNG/SVG、atlas document/Excalidraw/Bundle各roundtrip。unknown未対応で破壊しない |
| **Q10** | malformed YAML/frontmatter、duplicate ID、dangling/source missing、cross-scope/path escape、未許可権限で安全拒否。正常な他entityを維持 |
| **Q11** | Provider hang/timeout/kill、Frame exception/reload、不正Message、stale epoch、Cancel無視を故障注入。他方UI/Host/Draftが継続 |
| **Q12** | 決定論的生成の1k/10k node + 2k/20k edge、Canvas100/500 objectsでIndex/query/layout/Frame入力・Heap・Worker終了を実計測、限界は明示 |
| **Q13** | 日本語IM E/Undo、keyboard only、フォーカス移動、dark/light、幅390pxとDesktopで操作。全意味操作にPointer不要の代替 |
| **Q14** | 3 profile bundle closure、lazy chunk、idle worker=0、独立`pnpm pack`と外部consumer動作、license・asset同梱を検証 |
| **Q15** | 同一最終HEADで全Gate再確認、依存lock/version固定、F01–F31とQ表を埋め、PR公開・ビルド方法・未達レポート |

## 必須性能予算（V1製品の初期品質基準）

試験機の目安: x86_64、16 logical CPU前後、32GiB以上、Chromium 155前後のHeadless、1440×1000。この条件と実測機との差を併記。以下は実装前の**目標値であり実測結果ではない**。特殊なCPUやWebKitだけで達成を装わない。

| Scenario | Target |
| --- | --- |
| Atlas 1kNode/2kEdge 初回可視、cache cold | p95 ≤ 3s（5計測、初回bundle download別途記録） |
| Graph 10kNode/20kEdge Index構築 | ≤ 10s、Workspace全件の可検索性維持 |
| 1kNode 検索（日本語部分一致・tag・type）、worker warmed | p95 ≤ 100ms、30回 |
| 10kNode 検索、worker warmed | p95 ≤ 250ms、30回 |
| 10kNode neighbors(1–3 hops) / shortest path（bounded result） | p95 ≤ 500ms、30回 |
| 1kNode Force layout Worker / cancellation | ≤ 2s / cancel ACK ≤ 500ms |
| 500 objects Freeformの通常Pan/Drag | browser Long Task 50ms超が継続しない、E2Eでframerate p50 ≥ 30fps |
| DisableしたPlugin | Worker=0、追加Network poll=0、heavy code import=0。cache非正本 |
| Commit/reload | 測定時のmanifest/revision一致、未保存データの欠落0件 |

System process RSSをChromeの合算RSS値から厳密なPlugin heap値として偽装しない。CPU sample/long task/heap/dedicated worker を分ける。Machine差やBrowser未対応があれば `NOT_CHECKED` として明示し、勝手にGoal PASSとしない。

## Failure matrix

- **Permanence:** browser forced reload/crash、storage denied/quota、2 Tab race、operation reuse、partial multi-file transaction。IDBに保存がACKされたものだけ耐久保証。未ACK Draftの喪失リスクは明示。
- **Provider:** bad checksum/unknown ID、multiple provider ID、invalid Node/Edge、stale Snapshot、deadline、cancel、Frame close。Graph/CanvasはManual dataを維持。
- **Story:** duplicate entity、circular relations、missing Scene/POV、unknown YAML tag/alias bomb、unknown fields、dangling、time不明。sourceを自動修復で壊さない。
- **Bundle:** traversal、absolute Path、case-fold collision、zip bomb、SVG script、duplicate asset key、巨大image。既存workspace unchanged。

## Deliverables and limits

成果は `docs/implementation/VERIFICATION.md`, `PROGRESS.md`, `PROVENANCE.md`, 3 profile実build, 検証Fixture/Script, 操作可能なStandalone, 完結した実装PR。実装のためにCI workflowを作る/手動起動する必要はない。Scriptorium本番Plugin SDK・実GitHub publishを測定する代わりに、Mockで「完了」と書くことは厳禁。
