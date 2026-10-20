import type { PluginHostClient, VersionedFile, WorkspaceSnapshotPage } from '@scriptorium-atlas/contracts';

export type WorkspaceFile = WorkspaceSnapshotPage['files'][number];

export async function readWorkspaceSnapshot(host: PluginHostClient): Promise<{
  workspace: WorkspaceSnapshotPage['workspace'];
  files: Map<string, WorkspaceFile>;
}> {
  const files = new Map<string, WorkspaceFile>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let workspace: WorkspaceSnapshotPage['workspace'] | undefined;
  for (let pageNumber = 0; pageNumber < 100_000; pageNumber += 1) {
    const page = await host.snapshot({ ...(cursor ? { cursor } : {}), limit: 500 });
    if (workspace && (page.workspace.workspaceId !== workspace.workspaceId
      || page.workspace.epoch !== workspace.epoch
      || page.workspace.sourceRevision !== workspace.sourceRevision)) {
      throw new Error('Workspace identity, epoch, or source revision changed while the Atlas inventory was loading. Refresh and try again.');
    }
    workspace = page.workspace;
    for (const file of page.files) {
      if (files.has(file.path)) throw new Error(`Host repeated ${file.path} across workspace pages.`);
      files.set(file.path, file);
    }
    if (page.complete && page.nextCursor === null) return { workspace, files };
    if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error('Host returned an incomplete or repeated workspace cursor.');
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('Workspace inventory exceeded the Host pagination limit.');
}

export function decodeFileText(file: VersionedFile): string {
  if (file.encoding === 'utf8') return file.content;
  const binary = atob(file.content);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function fileBytes(file: VersionedFile): Uint8Array {
  if (file.encoding === 'base64') {
    const binary = atob(file.content);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return new TextEncoder().encode(file.content);
}

export async function readFileBytes(host: PluginHostClient, file: WorkspaceFile): Promise<Uint8Array> {
  if ('content' in file) return fileBytes(file);
  if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || file.byteLength > 10 * 1024 * 1024) {
    throw new Error(`Host file ${file.path} exceeds the Atlas 10 MiB file limit.`);
  }
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < file.byteLength || (file.byteLength === 0 && offset === 0)) {
    const response = await host.read({ path: file.path, expectedRevision: file.revision, offset, limit: Math.min(4 * 1024 * 1024, file.byteLength - offset || 1) });
    if (response.workspaceId !== file.workspaceId || response.path !== file.path || response.revision !== file.revision) {
      throw new Error(`Host returned a different workspace file or revision for ${file.path}.`);
    }
    if (!('complete' in response)) {
      const result = fileBytes(response);
      if (result.length !== file.byteLength) throw new Error(`Host returned ${result.length} bytes for ${file.path}; expected ${file.byteLength}.`);
      return result;
    }
    if (response.offset !== offset || response.nextOffset < offset || response.nextOffset > file.byteLength || (response.nextOffset === offset && !response.complete)) {
      throw new Error(`Host returned a discontinuous read chunk for ${file.path}.`);
    }
    const binary = atob(response.content);
    const chunk = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (chunk.length !== response.nextOffset - response.offset) throw new Error(`Host returned a malformed chunk length for ${file.path}.`);
    chunks.push(chunk);
    offset = response.nextOffset;
    if (response.complete) {
      const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
      let cursor = 0;
      for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
      if (result.length !== file.byteLength) throw new Error(`Host returned an incomplete file for ${file.path}.`);
      return result;
    }
  }
  if (file.byteLength === 0) return new Uint8Array();
  throw new Error(`Host file ${file.path} did not complete its chunked read.`);
}

export async function readFileText(host: PluginHostClient, file: WorkspaceFile): Promise<string> {
  if ('content' in file) return decodeFileText(file);
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFileBytes(host, file));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const ownedBytes = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  ownedBytes.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', ownedBytes.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function downloadText(filename: string, text: string, contentType = 'application/json;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: contentType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function imageDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}
