import {
  validateContract,
  type AssetChunk,
  type AssetChunkReceipt,
  type AssetUploadReceipt,
  type AssetUploadStart,
  type ChangeIntent,
  type CommitReceipt,
  type FileListQuery,
  type FilePage,
  type FileReadQuery,
  type HostErrorCode,
  type PreparedChange,
  type ProviderDescriptor,
  type ProviderLease,
  type RecoverySummary,
  type SnapshotFileMetadata,
  type VersionedFile,
  type VersionedFileChunk,
  type WorkspaceHandle,
  type WorkspaceSnapshotPage,
  type WorkspaceSnapshotFile,
  type WorkspaceSnapshotQuery
} from '@scriptorium-atlas/contracts';
import type { HostPort } from '@scriptorium-atlas/contracts/host';
import { asPersistenceError, fail, PersistenceError } from './errors.js';
import {
  openDatabase,
  readAllByIndex,
  readRequest,
  readonlyTransaction,
  strictTransaction,
  transactionResult,
  type DatabaseOptions
} from './database.js';
import { digestJson, base64ToBytes, bytesToBase64, compareStrings, copyArrayBuffer, decodeUtf8, sha256, utf8Bytes } from './bytes.js';
import {
  validateOperationId,
  validateRelativePath,
  validateWorkspacePayloadPath,
  validateWorkspaceId,
  validateWorkspaceName
} from './path.js';
export { validateRelativePath };
import {
  createBundle,
  inferContentType,
  assertBundleWorkspaceCapacity,
  MAX_SOURCE_TEXT_BYTES,
  parseBundle,
  validateKnownDocument,
  validateFileSize,
  workspaceRevision
} from './bundle.js';
import type { DatabaseSnapshot, FileRecord, InventoryFile, JournalRecord, PreparedWriteRecord, ReceiptRecord, WorkspaceRecord } from './model.js';

const MAX_CHANGE_WRITES = 256;
const MAX_CHANGE_BYTES = 8 * 1024 * 1024;
const MAX_READ_SET = 512;
const MAX_READ_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_MESSAGE_BYTES = 7 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_SNAPSHOT_PAGE_SIZE = 10;

export interface WorkspaceInfo {
  workspace: WorkspaceHandle;
  name: string;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
}

export interface PreparedFileReview {
  path: string;
  before: VersionedFile | null;
  after: VersionedFile | null;
}

export interface PreparedProposal {
  prepared: PreparedChange;
  change: ChangeIntent;
  files: PreparedFileReview[];
  state: 'prepared' | 'committing';
}

export type HostProviderBridge = Pick<HostPort, 'describeProviders' | 'acquireProvider'>;

export interface OpenIndexedDbHostOptions extends DatabaseOptions {
  now?: () => Date;
  providers?: HostProviderBridge;
}

export interface IndexedDbHostPort extends HostPort {
  readonly storageStatus: { state: 'ready' | 'read-only' | 'unavailable'; reason?: string };
  createWorkspace(input: { name: string; workspaceId?: string }): Promise<WorkspaceInfo>;
  listWorkspaces(): Promise<WorkspaceInfo[]>;
  getWorkspaceHandle(workspaceId: string): Promise<WorkspaceHandle>;
  renameWorkspace(workspaceId: string, name: string): Promise<WorkspaceInfo>;
  getSnapshotPage(workspace: WorkspaceHandle, query?: WorkspaceSnapshotQuery): Promise<WorkspaceSnapshotPage>;
  getPrepared(preparedId: string): Promise<PreparedProposal | null>;
  listPending(workspaceId: string): Promise<PreparedProposal[]>;
  listPendingAssets(workspaceId: string): Promise<AssetUploadReceipt[]>;
  importBundle(blob: Blob, options?: { workspaceId?: string; name?: string }): Promise<WorkspaceInfo>;
  close(): void;
}

