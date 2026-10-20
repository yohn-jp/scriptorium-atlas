# Atlas / Story Knowledge V1 — 必須機能 F01–F31

**Status: NORMATIVE**。全件必須。完了判定は[Q01–Q15](../quality/ACCEPTANCE-V1.md)。実装範囲は広くても、モックだけで完了させない。

| ID | 機能 | V1の必須操作・観測結果 | 検証 |
| --- | --- | --- | --- |
| F01 | 3 profiles | atlas/story/combinedそれぞれ別build、実起動。別Plugin/重量級依存の混入なし | Q01/Q14 |
| F02 | Workspace | 空から作成、開閉、名前変更、ファイル一覧、実import/export、再読込 | Q02/Q03 |
| F03 | 安全なImport | Manifest/Path/Schema/size/ZIP entry/version検証。不正入力時に既存Workspace維持 | Q03/Q10 |
| F04 | durable保存 | strict IndexedDB Journal、Commit/CAS、Reload・中断・容量不足の復旧。未保存を保存済と表示しない | Q04/Q05 |
| F05 | Provider | describe/open/page/getNodes/neighbors/close。metadata discovery、無効/不在/失敗の区別 | Q06/Q11 |
| F06 | 複数Provider | Provider ID+Local IDの完全identity、snapshot一致、duplicate拒否、unresolved保持 | Q06 |
| F07 | 増分更新 | 差分によるparse/index、changed/deleted、gap時full-resync、pin維持 | Q06/Q12 |
| F08 | Graph UI | pan/zoom/fit、select/multi、drag/pin/group、keyboard、minimap、Source Inspector | Q07/Q13 |
| F09 | Search/filter | name/id/alias/tag/type/path、日本語部分一致、neighbor focus、reveal/open | Q07/Q12 |
| F10 | Graph分析 | in/out/both、1–3 hops、unweighted shortest path、weak component group、説明可能な結果 | Q07/Q12 |
| F11 | Layout | force・layered(DAG/cycle)・timeline・manual。seed/pin/cancel/stale拒否 | Q07/Q11/Q12 |
| F12 | Manual Graph | node/edge CRUD、rename/duplicate、local/ref ID分離、Undo/Redo | Q07/Q04 |
| F13 | Source | path/revisionの閲覧/明示open、missing/stale/denied、不正遷移拒否 | Q07/Q08 |
| F14 | Views | 複数Board、viewport、filter、group、pin、saved location。再計算でmanual変更を破壊しない | Q04/Q07 |
| F15 | Freeform | Excalidrawのshape/arrow/handwrite/text/image/group/undo/redoを操作 | Q07/Q09 |
| F16 | Cards | text、画像、Markdown/source、provider-node cardを配置・編集・resize・link | Q07/Q09 |
| F17 | Graph↔Canvas | provider nodeをdrag/commandで参照card化、逆navigation、semantic edgeとの区別 | Q07/Q08 |
| F18 | I/O | `.atlas.json`、`.excalidraw`、asset付きbundle、PNG/SVG出力。lossless reload | Q03/Q09 |
| F19 | Structured views | Kanban boardのlane/reorder、Timelineのaxis/range/unknown、ordered storyboard | Q07/Q09 |
| F20 | Story-only UI | type別一覧、検索、詳細、関連、source、back navigation。Atlasなしで操作 | Q01/Q08 |
| F21 | Story編集 | character/location/faction/item/event/lore/thread/arc + volume/chapter/sceneのcreate/edit/delete、preview/CAS | Q04/Q08 |
| F22 | Semantic relations | 正しい方向/provenance、関係追加・編集・削除、incoming参照を持つ削除を保護 | Q08/Q10 |
| F23 | Story navigation | appearance、POV、location、planted/advanced/payoff、explicit timeline | Q08 |
| F24 | Diagnostics | duplicate ID、不正YAML、dangling、hierarchy、missing manuscript、time整合 | Q08/Q10 |
| F25 | Host boundary | public versioned schema、ACL/Grant、epoch、cancel、Timeout、未実装SDKへのfail-closed | Q06/Q10/Q11 |
| F26 | Independent packaging | public exportsのみ、package単独pack/consumer、Plugin manifest/version、private importなし | Q14 |
| F27 | UX/A11y | 日本語、IME、undo/redo、keyboard focus、dark/light、mobile最低390px、操作代替 | Q13 |
| F28 | Data safety | source/view分離、multi-file atomic transaction、原文未知field/コメント/no-op保持 | Q04/Q05/Q09 |
| F29 | Lightweight | lazy chunk、workerとqueue/cache上限、disable release、明記規模で性能達成 | Q12/Q14 |
| F30 | Failure handling | Provider hang/crash、不正RPC、frame reload、IDB拒否で他方機能とdraft保護 | Q05/Q10/Q11 |
| F31 | Delivery | 実行command、commit/head、F/Q証拠、測定環境、artifact provenance、実装PR | Q15 |

## GraphとCanvasでの操作契約

- 選択・検索・Filter・Navigationは別更新。空Graph、Loading、Partial、Error、0件を識別し、無限Spinnerを出さない。
- Layoutは**明示実行**。Pan/Resize/Hoverで毎回force計算しない。手動Pinの場所は自動再計算で上書きしない。大規模GraphはLOD/cluster利用可だが全データの検索・取得を維持し、件数上限で勝手に捨てない。
- Viewで動かすCard/Nodeは元データの意味変更ではない。Timelineの異なる時間axisは混ぜず、date不明はunknown lane。Story scene orderを書き換えるにはStory Commandが必要。
- Story UIは一覧→詳細→関係→scene/source→戻る。作成は空Workspaceから可能。Source未保存のフォームはProvider再読込で上書きしない。
- すべてのCanvas gestureにはkeyboard/list/Inspector代替、保存・Error・Conflictへの明確な操作導線を設ける。

**非対象:** Scriptorium Plugin SDK製造・本番導入、旧Story内部module削除、無制限任意プラグイン、CRDT、AI/NLP、新規独自Canvas描画エンジン、Arcadia Loom全機能互換。
