import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, BoardDocument } from '@scriptorium-atlas/contracts';
import { applyAtlasCommand, createEmptyAtlasBoard } from '../commands/model.js';
import { sha256Hex } from './host-utils.js';
import { buildAtlasCardExportOverlay } from './card-export.js';

const pngBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/az8AAAAASUVORK5CYII='), (char) => char.charCodeAt(0));

function cardBase(id: string) {
  return { id, position: { x: 10, y: 20 }, width: 280, height: 180 } as const;
}

async function boardWithEveryCard(): Promise<{ board: BoardDocument; asset: Asset }> {
  const digest = await sha256Hex(pngBytes);
  const asset: Asset = {
    id: 'asset-export',
    path: `documents/assets/${digest}.png`,
    sha256: digest,
    bytes: pngBytes.byteLength,
    mime: 'image/png',
  };
  let board = createEmptyAtlasBoard('Export cards');
  board = applyAtlasCommand(board, {
    type: 'card.create',
    card: { ...cardBase('text-card'), kind: 'text', text: 'A Markdown note', annotation: 'Visible note metadata' },
  });
  board = applyAtlasCommand(board, {
    type: 'card.create',
    card: {
      ...cardBase('source-card'), kind: 'source', text: 'Pinned source excerpt', annotation: 'Quoted passage',
      source: { workspaceId: 'workspace-a', path: 'documents/source.md', revision: 'rev-123' },
    },
  });
  board = applyAtlasCommand(board, {
    type: 'card.create',
    card: {
      ...cardBase('provider-card'), kind: 'provider-node', text: 'Alice',
      nodeRef: { providerId: 'scriptorium.story', localId: 'character-1' }, annotation: 'Provider annotation',
    },
  });
  board = applyAtlasCommand(board, {
    type: 'card.create',
    card: {
      ...cardBase('image-card'), kind: 'image', assetId: asset.id, annotation: 'Cover image',
      source: { workspaceId: 'workspace-a', path: 'documents/cover-note.md', revision: 'rev-cover' },
    },
    asset,
  });
  return { board, asset };
}

afterEach(() => vi.unstubAllGlobals());

describe('Atlas card image export overlay', () => {
  it('converts every card kind and embeds verified image bytes for official Canvas export', async () => {
    vi.stubGlobal('Image', class {
      naturalWidth = 640;
      naturalHeight = 480;
      src = '';
      async decode(): Promise<void> {}
    });
    const { board, asset } = await boardWithEveryCard();
    const before = structuredClone(board);
    const result = await buildAtlasCardExportOverlay(board, async () => pngBytes);

    expect(result.unavailableImagePaths).toEqual([]);
    expect(result.overlay.elements).toHaveLength(13);
    const bodyText = result.overlay.elements
      .filter((element) => element.type === 'text')
      .map((element) => element.type === 'text' ? element.text : '')
      .join('\n');
    expect(bodyText).toContain('A Markdown note');
    expect(bodyText).toContain('Pinned source excerpt');
    expect(bodyText).toContain('documents/source.md');
    expect(bodyText).toContain('scriptorium.story/character-1');
    expect(bodyText).toContain('documents/cover-note.md');
    const imageElement = result.overlay.elements.find((element) => element.type === 'image');
    expect(imageElement?.type === 'image' ? imageElement.fileId : null).toBe(result.overlay.files?.[0]?.id);
    expect(result.overlay.files?.[0]).toMatchObject({
      mimeType: asset.mime,
      dataURL: expect.stringMatching(/^data:image\/png;base64,/),
    });
    expect(board).toEqual(before);
  });

  it('keeps a visible placeholder when a referenced image asset is unavailable', async () => {
    const { board, asset } = await boardWithEveryCard();
    const result = await buildAtlasCardExportOverlay(board, async () => { throw new Error('missing'); });
    expect(result.unavailableImagePaths).toEqual([asset.path]);
    expect(result.overlay.files).toBeUndefined();
    expect(result.overlay.elements.some((element) => element.type === 'text' && element.text.includes(asset.path))).toBe(true);
    expect(result.overlay.elements.some((element) => element.type === 'text' && element.text.includes('documents/cover-note.md'))).toBe(true);
  });
});