export async function openIndexedDbHost(options: OpenIndexedDbHostOptions = {}): Promise<IndexedDbHostPort> {
  let database: IDBDatabase | null = null;
  let state: 'ready' | 'read-only' | 'unavailable' = 'ready';
  let reason: string | undefined;
  try {
    database = await openDatabase(options);
    await probeStrictDurability(database);
  } catch (error) {
    const mapped = asPersistenceError(error);
    state = database ? 'read-only' : 'unavailable';
    reason = mapped.message;
  }

  const now = options.now ?? (() => new Date());
  const db = () => {
    if (!database) fail('STORAGE_UNAVAILABLE', reason ?? 'IndexedDB could not be opened.');
    return database;
  };
  const writableDb = () => {
    if (!database) fail('STORAGE_UNAVAILABLE', reason ?? 'IndexedDB could not be opened.');
    if (state !== 'ready') fail('STORAGE_UNAVAILABLE', reason ?? 'IndexedDB is read-only.');
    return database;
  };
  const markReadOnly = (error: unknown) => {
    const mapped = asPersistenceError(error);
    if (mapped.code === 'STORAGE_UNAVAILABLE') {
      state = 'read-only';
      reason = mapped.message;
    }
    return mapped;
  };
  const host: IndexedDbHostPort = {
    get storageStatus() {
      return reason === undefined ? { state } : { state, reason };
    },
    close() {
      database?.close();
      database = null;
      state = 'unavailable';
      reason = 'IndexedDB connection is closed.';
    },
    async createWorkspace(input) {
      const active = writableDb();
      const workspaceId = validateWorkspaceId(input.workspaceId ?? createId('ws-'));
      const name = validateWorkspaceName(input.name);
      const timestamp = timestampNow(now);
      const sourceRevision = await workspaceRevision([]);
      assertBundleWorkspaceCapacity(workspaceId, name, sourceRevision, []);
      const row: WorkspaceRecord = {
        workspaceId,
        name,
        sourceRevision,
        generation: 0,
        journalSequence: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const transaction = strictTransaction(active, ['workspaces']);
      const done = transactionResult(transaction);
      transaction.objectStore('workspaces').add(row);
      try {
        await done;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'ConstraintError') {
          fail('INVALID_INPUT', 'Workspace ID already exists.', { workspaceId });
        }
        throw markReadOnly(error);
      }
      return { workspace: toHandle(row), name: row.name, createdAt: row.createdAt, updatedAt: row.updatedAt, fileCount: 0 };
    },
    async listWorkspaces() {
      const active = db();
      const transaction = readonlyTransaction(active, ['workspaces', 'files']);
      const done = transactionResult(transaction);
      const workspacesRequest = transaction.objectStore('workspaces').getAll() as IDBRequest<WorkspaceRecord[]>;
      const counts: Promise<number>[] = [];
      workspacesRequest.addEventListener('success', () => {
        for (const row of workspacesRequest.result) {
          counts.push(requestValue(transaction.objectStore('files').index('byWorkspace').count(row.workspaceId)));
        }
      });
      const workspacesPromise = requestValue(workspacesRequest);
      try {
        const rows = await workspacesPromise;
        const fileCounts = await Promise.all(counts);
        await done;
        return rows.map((row, index) => ({
          workspace: toHandle(row),
          name: row.name,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          fileCount: fileCounts[index] ?? 0
        })).sort((left, right) => compareStrings(left.workspace.workspaceId, right.workspace.workspaceId));
      } catch (error) {
        throw asPersistenceError(error);
      }
    },
    async getWorkspaceHandle(workspaceId) {
      const row = await readRequest<WorkspaceRecord>(db(), 'workspaces', validateWorkspaceId(workspaceId));
      if (!row) fail('UNAVAILABLE', 'Workspace does not exist.', { workspaceId });
      return toHandle(row);
    },
    async renameWorkspace(workspaceId, name) {
      const active = writableDb();
      const id = validateWorkspaceId(workspaceId);
      const newName = validateWorkspaceName(name);
      const snapshot = await readFilesByPaths(active, id, []);
      assertBundleWorkspaceCapacity(id, newName, snapshot.workspace.sourceRevision, snapshot.inventory);
      const transaction = strictTransaction(active, ['workspaces']);
      const done = transactionResult(transaction);
      const store = transaction.objectStore('workspaces');
      const request = store.get(id) as IDBRequest<WorkspaceRecord | undefined>;
      let renamed: WorkspaceRecord | undefined;
      let failure: unknown;
      request.onsuccess = () => {
        const current = request.result;
        if (!current) {
          failure = new PersistenceError('UNAVAILABLE', 'Workspace does not exist.', { workspaceId: id });
          abort(transaction);
          return;
        }
        if (current.sourceRevision !== snapshot.workspace.sourceRevision || current.generation !== snapshot.workspace.generation) {
          failure = new PersistenceError('REVISION_CONFLICT', 'Workspace changed while its rename was being checked.');
          abort(transaction);
          return;
        }
        renamed = { ...current, name: newName, generation: current.generation + 1, updatedAt: timestampNow(now) };
        store.put(renamed);
      };
      try {
        await done;
      } catch (error) {
        if (failure) throw failure;
        throw markReadOnly(error);
      }
      if (!renamed) fail('STORAGE_UNAVAILABLE', 'Workspace rename did not produce a record.');
      return workspaceInfo(active, renamed);
    },
    async list(workspace, query = {}) {
      validateContract('workspaceHandle', workspace);
      const prefix = validatePrefix(query.prefix ?? '');
      const after = decodeCursor(query.cursor, prefix);
      const limit = validatePageLimit(query.limit ?? DEFAULT_PAGE_SIZE);
      const active = db();
      const metadata = await readPage(active, workspace.workspaceId, prefix, after, limit);
      assertHandleCurrent(metadata.workspace, workspace);
      const hasMore = metadata.files.length > limit;
      const files = metadata.files.slice(0, limit).map(toMetadata);
      const nextCursor = hasMore && files.length ? encodeCursor(files[files.length - 1]!.path) : null;
      const page: FilePage = { files, nextCursor, complete: !hasMore };
      return page;
    },
    async read(workspace, query: FileReadQuery): Promise<VersionedFile | VersionedFileChunk> {
      validateContract('workspaceHandle', workspace);
      validateRelativePath(query.path);
      const active = db();
      const snapshot = await readFilesByPaths(active, workspace.workspaceId, [query.path]);
      assertHandleCurrent(snapshot.workspace, workspace);
      const file = snapshot.files.get(query.path);
      if (!file) fail('UNAVAILABLE', 'File does not exist.', { path: query.path });
      if (query.expectedRevision !== undefined && query.expectedRevision !== file.revision) {
        fail('REVISION_CONFLICT', 'File revision does not match the requested revision.', { path: file.path });
      }
      if (query.offset !== undefined || query.limit !== undefined) {
        const offset = query.offset ?? 0;
        const limit = query.limit ?? MAX_READ_CHUNK_BYTES;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_CHUNK_BYTES) {
          fail('INVALID_INPUT', 'File chunk offset or limit is invalid.');
        }
        if (offset > file.bytes.byteLength) fail('INVALID_INPUT', 'File chunk offset exceeds the file size.', { path: file.path });
        const end = Math.min(offset + limit, file.bytes.byteLength);
        const chunk: VersionedFileChunk = {
          workspaceId: file.workspaceId,
          path: file.path,
          revision: file.revision,
          offset,
          content: bytesToBase64(new Uint8Array(file.bytes, offset, end - offset)),
          encoding: 'base64',
          nextOffset: end,
          complete: end === file.bytes.byteLength
        };
        return chunk;
      }
      const maxBytes = query.maxBytes ?? MAX_READ_CHUNK_BYTES;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_CHUNK_BYTES) {
        fail('INVALID_INPUT', 'maxBytes must be between 1 and 4 MiB.');
      }
      if (file.bytes.byteLength > maxBytes) {
        fail('INVALID_INPUT', 'File exceeds maxBytes; use chunked read with offset and limit.', {
          path: file.path,
          maxBytes,
          bytes: file.bytes.byteLength
        });
      }
      return asVersionedFile(file);
    },
    async getSnapshotPage(workspace, query = {}) {
      validateContract('workspaceHandle', workspace);
      const after = decodeCursor(query.cursor, '');
      const limit = validatePageLimit(query.limit ?? DEFAULT_SNAPSHOT_PAGE_SIZE);
      const active = db();
      const pageData = await readPage(active, workspace.workspaceId, '', after, limit);
      assertHandleCurrent(pageData.workspace, workspace);
      const files: WorkspaceSnapshotFile[] = [];
      // The empty-array envelope already contains `[]`; each accepted entry adds only its JSON and a comma.
      let serializedFileItemsBytes = 0;
      let lastPath: string | undefined;
      let hasMore = false;
      for (const file of pageData.files) {
        if (files.length === limit) {
          hasMore = true;
          break;
        }
        let versioned: VersionedFile | undefined;
        let entry: WorkspaceSnapshotFile;
        if (file.bytes.byteLength > MAX_SOURCE_TEXT_BYTES) {
          const encoding = decodeUtf8(new Uint8Array(file.bytes)) === undefined ? 'base64' : 'utf8';
          entry = snapshotFileMetadata(file, encoding);
        } else {
          versioned = asVersionedFile(file, false);
          entry = versioned;
        }
        const candidateHasMore = pageData.files.length > files.length + 1;
        const candidateEnvelope = {
          workspace,
          files: [],
          nextCursor: candidateHasMore ? encodeCursor(file.path) : null,
          complete: !candidateHasMore
        };
        const candidateEnvelopeBytes = utf8Bytes(JSON.stringify(candidateEnvelope)).byteLength;
        const separatorBytes = files.length > 0 ? 1 : 0;
        let entryBytes = utf8Bytes(JSON.stringify(entry)).byteLength;
        let candidateBytes = candidateEnvelopeBytes + serializedFileItemsBytes + separatorBytes + entryBytes;
        if (candidateBytes > MAX_SNAPSHOT_MESSAGE_BYTES && 'content' in entry) {
          entry = snapshotFileMetadata(file, versioned!.encoding);
          entryBytes = utf8Bytes(JSON.stringify(entry)).byteLength;
          candidateBytes = candidateEnvelopeBytes + serializedFileItemsBytes + separatorBytes + entryBytes;
        }
        if (candidateBytes > MAX_SNAPSHOT_MESSAGE_BYTES) {
          if (files.length === 0) {
            fail('STORAGE_UNAVAILABLE', 'Snapshot metadata exceeds the configured response byte limit.', { path: file.path });
          }
          hasMore = true;
          break;
        }
        files.push(entry);
        serializedFileItemsBytes += separatorBytes + entryBytes;
        lastPath = file.path;
      }
      if (!hasMore && pageData.files.length > files.length) hasMore = true;
      const page: WorkspaceSnapshotPage = {
        workspace,
        files,
        nextCursor: hasMore && lastPath ? encodeCursor(lastPath) : null,
        complete: !hasMore
      };
      if (utf8Bytes(JSON.stringify(page)).byteLength > MAX_SNAPSHOT_MESSAGE_BYTES) {
        fail('STORAGE_UNAVAILABLE', 'Snapshot page exceeds the configured response byte limit.');
      }
      return page;
    },
    async snapshot(workspace, query = {}) {
      return host.getSnapshotPage(workspace, query);
    },
    async prepare(workspace, change) {
      const active = writableDb();
      try {
        return await prepareProposal(active, workspace, change, now);
      } catch (error) {
        throw markReadOnly(error);
      }
    },
    async beginAsset(workspace, asset): Promise<AssetUploadReceipt> {
      const active = writableDb();
      validateContract('workspaceHandle', workspace);
      validateContract('assetUploadStart', asset);
      const normalized = validateAssetStart(workspace, asset);
      const digest = await digestJson(normalized);
      const existing = await readOperation(active, asset.workspaceId, asset.operationId);
      if (existing.journal) {
        const journal = existing.journal;
        const prior = journal.assetUpload;
        if (journal.source !== 'asset-upload' || !prior || prior.operationId !== normalized.operationId
          || prior.workspaceId !== normalized.workspaceId || prior.baseWorkspaceRevision !== normalized.baseWorkspaceRevision
          || prior.path !== normalized.path || prior.sha256 !== normalized.sha256 || prior.totalBytes !== normalized.totalBytes
          || prior.contentType !== normalized.contentType) {
          fail('OPERATION_ID_REUSED', 'Operation ID already has another durable payload.');
        }
        return assetUploadReceipt(prior);
      }
      if (existing.receipt) fail('OPERATION_ID_REUSED', 'Operation ID already has a committed receipt.');
      const snapshot = await readFilesByPaths(active, workspace.workspaceId, []);
      assertHandleCurrent(snapshot.workspace, workspace);
      if (asset.baseWorkspaceRevision !== snapshot.workspace.sourceRevision) {
        fail('REVISION_CONFLICT', 'Asset upload was started against a stale workspace revision.');
      }
      const timestamp = timestampNow(now);
      const uploadId = createId('upload-');
      const upload: JournalRecord['assetUpload'] = {
        ...normalized,
        uploadId,
        receivedBytes: 0,
        expiresAt: new Date(now().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        chunks: []
      };
      const journal: JournalRecord = {
        workspaceId: asset.workspaceId,
        operationId: asset.operationId,
        preparedId: uploadId,
        digest,
        source: 'asset-upload',
        state: 'uploading',
        baseWorkspaceRevision: asset.baseWorkspaceRevision,
        baseGeneration: workspace.epoch,
        createdAt: timestamp,
        updatedAt: timestamp,
        assetUpload: upload
      };
      try {
        const durableUpload = await persistAssetUpload(active, snapshot.workspace, journal);
        return assetUploadReceipt(durableUpload);
      } catch (error) {
        console.error('debug prepareAsset error', error);
        throw markReadOnly(error);
      }
    },
    async appendAsset(workspace, chunk): Promise<AssetChunkReceipt> {
      const active = writableDb();
      validateContract('workspaceHandle', workspace);
      validateContract('assetChunk', chunk);
      const bytes = base64ToBytes(chunk.content);
      if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024) {
        fail('INVALID_INPUT', 'Asset chunks must contain between 1 byte and 1 MiB.');
      }
      const journal = await readJournalByPreparedId(active, chunk.uploadId);
      if (!journal || journal.workspaceId !== workspace.workspaceId || journal.source !== 'asset-upload' || !journal.assetUpload) {
        fail('UNAVAILABLE', 'Asset upload does not exist.');
      }
      assertHandleCurrent(await readRequest<WorkspaceRecord>(active, 'workspaces', workspace.workspaceId).then(row => {
        if (!row) fail('UNAVAILABLE', 'Workspace does not exist.');
        return row;
      }), workspace);
      if (journal.state !== 'uploading') fail('INVALID_INPUT', 'Asset upload is no longer accepting chunks.');
      const current = journal.assetUpload;
      const prior = current.chunks.find(item => item.offset === chunk.offset);
      if (prior) {
        if (!equalBytes(new Uint8Array(prior.bytes), bytes)) fail('OPERATION_ID_REUSED', 'Repeated asset chunk offset contains different bytes.');
        return assetChunkReceipt(journal, prior.durableAck);
      }
      if (chunk.offset !== current.receivedBytes) fail('INVALID_INPUT', 'Asset chunks must be appended contiguously.', { expectedOffset: current.receivedBytes });
      if (current.receivedBytes + bytes.byteLength > current.totalBytes) fail('INVALID_INPUT', 'Asset chunk exceeds the declared total byte count.');
      try {
        return await appendAssetChunk(active, journal, bytes, now);
      } catch (error) {
        throw markReadOnly(error);
      }
    },
    async prepareAsset(workspace, uploadId, change): Promise<PreparedChange> {
      const active = writableDb();
      try {
        validateContract('workspaceHandle', workspace);
        validateContract('changeIntent', change);
        const journal = await readJournalByPreparedId(active, uploadId);
        if (!journal || journal.workspaceId !== workspace.workspaceId || journal.source !== 'asset-upload' || !journal.assetUpload) {
          fail('UNAVAILABLE', 'Asset upload does not exist.');
        }
        const upload = journal.assetUpload;
        if (change.operationId !== upload.operationId || change.workspaceId !== upload.workspaceId || change.baseWorkspaceRevision !== upload.baseWorkspaceRevision) {
          fail('INVALID_INPUT', 'ChangeIntent does not match the staged asset operation.');
        }
        if (upload.receivedBytes !== upload.totalBytes) fail('INVALID_INPUT', 'Asset upload is incomplete.');
        const bytes = concatenateAssetChunks(upload);
        if (await sha256(bytes) !== upload.sha256) fail('INVALID_INPUT', 'Staged asset SHA-256 does not match its declaration.');
        return await prepareProposal(active, workspace, change, now, { journal, bytes });
      } catch (error) {
        throw markReadOnly(error);
      }
    },
    async commit(workspace, preparedId, authorApproval) {
      const active = writableDb();
      validateContract('workspaceHandle', workspace);
      if (authorApproval !== true) fail('PERMISSION_DENIED', 'Host author approval is required before commit.');
      if (typeof preparedId !== 'string' || preparedId.length < 1 || preparedId.length > 128) fail('INVALID_INPUT', 'Prepared ID is invalid.');
      const journal = await readJournalByPreparedId(active, preparedId);
      if (!journal || journal.workspaceId !== workspace.workspaceId || !['change', 'asset-upload'].includes(journal.source) || !journal.change || !journal.prepared || !journal.writes) {
        fail('UNAVAILABLE', 'Prepared change does not exist.');
      }
      const initialReceipt = await readReceipt(active, journal.workspaceId, journal.operationId);
      if (initialReceipt) {
        if (initialReceipt.digest !== journal.digest) fail('OPERATION_ID_REUSED', 'Operation ID has a different committed payload.');
        return publicReceipt(initialReceipt);
      }
      const snapshot = await readFilesByPaths(
        active,
        journal.workspaceId,
        [...new Set([...journal.change.reads.map(read => read.path), ...journal.writes.map(write => write.path)])]
      );
      assertHandleCurrent(snapshot.workspace, workspace);
      if (snapshot.workspace.sourceRevision !== journal.baseWorkspaceRevision || snapshot.workspace.generation !== journal.baseGeneration) {
        fail('REVISION_CONFLICT', 'Workspace changed after proposal review.');
      }
      if (workspace.sourceRevision !== journal.baseWorkspaceRevision || workspace.epoch !== journal.baseGeneration) {
        fail('REVISION_CONFLICT', 'Host session does not match the prepared workspace generation.');
      }
      for (const read of journal.change.reads) {
        if ((snapshot.files.get(read.path)?.revision ?? null) !== read.revision) {
          fail('REVISION_CONFLICT', 'Read-set changed after proposal review.', { path: read.path });
        }
      }
      for (const write of journal.writes) {
        if ((snapshot.files.get(write.path)?.revision ?? null) !== write.expectedRevision) {
          fail('REVISION_CONFLICT', 'Write target changed after proposal review.', { path: write.path });
        }
      }

      const nextFiles = new Map(snapshot.inventory.map(file => [file.path, { ...file }]));
      const writtenRows: FileRecord[] = [];
      const committedAt = timestampNow(now);
      for (const write of journal.writes) {
        if (write.bytes === null) {
          nextFiles.delete(write.path);
        } else {
          const row: FileRecord = {
            workspaceId: journal.workspaceId,
            path: write.path,
            revision: write.revision!,
            bytes: write.bytes.slice(0),
            contentType: write.contentType,
            updatedAt: committedAt
          };
          nextFiles.set(write.path, { path: row.path, revision: row.revision, byteLength: row.bytes.byteLength });
          writtenRows.push(row);
        }
      }
      const nextRevision = await workspaceRevision([...nextFiles.values()]);
      assertBundleWorkspaceCapacity(journal.workspaceId, snapshot.workspace.name, nextRevision, [...nextFiles.values()]);
      const transitioned = await transitionJournal(active, journal, 'committing', timestampNow(now));
      if (transitioned.state === 'committed') {
        const receipt = await readReceipt(active, journal.workspaceId, journal.operationId);
        if (receipt?.digest === journal.digest) return publicReceipt(receipt);
        fail('COMMIT_UNKNOWN', 'Committed journal has no matching receipt.');
      }
      const receipt: ReceiptRecord = {
        operationId: journal.operationId,
        workspaceId: journal.workspaceId,
        sourceRevision: nextRevision,
        files: writtenRows.map(file => ({ path: file.path, revision: file.revision })),
        committedAt,
        digest: journal.digest,
        source: journal.source === 'asset-upload' ? 'asset-upload' : 'change'
      };
      const updatedWorkspace: WorkspaceRecord = {
        ...snapshot.workspace,
        sourceRevision: nextRevision,
        generation: snapshot.workspace.generation + 1,
        updatedAt: committedAt
      };
      try {
        await commitAtomically(active, snapshot.workspace, updatedWorkspace, journal, writtenRows, receipt, now);
        return publicReceipt(receipt);
      } catch (error) {
        const knownReceipt = await readReceipt(active, journal.workspaceId, journal.operationId).catch(() => undefined);
        if (knownReceipt?.digest === journal.digest) return publicReceipt(knownReceipt);
        await resetJournalToPrepared(active, journal, now).catch(() => undefined);
        const mapped = markReadOnly(error);
        if (mapped.code === 'QUOTA_EXCEEDED') throw mapped;
        if (mapped.code === 'REVISION_CONFLICT') throw mapped;
        throw new PersistenceError('COMMIT_UNKNOWN', 'Commit outcome could not be confirmed; query the same operation ID before retrying.', {
          operationId: journal.operationId,
          cause: mapped.code
        });
      }
    },
    async recover(workspaceId) {
      const id = validateWorkspaceId(workspaceId);
      if (!database) return { workspaceId: id, pendingOperationIds: [], unknownCommitIds: [], readOnly: true };
      const [prepared, uploading, committing, receipts] = await Promise.all([
        readAllByIndex<JournalRecord>(database, 'journal', 'byWorkspaceState', [id, 'prepared']),
        readAllByIndex<JournalRecord>(database, 'journal', 'byWorkspaceState', [id, 'uploading']),
        readAllByIndex<JournalRecord>(database, 'journal', 'byWorkspaceState', [id, 'committing']),
        readAllByWorkspaceReceipts(database, id)
      ]);
      const receiptIds = new Set(receipts.map(receipt => receipt.operationId));
      const summary: RecoverySummary = {
        workspaceId: id,
        pendingOperationIds: [...prepared, ...uploading].filter(row => row.source === 'change' || row.source === 'asset-upload').map(row => row.operationId).sort(compareStrings),
        unknownCommitIds: committing.filter(row => (row.source === 'change' || row.source === 'asset-upload') && !receiptIds.has(row.operationId)).map(row => row.operationId).sort(compareStrings),
        readOnly: state !== 'ready'
      };
      return summary;
    },
    async export(workspaceId) {
      const snapshot = await readFullSnapshot(db(), validateWorkspaceId(workspaceId));
      if (await workspaceRevision(snapshot.files) !== snapshot.workspace.sourceRevision) {
        fail('STORAGE_UNAVAILABLE', 'Workspace file inventory does not match its stored source revision.');
      }
      return createBundle({
        workspaceId: snapshot.workspace.workspaceId,
        name: snapshot.workspace.name,
        sourceRevision: snapshot.workspace.sourceRevision,
        files: snapshot.files
      });
    },
    async importBundle(blob, importOptions = {}) {
      const active = writableDb();
      const imported = await parseBundle(blob, importOptions);
      assertBundleWorkspaceCapacity(
        imported.workspaceId,
        imported.name,
        imported.sourceRevision,
        imported.files.map(file => ({ path: file.path, revision: file.revision, byteLength: file.bytes.byteLength }))
      );
      const timestamp = timestampNow(now);
      const workspace: WorkspaceRecord = {
        workspaceId: imported.workspaceId,
        name: imported.name,
        sourceRevision: imported.sourceRevision,
        generation: 0,
        journalSequence: 1,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const operationId = `bundle-${imported.digest.slice(0, 48)}`;
      const preparedId = createId('import-');
      const receipt: ReceiptRecord = {
        operationId,
        workspaceId: imported.workspaceId,
        sourceRevision: imported.sourceRevision,
        files: imported.files.map(file => ({ path: file.path, revision: file.revision })),
        committedAt: timestamp,
        digest: imported.digest,
        source: 'bundle-import'
      };
      const journal: JournalRecord = {
        workspaceId: imported.workspaceId,
        operationId,
        preparedId,
        digest: imported.digest,
        source: 'bundle-import',
        state: 'committed',
        baseWorkspaceRevision: imported.sourceRevision,
        baseGeneration: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const transaction = strictTransaction(active, ['workspaces', 'files', 'journal', 'receipts']);
      const done = transactionResult(transaction);
      const workspaces = transaction.objectStore('workspaces');
      const fileStore = transaction.objectStore('files');
      const journalStore = transaction.objectStore('journal');
      const receiptStore = transaction.objectStore('receipts');
      workspaces.add(workspace);
      for (const file of imported.files) fileStore.add(file);
      journalStore.add(journal);
      receiptStore.add(receipt);
      try {
        await done;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'ConstraintError') {
          fail('INVALID_INPUT', 'Imported workspace ID already exists; existing workspace was preserved.', {
            workspaceId: imported.workspaceId
          });
        }
        throw markReadOnly(error);
      }
      return {
        workspace: toHandle(workspace),
        name: workspace.name,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        fileCount: imported.files.length
      };
    },
    async describeProviders(workspaceId) {
      const id = validateWorkspaceId(workspaceId);
      await readRequest<WorkspaceRecord>(db(), 'workspaces', id).then(row => {
        if (!row) fail('UNAVAILABLE', 'Workspace does not exist.', { workspaceId: id });
      });
      return options.providers ? options.providers.describeProviders(id) : [];
    },
    async acquireProvider(workspaceId, providerId, sourceRevision) {
      const id = validateWorkspaceId(workspaceId);
      const row = await readRequest<WorkspaceRecord>(db(), 'workspaces', id);
      if (!row) fail('UNAVAILABLE', 'Workspace does not exist.', { workspaceId: id });
      if (row.sourceRevision !== sourceRevision) fail('REVISION_CONFLICT', 'Provider lease requested for a stale workspace revision.');
      if (!options.providers) fail('UNAVAILABLE', 'No Graph Provider is registered in this Host.');
      return options.providers.acquireProvider(id, providerId, sourceRevision);
    },
    async getPrepared(preparedId) {
      const journal = await readJournalByPreparedId(db(), preparedId);
      if (!journal || (journal.source !== 'change' && journal.source !== 'asset-upload') || !journal.change || !journal.prepared || !journal.writes) return null;
      return await reviewProposal(journal);
    },
    async listPending(workspaceId) {
      const id = validateWorkspaceId(workspaceId);
      const active = db();
      const [prepared, committing] = await Promise.all([
        readAllByIndex<JournalRecord>(active, 'journal', 'byWorkspaceState', [id, 'prepared']),
        readAllByIndex<JournalRecord>(active, 'journal', 'byWorkspaceState', [id, 'committing'])
      ]);
      const proposals = [...prepared, ...committing]
        .filter(row => (row.source === 'change' || row.source === 'asset-upload') && row.change && row.prepared && row.writes)
        .sort((left, right) => compareStrings(left.createdAt, right.createdAt));
      return Promise.all(proposals.map(reviewProposal));
    },
    async listPendingAssets(workspaceId) {
      const id = validateWorkspaceId(workspaceId);
      const rows = await readAllByIndex<JournalRecord>(db(), 'journal', 'byWorkspaceState', [id, 'uploading']);
      return rows
        .filter(row => row.source === 'asset-upload' && row.assetUpload)
        .sort((left, right) => compareStrings(left.createdAt, right.createdAt))
        .map(row => assetUploadReceipt(row.assetUpload!));
    }
  };

  async function reviewProposal(journal: JournalRecord): Promise<PreparedProposal> {
    const change = journal.change!;
    const prepared = journal.prepared!;
    const writes = journal.writes!;
    const files: PreparedFileReview[] = [];
    for (const write of writes) {
      const beforeBytes = write.beforeBytes;
      const afterBytes = write.bytes;
      const before = beforeBytes === null || write.expectedRevision === null ? null : await asVersionedFile({
        workspaceId: journal.workspaceId,
        path: write.path,
        revision: write.expectedRevision,
        bytes: beforeBytes,
        contentType: write.contentType,
        updatedAt: journal.createdAt
      }, false);
      const after = afterBytes === null || write.revision === null ? null : await asVersionedFile({
        workspaceId: journal.workspaceId,
        path: write.path,
        revision: write.revision,
        bytes: afterBytes,
        contentType: write.contentType,
        updatedAt: journal.createdAt
      }, false);
      files.push({ path: write.path, before, after });
    }
    return { prepared, change, files, state: journal.state === 'committing' ? 'committing' : 'prepared' };
  }

  return host;
}

