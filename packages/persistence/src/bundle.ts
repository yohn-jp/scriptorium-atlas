import { Unzip, UnzipInflate, UnzipPassThrough, zipSync, type Zippable } from 'fflate';
import { assertBoardIntegrity } from '@scriptorium-atlas/contracts';
import type { FileRecord } from './model.js';
import { base64ToBytes, compareStrings, copyBytes, decodeUtf8, sha256, stableJson, utf8Bytes } from './bytes.js';
import { svgContentType } from './svg.js';
import { fail } from './errors.js';
import { caseFoldPath, validateRelativePath, validateWorkspaceId, validateWorkspaceName, validateWorkspacePayloadPath } from './path.js';

// manifest.json consumes one of the 100,000 allowed archive entries.
export const MAX_WORKSPACE_FILES = 99_999;
export const MAX_BUNDLE_ENTRIES = 100_000;
export const MAX_BUNDLE_EXPANDED_BYTES = 256 * 1024 * 1024;
export const MAX_BUNDLE_MANIFEST_BYTES = MAX_BUNDLE_EXPANDED_BYTES;
export const MAX_BUNDLE_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_SOURCE_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const BUNDLE_SCHEMA = 'atlas.bundle/v1';
const MANIFEST_PATH = 'manifest.json';
const WORKSPACE_PREFIX = 'workspace/';

export interface BundleSource {
  workspaceId: string;
  name: string;
  sourceRevision: string;
  files: FileRecord[];
}

export interface ImportedBundle {
  workspaceId: string;
  name: string;
  sourceRevision: string;
  digest: string;
  files: FileRecord[];
}

export interface BundleManifestEntry {
  path: string;
  revision: string;
  byteLength: number;
}

interface BundleManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

interface BundleManifest {
  schema: typeof BUNDLE_SCHEMA;
  workspaceId: string;
  name: string;
  sourceRevision: string;
  files: BundleManifestFile[];
}

interface CentralEntry {
  name: string;
  rawName: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressedBytes: number;
  uncompressedBytes: number;
  localOffset: number;
  dataOffset: number;
  dataEnd: number;
  externalAttributes: number;
  madeBy: number;
}

export async function createBundle(source: BundleSource): Promise<Blob> {
  validateWorkspaceId(source.workspaceId);
  validateWorkspaceName(source.name);
  if (source.files.length > MAX_WORKSPACE_FILES) {
    fail('INVALID_INPUT', 'Workspace file count exceeds the V1 bundle limit.', { maxFiles: MAX_WORKSPACE_FILES });
  }
  const files = [...source.files].sort((left, right) => compareStrings(left.path, right.path));
  const seenPaths = new Set<string>();
  const seenFoldedPaths = new Set<string>();
  const manifestFiles: BundleManifestFile[] = [];
  const payload = Object.create(null) as Record<string, Uint8Array>;
  const zipFiles = Object.create(null) as Zippable;
  let expandedBytes = 0;

  for (const file of files) {
    const path = validateWorkspacePayloadPath(file.path);
    const folded = caseFoldPath(path);
    if (seenPaths.has(path) || seenFoldedPaths.has(folded)) {
      fail('INVALID_PATH', 'Workspace paths must be unique under case-insensitive comparison.', { path });
    }
    seenPaths.add(path);
    seenFoldedPaths.add(folded);
    const bytes = new Uint8Array(file.bytes);
    if (bytes.byteLength !== file.bytes.byteLength || await sha256(bytes) !== file.revision) {
      fail('INVALID_INPUT', 'Workspace inventory contains bytes that do not match the stored file revision.', { path });
    }
    validateFileSize(path, bytes.byteLength);
    expandedBytes += bytes.byteLength;
    if (expandedBytes > MAX_BUNDLE_EXPANDED_BYTES) {
      fail('INVALID_INPUT', 'Workspace exceeds the V1 expanded bundle size limit.', {
        maxBytes: MAX_BUNDLE_EXPANDED_BYTES
      });
    }
    const zipPath = `${WORKSPACE_PREFIX}${path}`;
    payload[zipPath] = bytes;
    manifestFiles.push({ path, sha256: file.revision, bytes: bytes.byteLength });
  }
  if (await workspaceRevision(files) !== source.sourceRevision) {
    fail('INVALID_INPUT', 'Workspace revision does not match its file inventory.');
  }

  const manifestBytes = serializeManifest(source.workspaceId, source.name, source.sourceRevision, manifestFiles);
  expandedBytes += manifestBytes.byteLength;
  if (files.length + 1 > MAX_BUNDLE_ENTRIES || expandedBytes > MAX_BUNDLE_EXPANDED_BYTES) {
    fail('INVALID_INPUT', 'Bundle including its manifest exceeds the V1 ZIP entry or expanded byte limit.', {
      maxEntries: MAX_BUNDLE_ENTRIES,
      maxExpandedBytes: MAX_BUNDLE_EXPANDED_BYTES
    });
  }
  zipFiles[MANIFEST_PATH] = [manifestBytes, { os: 3, attrs: 0o100644 << 16 }];
  for (const [path, bytes] of Object.entries(payload)) {
    zipFiles[path] = [bytes, { os: 3, attrs: 0o100644 << 16 }];
  }
  const archive = zipSync(zipFiles, {
    level: 6,
    mtime: new Date('1980-01-01T00:00:00.000Z'),
    os: 3
  });
  if (archive.byteLength > MAX_BUNDLE_ARCHIVE_BYTES) {
    fail('INVALID_INPUT', 'Compressed bundle exceeds the V1 archive size limit.', { maxBytes: MAX_BUNDLE_ARCHIVE_BYTES });
  }
  return new Blob([archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer], { type: 'application/zip' });
}

