# Graph Provider v1 — 公開Consumer/Producer契約

**Status:** NORMATIVE。Protocol `atlas.graph/v1`。この契約はAtlas固有描画を一切含まない。Story-onlyはProviderを提供し、Atlas-onlyではmanual/file Providerを使う。

## IDとSnapshot

- `ProviderId`: `[a-z0-9]+([.-][a-z0-9]+)*`、最大128文字。例 `scriptorium.story-knowledge`。重複Provider IDはHostが拒否。
- `NodeId`: `(providerId, localId)` の**2要素**がidentity。表示名/Path/Node kindはidentityに使わない。Local IDはUTF-8 1–256文字、NUL/control禁止、同一Provider内で不変。複合キーは `JSON.stringify([providerId,localId])` 相当の可逆エンコードで実装し、単純な `:` 区切り連結は禁止。
- `EdgeId`: `(providerId, localEdgeId)`。Edgeは `from`/`to` それぞれ完全 `NodeRef` を持つ。cross-provider EdgeはProviderが明示的に申告し、両ProviderのGrant/ScopeをHostが検証する。
- `SnapshotRef`: `{workspaceId,sourceRevision,providerRevision,epoch}`。SourceRevisionはHost固定のWorkspaceの内容Revision（又は既知のScriptorium Snapshot digest）、ProviderRevisionはそのSourceを使った派生Index版。Epochは失敗再起動/Provider交換で変化する。異なるSourceRevisionのNode集合を**単一の確定Graphとして混ぜない**。
- GraphNode `kind` は `namespace.type` の識別子。例えば `story.character`。任意のConsumerは未認識kindに汎用表示を使う。Raw Source本文はGraphPayloadに入れず、SourceRefでHost越しに読む。

## 論理Schema

```ts
type NodeRef = { providerId: string; localId: string };
type SourceRef = { workspaceId: string; path: string; revision: string };
type GraphNode = {
  ref: NodeRef; kind: string; label: string;
  aliases?: string[]; tags?: string[];
  source?: SourceRef; status?: "available" | "stale" | "unresolved";
  meta?: Record<string, string | number | boolean | null>;
};
type GraphEdge = {
  ref: NodeRef; from: NodeRef; to: NodeRef; kind: string;
  directed: boolean; source?: SourceRef;
  provenance?: Array<{ path: string; revision: string; field: string }>;
};
type SnapshotRef = { workspaceId: string; sourceRevision: string; providerRevision: string; epoch: number };
type ProviderPage<T> = { snapshot: SnapshotRef; items: T[]; nextCursor: string | null; complete: boolean };
```

TypeScriptは説明用。実装上のJSON Schemaは `v1.schema.json` を正本とし、手書き型と異なる実装を禁止。Node/Edgeの未知keyは明示Versionで許可したもの以外をHostが拒否。拡張メタデータのサイズはHostが制限する。

## Provider API（MessagePort / Transport neutral）

- `describe(): ProviderDescriptor` — code実行なしのManifest metadata。ID・schemaVersion・feature flags・必要Read Capabilities。
- `open({workspaceId,requestedSnapshot,grants,deadline}): {handle,actualSnapshot,capabilities}` — Hostが認可済みPrincipal/Scopeを束縛。requestedSnapshotが存在せず不一致なら拒否。
- `listNodes({handle,cursor,limit,filter,signal}): ProviderPage<GraphNode>`
- `listEdges({handle,cursor,limit,filter,signal}): ProviderPage<GraphEdge>`
- `getNodes({handle,refs,signal}): ProviderPage<GraphNode>` — NodeRefはそのProviderに属するもののみ。
- `neighbors({handle,from,direction,depth,limit,cursor,signal}): ProviderPage<{node,edges}>` — depth 1–3、方向 `in|out|both`。
- `diff({handle,previousSnapshot,cursor,limit}): ProviderPage<GraphDelta>` — changed/removed node/edge、from/to revisions。差分不能は `RESYNC_REQUIRED` で全件再列挙。
- `close({handle}): void` — 冪等にlease解放、以後の古いResponseは破棄。