async function probeStrictDurability(database: IDBDatabase): Promise<void> {
  const transaction = strictTransaction(database, ['workspaces']);
  await transactionResult(transaction);
}

interface StagedProposalInput {
  journal: JournalRecord;
  bytes: Uint8Array;
}

async function prepareProposal(
  database: IDBDatabase,
  handle: WorkspaceHandle,
  change: ChangeIntent,
  now: () => Date,
  staged?: StagedProposalInput
): Promise<PreparedChange> {
  validateContract('workspaceHandle', handle);
  validateContract('changeIntent', change);
  const workspaceId = validateWorkspaceId(change.workspaceId);
  if (workspaceId !== handle.workspaceId || change.baseWorkspaceRevision !== handle.sourceRevision) {
    fail('REVISION_CONFLICT', 'ChangeIntent does not match the Host workspace handle.');
  }
  validateOperationId(change.operationId);
  if (change.reads.length > MAX_READ_SET) fail('INVALID_INPUT', 'ChangeIntent read set exceeds the limit.', { maxReads: MAX_READ_SET });
  if (change.writes.length > MAX_CHANGE_WRITES) fail('INVALID_INPUT', 'ChangeIntent write set exceeds the limit.', { maxWrites: MAX_CHANGE_WRITES });

  const readByPath = new Map<string, string | null>();
  const foldedPaths = new Map<string, string>();
  for (const read of change.reads) {
    validateRelativePath(read.path);
    const folded = read.path.normalize('NFC').toLocaleLowerCase('und');
    const collision = foldedPaths.get(folded);
    if (collision && collision !== read.path) fail('INVALID_PATH', 'ChangeIntent contains case-colliding paths.', { path: read.path });
    foldedPaths.set(folded, read.path);
    if (readByPath.has(read.path)) fail('INVALID_INPUT', 'ChangeIntent read set contains a duplicate path.', { path: read.path });
    if (read.revision !== null && (typeof read.revision !== 'string' || !/^[a-f0-9]{64}$/.test(read.revision))) {
      fail('INVALID_INPUT', 'ChangeIntent read revision is malformed.', { path: read.path });
    }
    readByPath.set(read.path, read.revision);
  }

  const writePaths = new Set<string>();
  let regularWriteBytes = 0;
  for (const write of change.writes) {
    if (write.content === null) validateRelativePath(write.path);
    else validateWorkspacePayloadPath(write.path);
    const folded = write.path.normalize('NFC').toLocaleLowerCase('und');
    const collision = foldedPaths.get(folded);
    if (collision && collision !== write.path) fail('INVALID_PATH', 'ChangeIntent contains case-colliding paths.', { path: write.path });
    foldedPaths.set(folded, write.path);
    if (writePaths.has(write.path)) fail('INVALID_INPUT', 'ChangeIntent contains a duplicate write path.', { path: write.path });
    writePaths.add(write.path);
    if (!readByPath.has(write.path)) fail('INVALID_INPUT', 'Every write target must appear in the read set.', { path: write.path });
    if (write.content !== null && typeof write.content !== 'string') fail('INVALID_INPUT', 'Write content must be UTF-8/base64 text or null.', { path: write.path });
    if (write.content !== null) {
      const bytes = write.encoding === 'base64'
        ? base64ToBytes(write.content)
        : write.encoding === undefined || write.encoding === 'utf8'
          ? utf8Bytes(write.content)
          : fail('INVALID_INPUT', 'Write encoding is unsupported.', { path: write.path });
      regularWriteBytes += bytes.byteLength;
      if (regularWriteBytes > MAX_CHANGE_BYTES) {
        fail('INVALID_INPUT', 'Regular ChangeIntent writes exceed 8 MiB; use staged asset upload for large images.', { maxBytes: MAX_CHANGE_BYTES });
      }
    }
  }

  if (staged) {
    const upload = staged.journal.assetUpload;
    if (!upload || staged.journal.workspaceId !== workspaceId || staged.journal.operationId !== change.operationId || upload.operationId !== change.operationId) {
      fail('INVALID_INPUT', 'Staged asset does not match the ChangeIntent operation.');
    }
    if (staged.journal.state === 'prepared' && staged.journal.digest !== await proposalDigest(change, upload)) {
      fail('OPERATION_ID_REUSED', 'Asset operation already has a different prepared payload.');
    }
    if (writePaths.has(upload.path)) fail('INVALID_INPUT', 'Staged asset path must not also appear in ChangeIntent.writes.', { path: upload.path });
    validateWorkspacePayloadPath(upload.path);
    const folded = upload.path.normalize('NFC').toLocaleLowerCase('und');
    const collision = foldedPaths.get(folded);
    if (collision && collision !== upload.path) fail('INVALID_PATH', 'Staged asset path collides with another ChangeIntent path.', { path: upload.path });
    foldedPaths.set(folded, upload.path);
    if (!readByPath.has(upload.path)) fail('INVALID_INPUT', 'Staged asset target must appear in the ChangeIntent read set.', { path: upload.path });
  }

  const digest = staged
    ? await proposalDigest(change, staged.journal.assetUpload!)
    : await digestJson(change);
  const previous = await readOperation(database, workspaceId, change.operationId);
  if (previous.receipt) {
    if (previous.receipt.digest === digest && previous.journal?.prepared) return previous.journal.prepared;
    fail('OPERATION_ID_REUSED', 'Operation ID already has a different committed payload.');
  }
  if (previous.journal) {
    const isSameStagedUpload = staged
      && previous.journal.source === 'asset-upload'
      && previous.journal.preparedId === staged.journal.preparedId
      && previous.journal.digest === staged.journal.digest
      && previous.journal.state === 'uploading';
    if (!isSameStagedUpload) {
      if (previous.journal.digest === digest && previous.journal.prepared) return previous.journal.prepared;
      fail('OPERATION_ID_REUSED', 'Operation ID already has another durable proposal.');
    }
  }
  if (staged && staged.journal.state === 'prepared') {
    if (staged.journal.digest !== digest || !staged.journal.prepared) fail('OPERATION_ID_REUSED', 'Asset operation already has another prepared payload.');
    return staged.journal.prepared;
  }

  const allWritePaths = [...writePaths, ...(staged ? [staged.journal.assetUpload!.path] : [])];
  const snapshot = await readFilesByPaths(database, workspaceId, [...new Set([...readByPath.keys(), ...allWritePaths])]);
  assertHandleCurrent(snapshot.workspace, handle);
  if (snapshot.workspace.sourceRevision !== change.baseWorkspaceRevision) fail('REVISION_CONFLICT', 'ChangeIntent base revision is stale.');
  if (staged && (staged.journal.baseWorkspaceRevision !== snapshot.workspace.sourceRevision || staged.journal.baseGeneration !== snapshot.workspace.generation)) {
    fail('REVISION_CONFLICT', 'Staged asset upload is based on a stale workspace generation.');
  }
  for (const [path, expectedRevision] of readByPath) {
    const actualRevision = snapshot.files.get(path)?.revision ?? null;
    if (actualRevision !== expectedRevision) fail('REVISION_CONFLICT', 'Read-set revision does not match the workspace.', { path, expectedRevision, actualRevision });
  }
  const existingByFold = new Map(snapshot.inventory.map(file => [file.path.normalize('NFC').toLocaleLowerCase('und'), file.path]));
  for (const path of allWritePaths) {
    const existingPath = existingByFold.get(path.normalize('NFC').toLocaleLowerCase('und'));
    if (existingPath && existingPath !== path) {
      fail('INVALID_PATH', 'Write path collides with an existing workspace path under case-insensitive comparison.', { path, existingPath });
    }
  }

  const writes: PreparedWriteRecord[] = [];
  const createWrite = async (path: string, content: string | null, encoding: 'utf8' | 'base64' | undefined, contentType?: string): Promise<void> => {
    const previous = snapshot.files.get(path);
    const expectedRevision = readByPath.get(path)!;
    if (expectedRevision !== (previous?.revision ?? null)) fail('REVISION_CONFLICT', 'Write target revision does not match its read-set entry.', { path });
    if (content === null) {
      if (!previous) fail('INVALID_INPUT', 'Cannot delete a file that does not exist.', { path });
      writes.push({ path, bytes: null, revision: null, beforeBytes: previous.bytes.slice(0), contentType: previous.contentType, expectedRevision });
      return;
    }
    const bytes = encoding === 'base64' ? base64ToBytes(content) : utf8Bytes(content);
    validateFileSize(path, bytes.byteLength);
    validateKnownDocument(path, bytes);
    const revision = await sha256(bytes);
    const afterType = contentType ?? inferContentType(path, bytes);
    if (afterType.length > 128 || !afterType.includes('/')) fail('INVALID_INPUT', 'File content type is invalid.', { path });
    writes.push({
      path,
      bytes: copyArrayBuffer(bytes),
      revision,
      beforeBytes: previous?.bytes.slice(0) ?? null,
      contentType: afterType,
      expectedRevision
    });
  };
  for (const write of change.writes) await createWrite(write.path, write.content, write.encoding);
  if (staged) {
    const upload = staged.journal.assetUpload!;
    validateFileSize(upload.path, staged.bytes.byteLength);
    if (staged.bytes.byteLength !== upload.totalBytes || await sha256(staged.bytes) !== upload.sha256) {
      fail('INVALID_INPUT', 'Staged asset bytes do not match the declared upload size and hash.');
    }
    const inferredContentType = inferContentType(upload.path, staged.bytes);
    let stagedContentType = upload.contentType;
    if (upload.path.toLowerCase().endsWith('.svg')) {
      if (upload.contentType !== 'image/svg+xml' && upload.contentType !== 'application/octet-stream') {
        fail('INVALID_INPUT', 'SVG asset content type must be image/svg+xml or application/octet-stream.', { path: upload.path });
      }
      if (inferredContentType === 'application/octet-stream') stagedContentType = inferredContentType;
    } else if (inferredContentType !== upload.contentType) {
      fail('INVALID_INPUT', 'Staged image bytes do not match the declared content type.', { path: upload.path });
    }
    await createWrite(upload.path, bytesToBase64(staged.bytes), 'base64', stagedContentType);
  }

  const nextInventory = projectInventory(snapshot.inventory, writes);
  const nextRevision = await workspaceRevision(nextInventory);
  assertBundleWorkspaceCapacity(workspaceId, snapshot.workspace.name, nextRevision, nextInventory);
  const createdAt = timestampNow(now);
  const preparedId = staged?.journal.preparedId ?? createId('prepared-');
  const prepared: PreparedChange = {
    preparedId,
    operationId: change.operationId,
    workspaceId,
    baseWorkspaceRevision: change.baseWorkspaceRevision,
    changes: writes.map(write => ({
      path: write.path,
      operation: write.bytes === null ? 'delete' as const : write.expectedRevision === null ? 'create' as const : 'update' as const,
      previousRevision: write.expectedRevision,
      nextRevision: write.revision,
      bytes: write.bytes?.byteLength ?? 0
    })).sort((left, right) => compareStrings(left.path, right.path)),
    createdAt,
    durableAck: { operationId: change.operationId, workspaceId, journalSequence: 0, acknowledgedAt: createdAt }
  };
  const proposal: JournalRecord = {
    workspaceId,
    operationId: change.operationId,
    preparedId,
    digest,
    source: staged ? 'asset-upload' : 'change',
    state: 'prepared',
    change,
    prepared,
    writes,
    baseWorkspaceRevision: snapshot.workspace.sourceRevision,
    baseGeneration: snapshot.workspace.generation,
    createdAt,
    updatedAt: createdAt,
    ...(staged?.journal.assetUpload ? { assetUpload: staged.journal.assetUpload } : {})
  };
  return persistPrepared(database, snapshot.workspace, proposal, staged?.journal);
}