export async function parseBundle(blob: Blob, destination?: { workspaceId?: string; name?: string }): Promise<ImportedBundle> {
  if (blob.size > MAX_BUNDLE_ARCHIVE_BYTES) {
    fail('INVALID_INPUT', 'Compressed bundle exceeds the V1 archive size limit.', { maxBytes: MAX_BUNDLE_ARCHIVE_BYTES });
  }
  const archive = new Uint8Array(await blob.arrayBuffer());
  const central = parseCentralDirectory(archive);
  if (central.length > MAX_BUNDLE_ENTRIES) {
    fail('INVALID_INPUT', 'Bundle has more than 100,000 ZIP entries.');
  }
  validateArchiveEntries(archive, central);
  const extracted = extractBounded(archive, central);
  const manifestBytes = extracted.get(MANIFEST_PATH);
  if (!manifestBytes) fail('INVALID_INPUT', 'Bundle is missing manifest.json.');
  if (manifestBytes.byteLength > MAX_BUNDLE_MANIFEST_BYTES) fail('INVALID_INPUT', 'Bundle manifest exceeds the V1 expanded byte limit.');

  const manifestText = decodeUtf8(manifestBytes);
  if (manifestText === undefined) fail('INVALID_INPUT', 'Bundle manifest is not valid UTF-8.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    fail('INVALID_INPUT', 'Bundle manifest is malformed JSON.');
  }
  const manifest = validateManifest(parsed);
  const destinationWorkspaceId = validateWorkspaceId(destination?.workspaceId ?? manifest.workspaceId);
  const destinationName = validateWorkspaceName(destination?.name ?? manifest.name);
  if (manifest.files.length > MAX_WORKSPACE_FILES) fail('INVALID_INPUT', 'Workspace has too many payload files.');

  const expectedEntries = new Set<string>([MANIFEST_PATH]);
  const sourceFiles: FileRecord[] = [];
  const seenPath = new Set<string>();
  const seenFolded = new Set<string>();
  let expandedBytes = manifestBytes.byteLength;
  for (const item of manifest.files) {
    const path = validateWorkspacePayloadPath(item.path);
    const folded = caseFoldPath(path);
    if (seenPath.has(path) || seenFolded.has(folded)) {
      fail('INVALID_PATH', 'Manifest contains duplicate or case-colliding paths.', { path });
    }
    seenPath.add(path);
    seenFolded.add(folded);
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      fail('INVALID_INPUT', 'Manifest file size or SHA-256 value is invalid.', { path });
    }
    const zipPath = `${WORKSPACE_PREFIX}${path}`;
    expectedEntries.add(zipPath);
    const bytes = extracted.get(zipPath);
    if (!bytes) fail('INVALID_INPUT', 'A manifest file is missing from the ZIP archive.', { path });
    if (bytes.byteLength !== item.bytes || await sha256(bytes) !== item.sha256) {
      fail('INVALID_INPUT', 'Bundle file size or SHA-256 verification failed.', { path });
    }
    validateFileSize(path, bytes.byteLength);
    validateKnownDocument(path, bytes);
    expandedBytes += bytes.byteLength;
    if (expandedBytes > MAX_BUNDLE_EXPANDED_BYTES) {
      fail('INVALID_INPUT', 'Bundle exceeds the V1 expanded byte limit.', { maxBytes: MAX_BUNDLE_EXPANDED_BYTES });
    }
    sourceFiles.push({
      workspaceId: destinationWorkspaceId,
      path,
      revision: item.sha256,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      contentType: inferContentType(path, bytes),
      updatedAt: new Date(0).toISOString()
    });
  }
  if (expectedEntries.size !== extracted.size || [...extracted.keys()].some(path => !expectedEntries.has(path))) {
    fail('INVALID_INPUT', 'ZIP archive contains a file that is absent from manifest.json.');
  }
  const computedRevision = await workspaceRevision(sourceFiles);
  if (computedRevision !== manifest.sourceRevision) {
    fail('INVALID_INPUT', 'Manifest workspace revision does not match its files.');
  }
  const digest = await sha256(manifestBytes);
  return {
    workspaceId: destinationWorkspaceId,
    name: destinationName,
    sourceRevision: computedRevision,
    digest,
    files: sourceFiles
  };
}