Plugin frameはHostの`providerCall(leaseId, request)`にlease-bound queryを渡し、Plugin用request paramsに`handle`を含めない。Hostは接続元Pluginと`leaseId`を検証し、query毎にHostが認可したhandleをProvider向け`params.handle`と外側envelopeへ注入する。Provider向けopen requestだけ外側handleを持たず、open responseで発行されたhandleを以後のleaseへ結び付ける。Pluginが別handleを指定して認可範囲を変更することはできない。Pending openを中断するcancelはhandleなしでよいが、Hostは同じPlugin session/provider/epochのpending request IDへの取消しだけを許可する。
- Event `updated({snapshot,revision,epoch,changedPaths})` はヒント。欠落Eventだけで誤ったキャッシュ整合と見なさずdiff/resync。

Cursorは `handle + snapshot + filter + result order` へ束縛された不透明値、別filterへ再利用は禁止。Page limitは1–500、既定100。結果はNodeRef/EdgeRefのcanonical順で安定し、初期Pageは前snapshotと勝手に混ぜない。全件数が不明なら`total`を捏造しない。**`nextCursor=null` がページ列挙の終端、`complete` は元ソース・参照の完全性**を意味する。`{nextCursor:null,complete:false}` は「健全な結果をすべて列挙したが、不正/欠落したSourceのためGraphは部分的」という有効な最終ページである。Consumerはそのデータを警告付きで表示し、全体完全性を要する差分・削除判定を信用せず全件再同期または操作制限を選ぶ。Providerごとのstateがbrokenでも他Providerは継続する。

## Broker境界と異常

- HostはProvider接続元のID、許可されたWorkspace、Principal、Snapshotを確定し、その組合せに対するLeaseを生成。Request JSONの自己申告をTrustしない。
- Channelは `protocolVersion/requestId/providerId/handle/epoch/deadline/payload`。JSON serializable、structured clone可能な純粋データ、8MiB未満の有界message、request/responseのschema validation。Open resultは発行handleをresult内に含め、openとpending-open cancel以外のresponseはouter handleを必須とする。Result shapeはoperation methodに束縛する。Invalid・超過・別epoch応答は拒否して対象ProviderのみFAILED。
- 1Provider最大4同時RPC、64件Queue、deadline: interactive 5s/first page 10s、Index build 30s。TimeoutはCancelを送り、応答不能Workerは終了。最大2回の指数Backoff後Quarantine、resetはユーザー明示。これらは初期Standalone Host Budgetであり、Scriptorium productionのOS resource budgetを代替しない。
- `NOT_INSTALLED, DISABLED, HOST_UNAVAILABLE, PROVIDER_FAILED, PROTOCOL_INVALID, PERMISSION_DENIED, SNAPSHOT_STALE, RESYNC_REQUIRED, TIMEOUT, CANCELLED, OVERLOADED, SOURCE_MISSING` は公開Error code。UIにError/Retry/Export/Provider選択の手段を残す。
- Provider一覧取得だけで重いWorkerをspawnしない。Last leaseが0ならIndex/Worker/Timerを止める。Story UIが隠れていてもAtlas consumerのLeaseがあればProviderは利用可能。
- AtlasはGraphを描画/手動配置できてもStory意味関係は勝手に書き換えられない。Metadataに `command` を持つ場合も、意味更新はOwner PluginのSourceRef+Host Change Proposalへ移譲。

## 受入Case

1. 2Providerが同じ`localId=alice`を返しても別Nodeとして表示。
2. 重複ID/Edge Endpoint欠落/ページの異なるSnapshotを拒否・隔離。
3. `Story-only` Providerの一覧/近傍/FilterがAtlas不在で動く。
4. `Atlas-only`でProvider 0でもmanual graphとCanvasが完全機能。
5. `combined`でStory停止→Atlasの手動Nodeは維持、Story復帰→StableRefのPinとCardを復旧。
6. 不正RPC、過大payload、Cancel無視、Stale Epoch、diff gapは対象を切り離し、Host/他Plugin/保存文書を保護。