async function proposalDigest(change: ChangeIntent, upload: NonNullable<JournalRecord['assetUpload']>): Promise<string> {
  return digestJson({ change, asset: { path: upload.path, sha256: upload.sha256, totalBytes: upload.totalBytes, contentType: upload.contentType } });
}

async function readFullSnapshot(database: IDBDatabase, workspaceId: string): Promise<DatabaseSnapshot> {
  const transaction = readonlyTransaction(database, ['workspaces', 'files']);
  const done = transactionResult(transaction);
  const workspaceRequest = requestValue(transaction.objectStore('workspaces').get(workspaceId) as IDBRequest<WorkspaceRecord | undefined>);
  const filesRequest = requestValue(transaction.objectStore('files').index('byWorkspace').getAll(workspaceId) as IDBRequest<FileRecord[]>);
  const [workspace, files] = await Promise.all([workspaceRequest, filesRequest, done]);
  if (!workspace) fail('UNAVAILABLE', 'Workspace does not exist.', { workspaceId });
  // Keep reading legacy over-limit workspaces; createBundle reports export limits without changing stored files.
  return { workspace, files: files.sort((left, right) => compareStrings(left.path, right.path)) };
}

async function readFilesByPaths(database: IDBDatabase, workspaceId: string, paths: string[]): Promise<{
  workspace: WorkspaceRecord;
  inventory: InventoryFile[];
  files: Map<string, FileRecord>;
}> {
  const transaction = readonlyTransaction(database, ['workspaces', 'files']);
  const done = transactionResult(transaction);
  const workspaceRequest = requestValue(transaction.objectStore('workspaces').get(workspaceId) as IDBRequest<WorkspaceRecord | undefined>);
  const fileStore = transaction.objectStore('files');
  const pathsUnique = [...new Set(paths)];
  const fileRequests = pathsUnique.map(path => requestValue(fileStore.get([workspaceId, path]) as IDBRequest<FileRecord | undefined>));
  const inventoryPromise = readInventoryKeys(fileStore.index('byWorkspacePathRevision'), workspaceId);
  const [workspace, files, inventory] = await Promise.all([workspaceRequest, Promise.all(fileRequests), inventoryPromise, done]);
  if (!workspace) fail('UNAVAILABLE', 'Workspace does not exist.', { workspaceId });
  return {
    workspace,
    inventory,
    files: new Map(files.filter((file): file is FileRecord => Boolean(file)).map(file => [file.path, file]))
  };
}