export async function workspaceRevision(files: Array<Pick<FileRecord, 'path' | 'revision'>>): Promise<string> {
  const entries = [...files].sort((left, right) => compareStrings(left.path, right.path));
  return sha256(utf8Bytes(stableJson(entries.map(file => [file.path, file.revision]))));
}

export function serializedManifestBytes(
  workspaceId: string,
  name: string,
  sourceRevision: string,
  files: readonly BundleManifestEntry[]
): Uint8Array {
  validateWorkspaceId(workspaceId);
  validateWorkspaceName(name);
  if (!/^[a-f0-9]{64}$/.test(sourceRevision)) fail('INVALID_INPUT', 'Workspace revision is malformed.');
  const entries = [...files].sort((left, right) => compareStrings(left.path, right.path));
  const manifestFiles: BundleManifestFile[] = entries.map(file => {
    const path = validateWorkspacePayloadPath(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.revision) || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0) {
      fail('INVALID_INPUT', 'Workspace inventory contains invalid manifest metadata.', { path });
    }
    return { path, sha256: file.revision, bytes: file.byteLength };
  });
  return serializeManifest(workspaceId, name, sourceRevision, manifestFiles);
}

function serializeManifest(
  workspaceId: string,
  name: string,
  sourceRevision: string,
  files: BundleManifestFile[]
): Uint8Array {
  const manifest: BundleManifest = {
    schema: BUNDLE_SCHEMA,
    workspaceId,
    name,
    sourceRevision,
    files
  };
  return utf8Bytes(`${stableJson(manifest)}\n`);
}

