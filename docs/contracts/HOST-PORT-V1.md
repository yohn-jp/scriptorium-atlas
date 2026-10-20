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
  list(workspace: WorkspaceHandle, query: { prefix?: string; cursor?: string; limit?: number }): Promise<FilePage>;
  read(workspace: WorkspaceHandle, req: { path: string; expectedRevision?: string; maxBytes?: number }): Promise<VersionedFile>;
  prepare(workspace: WorkspaceHandle, change: ChangeIntent): Promise<PreparedChange>;
  commit(workspace: WorkspaceHandle, preparedId: string, authorApproval: boolean): Promise<CommitReceipt>;
  recover(workspaceId: string): Promise<RecoverySummary>;
  export(workspaceId: string): Promise<Blob>; // explicit author operation only
  describeProviders(workspaceId: string): Promise<ProviderDescriptor[]>;
  acquireProvider(workspaceId: string, providerId: string, sourceRevision: string): Promise<ProviderHandle>;
}
```

型はwire例示、規範のSchemaは `v1.schema.json` とGraph Provider文書に従って作成。操作にAuthor Approvalを渡すのはHost UIのみ、Pluginが自由なtrueを送って認可を獲得できない。Source Path / Workspace ID / RevisionはHostがSessionに束縛し、Pluginの任意指定をAuthor認可に使わない。

## 2. Standaloneの持続化仕様

- IndexedDB Database `scriptorium-atlas-v1` にWorkspaces/Files/Journal/Receiptsの4 Logical Store。Schema VersionでMigrationを明示。Private Storage利用不能なら編集をREAD_ONLY+Export可能へ落とし、無言でvolatile-onlyにしない。
- File Entry = `{workspaceId,path,revision,bytes,contentType,updatedAt}`。Revisionはcontent SHA-256。Workspace全体のSource Revisionは各PathとRevisionのソート済みリストdigestとし、同一bytesなら決定論的。
- ChangeIntent = `{operationId,workspaceId,baseWorkspaceRevision,reads:[{path,revision|null}],writes:[{path,content|null,encoding}],message,kind}`。1 transaction当たりWrite File ≤256、Bytes ≤8MiB（大きい添付のChunk Asset保存はSeparate contract）、Path検証必須、重複Write/No-Op/ABAに対する競合の明示。複数ファイルを1 TxnでAtomic Commit。Hostは**read-setとFile Bytesに基づきRevision照合**し、書込みの後にReceiptを同じstrict transactionで永続化。
- `prepare` はPreview/Revision/Quota/Grantを検証し、Author Reviewへ表示。Hostが`commit`を受理するまではWorkspace Currentを変えない。操作ID再利用は完全Digest一致の場合のみ冪等ACK、異なるPayloadなら`OPERATION_ID_REUSED`。
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

`UNAVAILABLE, INVALID_INPUT, PERMISSION_DENIED, REVISION_CONFLICT, STORAGE_UNAVAILABLE, QUOTA_EXCEEDED, COMMIT_UNKNOWN, OPERATION_ID_REUSED, TIMEOUT, CANCELED, INVALID_PATH, UNSUPPORTED_VERSION` を機械エラーとする。

Server/WASM本番Sandboxは本Goalに含めない。StandaloneでもPlugin UI/Workerのクラッシュ、悪性postMessage/キャンセル無視、Sourceの欠落、IDBを閉じる/QuotaErrorを実際に起こし、Host/他Pluginの編集継続を実証。OS全体OOMやBrowser renderer同居でHostが絶対に落ちないとは言わない。

## 5. 検証する性質

- same operationId/same bytesはidempotent、same ID/different bytesはreject。
- readRevision違い、deleted/added file競合、二つのtabの同時Commitは他者のファイルを破壊しない。
- ファイル本体とReceiptがAtomicに可視化される。
- 保存中にframe/Workerが終わっても既にHostがACKしたDraftはReload後に回復。
- 過大/非許可Path/権限外Workspaceは拒否。Graph ProviderがGit/File Permissionを勝手に増やせない。
