import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { CanvasEditor } from '@scriptorium-atlas/canvas/ui';
import type { CanvasViewport } from '@scriptorium-atlas/canvas/ui';
import type { CanvasViewportState } from '@scriptorium-atlas/canvas/ui';
import { validateContract } from '@scriptorium-atlas/contracts';
import type { BoardDocument, BoardView, SourceRef } from '@scriptorium-atlas/contracts';
import { nodeKey } from '@scriptorium-atlas/graph';
import type { ProviderSnapshot } from './provider-snapshot.js';
import { applyAtlasCommand } from '../commands/model.js';

export type FreeformViewProps = {
  board: BoardDocument;
  view: BoardView;
  sceneText: string;
  assets: ReadonlyMap<string, string>;
  graph: ProviderSnapshot | null;
  focusCardId?: string | null;
  onBoardChange(board: BoardDocument): void;
  onSceneChange(sceneText: string): void;
  onDuplicateCard(cardId: string): void;
  onSource(source: SourceRef): void;
  onNavigateToNode(ref: NonNullable<BoardDocument['cards'][number]['nodeRef']>): void;
};

export function FreeformView(props: FreeformViewProps) {
  const dispatch = (command: Parameters<typeof applyAtlasCommand>[1]) => props.onBoardChange(applyAtlasCommand(props.board, command));
  const latestBoard = useRef(props.board);
  const latestOnBoardChange = useRef(props.onBoardChange);
  const rejectedViewport = useRef<string | null>(null);
  const [viewportResetEpoch, setViewportResetEpoch] = useState(0);
  const [viewportNotice, setViewportNotice] = useState<string | null>(null);
  latestBoard.current = props.board;
  latestOnBoardChange.current = props.onBoardChange;
  const savedViewport = props.view.viewport;
  const canvasViewport: CanvasViewportState = {
    scrollX: savedViewport.x / savedViewport.zoom,
    scrollY: savedViewport.y / savedViewport.zoom,
    zoom: savedViewport.zoom,
  };
  const saveCanvasViewport = useCallback((next: CanvasViewportState) => {
    if (!Number.isFinite(next.scrollX) || !Number.isFinite(next.scrollY) || !Number.isFinite(next.zoom) || next.zoom <= 0) return;
    const viewId = props.view.id;
    const board = latestBoard.current;
    const view = board.views.find((candidate) => candidate.id === viewId);
    if (!view || view.kind !== 'freeform') return;
    const viewport = { x: next.scrollX * next.zoom, y: next.scrollY * next.zoom, zoom: next.zoom };
    if (!validateContract('viewport', viewport)) {
      const signature = [next.scrollX, next.scrollY, next.zoom].map(String).join('|');
      if (rejectedViewport.current !== signature) {
        rejectedViewport.current = signature;
        setViewportNotice('Canvasの表示位置がAtlasの保存範囲外です。最後に保存した表示位置へ戻しました。');
        setViewportResetEpoch((epoch) => epoch + 1);
      }
      return;
    }
    rejectedViewport.current = null;
    setViewportNotice(null);
    if (view.viewport.x === viewport.x && view.viewport.y === viewport.y && view.viewport.zoom === viewport.zoom) return;
    latestOnBoardChange.current(applyAtlasCommand(board, { type: 'view.viewport', viewId, viewport }));
  }, [props.view.id]);

  const renderOverlay = (viewport: CanvasViewport) => <CardOverlay
    board={props.board}
    viewport={viewport}
    assets={props.assets}
    graph={props.graph}
    {...(props.focusCardId === undefined ? {} : { focusCardId: props.focusCardId })}
    onUpdate={(id, patch) => dispatch({ type: 'card.update', id, patch })}
    onDelete={(id) => dispatch({ type: 'card.delete', id })}
    onDuplicate={props.onDuplicateCard}
    onSource={props.onSource}
    onNavigateToNode={props.onNavigateToNode}
  />;

  return <div className="atlas-freeform-view">
    <div className="atlas-freeform-toolbar atlas-toolbar">
      <span>{props.view.name}</span>
      <small>Canvasの図形はExcalidrawシーンに、カードはAtlasボードに保存されます。</small>
      {viewportNotice && <small role="status">{viewportNotice}</small>}
    </div>
    <CanvasEditor
      key={`${props.board.boardId}:${props.view.id}:${viewportResetEpoch}`}
      sceneText={props.sceneText}
      onChange={props.onSceneChange}
      className="atlas-freeform-canvas"
      viewport={canvasViewport}
      onViewportChange={saveCanvasViewport}
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
  graph,
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
  graph: ProviderSnapshot | null;
  focusCardId?: string | null;
  onUpdate(id: string, patch: { text?: string | null; annotation?: string | null; position?: { x: number; y: number }; width?: number; height?: number }): void;
  onDelete(id: string): void;
  onDuplicate(id: string): void;
  onSource(source: SourceRef): void;
  onNavigateToNode(ref: NonNullable<BoardDocument['cards'][number]['nodeRef']>): void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const consumedFocusRequest = useRef<string | null>(null);
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
    if (!focusCardId) {
      consumedFocusRequest.current = null;
      return;
    }
    if (consumedFocusRequest.current === focusCardId || !board.cards.some((card) => card.id === focusCardId)) return;
    consumedFocusRequest.current = focusCardId;
    setSelectedId(focusCardId);
  }, [focusCardId, board.cards]);

  const cards = board.cards;
  const cardKindLabel = (kind: BoardDocument['cards'][number]['kind']) => ({
    text: 'テキスト',
    source: 'ソース',
    'provider-node': 'Providerノード',
    image: '画像',
  })[kind];

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
      const linkedNode = card.nodeRef
        ? graph?.nodes.find((node) => nodeKey(node.ref) === nodeKey(card.nodeRef!))
        : undefined;
      const cachedNode = card.nodeRef
        ? board.nodes.find((node) => node.ref && nodeKey(node.ref) === nodeKey(card.nodeRef!))
        : undefined;
      const providerConnected = Boolean(card.nodeRef && graph?.providerIds.includes(card.nodeRef.providerId));
      const providerStateClass = linkedNode ? 'is-resolved' : providerConnected ? 'is-unresolved' : 'is-disconnected';
      const providerState = providerConnected
        ? linkedNode ? '接続中' : '未解決'
        : '未接続（キャッシュ表示）';
      return <article
        className={`atlas-canvas-card atlas-card-${card.kind}${selectedId === card.id ? ' is-selected' : ''}`}
        key={card.id}
        style={{ left: point.x, top: point.y, width: size.width, height: size.height }}
        onPointerDown={() => setSelectedId(card.id)}
        onFocus={() => setSelectedId(card.id)}
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
        aria-label={`${cardKindLabel(card.kind)}カード`}
      >
        <header>
          <button type="button" className="atlas-card-drag" aria-label="カードを移動" onPointerDown={(event) => startGesture(event, card, 'move')}>⠿</button>
          <span>{card.kind === 'text' ? 'Markdown' : cardKindLabel(card.kind)}</span>
          <button type="button" aria-label="カードを複製" onClick={() => onDuplicate(card.id)}>⧉</button>
          <button type="button" aria-label="カードを削除" onClick={() => onDelete(card.id)}>×</button>
        </header>
        {card.kind === 'image' ? <>
          {imageUrl
            ? <img className="atlas-card-image" src={imageUrl} alt={card.annotation ?? 'Atlasの画像'} draggable={false} />
            : <p className="atlas-card-unavailable">画像データを読み込めないか、見つかりません。</p>}
          <CardAnnotationEditor card={card} onUpdate={onUpdate} />
        </>
          : card.kind === 'provider-node'
            ? <ProviderCardDetails
                card={card}
                label={linkedNode?.label ?? cachedNode?.label ?? card.text ?? card.nodeRef?.localId ?? 'Providerノードが見つかりません'}
                state={providerState}
                stateClass={providerStateClass}
                onUpdate={onUpdate}
                onNavigateToNode={onNavigateToNode}
              />
            : <CardTextEditor card={card} onUpdate={onUpdate} />}
        {card.source && <button className="atlas-card-source" type="button" onClick={() => onSource(card.source!)}>
          {card.source.path} · {card.source.revision.slice(0, 12)} · 固定したリビジョンを開く
        </button>}
        {selectedId === card.id && <button
          className="atlas-card-resize"
          type="button"
          aria-label="カードのサイズを変更"
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown"
          title="矢印キーでサイズを変更できます。Shiftキーで大きく変更します。"
          onPointerDown={(event) => startGesture(event, card, 'resize')}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const amount = event.shiftKey ? 40 : 10;
            const width = card.width + (event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0);
            const height = card.height + (event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0);
            onUpdate(card.id, { width: Math.max(120, width), height: Math.max(88, height) });
          }}
        >⌟</button>}
      </article>;
    })}
  </div>;
}