export function assertBundleWorkspaceCapacity(
  workspaceId: string,
  name: string,
  sourceRevision: string,
  files: readonly BundleManifestEntry[]
): void {
  if (files.length > MAX_WORKSPACE_FILES) {
    fail('INVALID_INPUT', 'Workspace exceeds the V1 payload file count after reserving manifest.json.', {
      maxPayloadFiles: MAX_WORKSPACE_FILES,
      files: files.length
    });
  }
  const payloadBytes = files.reduce((total, file) => total + file.byteLength, 0);
  const manifestBytes = serializedManifestBytes(workspaceId, name, sourceRevision, files).byteLength;
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes + manifestBytes > MAX_BUNDLE_EXPANDED_BYTES) {
    fail('INVALID_INPUT', 'Workspace payload and serialized manifest exceed the V1 expanded byte limit.', {
      maxExpandedBytes: MAX_BUNDLE_EXPANDED_BYTES,
      payloadBytes,
      manifestBytes
    });
  }
}

export function inferContentType(path: string, bytes?: Uint8Array): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.atlas.json') || lower.endsWith('.excalidraw') || lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'application/yaml';
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'text/markdown; charset=utf-8';
  if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return svgContentType(bytes);
  return 'application/octet-stream';
}

export function validateFileSize(path: string, byteLength: number): void {
  if (isTextPath(path) && byteLength > MAX_SOURCE_TEXT_BYTES) {
    fail('INVALID_INPUT', 'Source text file exceeds 2 MiB.', { path, maxBytes: MAX_SOURCE_TEXT_BYTES });
  }
  if (isImagePath(path) && byteLength > MAX_IMAGE_BYTES) {
    fail('INVALID_INPUT', 'Image file exceeds 10 MiB.', { path, maxBytes: MAX_IMAGE_BYTES });
  }
}

function isTextPath(path: string): boolean {
  return /\.(?:atlas\.json|excalidraw|json|md|mdx|txt|yaml|yml)$/i.test(path);
}

function isImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|webp|svg)$/i.test(path);
}

export function validateKnownDocument(path: string, bytes: Uint8Array): void {
  const lower = path.toLowerCase();
  if (!lower.endsWith('.atlas.json') && !lower.endsWith('.excalidraw')) return;
  const text = decodeUtf8(bytes);
  if (text === undefined) fail('INVALID_INPUT', 'Versioned document is not valid UTF-8.', { path });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('INVALID_INPUT', 'Versioned document is malformed JSON.', { path });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_INPUT', 'Versioned document must be a JSON object.', { path });
  }
  const object = value as Record<string, unknown>;
  if (lower.endsWith('.atlas.json')) {
    if (object.schema !== 'atlas.board/v1') {
      fail('UNSUPPORTED_VERSION', 'Atlas document version is not supported.', { path, schema: object.schema });
    }
    try {
      assertBoardIntegrity(object);
    } catch (error) {
      fail('INVALID_INPUT', 'Atlas document does not match the canonical v1 schema or relationship integrity.', {
        path,
        cause: error instanceof Error ? error.message : 'invalid board'
      });
    }
  } else if (object.type !== 'excalidraw' || object.version !== 2) {
    fail('UNSUPPORTED_VERSION', 'Excalidraw scene version is not supported.', { path, version: object.version });
  }
}

