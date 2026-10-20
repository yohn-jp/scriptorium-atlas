import { useEffect, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { CanvasEditor } from '@scriptorium-atlas/canvas/ui';
import type { CanvasViewport } from '@scriptorium-atlas/canvas/ui';
import type { BoardDocument, BoardView, SourceRef } from '@scriptorium-atlas/contracts';
import { applyAtlasCommand } from '../commands/model.js';

export type FreeformViewProps = {
  board: BoardDocument;
  view: BoardView;
  sceneText: string;
  assets: ReadonlyMap<string, string>;
  focusCardId?: string | null;
  onBoardChange(board: BoardDocument): void;
  onSceneChange(sceneText: string): void;
  onDuplicateCard(cardId: string): void;
  onSource(source: SourceRef): void;
  onNavigateToNode(ref: NonNullable<BoardDocument['cards'][number]['nodeRef']>): void;
};

export function FreeformView(props: FreeformViewProps) {
  const dispatch = (command: Parameters<typeof applyAtlasCommand>[1]) => props.onBoardChange(applyAtlasCommand(props.board, command));

  const renderOverlay = (viewport: CanvasViewport) => <CardOverlay
    board={props.board}
    viewport={viewport}
    assets={props.assets}
    focusCardId={props.focusCardId}
    onUpdate={(id, patch) => dispatch({ type: 'card.update', id, patch })}
    onDelete={(id) => dispatch({ type: 'card.delete', id })}
    onDuplicate={props.onDuplicateCard}
    onSource={props.onSource}
    onNavigateToNode={props.onNavigateToNode}
  />;

  return <div className="atlas-freeform-view">
    <div className="atlas-freeform-toolbar atlas-toolbar">
      <span>{props.view.name}</span>
      <small>Canvas shapes are saved in the separate Excalidraw scene; cards remain in the Atlas Board.</small>
    </div>
    <CanvasEditor
      sceneText={props.sceneText}
      onChange={props.onSceneChange}
      className="atlas-freeform-canvas"
      renderOverlay={renderOverlay}
    />
  </div>;
}

type Gesture = {
  cardId: string;
  kind: 'move' | 'resize';
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
};

function CardOverlay({
  board,
  viewport,
  assets,
  focusCardId,
  onUpdate,
  onDelete,
  onDuplicate,
  onSource,
  onNavigateToNode,
}: {
  board: BoardDocument;
  viewport: CanvasViewport;
  assets: ReadonlyMap<string, string>;
  focusCardId?: string | null;
  onUpdate(id: string, patch: { text?: string | null; annotation?: string | null; position?: { x: number; y: number }; width?: number; height?: number }): void;
  onDelete(id: string): void;
  onDuplicate(id: string): void;
  onSource(source: SourceRef): void;
  onNavigateToNode(ref: NonNullable<BoardDocument['cards'][number]['nodeRef']>): void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const positionFor = (card: BoardDocument['cards'][number]) => {
    const moved = gesture?.cardId === card.id && gesture.kind === 'move'
      ? { x: card.position.x + gesture.dx / viewport.zoom, y: card.position.y + gesture.dy / viewport.zoom }
      : card.position;
    return viewport.sceneToViewport(moved);
  };
  const sizeFor = (card: BoardDocument['cards'][number]) => ({
    width: (card.width + (gesture?.cardId === card.id && gesture.kind === 'resize' ? gesture.dx / viewport.zoom : 0)) * viewport.zoom,
    height: (card.height + (gesture?.cardId === card.id && gesture.kind === 'resize' ? gesture.dy / viewport.zoom : 0)) * viewport.zoom,
  });

  useEffect(() => {
    const onMove = (event: globalThis.PointerEvent) => {
      setGesture((current) => current && current.pointerId === event.pointerId
        ? { ...current, dx: event.clientX - current.startX, dy: event.clientY - current.startY }
        : current);
    };
    const onUp = (event: globalThis.PointerEvent) => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const current = gesture;
      setGesture(null);
      const card = board.cards.find((item) => item.id === current.cardId);
      if (!card) return;
      if (current.kind === 'move') onUpdate(card.id, { position: { x: card.position.x + current.dx / viewport.zoom, y: card.position.y + current.dy / viewport.zoom } });
      else onUpdate(card.id, {
        width: Math.max(120, card.width + current.dx / viewport.zoom),
        height: Math.max(88, card.height + current.dy / viewport.zoom),
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [board.cards, gesture, viewport.zoom, onUpdate]);

  useEffect(() => {
    if (focusCardId && board.cards.some((card) => card.id === focusCardId)) setSelectedId(focusCardId);
  }, [focusCardId, board.cards]);

  const cards = board.cards;

  const startGesture = (event: ReactPointerEvent<HTMLButtonElement>, card: BoardDocument['cards'][number], kind: Gesture['kind']) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(card.id);
    setGesture({ cardId: card.id, kind, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      dx: 0, dy: 0 });
  };

  return <div className="atlas-card-overlay">
    {cards.map((card) => {
      const point = positionFor(card);
      const size = sizeFor(card);
      const imageUrl = card.assetId ? assets.get(board.assets.find((asset) => asset.id === card.assetId)?.path ?? '') : undefined;
      const linkedNode = card.nodeRef && board.nodes.find((node) => node.ref?.providerId === card.nodeRef!.providerId && node.ref?.localId === card.nodeRef!.localId);
      return <article
        className={`atlas-canvas-card atlas-card-${card.kind}${selectedId === card.id ? ' is-selected' : ''}`}
        key={card.id}
        style={{ left: point.x, top: point.y, width: size.width, height: size.height }}
        onPointerDown={() => setSelectedId(card.id)}
        onKeyDown={(event) => {
          if (selectedId !== card.id || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          if (event.target instanceof HTMLElement && event.target.closest('textarea,input,button')) return;
          event.preventDefault();
          const amount = event.shiftKey ? 40 : 10;
          const x = card.position.x + (event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0);
          const y = card.position.y + (event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0);
          onUpdate(card.id, { position: { x, y } });
        }}
        tabIndex={0}
        role="group"
        aria-label={`${card.kind} card`}
      >
        <header>
          <button type="button" className="atlas-card-drag" aria-label="Move card" onPointerDown={(event) => startGesture(event, card, 'move')}>⠿</button>
          <span>{card.kind === 'text' ? 'Markdown' : card.kind}</span>
          <button type="button" aria-label="Duplicate card" onClick={() => onDuplicate(card.id)}>⧉</button>
          <button type="button" aria-label="Delete card" onClick={() => onDelete(card.id)}>×</button>
        </header>
        {card.kind === 'image' ? imageUrl
          ? <img className="atlas-card-image" src={imageUrl} alt={card.annotation ?? 'Atlas image'} draggable={false} />
          : <p className="atlas-card-unavailable">Image asset is not loaded or missing.</p>
          : card.kind === 'provider-node'
            ? <div className="atlas-card-provider">
                <strong>{linkedNode?.label ?? card.text ?? card.nodeRef?.localId ?? 'Missing provider node'}</strong>
                <small>{card.nodeRef?.providerId}/{card.nodeRef?.localId}</small>
                {card.annotation && <p>{card.annotation}</p>}
                {card.nodeRef && <button type="button" onClick={() => onNavigateToNode(card.nodeRef!)}>Reveal in graph</button>}
              </div>
            : <CardTextEditor card={card} onUpdate={onUpdate} />}
        {card.source && <button className="atlas-card-source" type="button" onClick={() => onSource(card.source!)}>
          {card.source.path} · {card.source.revision.slice(0, 12)} · Open pinned revision
        </button>}
        {selectedId === card.id && <button className="atlas-card-resize" type="button" aria-label="Resize card" onPointerDown={(event) => startGesture(event, card, 'resize')}>⌟</button>}
      </article>;
    })}
  </div>;
}

function CardTextEditor({
  card,
  onUpdate,
}: {
  card: BoardDocument['cards'][number];
  onUpdate(id: string, patch: { text?: string | null; annotation?: string | null }): void;
}) {
  const [text, setText] = useState(card.text ?? '');
  const [annotation, setAnnotation] = useState(card.annotation ?? '');
  useEffect(() => { setText(card.text ?? ''); setAnnotation(card.annotation ?? ''); }, [card.id, card.text, card.annotation]);
  return <div className="atlas-card-editor">
    <textarea aria-label="Card Markdown" value={text} onChange={(event) => setText(event.currentTarget.value)} onBlur={() => onUpdate(card.id, { text })} />
    <input aria-label="Card annotation" value={annotation} placeholder="Annotation" onChange={(event) => setAnnotation(event.currentTarget.value)} onBlur={() => onUpdate(card.id, { annotation })} />
  </div>;
}
