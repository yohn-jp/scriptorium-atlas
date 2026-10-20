# Standalone Host Port v1 — 本物の保存・回復・Plugin連結

**Status:** NORMATIVE。公開Scriptorium Plugin SDKとは**別**のBridge Port。宿主のFile/Revision/Recovery/CAS責務をPluginから切り離す。

## 1. Capability境界

```ts
interface WorkspaceHandle {
  workspaceId: string;
  sourceRevision: string;
  epoch: number;
}
interface HostPort {
  snapshot(workspace: WorkspaceHandle, query?: WorkspaceSnapshotQuery): Promise<WorkspaceSnapshotPage>;
  list(workspace: WorkspaceHandle, query?: FileListQuery): Promise<FilePage>;
  read(workspace: WorkspaceHandle, req: FileReadQuery): Promise<VersionedFile | VersionedFileChunk>;
  prepare(workspace: WorkspaceHandle, change: ChangeIntent): Promise<PreparedChange>;
  beginAsset(workspace: WorkspaceHandle, asset: AssetUploadStart): Promise<AssetUploadReceipt>;
  appendAsset(workspace: WorkspaceHandle, chunk: AssetChunk): Promise<AssetChunkReceipt>;
  prepareAsset(workspace: WorkspaceHandle, uploadId: string, change: ChangeIntent): Promise<PreparedChange>;
  commit(workspace: WorkspaceHandle, preparedId: string, authorApproval: boolean): Promise<CommitReceipt>;
  recover(workspaceId: string): Promise<RecoverySummary>;
  export(workspaceId: string): Promise<Blob>; // explicit author operation only
  describeProviders(workspaceId: string): Promise<ProviderDescriptor[]>;
  acquireProvider(workspaceId: string, providerId: string, sourceRevision: string): Promise<ProviderLease>;
}
```

型はwire例示、規範のSchemaは `v1.schema.json` とGraph Provider文書に従って作成。操作にAuthor Approvalを渡すのはHost UIのみ、Pluginが自由なtrueを送って認可を獲得できない。Source Path / Workspace ID / RevisionはHostがSessionに束縛し、Pluginの任意指定をAuthor認可に使わない。

Plugin frame RPCは`atlas.host/v1`のrequest/response/event envelopeをMessagePortで交換する。Pluginに公開する`PluginHostClient`はsnapshot page・list・read・prepare・source request・Provider lease/query・Workspace changed通知だけを持つ。Commit、Recovery、Workspace ExportはHost側UI/APIに限定する。Snapshot pageは各RPCの8 MiB上限内で送り、2 MiB以下のtext fileは内容込みで返す。10 MiB以下のAsset・large binary・page budgetを超えるfileは`SnapshotFileMetadata`（workspace/path/revision/content type/update time/byte length/encoding）のみを返し、Pluginは期待revisionを指定してbounded `read` chunksを追加取得する。MetadataとcontentのUnionは`WorkspaceSnapshotFile`で表し、content fieldの有無で判別する。`read`はdecoded bytesを最大4 MiBずつ返し、大きなfileへの初回readは0 offsetのchunkから始める。chunkはBase64 wire encodingを使い、各RPCのJSON envelopeを含むserialized sizeを8 MiB未満に保つ。

## 2. Standaloneの持続化仕様