function validateManifest(value: unknown): BundleManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', 'Bundle manifest must be an object.');
  const item = value as Record<string, unknown>;
  const allowedKeys = ['files', 'name', 'schema', 'sourceRevision', 'workspaceId'];
  if (Object.keys(item).some(key => !allowedKeys.includes(key)) || allowedKeys.some(key => !(key in item))) {
    fail('INVALID_INPUT', 'Bundle manifest fields do not match atlas.bundle/v1.');
  }
  if (item.schema !== BUNDLE_SCHEMA) {
    fail('UNSUPPORTED_VERSION', 'Bundle schema version is not supported.', { schema: item.schema });
  }
  if (typeof item.workspaceId !== 'string' || typeof item.name !== 'string' || typeof item.sourceRevision !== 'string' || !Array.isArray(item.files)) {
    fail('INVALID_INPUT', 'Bundle manifest fields are malformed.');
  }
  validateWorkspaceId(item.workspaceId);
  validateWorkspaceName(item.name);
  if (!/^[a-f0-9]{64}$/.test(item.sourceRevision)) fail('INVALID_INPUT', 'Manifest workspace revision is malformed.');
  if (item.files.length > MAX_WORKSPACE_FILES) fail('INVALID_INPUT', 'Bundle manifest lists too many payload files.');
  const files = item.files.map((file, index) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      fail('INVALID_INPUT', 'Manifest file entry is malformed.', { index });
    }
    const record = file as Record<string, unknown>;
    if (Object.keys(record).some(key => !['bytes', 'path', 'sha256'].includes(key)) || Object.keys(record).length !== 3) {
      fail('INVALID_INPUT', 'Manifest file entry fields are invalid.', { index });
    }
    if (typeof record.path !== 'string' || typeof record.sha256 !== 'string' || typeof record.bytes !== 'number') {
      fail('INVALID_INPUT', 'Manifest file entry fields are malformed.', { index });
    }
    return { path: record.path, sha256: record.sha256, bytes: record.bytes };
  });
  return {
    schema: BUNDLE_SCHEMA,
    workspaceId: item.workspaceId,
    name: item.name,
    sourceRevision: item.sourceRevision,
    files
  };
}

function validateArchiveEntries(archive: Uint8Array, entries: CentralEntry[]): void {
  const names = new Set<string>();
  const foldedNames = new Set<string>();
  const localOffsets = new Set<number>();
  const dataRanges: Array<{ start: number; end: number }> = [];
  for (const entry of entries) {
    const path = validateZipEntryName(entry.name);
    const folded = caseFoldPath(path);
    if (names.has(path) || foldedNames.has(folded)) fail('INVALID_PATH', 'ZIP contains duplicate or case-colliding paths.', { path });
    names.add(path);
    foldedNames.add(folded);
    if (entry.flags & (0x0001 | 0x0020 | 0x0040 | 0x2000)) fail('INVALID_INPUT', 'Encrypted or patched ZIP entries are not supported.');
    if (entry.method !== 0 && entry.method !== 8) fail('INVALID_INPUT', 'ZIP compression method is not supported.', { method: entry.method });
    if (entry.uncompressedBytes > MAX_BUNDLE_EXPANDED_BYTES) fail('INVALID_INPUT', 'ZIP entry exceeds the expanded size limit.', { path });
    if (!Number.isSafeInteger(entry.uncompressedBytes) || !Number.isSafeInteger(entry.compressedBytes)) {
      fail('INVALID_INPUT', 'ZIP entry size is outside the supported range.', { path });
    }
    if (entry.uncompressedBytes > 0 && entry.compressedBytes === 0) fail('INVALID_INPUT', 'ZIP entry has an invalid compressed size.', { path });
    if (entry.localOffset < 0 || entry.dataOffset < entry.localOffset || entry.dataEnd > archive.byteLength) {
      fail('INVALID_INPUT', 'ZIP entry offset is outside the archive.', { path });
    }
    if (localOffsets.has(entry.localOffset)) fail('INVALID_INPUT', 'ZIP entries share a local header.');
    localOffsets.add(entry.localOffset);
    if (isSymlink(entry)) fail('INVALID_INPUT', 'ZIP symbolic links are not supported.', { path });
    const reader = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const localSignature = reader.getUint32(entry.localOffset, true);
    if (localSignature !== 0x04034b50) fail('INVALID_INPUT', 'ZIP local file header is malformed.', { path });
    const localFlags = reader.getUint16(entry.localOffset + 6, true);
    const localMethod = reader.getUint16(entry.localOffset + 8, true);
    const localNameLength = reader.getUint16(entry.localOffset + 26, true);
    const localExtraLength = reader.getUint16(entry.localOffset + 28, true);
    if (localFlags !== entry.flags || localMethod !== entry.method) fail('INVALID_INPUT', 'ZIP local and central headers disagree.', { path });
    const localNameStart = entry.localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const expectedDataOffset = localNameEnd + localExtraLength;
    if (localNameEnd > archive.byteLength || expectedDataOffset !== entry.dataOffset) {
      fail('INVALID_INPUT', 'ZIP local header lengths are invalid.', { path });
    }
    const localName = archive.subarray(localNameStart, localNameEnd);
    if (!bytesEqual(localName, entry.rawName)) fail('INVALID_INPUT', 'ZIP local path does not match its central path.', { path });
    const descriptor = Boolean(entry.flags & 0x0008);
    if (!descriptor) {
      const localCompressed = reader.getUint32(entry.localOffset + 18, true);
      const localUncompressed = reader.getUint32(entry.localOffset + 22, true);
      if (localCompressed !== entry.compressedBytes || localUncompressed !== entry.uncompressedBytes) {
        fail('INVALID_INPUT', 'ZIP local and central sizes disagree.', { path });
      }
    }
    dataRanges.push({ start: entry.dataOffset, end: entry.dataEnd });
  }
  dataRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < dataRanges.length; index += 1) {
    const previous = dataRanges[index - 1];
    const current = dataRanges[index];
    if (previous && current && previous.end > current.start) fail('INVALID_INPUT', 'ZIP entry data ranges overlap.');
  }
}

