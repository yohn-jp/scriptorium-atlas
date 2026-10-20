import type { Asset, BoardDocument } from '@scriptorium-atlas/contracts';
import type { CanvasExportElementSkeleton, CanvasExportFile, CanvasExportOverlay } from '@scriptorium-atlas/canvas/io';
import { imageDataUrl } from './host-utils.js';
import { sanitizeImageBytes, verifyAssetBytes } from './asset-media.js';

export type AtlasCardAssetReader = (asset: Asset) => Promise<Uint8Array>;

export type AtlasCardExportResult = {
  overlay: CanvasExportOverlay;
  unavailableImagePaths: string[];
};

function cardHeading(card: BoardDocument['cards'][number]): string {
  switch (card.kind) {
    case 'text': return 'Markdown';
    case 'source': return 'Source';
    case 'provider-node': return 'Provider node';
    case 'image': return card.annotation?.trim() ? `Image · ${card.annotation.trim()}` : 'Image';
  }
}

function cardBody(card: BoardDocument['cards'][number]): string {
  const source = card.source ? `${card.source.path}\nRevision ${card.source.revision}` : '';
  switch (card.kind) {
    case 'text':
      return [card.text, card.annotation].filter((value): value is string => Boolean(value?.trim())).join('\n\n');
    case 'source':
      return [card.text, card.annotation, source].filter((value): value is string => Boolean(value?.trim())).join('\n\n');
    case 'provider-node': {
      const reference = card.nodeRef ? `${card.nodeRef.providerId}/${card.nodeRef.localId}` : '';
      return [card.text ?? card.nodeRef?.localId, reference, card.annotation, source]
        .filter((value): value is string => Boolean(value?.trim())).join('\n\n');
    }
    case 'image':
      return source;
  }
}

function appendCardFrame(
  elements: CanvasExportElementSkeleton[],
  card: BoardDocument['cards'][number],
): void {
  const { x, y } = card.position;
  elements.push({
    type: 'rectangle',
    x,
    y,
    width: card.width,
    height: card.height,
    strokeColor: '#b8a688',
    backgroundColor: '#fffdf5',
    fillStyle: 'solid',
    strokeWidth: 1,
    roughness: 0,
  });
  elements.push({
    type: 'rectangle',
    x: x + 1,
    y: y + 1,
    width: Math.max(1, card.width - 2),
    height: 30,
    strokeColor: '#e1d9cb',
    backgroundColor: '#f5eee0',
    fillStyle: 'solid',
    strokeWidth: 1,
    roughness: 0,
    label: {
      text: cardHeading(card),
      fontSize: 12,
      textAlign: 'left',
      verticalAlign: 'middle',
    },
  });
}

function appendCardText(
  elements: CanvasExportElementSkeleton[],
  card: BoardDocument['cards'][number],
  text: string,
  y = card.position.y + 38,
): void {
  if (!text) return;
  elements.push({
    type: 'text',
    x: card.position.x + 8,
    y,
    width: Math.max(1, card.width - 16),
    text,
    fontSize: 12,
    strokeColor: '#302a23',
    textAlign: 'left',
    verticalAlign: 'top',
  });
}

function fitImageInCard(
  imageSize: { width: number; height: number },
  card: BoardDocument['cards'][number],
): { x: number; y: number; width: number; height: number } {
  if (imageSize.width <= 0 || imageSize.height <= 0) throw new Error('Image dimensions are unavailable.');
  const footerHeight = card.source ? 34 : 0;
  const bounds = { width: Math.max(1, card.width - 12), height: Math.max(1, card.height - 42 - footerHeight) };
  const scale = Math.min(bounds.width / imageSize.width, bounds.height / imageSize.height);
  const width = imageSize.width * scale;
  const height = imageSize.height * scale;
  return {
    x: card.position.x + (card.width - width) / 2,
    y: card.position.y + 32 + (bounds.height - height) / 2,
    width,
    height,
  };
}

/** Converts Atlas-only card overlays into temporary official Canvas export elements. */
export async function buildAtlasCardExportOverlay(
  board: BoardDocument,
  readAsset: AtlasCardAssetReader,
): Promise<AtlasCardExportResult> {
  const elements: CanvasExportElementSkeleton[] = [];
  const files: CanvasExportFile[] = [];
  const imageCache = new Map<string, Promise<{ file: CanvasExportFile; width: number; height: number }>>();
  const includedFileIds = new Set<string>();
  const unavailableImagePaths: string[] = [];

  for (const card of board.cards) {
    appendCardFrame(elements, card);
    if (card.kind !== 'image') {
      appendCardText(elements, card, cardBody(card));
      continue;
    }

    const asset = board.assets.find((item) => item.id === card.assetId);
    if (!asset) {
      unavailableImagePaths.push(card.assetId ?? card.id);
      appendCardText(elements, card, 'Image asset is missing.');
      if (card.source) appendCardText(elements, card, cardBody(card), card.position.y + card.height - 30);
      continue;
    }

    try {
      let image = imageCache.get(asset.id);
      if (!image) {
        image = (async () => {
          const originalBytes = await readAsset(asset);
          await verifyAssetBytes(asset, originalBytes);
          const safeBytes = sanitizeImageBytes(originalBytes, asset.mime);
          const dataURL = imageDataUrl(safeBytes, asset.mime);
          const probe = new Image();
          probe.src = dataURL;
          await probe.decode();
          return {
            file: { id: `atlas-export-${crypto.randomUUID()}`, mimeType: asset.mime, dataURL },
            width: probe.naturalWidth,
            height: probe.naturalHeight,
          };
        })();
        imageCache.set(asset.id, image);
      }
      const prepared = await image;
      if (!includedFileIds.has(prepared.file.id)) {
        files.push(prepared.file);
        includedFileIds.add(prepared.file.id);
      }
      const bounds = fitImageInCard(prepared, card);
      elements.push({ type: 'image', ...bounds, fileId: prepared.file.id });
      if (card.source) appendCardText(elements, card, cardBody(card), card.position.y + card.height - 30);
    } catch {
      unavailableImagePaths.push(asset.path);
      appendCardText(elements, card, `Image asset is unavailable: ${asset.path}`);
      if (card.source) appendCardText(elements, card, cardBody(card), card.position.y + card.height - 30);
    }
  }

  return {
    overlay: { elements, ...(files.length ? { files } : {}) },
    unavailableImagePaths,
  };
}