function readInventoryKeys(index: IDBIndex, workspaceId: string): Promise<InventoryFile[]> {
  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([workspaceId, '', ''], [workspaceId, '\uffff'.repeat(1024), '\uffff'.repeat(128)]);
    const request = index.openCursor(range);
    const inventory: InventoryFile[] = [];
    request.onerror = () => reject(request.error ?? new DOMException('File inventory cursor failed.', 'UnknownError'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        inventory.sort((left, right) => compareStrings(left.path, right.path));
        resolve(inventory);
        return;
      }
      const key = cursor.key as IDBValidKey[];
      if (key[0] !== workspaceId) {
        inventory.sort((left, right) => compareStrings(left.path, right.path));
        resolve(inventory);
        return;
      }
      const [, path, revision] = key;
      if (typeof path !== 'string' || typeof revision !== 'string') {
        reject(new DOMException('File inventory index key is malformed.', 'DataError'));
        return;
      }
      const file = cursor.value as FileRecord;
      inventory.push({ path, revision, byteLength: file.bytes.byteLength });
      cursor.continue();
    };
  });
}

async function readPage(
  database: IDBDatabase,
  workspaceId: string,
  prefix: string,
  after: string | undefined,
  limit: number
): Promise<{ workspace: WorkspaceRecord; files: FileRecord[] }> {
  const transaction = readonlyTransaction(database, ['workspaces', 'files']);
  const done = transactionResult(transaction);
  const workspaceRequest = requestValue(transaction.objectStore('workspaces').get(workspaceId) as IDBRequest<WorkspaceRecord | undefined>);
  const filesPromise = new Promise<FileRecord[]>((resolve, reject) => {
    let lowerPath = prefix || '';
    let lowerOpen = false;
    if (after !== undefined && after > lowerPath) {
      lowerPath = after;
      lowerOpen = true;
    }
    const upperPath = prefix ? `${prefix}\uffff`.slice(0, 2048) : '\uffff'.repeat(1024);
    const range = IDBKeyRange.bound([workspaceId, lowerPath], [workspaceId, upperPath], lowerOpen, false);
    const request = transaction.objectStore('files').index('byWorkspacePath').openCursor(range);
    const files: FileRecord[] = [];
    request.onerror = () => reject(request.error ?? new DOMException('File page cursor failed.', 'UnknownError'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || files.length >= limit + 1) {
        resolve(files);
        return;
      }
      const file = cursor.value as FileRecord;
      if (!file.path.startsWith(prefix) || (after !== undefined && file.path <= after)) {
        cursor.continue();
        return;
      }
      files.push(file);
      cursor.continue();
    };
  });
  const [workspace, files] = await Promise.all([workspaceRequest, filesPromise, done]);
  if (!workspace) fail('UNAVAILABLE', 'Workspace does not exist.', { workspaceId });
  return { workspace, files };
}

