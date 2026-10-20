import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  assertBoardIntegrity,
  decodeVersionedFile,
  decodeVersionedFileText,
  validateBundleManifest,
  validateAssetChunk,
  validateBoard,
  validateBoardIntegrity,
  validateHostRpcRequest,
  validateNodeRef,
  validateProviderRpcRequest,
  validateProviderRpcResponse,
  validateWorkspaceSnapshotPage,
} from '../src/index.js';
import type { VersionedFile } from '../src/index.js';
import type { BundleManifest } from '../src/index.js';

const boardFixtureUrl = new URL('../../../docs/contracts/examples/board.json', import.meta.url);

describe('schema-backed contracts', () => {
  it('validates the exact atlas.bundle/v1 manifest shape', () => {
    const manifest: BundleManifest = {
      schema: 'atlas.bundle/v1',
      workspaceId: 'workspace-1',
      name: 'Research notebook',
      sourceRevision: 'a'.repeat(64),
      files: [{ path: 'notes.md', sha256: 'b'.repeat(64), bytes: 0 }],
    };
    expect(validateBundleManifest(manifest)).toBe(true);
    expect(validateBundleManifest({ ...manifest, unexpected: true })).toBe(false);
    expect(validateBundleManifest({ ...manifest, schema: 'atlas.bundle/v2' })).toBe(false);
    expect(validateBundleManifest({ ...manifest, sourceRevision: 'not-a-sha256' })).toBe(false);
    expect(validateBundleManifest({ ...manifest, name: '   ' })).toBe(false);
    expect(validateBundleManifest({ ...manifest, files: [{ ...manifest.files[0], sha256: 'bad' }] })).toBe(false);
    expect(validateBundleManifest({ ...manifest, files: [{ ...manifest.files[0], bytes: -1 }] })).toBe(false);
    expect(validateBundleManifest({ ...manifest, files: [{ path: 'notes.md', sha256: 'b'.repeat(64) }] })).toBe(false);
  });

  it('accepts the canonical Board fixture and rejects invalid integrity relationships', async () => {
    const board: unknown = JSON.parse(await readFile(boardFixtureUrl, 'utf8'));
    expect(validateBoard(board)).toBe(true);
    expect(validateBoardIntegrity(board)).toBe(true);
    expect(() => assertBoardIntegrity(board)).not.toThrow();

    const invalid = structuredClone(board) as {
      views: Array<{ timeline?: { range: { start: number; end: number } } }>;
    };
    const timeline = invalid.views.find(({ timeline: viewTimeline }) => viewTimeline)?.timeline;
    expect(timeline).toBeDefined();
    timeline!.range.start = 10;
    timeline!.range.end = 1;
    expect(validateBoard(invalid)).toBe(true);
    expect(validateBoardIntegrity(invalid)).toBe(false);
  });

  it('requires the host RPC discriminator and validates handle-bound provider envelopes', () => {
    const hostRequest = {
      protocolVersion: 'atlas.host/v1',
      callId: 'call-1',
      epoch: 0,
      method: 'list',
      params: {},
      type: 'atlas.host.request',
    };
    expect(validateHostRpcRequest(hostRequest)).toBe(true);
    expect(validateHostRpcRequest({ ...hostRequest, type: undefined })).toBe(false);
    expect(validateHostRpcRequest({ ...hostRequest, type: 'wrong' })).toBe(false);

    const providerRequest = {
      type: 'atlas.provider.request',
      protocolVersion: 'atlas.graph/v1',
      requestId: 'provider:1',
      providerId: 'scriptorium.story-knowledge',
      epoch: 0,
      deadline: 1000,
      handle: 'lease-handle',
      payload: { method: 'getNodes', params: { handle: 'lease-handle', refs: [] } },
    };
    expect(validateProviderRpcRequest(providerRequest)).toBe(true);
    expect(validateProviderRpcRequest({ ...providerRequest, handle: undefined })).toBe(false);
    expect(validateProviderRpcRequest({ ...providerRequest, handle: undefined, payload: {
      method: 'open',
      params: {
        workspaceId: 'workspace-1',
        requestedSnapshot: { workspaceId: 'workspace-1', sourceRevision: 'source-1', providerRevision: 'provider-1', epoch: 0 },
        grants: [{ capability: 'graph.read' }],
        deadline: 1000,
      },
    } })).toBe(false);
    const { handle: _handle, ...openEnvelope } = providerRequest;
    expect(validateProviderRpcRequest({ ...openEnvelope, payload: {
      method: 'open',
      params: {
        workspaceId: 'workspace-1',
        requestedSnapshot: { workspaceId: 'workspace-1', sourceRevision: 'source-1', providerRevision: 'provider-1', epoch: 0 },
        grants: [{ capability: 'graph.read' }],
        deadline: 1000,
      },
    } })).toBe(true);
    const { handle: _cancelHandle, ...cancelEnvelope } = providerRequest;
    expect(validateProviderRpcRequest({ ...cancelEnvelope, payload: { method: 'cancel', params: { requestId: 'provider:1' } } })).toBe(true);
  });

  it('accepts metadata-only snapshot entries for files that need chunked reads', () => {
    const snapshot = {
      workspace: { workspaceId: 'workspace-1', sourceRevision: 'source-1', epoch: 1 },
      files: [{
        workspaceId: 'workspace-1',
        path: 'assets/photo.png',
        revision: 'sha256-1',
        contentType: 'image/png',
        updatedAt: '2026-10-20T00:00:00.000Z',
        byteLength: 10 * 1024 * 1024,
        encoding: 'base64',
      }],
      nextCursor: null,
      complete: true,
    };
    expect(validateWorkspaceSnapshotPage(snapshot)).toBe(true);
    expect(validateWorkspaceSnapshotPage({ ...snapshot, files: [{ ...snapshot.files[0], byteLength: -1 }] })).toBe(false);
  });

  it('binds provider replies to the lease except for open and pending-open cancellation', () => {
    const getNodesResponse = {
      type: 'atlas.provider.response',
      protocolVersion: 'atlas.graph/v1',
      requestId: 'provider:2',
      providerId: 'scriptorium.story-knowledge',
      epoch: 0,
      ok: true,
      method: 'getNodes',
      handle: 'lease-handle',
      result: {
        snapshot: { workspaceId: 'workspace-1', sourceRevision: 'source-1', providerRevision: 'provider-1', epoch: 0 },
        items: [],
        nextCursor: null,
        complete: true,
      },
    };
    expect(validateProviderRpcResponse(getNodesResponse)).toBe(true);
    expect(validateProviderRpcResponse({ ...getNodesResponse, handle: undefined })).toBe(false);

    const openResponse = {
      type: 'atlas.provider.response',
      protocolVersion: 'atlas.graph/v1',
      requestId: 'provider:open',
      providerId: 'scriptorium.story-knowledge',
      epoch: 0,
      ok: true,
      method: 'open',
      result: {
        handle: 'new-handle',
        actualSnapshot: { workspaceId: 'workspace-1', sourceRevision: 'source-1', providerRevision: 'provider-1', epoch: 0 },
        capabilities: ['graph.read'],
      },
    };
    const cancelResponse = { ...openResponse, requestId: 'provider:cancel', method: 'cancel', result: null };
    expect(validateProviderRpcResponse(openResponse)).toBe(true);
    expect(validateProviderRpcResponse(cancelResponse)).toBe(true);
  });

  it('bounds asset chunks and decodes UTF-8 and Base64 file content', () => {
    expect(validateAssetChunk({ uploadId: 'upload-1', offset: 0, content: 'aGVsbG8=' })).toBe(true);
    expect(validateAssetChunk({ uploadId: 'upload-1', offset: 0, content: '%%%not-base64%%%' })).toBe(false);

    const utf8: VersionedFile = {
      workspaceId: 'workspace-1',
      path: 'notes.md',
      revision: 'rev-1',
      content: '日本語',
      encoding: 'utf8',
      contentType: 'text/markdown',
      updatedAt: '2026-10-20T00:00:00.000Z',
    };
    const base64: VersionedFile = { ...utf8, content: '5pel5pys6Kqe', encoding: 'base64' };
    expect(decodeVersionedFileText(utf8)).toBe('日本語');
    expect(new TextDecoder().decode(decodeVersionedFile(base64))).toBe('日本語');
    expect(() => decodeVersionedFileText(base64)).toThrow(/base64/i);
  });

  it('uses standalone validators without runtime code generation', async () => {
    const generatedUrl = new URL('../src/generated/validators.runtime.js', import.meta.url);
    const source = await readFile(generatedUrl, 'utf8');
    expect(source).not.toMatch(/new Function|\beval\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(validateNodeRef({ providerId: 'story', localId: '😀'.repeat(256) })).toBe(true);
    expect(validateNodeRef({ providerId: 'story', localId: '😀'.repeat(257) })).toBe(false);
  });
});