function ProviderCardDetails({
  card,
  label,
  state,
  stateClass,
  onUpdate,
  onNavigateToNode,
}: {
  card: BoardDocument['cards'][number];
  label: string;
  state: string;
  stateClass: string;
  onUpdate(id: string, patch: { annotation?: string | null }): void;
  onNavigateToNode(ref: NonNullable<BoardDocument['cards'][number]['nodeRef']>): void;
}) {
  return <div className="atlas-card-provider">
    <strong>{label}</strong>
    <small className={`atlas-card-provider-state ${stateClass}`} aria-label="Provider参照の状態">{state}</small>
    <small>{card.nodeRef?.providerId}/{card.nodeRef?.localId}</small>
    <CardAnnotationEditor card={card} onUpdate={onUpdate} />
    {card.nodeRef && <button type="button" onClick={() => onNavigateToNode(card.nodeRef!)}>グラフで表示</button>}
  </div>;
}

function CardAnnotationEditor({
  card,
  onUpdate,
}: {
  card: BoardDocument['cards'][number];
  onUpdate(id: string, patch: { annotation?: string | null }): void;
}) {
  const [annotation, setAnnotation] = useState(card.annotation ?? '');
  useEffect(() => setAnnotation(card.annotation ?? ''), [card.id, card.annotation]);
  return <input
    aria-label="カードの注釈"
    value={annotation}
    placeholder="注釈"
    onChange={(event) => setAnnotation(event.currentTarget.value)}
    onBlur={() => onUpdate(card.id, { annotation })}
  />;
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
    <textarea aria-label="カードのMarkdown本文" value={text} onChange={(event) => setText(event.currentTarget.value)} onBlur={() => onUpdate(card.id, { text })} />
    <input aria-label="カードの注釈" value={annotation} placeholder="注釈" onChange={(event) => setAnnotation(event.currentTarget.value)} onBlur={() => onUpdate(card.id, { annotation })} />
  </div>;
}