async function readOperation(database: IDBDatabase, workspaceId: string, operationId: string): Promise<{ journal?: JournalRecord; receipt?: ReceiptRecord }> {
  const transaction = readonlyTransaction(database, ['journal', 'receipts']);
  const done = transactionResult(transaction);
  const journal = requestValue(transaction.objectStore('journal').get([workspaceId, operationId]) as IDBRequest<JournalRecord | undefined>);
  const receipt = requestValue(transaction.objectStore('receipts').get([workspaceId, operationId]) as IDBRequest<ReceiptRecord | undefined>);
  const [journalRow, receiptRow] = await Promise.all([journal, receipt, done]);
  return { ...(journalRow ? { journal: journalRow } : {}), ...(receiptRow ? { receipt: receiptRow } : {}) };
}

async function persistPrepared(
  database: IDBDatabase,
  expectedWorkspace: WorkspaceRecord,
  proposal: JournalRecord,
  replacingUpload?: JournalRecord
): Promise<PreparedChange> {
  const transaction = strictTransaction(database, ['workspaces', 'journal']);
  const done = transactionResult(transaction);
  const workspaceStore = transaction.objectStore('workspaces');
  const journalStore = transaction.objectStore('journal');
  const workspaceRequest = workspaceStore.get(expectedWorkspace.workspaceId) as IDBRequest<WorkspaceRecord | undefined>;
  const journalRequest = journalStore.get([proposal.workspaceId, proposal.operationId]) as IDBRequest<JournalRecord | undefined>;
  let workspace: WorkspaceRecord | undefined;
  let currentJournal: JournalRecord | undefined;
  let ready = 0;
  let result: PreparedChange | undefined;
  let failure: unknown;
  const onRead = () => {
    ready += 1;
    if (ready !== 2) return;
    if (!workspace || workspace.sourceRevision !== expectedWorkspace.sourceRevision || workspace.generation !== expectedWorkspace.generation) {
      failure = new PersistenceError('REVISION_CONFLICT', 'Workspace changed before the proposal could be durably prepared.');
      abort(transaction);
      return;
    }
    if (currentJournal) {
      const replacing = replacingUpload
        && currentJournal.source === 'asset-upload'
        && currentJournal.preparedId === replacingUpload.preparedId
        && currentJournal.assetUpload?.uploadId === replacingUpload.assetUpload?.uploadId;
      if (replacing && currentJournal.state === 'prepared' && currentJournal.digest === proposal.digest && currentJournal.prepared) {
        result = currentJournal.prepared;
        abort(transaction);
        return;
      }
      if (replacing && currentJournal.state === 'uploading' && currentJournal.digest === replacingUpload.digest) {
        // The chunk journal is atomically promoted to a prepared proposal below.
      } else if (currentJournal.digest === proposal.digest && currentJournal.prepared) {
        result = currentJournal.prepared;
        abort(transaction);
        return;
      } else {
        failure = new PersistenceError('OPERATION_ID_REUSED', 'Operation ID already has another durable proposal.');
        abort(transaction);
        return;
      }
    } else if (replacingUpload) {
      failure = new PersistenceError('UNAVAILABLE', 'Staged asset journal disappeared before proposal preparation.');
      abort(transaction);
      return;
    }

    const journalSequence = (workspace.journalSequence ?? 0) + 1;
    const prepared: PreparedChange = {
      ...proposal.prepared!,
      durableAck: {
        operationId: proposal.operationId,
        workspaceId: proposal.workspaceId,
        journalSequence,
        acknowledgedAt: proposal.prepared!.createdAt
      }
    };
    result = prepared;
    try {
      workspaceStore.put({ ...workspace, journalSequence });
      journalStore.put({ ...proposal, prepared });
    } catch (error) {
      failure = error;
      abort(transaction);
    }
  };
  workspaceRequest.onsuccess = () => { workspace = workspaceRequest.result; onRead(); };
  journalRequest.onsuccess = () => { currentJournal = journalRequest.result; onRead(); };
  try {
    await done;
  } catch (error) {
    if (failure) throw failure;
    if (result) return result;
    throw asPersistenceError(error);
  }
  if (!result) fail('STORAGE_UNAVAILABLE', 'Prepared journal ACK was not created.');
  return result;
}

async function persistAssetUpload(
  database: IDBDatabase,
  expectedWorkspace: WorkspaceRecord,
  proposal: JournalRecord
): Promise<NonNullable<JournalRecord['assetUpload']>> {
  const transaction = strictTransaction(database, ['workspaces', 'journal']);
  const done = transactionResult(transaction);
  const workspaceStore = transaction.objectStore('workspaces');
  const journalStore = transaction.objectStore('journal');
  const workspaceRequest = workspaceStore.get(expectedWorkspace.workspaceId) as IDBRequest<WorkspaceRecord | undefined>;
  const journalRequest = journalStore.get([proposal.workspaceId, proposal.operationId]) as IDBRequest<JournalRecord | undefined>;
  let workspace: WorkspaceRecord | undefined;
  let existing: JournalRecord | undefined;
  let ready = 0;
  let failure: unknown;
  let result: NonNullable<JournalRecord['assetUpload']> | undefined;
  const onRead = () => {
    ready += 1;
    if (ready !== 2) return;
    if (!workspace || workspace.sourceRevision !== expectedWorkspace.sourceRevision || workspace.generation !== expectedWorkspace.generation) {
      failure = new PersistenceError('REVISION_CONFLICT', 'Workspace changed before asset staging began.');
      abort(transaction);
      return;
    }
    if (existing) {
      if (existing.source === 'asset-upload' && existing.digest === proposal.digest && existing.assetUpload) {
        result = existing.assetUpload;
        return;
      }
      failure = new PersistenceError('OPERATION_ID_REUSED', 'Operation ID already has another durable payload.');
      abort(transaction);
      return;
    }
    const journalSequence = (workspace.journalSequence ?? 0) + 1;
    try {
      workspaceStore.put({ ...workspace, journalSequence });
      journalStore.add(proposal);
      result = proposal.assetUpload;
    } catch (error) {
      failure = error;
      abort(transaction);
    }
  };
  workspaceRequest.onsuccess = () => { workspace = workspaceRequest.result; onRead(); };
  journalRequest.onsuccess = () => { existing = journalRequest.result; onRead(); };
  try {
    await done;
  } catch (error) {
    if (failure) throw failure;
    throw asPersistenceError(error);
  }
  if (!result) fail('STORAGE_UNAVAILABLE', 'Asset upload was not durably created.');
  return result;
}

