import type { SnapshotFileMetadata, VersionedFile, WorkspaceSnapshotFile } from './generated/types.js';

export function hasSnapshotContent(file: WorkspaceSnapshotFile): file is VersionedFile {
  return Object.hasOwn(file, 'content');
}

export function isSnapshotFileMetadata(file: WorkspaceSnapshotFile): file is SnapshotFileMetadata {
  return !hasSnapshotContent(file);
}

export function decodeVersionedFile(file: VersionedFile): Uint8Array {
  if (file.encoding === 'utf8') return new TextEncoder().encode(file.content);
  const binary = globalThis.atob(file.content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function decodeVersionedFileText(file: VersionedFile): string {
  if (file.encoding !== 'utf8') throw new TypeError('The versioned file is base64 encoded, not UTF-8 text.');
  return new TextDecoder('utf-8', { fatal: true }).decode(decodeVersionedFile(file));
}
