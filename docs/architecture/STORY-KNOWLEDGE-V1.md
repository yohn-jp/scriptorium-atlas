# Story Knowledge — Atlas非依存の物語管理Plugin

**Status:** NORMATIVE / implementation pending。Plugin/Provider ID `scriptorium.story-knowledge`。

## 1. 単独機能とルート

Atlasの有無に関係なく、人物・舞台・勢力・アイテム・出来事・伏線・アーク、volume/chapter/scene、sourceを一覧・検索・作成・編集・関連閲覧・保存・診断できる。UIは表・Form・Inspectors・Hierarchy・Timeline。Canvas/Excalidraw/React Flowは読み込まない。

SourceはYAML/Markdownを正本とし、独自Story正本DBへ移さない。Coreから今すぐ移植/削除するのではなく、既存公開MIT実装から独立製品に必要な部分だけ利用する。

## 2. 互換データ範囲

| Domain | 既存形式の検出 | 新規作成時の既定 |
| --- | --- | --- |
| character | `bible/characters/**/*.yaml`、profile・voice | `bible/characters/<id>/profile.yaml` |
| location | `bible/locations/**/*.yaml` | `bible/locations/<id>.yaml` |
| faction | `bible/factions/**/*.yaml` | `bible/factions/<id>.yaml` |
| item | `bible/items/**/*.yaml` | `bible/items/<id>.yaml` |
| event | `bible/timeline/events/**/*.yaml` | `bible/timeline/events/<id>.yaml` |
| lore | `bible/lore/**/*.yaml` | `bible/lore/<id>.yaml` |
| thread | `plot/threads/**/*.yaml` | `plot/threads/<id>.yaml` |
| arc | `plot/arcs/**/*.yaml` | `plot/arcs/<id>.yaml` |
| volume | `plot/volumes/*/volume.yaml` | 同一構造 |
| chapter | `plot/volumes/*/chapters/*/chapter.yaml` | 同一構造 |
| scene | `plot/volumes/*/chapters/*/scenes/*.yaml` | 同一構造 |
| manuscript | `manuscript/**/*.md` | Sceneに対応するMarkdown |

`dialogue_sketch` 等の未知型/未知フィールドは保持し、V1に専用UIがなくてもImport/Export時に消さない。既存IDやファイルPathは移動・renamingで勝手に書換えない。新規IDは衝突しないopaqueな固定識別子（`<type>-<uuid>`）とし、Display nameから再計算しない。

## 3. Parser・Source fidelity

- `yaml` のDocument/ASTを利用。Markdown frontmatter/bodyは原文保持、無関係な改行・空白/コメントをtrimせず、対象fieldだけ編集する。
- parse失敗、duplicate key、非標準tag、alias膨張、無効Unicode/path、type/path矛盾、duplicate entity IDはdiagnostic。**last-winsを禁止**、不完全Sourceからの書込みは限定。
- Type推論は明示 `type` と既知Pathの整合で決定。未知typeを黙ってcharacterにしない。Source Pathにはpath traversal・Symlink禁止。1file最大2MiB・nesting深度64・YAML alias数100までを初期上限（超えた場合は当該fileをError扱い、データ破棄しない）。
- `raw` と `description/body` はStory UIが必要な時に読む。Graph Providerへ原稿全文/未知private fieldsを直接配布しない。

## 4. 関係と出現

既存フィールド `appears, mentions, plants, advances, related, pov, affiliated, target, first_appears, planted, payoff`、`relations[]`、`entities.*`、`threads.plants/advances`、Sceneの `location/manuscript` を読む。

各関係の元Path/Field/RevisionをProvenanceに持つ。方向は原文の `from→to` に固定。Thread側 `planted/payoff` はThread→Scene、Sceneの `threads.plants` はScene→Thread。UIで両方向に見せてもSourceの向きを書換えない。

新規一般関係は元Entityの `relations` に `{id,target,kind,note?}` として保存。既存専用Fieldは元Fieldを優先。自動で両方へ二重書込みしない。既存IDなし関係は `[sourceId, sourceField, targetId, kind]` のcanonical hashからstable IDを得る。同一関係は一つのEdgeへまとめても出典を全件保持。関係のNote改訂でIDが不必要に変わらない。

出現/伏線: Scene appears/mentions/pov、Thread planted/advanced/payoff、人物ごとのappearance、Scene POV/location、Event/Scene順をread-onlyで抽出。未明示の時間・因果・心理関係を捏造しない。

## 5. 編集/安全

- Formはreadonly derived fieldと手入力fieldを分け、dirty draftを読み込み更新で潰さない。Previewはchanged paths/old revision/new content/関係影響を示し、Host-controlled Review→CAS commitを経由。
- multi-file Source更新は1 atomic ChangeSetで全read-setを照合。Authorの明示Commit前に意味的変更を確定しない。
- Deleteはincoming relation一覧を出す。参照が残る場合はdefault拒否。明示Cascadeは対応するSource Fieldだけを一括変更。不明/未対応参照はCascade不可と診断。
- volume/chapter/sceneを新規作成する時は参照の正本と階層が整合し、missing manuscriptを残さない。empty Workspaceでcharacter/location/volume/chapter/scene/threadの作成→保存→reloadを必ず検証。
- 真に同一の意味変更を不変Sourceへ再適用するときはNo-opとして原文bytesを維持する。

## 6. Graph Providerと独立UI

Graph node kindは `story.<type>`、providerは `scriptorium.story-knowledge`。Legacy Entity IDはLocal IDとして保持し、新規もStable ID。NodeにはSource path/revisionを付与し、参照先不在はunresolvedを返す。AtlasはGraph描画のconsumerであってStoryのOwnerではない。

Story-onlyでも内部ProviderのQueryをUIから利用する。Graph需要がない時はlayout/UI runtimeは存在しない。Storyの描画・Inspect・Library UIはAtlasの内部helperをimportしない。Exportは元YAML/MDと必要なStory設定。Providerが停止してもHostの保存済みSourceは維持され、再起動後に同Snapshotからindexを再構築する。

## 7. 出典と修復

公開Source: `yohn-jp/scriptorium/modules/story/src/snapshot.ts` と `domain/graph.ts`、`yohn-jp/arcadia-loom` のGraphCanvas。前者の旧実装の `Map.set()` によるID上書き、Markdownの `.trim()`、重複関係とprovenance不十分をそのまま移植しない。参照commit/license/変更点を `docs/implementation/PROVENANCE.md` に記録する。実ユーザーの原稿/Secretやprivate databaseをコピーしない。