- IndexedDB Database `scriptorium-atlas-v1` にWorkspaces/Files/Journal/Receiptsの4 Logical Store。Schema VersionでMigrationを明示。Private Storage利用不能なら編集をREAD_ONLY+Export可能へ落とし、無言でvolatile-onlyにしない。
- File Entry = `{workspaceId,path,revision,bytes,contentType,updatedAt}`。Revisionはcontent SHA-256。Workspace全体のSource Revisionは各PathとRevisionのソート済みリストdigestとし、同一bytesなら決定論的。
- ChangeIntent = `{operationId,workspaceId,baseWorkspaceRevision,reads:[{path,revision|null}],writes:[{path,content|null,encoding}],message,kind}`。1 transaction当たりWrite File ≤256、Bytes ≤8MiB（大きい添付のChunk Asset保存はSeparate contract）、Path検証必須、重複Write/No-Op/ABAに対する競合の明示。複数ファイルを1 TxnでAtomic Commit。Hostは**read-setとFile Bytesに基づきRevision照合**し、書込みの後にReceiptを同じstrict transactionで永続化。
- `prepare` はPreview/Revision/Quota/Grantを検証し、ChangeIntentとReceipt情報をstrict Journal transactionへ保存してから`PreparedChange.durableAck`を返し、Author Reviewへ表示する。これは耐久Draft ACKでありCommit済みではない。Hostが`commit`を受理するまではWorkspace Currentを変えない。操作ID再利用は完全Digest一致の場合のみ冪等ACK、異なるPayloadなら`OPERATION_ID_REUSED`。
- 画像など最大10 MiBの単一Assetは、`beginAsset`でWorkspace ID/Base Revision/Path/SHA-256/byte count/content typeをHostへ登録し、`appendAsset`で最大1 MiBのBase64 chunkを連続offset順に送る。各chunkのdurable ACKを返し、同じoffsetとbytesの再送だけを冪等として扱う。SHAが一致した全bytesを`prepareAsset`が通常のPreview/Revision/Grant検証へ渡し、`ChangeIntent`とAssetを一つのAuthor Review/Atomic Commitに束ねる。通常の`ChangeIntent`は従来どおり合計8 MiB以下。Upload metadata/chunksは既存Journalの中に保持し、追加の公開Storeを作らない。Hostのexpiry/abort/commit outcomeが確定するまではUploadを削除しない。
- Browser DraftはHost所有Journalへ**strict transaction完了後にdurable ACK**。300–500msの操作Debounce可だが、Pagehideが同期耐久性を保証すると主張しない。未ACK UIは「未保存」、失敗はError+retry/export導線。タブ切換/Reload時は未確定Journalから再構成。
- 異なる2 Tab/iframeからの書込みはWorkspace GenerationとVersionのCASで管理。競合は`CONFLICT`として双方のDraftを保持。最新値で黙って上書きしない。
- Interrupted Commit/Exception/QuotaError/Browser Closeの後はJournal/ReceiptとFile Inventoryを照合。Receipt不明は`COMMIT_UNKNOWN`とし、操作ID/Hashで問い合わせてからretry。未承認ProposalをConfirmed Fileと表示しない。
- Index/cache/Graph PreviewはDisposable。Source/Board/Draft/ReceiptsとStorage Keyspaceを別にして、Cache削除で意味データを消さない。

## 3. Scriptorium接続（将来）

- `packages/scriptorium-adapter` は `SCRIPTORIUM_HOST_UNAVAILABLE` を返せるAdapter Shellを持つ。**公開Plugin SDKが実際に存在する時だけ**、SnapshotReader/DocumentSource→Versioned File、ChangeProposal→Host review、Journal/Receipt→Scriptorium Coreの認証済み経路に接続する。
- Coreの `MutationCoordinator.approve/checkpoint/publish` はPluginへExposeしない。Git Credential/Git cli/Repository PathのDirect access禁止。Provider上の変更はGraph Creator/CanvasからSourceをDirect writeしない。
- Version不整合時はAdapter起動を拒否。Core private packageをnpm dependencyに追加しない。
- Standalone Commit成功はローカル確定を意味し、GitHubへPublishされたことを意味しない。UIで区別する。

## 4. Error/Fault予算

`UNAVAILABLE, INVALID_INPUT, PERMISSION_DENIED, REVISION_CONFLICT, STORAGE_UNAVAILABLE, QUOTA_EXCEEDED, COMMIT_UNKNOWN, OPERATION_ID_REUSED, TIMEOUT, CANCELED, INVALID_PATH, UNSUPPORTED_VERSION, SCRIPTORIUM_HOST_UNAVAILABLE` を機械エラーとする。

Server/WASM本番Sandboxは本Goalに含めない。StandaloneでもPlugin UI/Workerのクラッシュ、悪性postMessage/キャンセル無視、Sourceの欠落、IDBを閉じる/QuotaErrorを実際に起こし、Host/他Pluginの編集継続を実証。OS全体OOMやBrowser renderer同居でHostが絶対に落ちないとは言わない。

## 5. 検証する性質

- same operationId/same bytesはidempotent、same ID/different bytesはreject。
- readRevision違い、deleted/added file競合、二つのtabの同時Commitは他者のファイルを破壊しない。
- ファイル本体とReceiptがAtomicに可視化される。
- 保存中にframe/Workerが終わっても既にHostがACKしたDraftはReload後に回復。
- 過大/非許可Path/権限外Workspaceは拒否。Graph ProviderがGit/File Permissionを勝手に増やせない。