function validateZipEntryName(name: string): string {
  if (name === MANIFEST_PATH) return name;
  if (!name.startsWith(WORKSPACE_PREFIX)) fail('INVALID_PATH', 'Bundle ZIP contains a path outside its workspace root.', { path: name });
  const path = name.slice(WORKSPACE_PREFIX.length);
  return `${WORKSPACE_PREFIX}${validateWorkspacePayloadPath(path)}`;
}

function isSymlink(entry: CentralEntry): boolean {
  if (entry.madeBy === 3) {
    const mode = entry.externalAttributes >>> 16;
    const type = mode & 0o170000;
    if (type !== 0 && type !== 0o100000) return true;
  }
  return Boolean(entry.externalAttributes & 0x10);
}

function parseCentralDirectory(archive: Uint8Array): CentralEntry[] {
  if (archive.byteLength < 22) fail('INVALID_INPUT', 'ZIP archive is truncated.');
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  const commentLength = view.getUint16(eocdOffset + 20, true);
  if (eocdOffset + 22 + commentLength !== archive.byteLength) fail('INVALID_INPUT', 'ZIP archive has trailing or truncated data.');

  let entryCount = view.getUint16(eocdOffset + 10, true);
  let centralSize = view.getUint32(eocdOffset + 12, true);
  let centralOffset = view.getUint32(eocdOffset + 16, true);
  let directoryEnd = eocdOffset;
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    const locatorOffset = eocdOffset - 20;
    if (locatorOffset < 0 || view.getUint32(locatorOffset, true) !== 0x07064b50) fail('INVALID_INPUT', 'ZIP64 locator is missing.');
    if (view.getUint32(locatorOffset + 4, true) !== 0 || view.getUint32(locatorOffset + 16, true) !== 1) {
      fail('INVALID_INPUT', 'Multi-disk ZIP64 archives are not supported.');
    }
    const zip64Offset = readSafeUint64(view, locatorOffset + 8);
    if (zip64Offset + 56 > locatorOffset || view.getUint32(zip64Offset, true) !== 0x06064b50) {
      fail('INVALID_INPUT', 'ZIP64 end record is malformed.');
    }
    const zip64RecordSize = readSafeUint64(view, zip64Offset + 4);
    if (zip64RecordSize < 44 || zip64Offset + 12 + zip64RecordSize !== locatorOffset) {
      fail('INVALID_INPUT', 'ZIP64 end record length is malformed.');
    }
    if (view.getUint32(zip64Offset + 16, true) !== 0 || view.getUint32(zip64Offset + 20, true) !== 0) {
      fail('INVALID_INPUT', 'Multi-disk ZIP64 archives are not supported.');
    }
    const entriesOnDisk = readSafeUint64(view, zip64Offset + 24);
    const totalEntries = readSafeUint64(view, zip64Offset + 32);
    if (entriesOnDisk !== totalEntries) fail('INVALID_INPUT', 'ZIP64 entry counts disagree.');
    entryCount = totalEntries;
    centralSize = readSafeUint64(view, zip64Offset + 40);
    centralOffset = readSafeUint64(view, zip64Offset + 48);
    directoryEnd = zip64Offset;
  }
  if (view.getUint16(eocdOffset + 4, true) !== 0 || view.getUint16(eocdOffset + 6, true) !== 0) {
    fail('INVALID_INPUT', 'Multi-disk ZIP archives are not supported.');
  }
  if (entryCount > MAX_BUNDLE_ENTRIES || centralOffset + centralSize !== directoryEnd || centralOffset > archive.byteLength) {
    fail('INVALID_INPUT', 'ZIP central directory bounds or entry count are invalid.');
  }

  const entries: CentralEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) {
      fail('INVALID_INPUT', 'ZIP central directory entry is malformed.', { index });
    }
    const madeBy = view.getUint16(offset + 4, true) >>> 8;
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    let compressedBytes = view.getUint32(offset + 20, true);
    let uncompressedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const diskNumber = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    let localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const extraStart = nameEnd;
    const extraEnd = extraStart + extraLength;
    const recordEnd = extraEnd + entryCommentLength;
    if (nameLength === 0 || recordEnd > directoryEnd || diskNumber !== 0) {
      fail('INVALID_INPUT', 'ZIP central directory entry lengths or disk number are invalid.', { index });
    }
    const rawName = archive.slice(nameStart, nameEnd);
    if (!(flags & 0x0800) && rawName.some(byte => byte > 0x7f)) fail('INVALID_INPUT', 'Non-ASCII ZIP paths must set the UTF-8 flag.');
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawName);
    } catch {
      fail('INVALID_PATH', 'ZIP path is not valid UTF-8.');
    }
    if (name.includes('\0')) fail('INVALID_PATH', 'ZIP paths must not contain NUL.');
    const extraFields = parseExtraFields(archive.subarray(extraStart, extraEnd));
    const sentinelCompressed = compressedBytes === 0xffffffff;
    const sentinelUncompressed = uncompressedBytes === 0xffffffff;
    const sentinelOffset = localOffset === 0xffffffff;
    if (sentinelCompressed || sentinelUncompressed || sentinelOffset) {
      const zip64 = extraFields.get(0x0001);
      if (!zip64) fail('INVALID_INPUT', 'ZIP64 entry is missing its size metadata.', { path: name });
      let zip64Offset = 0;
      if (sentinelUncompressed) {
        uncompressedBytes = readSafeUint64(new DataView(zip64.buffer, zip64.byteOffset, zip64.byteLength), zip64Offset);
        zip64Offset += 8;
      }
      if (sentinelCompressed) {
        compressedBytes = readSafeUint64(new DataView(zip64.buffer, zip64.byteOffset, zip64.byteLength), zip64Offset);
        zip64Offset += 8;
      }
      if (sentinelOffset) localOffset = readSafeUint64(new DataView(zip64.buffer, zip64.byteOffset, zip64.byteLength), zip64Offset);
    }
    const localHeaderEnd = localOffset + 30;
    if (localHeaderEnd > centralOffset) fail('INVALID_INPUT', 'ZIP local header overlaps the central directory.', { path: name });
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localHeaderEnd + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedBytes;
    if (dataOffset > centralOffset || dataEnd > centralOffset) fail('INVALID_INPUT', 'ZIP entry data overlaps the central directory.', { path: name });
    entries.push({
      name,
      rawName,
      flags,
      method,
      crc,
      compressedBytes,
      uncompressedBytes,
      localOffset,
      dataOffset,
      dataEnd,
      externalAttributes,
      madeBy
    });
    offset = recordEnd;
  }
  if (offset !== directoryEnd) fail('INVALID_INPUT', 'ZIP central directory has unaccounted bytes.');
  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  fail('INVALID_INPUT', 'ZIP end of central directory record is missing.');
}

