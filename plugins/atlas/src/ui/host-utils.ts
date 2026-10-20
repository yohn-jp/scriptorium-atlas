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
      throw new Error('Atlasのファイル一覧を読み込む間に、ワークスペースID、エポック、またはソースリビジョンが変わりました。更新して再試行してください。');
    }
    workspace = page.workspace;
    for (const file of page.files) {
      if (files.has(file.path)) throw new Error(`Hostの複数ページに同じファイル ${file.path} が含まれています。`);
      files.set(file.path, file);
    }
    if (page.complete && page.nextCursor === null) return { workspace, files };
    if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error('Hostから未完了または重複したワークスペースカーソルが返されました。');
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('Hostワークスペースのファイル一覧がページ上限を超えました。');
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
    throw new Error(`Hostファイル ${file.path} がAtlasの10 MiBファイル上限を超えています。`);
  }
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < file.byteLength || (file.byteLength === 0 && offset === 0)) {
    const response = await host.read({ path: file.path, expectedRevision: file.revision, offset, limit: Math.min(4 * 1024 * 1024, file.byteLength - offset || 1) });
    if (response.workspaceId !== file.workspaceId || response.path !== file.path || response.revision !== file.revision) {
      throw new Error(`Hostから返された ${file.path} のワークスペースまたはリビジョンが一致しません。`);
    }
    if (!('complete' in response)) {
      const result = fileBytes(response);
      if (result.length !== file.byteLength) throw new Error(`Hostから返された ${file.path} は${result.length}バイトです（期待値: ${file.byteLength}バイト）。`);
      return result;
    }
    if (response.offset !== offset || response.nextOffset < offset || response.nextOffset > file.byteLength || (response.nextOffset === offset && !response.complete)) {
      throw new Error(`Hostから返された ${file.path} の読み込みチャンクに欠落があります。`);
    }
    const binary = atob(response.content);
    const chunk = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (chunk.length !== response.nextOffset - response.offset) throw new Error(`Hostから返された ${file.path} のチャンク長が不正です。`);
    chunks.push(chunk);
    offset = response.nextOffset;
    if (response.complete) {
      const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
      let cursor = 0;
      for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
      if (result.length !== file.byteLength) throw new Error(`Hostから返された ${file.path} は不完全です。`);
      return result;
    }
  }
  if (file.byteLength === 0) return new Uint8Array();
  throw new Error(`Hostファイル ${file.path} の分割読み込みが完了しませんでした。`);
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