async function appendAssetChunk(
  database: IDBDatabase,
  original: JournalRecord,
  bytes: Uint8Array,
  now: () => Date
): Promise<AssetChunkReceipt> {
  const transaction = strictTransaction(database, ['workspaces', 'journal']);
  const done = transactionResult(transaction);
  const workspaces = transaction.objectStore('workspaces');
  const journals = transaction.objectStore('journal');
  const workspaceRequest = workspaces.get(original.workspaceId) as IDBRequest<WorkspaceRecord | undefined>;
  const journalRequest = journals.get([original.workspaceId, original.operationId]) as IDBRequest<JournalRecord | undefined>;
  let workspace: WorkspaceRecord | undefined;
  let journal: JournalRecord | undefined;
  let ready = 0;
  let result: AssetChunkReceipt | undefined;
  let failure: unknown;
  const onRead = () => {
    ready += 1;
    if (ready !== 2) return;
    if (!workspace || workspace.sourceRevision !== original.baseWorkspaceRevision || workspace.generation !== original.baseGeneration || !journal || journal.digest !== original.digest || journal.preparedId !== original.preparedId || !journal.assetUpload || journal.state !== 'uploading') {
      failure = new PersistenceError('REVISION_CONFLICT', 'Asset upload changed before the chunk could be saved.');
      abort(transaction);
      return;
    }
    const upload = journal.assetUpload;
    const offset = original.assetUpload!.receivedBytes;
    const prior = upload.chunks.find(item => item.offset === offset);
    if (prior) {
      if (!equalBytes(new Uint8Array(prior.bytes), bytes)) {
        failure = new PersistenceError('OPERATION_ID_REUSED', 'Repeated asset chunk offset contains different bytes.');
        abort(transaction);
        return;
      }
      result = assetChunkReceipt(journal, prior.durableAck);
      abort(transaction);
      return;
    }
    if (upload.receivedBytes !== offset || upload.receivedBytes + bytes.byteLength > upload.totalBytes) {
      failure = new PersistenceError('REVISION_CONFLICT', 'Asset upload chunk offset changed before it could be saved.');
      abort(transaction);
      return;
    }
    const journalSequence = (workspace.journalSequence ?? 0) + 1;
    const acknowledgedAt = timestampNow(now);
    const durableAck = { operationId: journal.operationId, workspaceId: journal.workspaceId, journalSequence, acknowledgedAt };
    const nextUpload = {
      ...upload,
      receivedBytes: upload.receivedBytes + bytes.byteLength,
      chunks: [...upload.chunks, { offset: upload.receivedBytes, bytes: copyArrayBuffer(bytes), durableAck }]
    };
    try {
      workspaces.put({ ...workspace, journalSequence });
      const updated = { ...journal, assetUpload: nextUpload, updatedAt: acknowledgedAt };
      journals.put(updated);
      result = assetChunkReceipt(updated, durableAck);
    } catch (error) {
      failure = error;
      abort(transaction);
    }
  };
  workspaceRequest.onsuccess = () => { workspace = workspaceRequest.result; onRead(); };
  journalRequest.onsuccess = () => { journal = journalRequest.result; onRead(); };
  try {
    await done;
  } catch (error) {
    if (result) return result;
    if (failure) throw failure;
    throw asPersistenceError(error);
  }
  if (!result) fail('STORAGE_UNAVAILABLE', 'Asset chunk was not durably acknowledged.');
  return result;
}

async function readJournalByPreparedId(database: IDBDatabase, preparedId: string): Promise<JournalRecord | undefined> {
  const transaction = readonlyTransaction(database, ['journal']);
  const done = transactionResult(transaction);
  const request = requestValue(transaction.objectStore('journal').index('byPreparedId').get(preparedId) as IDBRequest<JournalRecord | undefined>);
  const [journal] = await Promise.all([request, done]);
  return journal;
}

async function readReceipt(database: IDBDatabase, workspaceId: string, operationId: string): Promise<ReceiptRecord | undefined> {
  return readRequest<ReceiptRecord>(database, 'receipts', [workspaceId, operationId]);
}

async function readAllByWorkspaceReceipts(database: IDBDatabase, workspaceId: string): Promise<ReceiptRecord[]> {
  const transaction = readonlyTransaction(database, ['receipts']);
  const done = transactionResult(transaction);
  const range = IDBKeyRange.bound([workspaceId, ''], [workspaceId, '\uffff']);
  const request = requestValue(transaction.objectStore('receipts').index('byWorkspaceCommittedAt').getAll(range) as IDBRequest<ReceiptRecord[]>);
  const [receipts] = await Promise.all([request, done]);
  return receipts;
}

function projectInventory(current: InventoryFile[], writes: PreparedWriteRecord[]): InventoryFile[] {
  const projected = new Map(current.map(file => [file.path, { ...file }]));
  for (const write of writes) {
    if (write.bytes === null || write.revision === null) {
      projected.delete(write.path);
    } else {
      projected.set(write.path, {
        path: write.path,
        revision: write.revision,
        byteLength: write.bytes.byteLength
      });
    }
  }
  return [...projected.values()].sort((left, right) => compareStrings(left.path, right.path));
}

async function workspaceInfo(database: IDBDatabase, workspace: WorkspaceRecord): Promise<WorkspaceInfo> {
  const transaction = readonlyTransaction(database, ['files']);
  const done = transactionResult(transaction);
  const count = requestValue(transaction.objectStore('files').index('byWorkspace').count(workspace.workspaceId));
  const [fileCount] = await Promise.all([count, done]);
  return {
    workspace: toHandle(workspace),
    name: workspace.name,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    fileCount
  };
}

async function transitionJournal(database: IDBDatabase, journal: JournalRecord, next: JournalRecord['state'], updatedAt: string): Promise<JournalRecord> {
  const transaction = strictTransaction(database, ['journal']);
  const done = transactionResult(transaction);
  const store = transaction.objectStore('journal');
  const request = store.get([journal.workspaceId, journal.operationId]) as IDBRequest<JournalRecord | undefined>;
  let result: JournalRecord | undefined;
  let failure: unknown;
  request.onsuccess = () => {
    const current = request.result;
    if (!current || current.digest !== journal.digest || current.preparedId !== journal.preparedId) {
      failure = new PersistenceError('OPERATION_ID_REUSED', 'Journal entry changed while preparing to commit.');
      abort(transaction);
      return;
    }
    result = current.state === 'committed' ? current : { ...current, state: next, updatedAt };
    if (current.state !== 'committed') store.put(result);
  };
  try {
    await done;
  } catch (error) {
    if (failure) throw failure;
    throw asPersistenceError(error);
  }
  if (!result) fail('STORAGE_UNAVAILABLE', 'Journal transition did not produce a record.');
  return result;
}

async function commitAtomically(
  database: IDBDatabase,
  originalWorkspace: WorkspaceRecord,
  updatedWorkspace: WorkspaceRecord,
  originalJournal: JournalRecord,
  writtenFiles: FileRecord[],
  receipt: ReceiptRecord,
  now: () => Date
): Promise<void> {
  const transaction = strictTransaction(database, ['workspaces', 'files', 'journal', 'receipts']);
  const done = transactionResult(transaction);
  const workspaces = transaction.objectStore('workspaces');
  const journalStore = transaction.objectStore('journal');
  const receiptStore = transaction.objectStore('receipts');
  const workspaceRequest = workspaces.get(originalWorkspace.workspaceId) as IDBRequest<WorkspaceRecord | undefined>;
  const journalRequest = journalStore.get([originalJournal.workspaceId, originalJournal.operationId]) as IDBRequest<JournalRecord | undefined>;
  const receiptRequest = receiptStore.get([receipt.workspaceId, receipt.operationId]) as IDBRequest<ReceiptRecord | undefined>;
  let workspace: WorkspaceRecord | undefined;
  let journal: JournalRecord | undefined;
  let existingReceipt: ReceiptRecord | undefined;
  let readyCount = 0;
  let failure: unknown;
  let alreadyCommitted = false;
  const onRead = () => {
    readyCount += 1;
    if (readyCount !== 3) return;
    if (existingReceipt) {
      if (existingReceipt.digest === receipt.digest) alreadyCommitted = true;
      else failure = new PersistenceError('OPERATION_ID_REUSED', 'Operation ID already has a different receipt.');
      abort(transaction);
      return;
    }
    if (!workspace || workspace.sourceRevision !== originalWorkspace.sourceRevision || workspace.generation !== originalWorkspace.generation) {
      failure = new PersistenceError('REVISION_CONFLICT', 'Workspace changed while the commit transaction was opening.');
      abort(transaction);
      return;
    }
    if (!journal || journal.digest !== originalJournal.digest || journal.preparedId !== originalJournal.preparedId || journal.state !== 'committing') {
      failure = new PersistenceError('OPERATION_ID_REUSED', 'Prepared journal entry changed before commit.');
      abort(transaction);
      return;
    }
    try {
      for (const file of writtenFiles) transaction.objectStore('files').put(file);
      for (const write of originalJournal.writes ?? []) {
        if (write.bytes === null) transaction.objectStore('files').delete([receipt.workspaceId, write.path]);
      }
      workspaces.put(updatedWorkspace);
      receiptStore.add(receipt);
      journalStore.put({ ...journal, state: 'committed', updatedAt: timestampNow(now) });
    } catch (error) {
      failure = error;
      abort(transaction);
    }
  };
  workspaceRequest.onsuccess = () => { workspace = workspaceRequest.result; onRead(); };
  journalRequest.onsuccess = () => { journal = journalRequest.result; onRead(); };
  receiptRequest.onsuccess = () => { existingReceipt = receiptRequest.result; onRead(); };
  try {
    await done;
  } catch (error) {
    if (alreadyCommitted) return;
    if (failure instanceof PersistenceError) throw failure;
    throw asPersistenceError(failure ?? error);
  }
}

