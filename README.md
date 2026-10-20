# Scriptorium Atlas

**汎用Graph/CanvasであるAtlasと、単独でも利用できるStory Knowledgeを、同一モノレポの独立プラグインとして開発する。**

**状態:** Standalone V1を実装・検証中。F01–F31／Q01–Q15の検証結果・再現方法は[検証台帳](docs/implementation/VERIFICATION.md)を参照。Scriptorium本番SDKへの統合は含まない。

## 起動

Node 24、pnpm 12.10.1を使用する。

```sh
pnpm install --frozen-lockfile
pnpm build:profiles
node apps/standalone/scripts/serve.mjs combined
```

`http://127.0.0.1:4173` を開く。`combined` を `atlas` または `story` に変えると独立profileを起動する。HostとPluginは4173–4175の別originを使う。別ポートでは `ATLAS_HOST_PORT=4200 node apps/standalone/scripts/serve.mjs combined` のように指定し、続く2ポートも空ける。

空のWorkspaceを作成し、Atlasのボード、Storyのライブラリ、またはHostの「Workspaceのファイル・Source」から編集する。変更案の耐久記録後は、Hostの「変更の確認・ローカルCommit」で内容を確認してCommitする。Pluginの準備済み表示とCommitは別の状態。ページ再読込後は「開く」からWorkspaceを選択する。保存先はこのブラウザのIndexedDBで、Bundle export/importで持ち出し・復元できる。

Import/Exportの上限100,000件・256MiBには、`manifest.json`の1件と実シリアライズ後bytesを含む（payloadは最大99,999件）。ZIP metadataと圧縮後bytesも別途検証する。超過は明示エラーとし、既存データを削除・切り詰めない。

## 契約の正本

1. [固定Goal・実装実行規約](docs/goals/ATLAS-V1.md)
2. [アーキテクチャ・パッケージ依存](docs/architecture/ATLAS-V1.md)
3. [必須機能 F01–F31](docs/architecture/FEATURES-V1.md)
4. [Story Knowledge](docs/architecture/STORY-KNOWLEDGE-V1.md)
5. [Graph Provider v1](docs/contracts/GRAPH-PROVIDER-V1.md)
6. [Canvas/Board/Story文書形式](docs/contracts/DOCUMENTS-V1.md)
7. [Host Port・保存/復旧](docs/contracts/HOST-PORT-V1.md)
8. [検証・品質ゲート](docs/quality/ACCEPTANCE-V1.md)
9. [設計上の既知問題と解決](docs/references/DESIGN-RESOLUTIONS.md)、[既存実装・仕様との対応](docs/references/SOURCES.md)
10. [機械可読な文書・Graph schema](docs/contracts/v1.schema.json)と[文書例](docs/contracts/examples/board.json)

これらがV1のCanonical Goal。変更履歴やエージェントセッション内の会話は仕様の正本ではない。

## 独立構成

| 構成 | 必ず動くもの |
| --- | --- |
| **Atlas-only** | 汎用Graph/Canvas、手動Graph、図面、Board/Timeline、保存・復元 |
| **Story-only** | 人物・舞台・勢力・伏線等の管理、検索、関係、保存・復元。Atlas/Excalidraw不使用 |
| **Combined** | 両者を独立起動し、StoryのGraph ProviderをAtlasで使い、片方の失敗から回復 |

Scriptorium公開Plugin SDKは今は設計状態なので、このGoalでは**Standalone実動作を完成**させる。Scriptorium本番組込みを完成と装わない。リポジトリの作成・統合・後日の分割でも、公開契約と保存形式は不変。

[短い /goal 起動指示](docs/goals/ATLAS-V1.md#goal起動指示)
