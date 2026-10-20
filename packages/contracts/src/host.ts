import type {
  ChangeIntent,
  AssetChunk,
  AssetChunkReceipt,
  AssetUploadReceipt,
  AssetUploadStart,
  CommitReceipt,
  FileListQuery,
  FilePage,
  FileReadQuery,
  HostRpcEvent,
  PluginDescriptor,
  PreparedChange,
  ProviderCallParams,
  ProviderDescriptor,
  ProviderLease,
  PluginProviderRequest,
  ProviderResult,
  RecoverySummary,
  SourceRef,
  VersionedFile,
  VersionedFileChunk,
  WorkspaceHandle,
  WorkspaceSnapshotPage,
  WorkspaceSnapshotQuery,
} from './generated/types.js';
export { decodeVersionedFile, decodeVersionedFileText, hasSnapshotContent, isSnapshotFileMetadata } from './encoding.js';

/** The client exposed to a plugin frame. It has no commit or recovery authority. */
export interface PluginHostClient {
  snapshot(query?: WorkspaceSnapshotQuery): Promise<WorkspaceSnapshotPage>;
  list(query?: FileListQuery): Promise<FilePage>;
  read(query: FileReadQuery): Promise<VersionedFile | VersionedFileChunk>;
  prepare(change: ChangeIntent): Promise<PreparedChange>;
  beginAsset(asset: AssetUploadStart): Promise<AssetUploadReceipt>;
  appendAsset(chunk: AssetChunk): Promise<AssetChunkReceipt>;
  prepareAsset(uploadId: string, change: ChangeIntent): Promise<PreparedChange>;
  requestSource(ref: SourceRef): Promise<VersionedFile>;
  describeProviders(): Promise<ProviderDescriptor[]>;
  acquireProvider(providerId: string, sourceRevision: string): Promise<ProviderLease>;
  providerCall(leaseId: string, request: PluginProviderRequest): Promise<ProviderResult>;
  releaseProvider(leaseId: string): Promise<void>;
  subscribeWorkspace(listener: (event: HostRpcEvent) => void): () => void;
}

/** Host-local adapter. Never pass this object through the plugin frame RPC. */
export interface HostPort {
  snapshot(workspace: WorkspaceHandle, query?: WorkspaceSnapshotQuery): Promise<WorkspaceSnapshotPage>;
  list(workspace: WorkspaceHandle, query?: FileListQuery): Promise<FilePage>;
  read(workspace: WorkspaceHandle, query: FileReadQuery): Promise<VersionedFile | VersionedFileChunk>;
  prepare(workspace: WorkspaceHandle, change: ChangeIntent): Promise<PreparedChange>;
  beginAsset(workspace: WorkspaceHandle, asset: AssetUploadStart): Promise<AssetUploadReceipt>;
  appendAsset(workspace: WorkspaceHandle, chunk: AssetChunk): Promise<AssetChunkReceipt>;
  prepareAsset(workspace: WorkspaceHandle, uploadId: string, change: ChangeIntent): Promise<PreparedChange>;
  commit(workspace: WorkspaceHandle, preparedId: string, authorApproval: boolean): Promise<CommitReceipt>;
  recover(workspaceId: string): Promise<RecoverySummary>;
  export(workspaceId: string): Promise<Blob>;
  describeProviders(workspaceId: string): Promise<ProviderDescriptor[]>;
  acquireProvider(workspaceId: string, providerId: string, sourceRevision: string): Promise<ProviderLease>;
}

/** Schema-derived argument shape used by the host provider-call RPC. */
export type HostProviderCallParams = ProviderCallParams;
export type HostPluginDescriptor = PluginDescriptor;
export type {
  AppendAssetParams,
  AssetChunk,
  AssetChunkReceipt,
  AssetUploadReceipt,
  AssetUploadStart,
  BeginAssetParams,
  PrepareAssetParams,
  PluginProviderRequest,
} from './generated/types.js';
