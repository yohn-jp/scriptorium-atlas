import type { AssetUploadStart, ChangeIntent, CommitReceipt, DurableAck, PreparedChange } from '@scriptorium-atlas/contracts';

export interface WorkspaceRecord {
  workspaceId: string;
  name: string;
  sourceRevision: string;
  generation: number;
  journalSequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileRecord {
  workspaceId: string;
  path: string;
  revision: string;
  bytes: ArrayBuffer;
  contentType: string;
  updatedAt: string;
}

export interface PreparedWriteRecord {
  path: string;
  bytes: ArrayBuffer | null;
  revision: string | null;
  beforeBytes: ArrayBuffer | null;
  contentType: string;
  expectedRevision: string | null;
}

export interface StagedAssetChunkRecord {
  offset: number;
  bytes: ArrayBuffer;
  durableAck: DurableAck;
}

export interface StagedAssetRecord extends AssetUploadStart {
  uploadId: string;
  receivedBytes: number;
  expiresAt: string;
  chunks: StagedAssetChunkRecord[];
}

export type JournalState = 'uploading' | 'prepared' | 'committing' | 'committed';

export interface JournalRecord {
  workspaceId: string;
  operationId: string;
  preparedId: string;
  digest: string;
  source: 'change' | 'bundle-import' | 'asset-upload';
  state: JournalState;
  change?: ChangeIntent;
  prepared?: PreparedChange;
  writes?: PreparedWriteRecord[];
  assetUpload?: StagedAssetRecord;
  baseWorkspaceRevision: string;
  baseGeneration: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiptRecord extends CommitReceipt {
  digest: string;
  source?: 'change' | 'bundle-import' | 'asset-upload';
}

export interface DatabaseSnapshot {
  workspace: WorkspaceRecord;
  files: FileRecord[];
}

export interface InventoryFile {
  path: string;
  revision: string;
  byteLength: number;
}