async function resetJournalToPrepared(database: IDBDatabase, original: JournalRecord, now: () => Date): Promise<void> {
  const transaction = strictTransaction(database, ['journal']);
  const done = transactionResult(transaction);
  const store = transaction.objectStore('journal');
  const request = store.get([original.workspaceId, original.operationId]) as IDBRequest<JournalRecord | undefined>;
  request.onsuccess = () => {
    const current = request.result;
    if (current?.digest === original.digest && current.state === 'committing') {
      store.put({ ...current, state: 'prepared', updatedAt: timestampNow(now) });
    }
  };
  await done;
}

function asVersionedFile(file: FileRecord, enforceMessageLimit = true): VersionedFile {
  const bytes = new Uint8Array(file.bytes);
  const text = decodeUtf8(bytes);
  const result: VersionedFile = {
    workspaceId: file.workspaceId,
    path: file.path,
    revision: file.revision,
    content: text ?? bytesToBase64(bytes),
    encoding: text === undefined ? 'base64' : 'utf8',
    contentType: file.contentType,
    updatedAt: file.updatedAt
  };
  if (enforceMessageLimit) {
    const messageBytes = utf8Bytes(JSON.stringify(result)).byteLength;
    if (messageBytes > MAX_SNAPSHOT_MESSAGE_BYTES) {
      fail('INVALID_INPUT', 'File content must be read through chunked reads to fit the Host message budget.', { path: file.path });
    }
  }
  return result;
}

function snapshotFileMetadata(file: FileRecord, encoding: 'utf8' | 'base64'): SnapshotFileMetadata {
  return {
    workspaceId: file.workspaceId,
    path: file.path,
    revision: file.revision,
    contentType: file.contentType,
    updatedAt: file.updatedAt,
    byteLength: file.bytes.byteLength,
    encoding
  };
}

function publicReceipt(receipt: ReceiptRecord): CommitReceipt {
  return {
    operationId: receipt.operationId,
    workspaceId: receipt.workspaceId,
    sourceRevision: receipt.sourceRevision,
    files: receipt.files,
    committedAt: receipt.committedAt
  };
}

function toHandle(workspace: WorkspaceRecord): WorkspaceHandle {
  return { workspaceId: workspace.workspaceId, sourceRevision: workspace.sourceRevision, epoch: workspace.generation };
}

function validateAssetStart(handle: WorkspaceHandle, asset: AssetUploadStart): AssetUploadStart {
  const workspaceId = validateWorkspaceId(asset.workspaceId);
  const path = validateWorkspacePayloadPath(asset.path);
  validateOperationId(asset.operationId);
  if (workspaceId !== handle.workspaceId || asset.baseWorkspaceRevision !== handle.sourceRevision) {
    fail('REVISION_CONFLICT', 'Asset upload does not match the Host workspace handle.');
  }
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) fail('INVALID_INPUT', 'Asset SHA-256 must be a lowercase hexadecimal digest.');
  if (!Number.isSafeInteger(asset.totalBytes) || asset.totalBytes < 1 || asset.totalBytes > 10 * 1024 * 1024) {
    fail('INVALID_INPUT', 'Staged assets must contain between 1 byte and 10 MiB.');
  }
  const isSvg = path.toLowerCase().endsWith('.svg');
  const validContentType = isSvg
    ? asset.contentType === 'image/svg+xml' || asset.contentType === 'application/octet-stream'
    : /^image\/[a-z0-9.+-]+$/iu.test(asset.contentType);
  if (!/\.(?:png|jpe?g|webp|svg)$/iu.test(path) || !validContentType || asset.contentType.length > 128) {
    fail('INVALID_INPUT', 'Staged asset uploads are limited to image files with an image content type.', { path });
  }
  validateFileSize(path, asset.totalBytes);
  return {
    operationId: asset.operationId,
    workspaceId,
    baseWorkspaceRevision: asset.baseWorkspaceRevision,
    path,
    sha256: asset.sha256,
    totalBytes: asset.totalBytes,
    contentType: asset.contentType
  };
}

function assetUploadReceipt(upload: NonNullable<JournalRecord['assetUpload']>): AssetUploadReceipt {
  return {
    uploadId: upload.uploadId,
    operationId: upload.operationId,
    workspaceId: upload.workspaceId,
    path: upload.path,
    totalBytes: upload.totalBytes,
    nextOffset: upload.receivedBytes,
    expiresAt: upload.expiresAt
  };
}

function assetChunkReceipt(journal: JournalRecord, durableAck: AssetChunkReceipt['durableAck']): AssetChunkReceipt {
  const upload = journal.assetUpload!;
  return {
    uploadId: upload.uploadId,
    nextOffset: upload.receivedBytes,
    receivedBytes: upload.receivedBytes,
    totalBytes: upload.totalBytes,
    durableAck
  };
}

function concatenateAssetChunks(upload: NonNullable<JournalRecord['assetUpload']>): Uint8Array {
  if (upload.receivedBytes !== upload.totalBytes) fail('INVALID_INPUT', 'Asset upload is incomplete.');
  const bytes = new Uint8Array(upload.totalBytes);
  let expectedOffset = 0;
  for (const chunk of upload.chunks) {
    const value = new Uint8Array(chunk.bytes);
    if (chunk.offset !== expectedOffset || value.byteLength > upload.totalBytes - expectedOffset) {
      fail('STORAGE_UNAVAILABLE', 'Staged asset chunk journal is not contiguous.');
    }
    bytes.set(value, expectedOffset);
    expectedOffset += value.byteLength;
  }
  if (expectedOffset !== upload.totalBytes) fail('STORAGE_UNAVAILABLE', 'Staged asset chunk journal does not match its declared size.');
  return bytes;
}

function toMetadata(file: FileRecord): FilePage['files'][number] {
  return { path: file.path, revision: file.revision, contentType: file.contentType, updatedAt: file.updatedAt };
}

function assertHandleCurrent(record: WorkspaceRecord, handle: WorkspaceHandle): void {
  if (record.workspaceId !== handle.workspaceId || record.sourceRevision !== handle.sourceRevision || record.generation !== handle.epoch) {
    fail('REVISION_CONFLICT', 'Workspace handle is stale.', {
      expectedRevision: handle.sourceRevision,
      actualRevision: record.sourceRevision,
      expectedEpoch: handle.epoch,
      actualEpoch: record.generation
    });
  }
}

function timestampNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('STORAGE_UNAVAILABLE', 'Clock returned an invalid timestamp.');
  return value.toISOString();
}

function createId(prefix: string): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return `${prefix}${cryptoObject.randomUUID()}`;
  if (!cryptoObject?.getRandomValues) fail('STORAGE_UNAVAILABLE', 'Secure random identifier generation is unavailable.');
  const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
  return `${prefix}${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`;
}

function validatePageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) fail('INVALID_INPUT', 'Page limit must be between 1 and 500.');
  return value;
}

function validatePrefix(value: string): string {
  if (value === '') return '';
  if (value.length > 1024 || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    fail('INVALID_PATH', 'File list prefix is invalid.');
  }
  const withoutTrailingSlash = value.endsWith('/') ? value.slice(0, -1) : value;
  if (withoutTrailingSlash === '') return '';
  validateRelativePath(withoutTrailingSlash);
  return value;
}

function encodeCursor(path: string): string {
  return encodeURIComponent(path);
}

function decodeCursor(cursor: string | undefined, prefix: string): string | undefined {
  if (cursor === undefined) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(cursor);
  } catch {
    fail('INVALID_INPUT', 'File cursor is malformed.');
  }
  validateRelativePath(path);
  if (prefix && !path.startsWith(prefix)) fail('INVALID_INPUT', 'Cursor does not belong to the requested path prefix.');
  return path;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new DOMException('IndexedDB request failed.', 'UnknownError'));
  });
}

function abort(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // A previous request may already have aborted the transaction.
  }
}
