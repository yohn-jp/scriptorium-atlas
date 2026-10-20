# Atlas/Canvas Documents v1 — 永続保存契約

**Status:** NORMATIVE。実Schema: [v1.schema.json](v1.schema.json)。例: [board.json](examples/board.json)。旧形式はschemaを偽って読むのではなく明示Migration対象とする。

## 1. 保存ファイル

- `.atlas.json`: Atlas固有のBoard/Graph/Timeline/カード、手動Node/Edge、Group、Viewport、Layout/Pin/Filter/Layer、Graph Provider参照。Schema discriminator `atlas.board/v1`。
- `.excalidraw`: Excalidrawの標準Scene JSON（`type: "excalidraw", version: 2`）。公式ライブラリのserialize/restore/import/exportを使い、Elements/Files/AppStateのうち永続対象の互換性を維持。未対応version/Elementで黙って丸めない。
- Story: 既存 `bible/**/*.yaml`, `plot/**/*.yaml`, `manuscript/**/*.md` を正本とする。AtlasはStoryを所有しない。全Canvas DraftをStoryのYAMLへ混ぜない。
- `.atlas.json`の `assets` は相対的Content Addressed Pathか、検証済みの既存File Pathを参照。外部URLを暗黙fetchしない。Standalone ZIP bundleでは必要Asset bytesを同梱する。
- Multiple Boardは独立ファイル。Board間リンクは `workspaceId + relative path + boardId` で決定し、同名表示や現在のTab順はidentityとしない。

## 2. Board schema意味

`schema`・`boardId`・`name`・`revision`・`views[]`・`nodes[]`・`edges[]`・`cards[]`・`assets[]` を持つ。各itemはIDがUniqueで、`origin` は `manual|provider` のいずれか。Provider Nodeの `ref` は `NodeRef` とSource snapshotを明示する。Manual NodeはBoard内に保存し、Providerの元entityを上書きしない。

- `view.kind`: `graph | freeform | board | timeline | storyboard`。Graphはedge/Pin/Viewport/Filter、BoardはLane ID/順番、Timelineは明示Axis/temporal値のみ、StoryboardはCard IDのOrderを管理する。
- `position`: 有限number、absolute pixel-space。NaN/Infinity/巨大値を拒否。Zoomは0.05–8、rotation等のExcalidraw固有属性は標準Sceneへ保持。
- `pin`: `{ nodeKey, x, y, mode:"manual" }`。Provider更新で位置を変更しない。ラベル更新は参照が同一なら保持。
- `card`: `text | source | provider-node | image`。Source/Provider CardにはRef・表示キャッシュ・missing状態があり、元の本文とは独立。自動Provider再取得がCardの手動Annotationを上書きしない。
- `edge`: `semantic | visual` の別。Drawn arrow/Canvas connectorをsemantic関係に自動変換しない。Semantic Edgeの変更はStory Command→Change Intent。
- `sourceRevision`はデータ正本を参照して表示更新できるが、LayoutなどのBoard revisionは独立に更新。Snapshotが更新された場合はStaleを明示して再読込。

## 3. 更新・シリアライズ

- Serializerは**同じ入力なら同じUTF-8 bytes**（fixed key ordering、UTF-8、末尾LF、stable ID order）、No-op保存時は元Bytesを維持。canonical化のためにユーザーの位置/未知fieldを勝手に丸めない。
- Excalidraw標準Sceneの自由表現は公式Serializerを優先し、CustomData/unknownのroundtripが確認できない場合は自動変換せず原文を保持。参照Cardを埋め込む場合は `.atlas.json` のBindingを正本にし、Excalidraw形式へ不可逆に捨てない。
- Undo/Redoは操作単位。Source変更とCanvas変更を混ぜた単一不透明Undoは禁止。Graph/CanvasのActionはHostへ保存Intentを届け、Durable JournalがACKする前に「保存済み」と表示しない。
- Unknown future versionは原文読取り/ダウンロードのみ、編集不可。破損JSON/不明参照/不明Assetは診断し、上書き保存しない。Migrationは明示Backup/Preview/Version更新を伴う。

## 4. Bundle / Asset安全

- `atlas-workspace.zip` に `manifest.json`、含まれる全Document、参照Asset bytes。ManifestにはSchema、Workspace ID、相対Path、SHA-256、file bytes。選択時に全件Manifest確認・hash/重複Path/Case-insensitive衝突・ZipSlip・絶対Path・NUL・Symlink・Bombを拒否。
- V1のHost許容上限: Workspace総ファイル数100,000、1 source text ≤2MiB、1 image ≤10MiB、bundle展開後総量 ≤256MiB、ZIP entry ≤100,000、深さ32。超過時はErrorと既存Workspace保存。将来のStreaming巨大形式は別契約。
- 画像URL/外部CSS/scriptをAssetとして実行しない。SVGのImportはscript/eventHandler/foreignObject/external referencesを安全化してから表示し、疑わしいSVGはBlobとしてのみダウンロード可。
- Export/ImportはByte preservationを検証。Gitの全履歴、private repository、Token、利用者の元ファイルを勝手にBundle化しない。ユーザー操作で選んだWorkspaceだけ処理する。
- PNG/SVGは見えているCanvasと選択したexport regionを出力し、Graph Provider非同期未取得のNodeは明示Placeholder。export成功をRepositoryへSave/Pubished済と表現しない。

## 5. 検証すべきRound-trip

`new → edit → Journal durable → commit → reload → export → import → compare`。Manual Nodes/Edges、Provider NodeRefs、Pin、Layer、図形/手書き/画像、Board order、Timeline unknown lane、日本語、未知フィールドを対象。Crash/QuotaError/mismatched Revision/unknown Versionでも原稿を消さない。