function parseExtraFields(bytes: Uint8Array): Map<number, Uint8Array> {
  const fields = new Map<number, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) fail('INVALID_INPUT', 'ZIP extra field is truncated.');
    const id = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const start = offset + 4;
    const end = start + length;
    if (end > bytes.byteLength || fields.has(id)) fail('INVALID_INPUT', 'ZIP extra field length or ID is invalid.');
    fields.set(id, bytes.slice(start, end));
    offset = end;
  }
  return fields;
}

function readSafeUint64(view: DataView, offset: number): number {
  if (offset < 0 || offset + 8 > view.byteLength) fail('INVALID_INPUT', 'ZIP64 integer is truncated.');
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_INPUT', 'ZIP64 value exceeds the supported size.');
  return Number(value);
}

function extractBounded(archive: Uint8Array, entries: CentralEntry[]): Map<string, Uint8Array> {
  let declaredExpandedBytes = 0;
  const centralByName = new Map(entries.map(entry => [entry.name, entry]));
  if (centralByName.size !== entries.length) fail('INVALID_PATH', 'ZIP contains duplicate entries.');
  for (const entry of entries) {
    declaredExpandedBytes += entry.uncompressedBytes;
    if (declaredExpandedBytes > MAX_BUNDLE_EXPANDED_BYTES) fail('INVALID_INPUT', 'ZIP exceeds the expanded size limit.');
  }

  const output = new Map<string, Uint8Array>();
  const chunkLists = new Map<string, Uint8Array[]>();
  const actualSizes = new Map<string, number>();
  let actualExpandedBytes = 0;
  let failure: unknown;
  const unzipper = new Unzip(file => {
    if (failure) {
      file.terminate();
      return;
    }
    const expected = centralByName.get(file.name);
    if (!expected || output.has(file.name) || file.compression !== expected.method) {
      failure = new Error('ZIP stream entries do not match the validated central directory.');
      file.terminate();
      return;
    }
    const chunks: Uint8Array[] = [];
    chunkLists.set(file.name, chunks);
    let fileSize = 0;
    file.ondata = (error, chunk, final) => {
      if (error) {
        failure = error;
        file.terminate();
        return;
      }
      if (chunk) {
        fileSize += chunk.byteLength;
        actualExpandedBytes += chunk.byteLength;
        if (fileSize > expected.uncompressedBytes || actualExpandedBytes > MAX_BUNDLE_EXPANDED_BYTES) {
          failure = new Error('ZIP stream exceeded its declared expanded size.');
          file.terminate();
          return;
        }
        chunks.push(chunk.slice());
      }
      if (final) {
        if (fileSize !== expected.uncompressedBytes) {
          failure = new Error('ZIP stream size does not match the central directory.');
          file.terminate();
          return;
        }
        actualSizes.set(file.name, fileSize);
        const combined = new Uint8Array(fileSize);
        let targetOffset = 0;
        for (const part of chunks) {
          combined.set(part, targetOffset);
          targetOffset += part.byteLength;
        }
        if (crc32(combined) !== expected.crc) {
          failure = new Error('ZIP entry CRC does not match.');
          file.terminate();
          return;
        }
        output.set(file.name, combined);
      }
    };
    try {
      file.start();
    } catch (error) {
      failure = error;
      file.terminate();
    }
  });
  unzipper.register(UnzipPassThrough);
  unzipper.register(UnzipInflate);
  try {
    unzipper.push(archive, true);
  } catch (error) {
    failure ??= error;
  }
  if (failure) fail('INVALID_INPUT', 'ZIP decompression failed validation.', { cause: failure instanceof Error ? failure.message : 'unknown' });
  if (output.size !== entries.length || actualExpandedBytes !== declaredExpandedBytes || actualSizes.size !== entries.length) {
    fail('INVALID_INPUT', 'ZIP extraction did not produce all declared entries.');
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
