import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import '@xyflow/react/dist/style.css';
import '@scriptorium-atlas/canvas/ui.css';
import './atlas.css';
import type {
  Asset,
  BoardDocument,
  BoardView,
  ChangeIntent,
  GraphEdgePage,
  GraphEdge,
  GraphNode,
  PluginHostClient,
  ProviderDescriptor,
  ProviderPage,
  SnapshotRef,
  SourceRef,
  View,
  WorkspaceSnapshotPage,
} from '@scriptorium-atlas/contracts';
import { assertBoardIntegrity } from '@scriptorium-atlas/contracts';
import { createEmptyExcalidrawScene, exportExcalidrawScene, inspectExcalidrawScene } from '@scriptorium-atlas/canvas/io';
import { nodeKey, sameSnapshot } from '@scriptorium-atlas/graph';
import { createGraphWorkerClient } from '@scriptorium-atlas/graph/worker';
import type { GraphWorkerClient } from '@scriptorium-atlas/graph/worker';
import { createLayoutWorkerClient } from '@scriptorium-atlas/layout/worker';
import type { LayoutWorkerClient } from '@scriptorium-atlas/layout/worker';
import type { LayoutInput } from '@scriptorium-atlas/layout';
import { serializeBoard } from '@scriptorium-atlas/persistence/board';
import { AtlasCommandHistory, applyAtlasCommand, createAtlasId, createEmptyAtlasBoard } from '../commands/model.js';
import { IMAGE_MIME_TYPES, assetExtension, sanitizeImageBytes, verifyAssetBytes } from './asset-media.js';
import {
  bytesToBase64,
  decodeFileText,
  downloadText,
  readFileBytes,
  readFileText,
  sha256Hex,
  type WorkspaceFile,
} from './host-utils.js';
import { FreeformView } from './FreeformView.js';
import { buildAtlasCardExportOverlay } from './card-export.js';
import { GraphCanvas } from './GraphCanvas.js';
import { StructuredViews } from './StructuredViews.js';
import {
  applyRemoteBaseline,
  isSessionDirty,
  loadAtlasInventory,
  makeBoardPath,
  scenePathForBoard,
  serializeSessionBoard,
  type AtlasInventory,
  type BoardBaseline,
  type BoardSession,
  type InvalidBoardFile,
} from './workspace.js';

export type AtlasPluginProps = { host: PluginHostClient };

type ProviderSnapshot = {
  providerId: string;
  providerIds: string[];
  snapshot: SnapshotRef;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

type ConnectedProvider = {
  providerId: string;
  leaseId: string;
  snapshot: SnapshotRef;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

type StagedAsset = {
  boardId: string;
  path: string;
  bytes: Uint8Array;
  sha256: string;
  mime: Asset['mime'];
};

type PreparedOperation = {
  boardId: string;
  operationId: string;
  boardText: string;
  sceneText: string | null;
  sceneWritten: boolean;
  assetPath?: string;
  preparedAtRevision: string;
  journalSequence: number;
  changes: Array<{ path: string; operation: string; bytes: number }>;
};

type SourcePanel = {
  source: SourceRef;
  state: 'loading' | 'ready' | 'missing' | 'stale' | 'denied' | 'error';
  content?: string;
  message?: string;
};

type PendingConflict = { boardId: string; path: string; deleted?: boolean };

const ASSET_CHUNK_BYTES = 768 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SCENE_BYTES = 2 * 1024 * 1024;
const MAX_BOARD_BYTES = 2 * 1024 * 1024;

export function AtlasPlugin({ host }: AtlasPluginProps) {
  const [sessions, setSessions] = useState<Map<string, BoardSession>>(() => new Map());
  const sessionsRef = useRef(sessions);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const activeBoardIdRef = useRef<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshotPage['workspace'] | null>(null);
  const [files, setFiles] = useState<Map<string, WorkspaceFile>>(() => new Map());
  const filesRef = useRef(files);
  const [invalidFiles, setInvalidFiles] = useState<InvalidBoardFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [fatalError, setFatalError] = useState('');
  const [prepared, setPrepared] = useState<PreparedOperation | null>(null);
  const preparedRef = useRef<PreparedOperation | null>(prepared);
  const preparingRef = useRef(false);
  const [autoPrepareRetry, setAutoPrepareRetry] = useState(0);
  const [stagedAsset, setStagedAsset] = useState<StagedAsset | null>(null);
  const stagedAssetRef = useRef<StagedAsset | null>(stagedAsset);
  const [sourcePanel, setSourcePanel] = useState<SourcePanel | null>(null);
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [providerId, setProviderId] = useState('');
  const [providerStatus, setProviderStatus] = useState('');
  const [providerError, setProviderError] = useState('');
  const [graph, setGraph] = useState<ProviderSnapshot | null>(null);
  const graphRef = useRef<ProviderSnapshot | null>(graph);
  const graphWorkerRef = useRef<GraphWorkerClient | null>(null);
  const layoutWorkerRef = useRef<LayoutWorkerClient | null>(null);
  const providerEntriesRef = useRef<Map<string, ConnectedProvider>>(new Map());
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<Awaited<ReturnType<GraphWorkerClient['search']>> | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [focusCardId, setFocusCardId] = useState<string | null>(null);
  const [assetUrls, setAssetUrls] = useState<Map<string, string>>(() => new Map());
  const [assetErrors, setAssetErrors] = useState<string[]>([]);
  const historyRef = useRef<Map<string, AtlasCommandHistory>>(new Map());
  const refreshSequenceRef = useRef(0);
  const assetInputRef = useRef<HTMLInputElement>(null);
  const boardImportRef = useRef<HTMLInputElement>(null);
  const sceneImportRef = useRef<HTMLInputElement>(null);

  const activeSession = activeBoardId ? sessions.get(activeBoardId) ?? null : null;
  const activeView = activeSession?.board.views.find((view) => view.id === activeViewId)
    ?? activeSession?.board.views[0]
    ?? null;
  const dirty = activeSession ? isSessionDirty(activeSession) : false;
  const activeHistory = activeBoardId ? historyRef.current.get(activeBoardId) : undefined;

  const publishSessions = useCallback((next: Map<string, BoardSession>) => {
    sessionsRef.current = next;
    setSessions(next);
  }, []);

  const publishFiles = useCallback((next: Map<string, WorkspaceFile>) => {
    filesRef.current = next;
    setFiles(next);
  }, []);

  const publishPrepared = useCallback((next: PreparedOperation | null) => {
    preparedRef.current = next;
    setPrepared(next);
  }, []);

  const publishStagedAsset = useCallback((next: StagedAsset | null) => {
    stagedAssetRef.current = next;
    setStagedAsset(next);
  }, []);

  const publishGraph = useCallback((next: ProviderSnapshot | null) => {
    graphRef.current = next;
    setGraph(next);
  }, []);

  const refreshWorkspace = useCallback(async (initial = false): Promise<AtlasInventory> => {
    const sequence = ++refreshSequenceRef.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    try {
      const inventory = await loadAtlasInventory(host);
      if (sequence !== refreshSequenceRef.current) return inventory;
      setWorkspace(inventory.workspace);
      publishFiles(inventory.files);
      setInvalidFiles(inventory.invalid);

      const next = new Map(sessionsRef.current);
      let commitObserved: PreparedOperation | null = null;
      for (const [id, remote] of inventory.boards) {
        const local = sessionsRef.current.get(id);
        if (!local) {
          next.set(id, remote);
          historyRef.current.set(id, new AtlasCommandHistory(remote.board));
          continue;
        }
        const sameFiles = local.boardFileRevision === remote.boardFileRevision && local.sceneFileRevision === remote.sceneFileRevision;
        if (sameFiles) continue;

        const operation = preparedRef.current;
        const isCommittedOperation = operation?.boardId === id
          && remote.originalText === operation.boardText
          && (!operation.sceneWritten || remote.sceneText === operation.sceneText);
        if (isCommittedOperation) {
          const currentBoardText = serializeSessionBoard(local);
          const editedAfterPrepare = currentBoardText !== operation.boardText
            || local.sceneText !== operation.sceneText;
          const merged: BoardSession = {
            ...remote,
            board: editedAfterPrepare ? local.board : remote.board,
            sceneText: local.sceneText !== operation.sceneText ? local.sceneText : remote.sceneText,
            externalDeleted: false,
            ...(editedAfterPrepare ? { originalBoard: remote.originalBoard, originalText: remote.originalText } : {}),
          };
          next.set(id, merged);
          if (!editedAfterPrepare) historyRef.current.get(id)?.replaceFromHost(remote.board);
          commitObserved = operation;
        } else if (!isSessionDirty(local)) {
          next.set(id, remote);
          historyRef.current.get(id)?.replaceFromHost(remote.board);
        } else {
          const baseline: BoardBaseline = {
            board: remote.board,
            boardText: remote.originalText,
            sceneText: remote.sceneText,
            boardRevision: remote.boardFileRevision,
            sceneRevision: remote.sceneFileRevision,
            ...(remote.sceneError ? { sceneError: remote.sceneError } : {}),
          };
          next.set(id, { ...local, conflict: baseline });
        }
      }

      for (const [id, local] of sessionsRef.current) {
        if (inventory.boards.has(id) || local.boardFileRevision === null) continue;
        if (isSessionDirty(local)) next.set(id, { ...local, externalDeleted: true });
        else next.delete(id);
      }
      if (sequence !== refreshSequenceRef.current) return inventory;
      publishSessions(next);
      if (commitObserved) {
        publishPrepared(null);
        const asset = stagedAssetRef.current;
        if (asset && asset.boardId === commitObserved.boardId && asset.path === commitObserved.assetPath) publishStagedAsset(null);
        setNotice(`Host commit observed for ${commitObserved.operationId}. The durable journal ACK and Host commit are separate states.`);
      }
      if (!activeBoardIdRef.current && next.size > 0) {
        const id = next.keys().next().value as string | undefined;
        if (id) { activeBoardIdRef.current = id; setActiveBoardId(id); setActiveViewId(next.get(id)!.board.views[0]?.id ?? null); }
      }
      if (initial && next.size === 0 && inventory.invalid.length === 0) setNotice('Create an Atlas Board to begin. Changes are submitted to the Host for review.');
      return inventory;
    } finally {
      if (sequence === refreshSequenceRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [host, publishFiles, publishPrepared, publishSessions, publishStagedAsset]);

  useEffect(() => {
    let live = true;
    void refreshWorkspace(true).catch((error) => {
      if (!live) return;
      setFatalError(errorMessage(error));
      setLoading(false);
    });
    const unsubscribe = host.subscribeWorkspace(() => {
      void refreshWorkspace().catch((error) => setFatalError(errorMessage(error)));
    });
    return () => {
      live = false;
      unsubscribe();
      refreshSequenceRef.current += 1;
      graphWorkerRef.current?.close();
      graphWorkerRef.current = null;
      layoutWorkerRef.current?.close();
      layoutWorkerRef.current = null;
      for (const provider of providerEntriesRef.current.values()) void host.releaseProvider(provider.leaseId).catch(() => undefined);
      providerEntriesRef.current.clear();
    };
  }, [host, refreshWorkspace]);

  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { activeBoardIdRef.current = activeBoardId; }, [activeBoardId]);
  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => { preparedRef.current = prepared; }, [prepared]);
  useEffect(() => { stagedAssetRef.current = stagedAsset; }, [stagedAsset]);
  useEffect(() => { graphRef.current = graph; }, [graph]);

  useEffect(() => {
    let active = true;
    void host.describeProviders().then((items) => {
      if (active) {
        setProviders(items);
        setProviderId((current) => current || items.find((item) => item.features.includes('listNodes') && item.features.includes('listEdges'))?.id || '');
      }
    }).catch((error) => { if (active) setProviderError(`Provider discovery failed: ${errorMessage(error)}`); });
    return () => { active = false; };
  }, [host]);

  useEffect(() => {
    const session = activeSession;
    if (!session?.board.assets.length) {
      setAssetUrls((old) => { for (const url of old.values()) URL.revokeObjectURL(url); return new Map(); });
      setAssetErrors([]);
      return;
    }
    let cancelled = false;
    const urls = new Map<string, string>();
    const errors: string[] = [];
    void (async () => {
      for (const asset of session.board.assets) {
        const file = files.get(asset.path);
        if (!file) { errors.push(`${asset.path}: asset file is missing.`); continue; }
        try {
          const original = await readFileBytes(host, file);
          await verifyAssetBytes(asset, original);
          const displayBytes = sanitizeImageBytes(original, asset.mime);
          const blobBytes = new Uint8Array(new ArrayBuffer(displayBytes.byteLength));
          blobBytes.set(displayBytes);
          urls.set(asset.path, URL.createObjectURL(new Blob([blobBytes.buffer], { type: asset.mime })));
        } catch (error) { errors.push(`${asset.path}: ${errorMessage(error)}`); }
      }
      if (cancelled) { for (const url of urls.values()) URL.revokeObjectURL(url); return; }
      setAssetUrls((old) => { for (const url of old.values()) URL.revokeObjectURL(url); return urls; });
      setAssetErrors(errors);
    })();
    return () => { cancelled = true; for (const url of urls.values()) URL.revokeObjectURL(url); };
  }, [activeSession?.board.boardId, activeSession?.board.revision, activeSession?.board.assets, files, host]);

  useEffect(() => {
    if (!graph || !activeView || !activeSession) { setSearchResult(null); return; }
    const worker = graphWorkerRef.current;
    if (!worker || !searchQuery.trim()) { setSearchResult(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void worker.search({
        query: searchQuery,
        ...(activeView.filter?.providers ? { providers: activeView.filter.providers } : {}),
        ...(activeView.filter?.kinds ? { kinds: activeView.filter.kinds } : {}),
        limit: 1000,
      }, controller.signal).then((result) => setSearchResult(result)).catch((error) => {
        if (!controller.signal.aborted) setProviderError(`Graph search failed: ${errorMessage(error)}`);
      });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [activeSession, activeView, graph, searchQuery]);

  useEffect(() => {
    if (!workspace || !graph || graph.snapshot.sourceRevision === workspace.sourceRevision) return;
    setProviderStatus('The workspace source revision changed. This provider snapshot is stale; reconnect to refresh it.');
  }, [workspace?.sourceRevision, graph?.snapshot.sourceRevision]);

  useEffect(() => {
    if (!activeSession) return;
    layoutWorkerRef.current?.updateRevision({
      boardRevision: activeSession.board.revision,
      ...(graph?.snapshot ? { snapshot: graph.snapshot } : {}),
    });
  }, [activeSession?.board.revision, graph?.snapshot]);

  const replaceSession = useCallback((boardId: string, nextSession: BoardSession) => {
    const next = new Map(sessionsRef.current);
    next.set(boardId, nextSession);
    publishSessions(next);
  }, [publishSessions]);

  const acceptBoard = useCallback((boardId: string, nextBoard: BoardDocument) => {
    const history = historyRef.current.get(boardId);
    const accepted = history ? history.accept(nextBoard) : nextBoard;
    const current = sessionsRef.current.get(boardId);
    if (!current) return;
    replaceSession(boardId, { ...current, board: accepted });
  }, [replaceSession]);

  const makeLocalSession = useCallback(async (board: BoardDocument, sceneText: string | null = null, sourceText?: string) => {
    const canonicalBoard = serializeBoard(board);
    const session: BoardSession = {
      board,
      originalBoard: structuredClone(board),
      originalText: sourceText ?? canonicalBoard,
      baseBoardText: null,
      sceneText,
      baseSceneText: null,
      path: makeBoardPath(board.boardId),
      scenePath: scenePathForBoard(makeBoardPath(board.boardId)),
      boardFileRevision: null,
      sceneFileRevision: null,
    };
    return session;
  }, []);

  const activateView = useCallback(async (boardId: string, viewId: string) => {
    const session = sessionsRef.current.get(boardId);
    const view = session?.board.views.find((candidate) => candidate.id === viewId);
    if (!session || !view) return;
    if (view.kind === 'freeform' && session.sceneText === null && !session.sceneError) {
      setNotice('Loading Canvas tools…');
      try {
        const sceneText = await createEmptyExcalidrawScene();
        const current = sessionsRef.current.get(boardId);
        if (current?.sceneText === null) replaceSession(boardId, { ...current, sceneText });
      } catch (error) {
        setNotice(`Canvas could not be opened: ${errorMessage(error)}`);
        return;
      }
    }
    if (activeBoardIdRef.current === boardId) {
      setActiveViewId(viewId);
      setNotice('');
    }
  }, [replaceSession]);

  useEffect(() => {
    if (activeSession && activeView?.kind === 'freeform' && activeSession.sceneText === null && !activeSession.sceneError) {
      void activateView(activeSession.board.boardId, activeView.id);
    }
  }, [activeSession?.board.boardId, activeSession?.sceneText, activeSession?.sceneError, activeView?.id, activeView?.kind, activateView]);

  const createBoard = useCallback(async () => {
    try {
      const board = createEmptyAtlasBoard();
      const session = await makeLocalSession(board);
      const next = new Map(sessionsRef.current);
      next.set(board.boardId, session);
      historyRef.current.set(board.boardId, new AtlasCommandHistory(board));
      publishSessions(next);
      setActiveBoardId(board.boardId);
      setActiveViewId(board.views[0]?.id ?? null);
      setFocusCardId(null);
      setNotice(`Created ${session.path} as a local draft. Prepare changes for Host review when ready.`);
    } catch (error) { setFatalError(`Could not create a Board: ${errorMessage(error)}`); }
  }, [makeLocalSession, publishSessions]);

  const createView = useCallback((kind: View['kind']) => {
    if (!activeSession) return;
    const id = createAtlasId('view');
    const name = ({ graph: 'Graph', freeform: 'Canvas', board: 'Board', timeline: 'Timeline', storyboard: 'Storyboard' } as const)[kind];
    const common = { id, kind, name, viewport: { x: 0, y: 0, zoom: 1 } };
    let view: BoardView;
    if (kind === 'graph') view = { ...common, kind, pins: [] };
    else if (kind === 'board') view = { ...common, kind, laneIds: ['lane-unassigned'], lanes: [{ id: 'lane-unassigned', label: 'Unassigned', cardIds: [] }] };
    else if (kind === 'timeline') view = { ...common, kind, axis: 'unknown', timeline: { range: { start: 0, end: 1 }, entries: [] } };
    else if (kind === 'storyboard') view = { ...common, kind, cardOrder: [] };
    else view = { ...common, kind };
    acceptBoard(activeSession.board.boardId, applyAtlasCommand(activeSession.board, { type: 'view.create', view }));
    if (kind === 'freeform') void activateView(activeSession.board.boardId, id);
    else setActiveViewId(id);
  }, [activeSession, acceptBoard, activateView]);

  const setView = useCallback((viewId: string) => {
    if (activeSession) {
      setFocusCardId(null);
      void activateView(activeSession.board.boardId, viewId);
    }
  }, [activeSession, activateView]);

  const renameBoard = (value: string) => {
    if (!activeSession || !value.trim() || value === activeSession.board.name) return;
    acceptBoard(activeSession.board.boardId, applyAtlasCommand(activeSession.board, { type: 'board.rename', name: value.trim() }));
  };

  const removeView = () => {
    if (!activeSession || !activeView || activeSession.board.views.length <= 1) return;
    const nextView = activeSession.board.views.find((view) => view.id !== activeView.id);
    acceptBoard(activeSession.board.boardId, applyAtlasCommand(activeSession.board, { type: 'view.delete', id: activeView.id }));
    setActiveViewId(nextView?.id ?? null);
  };

  const renameView = (value: string) => {
    if (!activeSession || !activeView || !value.trim() || value === activeView.name) return;
    acceptBoard(activeSession.board.boardId, applyAtlasCommand(activeSession.board, { type: 'view.update', id: activeView.id, patch: { name: value.trim() } }));
  };

  const createCard = (card: BoardDocument['cards'][number], asset?: Asset) => {
    if (!activeSession) return;
    const next = applyAtlasCommand(activeSession.board, { type: 'card.create', card, ...(asset ? { asset } : {}) });
    acceptBoard(activeSession.board.boardId, next);
    const freeform = next.views.find((view) => view.kind === 'freeform');
    if (freeform) void activateView(activeSession.board.boardId, freeform.id);
    else {
      const id = createAtlasId('view');
      const newView: View = { id, kind: 'freeform', name: 'Canvas', viewport: { x: 0, y: 0, zoom: 1 } };
      acceptBoard(activeSession.board.boardId, applyAtlasCommand(next, { type: 'view.create', view: newView }));
      void activateView(activeSession.board.boardId, id);
    }
    setFocusCardId(card.id);
  };

  const createTextCard = () => {
    if (!activeSession) return;
    const offset = activeSession.board.cards.length * 22;
    createCard({
      id: createAtlasId('card'), kind: 'text', text: '',
      position: { x: 100 + offset, y: 100 + offset }, width: 300, height: 180,
    });
  };

  const duplicateCard = (id: string) => {
    if (!activeSession) return;
    const newId = createAtlasId('card');
    acceptBoard(activeSession.board.boardId, applyAtlasCommand(activeSession.board, { type: 'card.duplicate', id, newId }));
    setFocusCardId(newId);
  };

  const openSource = useCallback(async (source: SourceRef) => {
    setSourcePanel({ source, state: 'loading' });
    try {
      const file = await host.requestSource(source);
      if (file.workspaceId !== source.workspaceId || file.path !== source.path) {
        setSourcePanel({ source, state: 'error', message: 'The Host returned a source from a different workspace or path.' });
        return;
      }
      if (file.revision !== source.revision) {
        setSourcePanel({ source, state: 'stale', message: `The Host returned revision ${file.revision}; the pinned revision is ${source.revision}.` });
        return;
      }
      setSourcePanel({ source, state: 'ready', content: decodeFileText(file) });
    } catch (error) {
      const code = hostErrorCode(error);
      const state = code === 'SOURCE_MISSING' ? 'missing' : code === 'REVISION_CONFLICT' || code === 'SNAPSHOT_STALE' ? 'stale' : code === 'PERMISSION_DENIED' ? 'denied' : 'error';
      setSourcePanel({ source, state, message: errorMessage(error) });
    }
  }, [host]);

  const createSourceCard = () => {
    if (!activeSession || !sourcePanel || sourcePanel.state !== 'ready') return;
    const offset = activeSession.board.cards.length * 24;
    createCard({
      id: createAtlasId('card'), kind: 'source', source: sourcePanel.source,
      text: sourcePanel.content?.slice(0, 20_000) ?? '', annotation: `Pinned revision ${sourcePanel.source.revision}`,
      position: { x: 120 + offset, y: 120 + offset }, width: 340, height: 220,
    });
  };

  const navigateToNode = (ref: NonNullable<BoardDocument['cards'][number]['nodeRef']>) => {
    if (!activeSession) return;
    let node = activeSession.board.nodes.find((candidate) => candidate.ref && nodeKey(candidate.ref) === nodeKey(ref));
    const providerNode = graphRef.current?.nodes.find((candidate) => nodeKey(candidate.ref) === nodeKey(ref));
    if (!node && providerNode) {
      const offset = activeSession.board.nodes.length * 24;
      const created: BoardDocument['nodes'][number] = {
        id: createAtlasId('node'), origin: 'provider', kind: providerNode.kind, label: providerNode.label,
        ref: providerNode.ref, ...(providerNode.source ? { source: providerNode.source } : {}),
        position: { x: 120 + offset, y: 120 + offset },
      };
      acceptBoard(activeSession.board.boardId, applyAtlasCommand(activeSession.board, { type: 'node.create', node: created }));
      node = created;
    }
    const graphView = activeSession.board.views.find((view) => view.kind === 'graph');
    if (graphView) setActiveViewId(graphView.id);
    setFocusNodeId(node?.id ?? null);
  };

  const addProviderNode = (providerNode: GraphNode) => {
    if (!activeSession) return;
    const existing = activeSession.board.nodes.find((node) => node.ref && nodeKey(node.ref) === nodeKey(providerNode.ref));
    if (existing) { setFocusNodeId(existing.id); return; }
    const offset = activeSession.board.nodes.length * 28;
    const node: BoardDocument['nodes'][number] = {
      id: createAtlasId('node'), origin: 'provider', kind: providerNode.kind, label: providerNode.label,
      ref: providerNode.ref, ...(providerNode.source ? { source: providerNode.source } : {}),
      position: { x: 80 + offset, y: 80 + offset },
    };
    acceptBoard(activeSession.board.boardId, applyAtlasCommand(activeSession.board, { type: 'node.create', node }));
    setFocusNodeId(node.id);
  };

  const connectProvider = async () => {
    if (!workspace || !providerId) return;
    const descriptor = providers.find((item) => item.id === providerId);
    if (!descriptor) { setProviderError(`Provider ${providerId} was not discovered by the Host.`); return; }
    if (!descriptor.features.includes('listNodes') || !descriptor.features.includes('listEdges')) {
      setProviderError(`${providerId} does not provide both paged nodes and edges.`);
      return;
    }
    if (providerEntriesRef.current.has(providerId)) {
      setProviderError(`${providerId} is already connected.`);
      return;
    }
    setProviderError('');
    setProviderStatus(`Connecting to ${providerId}…`);
    let acquiredLeaseId: string | null = null;
    try {
      const lease = await host.acquireProvider(providerId, workspace.sourceRevision);
      acquiredLeaseId = lease.leaseId;
      if (lease.providerId !== providerId || lease.snapshot.workspaceId !== workspace.workspaceId || lease.snapshot.sourceRevision !== workspace.sourceRevision) {
        await host.releaseProvider(lease.leaseId).catch(() => undefined);
        acquiredLeaseId = null;
        throw new Error('Provider lease returned a mismatched provider, workspace, or source revision.');
      }
      const nodePages = await collectProviderPages<ProviderPage>(host, lease.leaseId, 'listNodes', lease.snapshot);
      const edgePages = await collectProviderPages<GraphEdgePage>(host, lease.leaseId, 'listEdges', lease.snapshot);
      const entry: ConnectedProvider = { providerId, leaseId: lease.leaseId, snapshot: lease.snapshot, nodes: nodePages.flatMap((page) => page.items), edges: edgePages.flatMap((page) => page.items) };
      const candidateEntries = new Map(providerEntriesRef.current);
      candidateEntries.set(providerId, entry);
      const combined = await assembleProviderSnapshot(candidateEntries);
      const candidateWorker = createGraphWorkerClient();
      try { await candidateWorker.replaceSnapshot(combined.snapshot, combined.nodes, combined.edges); }
      catch (error) { candidateWorker.close(); throw error; }
      graphWorkerRef.current?.close();
      graphWorkerRef.current = candidateWorker;
      providerEntriesRef.current = candidateEntries;
      acquiredLeaseId = null;
      publishGraph(combined);
      setProviderStatus(`${combined.providerIds.join(' + ')}: ${combined.nodes.length} nodes and ${combined.edges.length} edges from a shared source revision.`);
    } catch (error) {
      if (acquiredLeaseId) await host.releaseProvider(acquiredLeaseId).catch(() => undefined);
      setProviderError(`${providerErrorKind(error)}: ${errorMessage(error)}`);
      setProviderStatus('Provider could not be added. Existing snapshots and Board data are unchanged.');
    }
  };

  const disconnectProvider = async (disconnectedId: string) => {
    const removed = providerEntriesRef.current.get(disconnectedId);
    if (!removed) return;
    const candidateEntries = new Map(providerEntriesRef.current);
    candidateEntries.delete(disconnectedId);
    try {
      if (candidateEntries.size === 0) {
        graphWorkerRef.current?.close();
        graphWorkerRef.current = null;
        providerEntriesRef.current = candidateEntries;
        publishGraph(null);
        setSearchResult(null);
      } else {
        const combined = await assembleProviderSnapshot(candidateEntries);
        const candidateWorker = createGraphWorkerClient();
        try { await candidateWorker.replaceSnapshot(combined.snapshot, combined.nodes, combined.edges); }
        catch (error) { candidateWorker.close(); throw error; }
        graphWorkerRef.current?.close();
        graphWorkerRef.current = candidateWorker;
        providerEntriesRef.current = candidateEntries;
        publishGraph(combined);
      }
      await host.releaseProvider(removed.leaseId);
      setProviderStatus(candidateEntries.size ? `Connected: ${[...candidateEntries.keys()].join(' + ')}.` : 'Provider disconnected; saved Board references remain available as unresolved items.');
    } catch (error) { setProviderError(`Provider disconnect failed: ${errorMessage(error)}`); }
  };

  const runLayout = async (kind: 'force' | 'layered' | 'timeline' | 'manual') => {
    if (!activeSession || !activeView || activeView.kind !== 'graph') return;
    const board = activeSession.board;
    const snapshot = graph?.snapshot;
    const worker = layoutWorkerRef.current ?? createLayoutWorkerClient();
    layoutWorkerRef.current = worker;
    const revision = { boardRevision: board.revision, ...(snapshot ? { snapshot } : {}) };
    worker.updateRevision(revision);
    setNotice(`Calculating ${kind} layout…`);
    try {
      const timelineView = board.views.find((view) => view.kind === 'timeline');
      const base = { boardRevision: board.revision, ...(snapshot ? { snapshot } : {}), nodes: board.nodes, edges: board.edges, pins: activeView.pins ?? [] };
      let input: LayoutInput;
      if (kind === 'timeline') {
        input = {
          ...base,
          kind,
          axis: timelineView?.axis ?? 'unknown',
          ...(timelineView?.timeline?.range ? { range: timelineView.timeline.range } : {}),
          entries: (timelineView?.timeline?.entries ?? []).filter((entry) => board.nodes.some((node) => node.id === entry.itemId)),
        };
      } else if (kind === 'force') input = { ...base, kind, seed: stableSeed(`${board.boardId}:${board.revision}`) };
      else input = { ...base, kind };
      const result = await worker.calculate(input);
      const current = sessionsRef.current.get(board.boardId);
      const currentSnapshot = graphRef.current?.snapshot;
      const snapshotMatches = snapshot ? Boolean(result.snapshot && currentSnapshot && sameSnapshot(snapshot, currentSnapshot) && sameSnapshot(result.snapshot, snapshot)) : !result.snapshot;
      if (!current || current.board.revision !== result.boardRevision || !snapshotMatches) {
        setNotice('Discarded a stale layout result. Run the layout again on the current Board and provider snapshot.');
        return;
      }
      const positions = result.positions.map(({ nodeId, position }) => ({ id: nodeId, position }));
      acceptBoard(board.boardId, applyAtlasCommand(current.board, { type: 'node.apply-layout', positions }));
      setNotice(`${kind} layout applied as one undoable action. ${result.unresolvedEdgeIds.length} edges had unresolved endpoints.`);
    } catch (error) { setNotice(`Layout failed: ${errorMessage(error)}`); }
  };

  const cancelLayout = () => {
    layoutWorkerRef.current?.cancel();
    setNotice('Layout calculation cancelled.');
  };

  const prepareChanges = async () => {
    if (!activeSession || activeSession.conflict) return;
    if (preparingRef.current) return;
    if (preparedRef.current) { setNotice('A Host review operation is already pending. Wait for its commit or resolution before preparing another.'); return; }
    const staged = stagedAssetRef.current;
    if (staged && staged.boardId !== activeSession.board.boardId) { setNotice('Finish the staged image upload for its Board before preparing another Board.'); return; }
    preparingRef.current = true;
    let retryAfterConcurrentEdit = false;
    setNotice('Checking current Host revisions…');
    try {
      const latest = await loadAtlasInventory(host);
      setWorkspace(latest.workspace);
      publishFiles(latest.files);
      const currentBoardFile = latest.files.get(activeSession.path);
      const currentSceneFile = latest.files.get(activeSession.scenePath);
      const wasDeleted = Boolean(activeSession.externalDeleted);
      const currentExpectedRevision = wasDeleted ? null : activeSession.boardFileRevision;
      if ((currentBoardFile?.revision ?? null) !== currentExpectedRevision || (currentSceneFile?.revision ?? null) !== activeSession.sceneFileRevision) {
        const remote = latest.boards.get(activeSession.board.boardId);
        if (remote) {
          const conflict: BoardBaseline = {
            board: remote.board,
            boardText: remote.originalText,
            sceneText: remote.sceneText,
            boardRevision: remote.boardFileRevision,
            sceneRevision: remote.sceneFileRevision,
            ...(remote.sceneError ? { sceneError: remote.sceneError } : {}),
          };
          replaceSession(activeSession.board.boardId, { ...activeSession, conflict });
        }
        setNotice('The Host revision changed. Resolve the external edit before preparing this Board.');
        return;
      }
      const currentSession = sessionsRef.current.get(activeSession.board.boardId) ?? activeSession;
      if (currentSession.board.revision !== activeSession.board.revision || currentSession.sceneText !== activeSession.sceneText) {
        retryAfterConcurrentEdit = true;
        setNotice('The local draft changed while the Host inventory was loading. Press Prepare again.');
        return;
      }
      const boardText = serializeSessionBoard(currentSession);
      if (new TextEncoder().encode(boardText).byteLength > MAX_BOARD_BYTES) throw new Error('The Atlas Board exceeds the 2 MiB document limit.');
      const writes: ChangeIntent['writes'] = [];
      const reads: ChangeIntent['reads'] = [];
      if (activeSession.baseBoardText === null || boardText !== activeSession.baseBoardText || wasDeleted) {
        writes.push({ path: activeSession.path, content: boardText, encoding: 'utf8' });
        reads.push({ path: activeSession.path, revision: currentBoardFile?.revision ?? null });
      }
      let sceneText: string | undefined;
      if (activeSession.sceneText !== null && (activeSession.baseSceneText === null || activeSession.sceneText !== activeSession.baseSceneText)) {
        if (activeSession.sceneError) throw new Error(`The Excalidraw scene is read-only: ${activeSession.sceneError}`);
        if (new TextEncoder().encode(activeSession.sceneText).byteLength > MAX_SCENE_BYTES) throw new Error('Excalidraw scene exceeds the Host 2 MiB document limit. Export the raw scene, reduce embedded image data, or import a smaller scene.');
        sceneText = activeSession.sceneText;
        writes.push({ path: activeSession.scenePath, content: sceneText, encoding: 'utf8' });
        reads.push({ path: activeSession.scenePath, revision: currentSceneFile?.revision ?? null });
      }
      const baselineAssetPaths = new Set(currentSession.originalBoard.assets.map((asset) => asset.path));
      const newlyReferencedAssets = currentSession.board.assets.filter((asset) =>
        currentSession.baseBoardText === null || !baselineAssetPaths.has(asset.path));
      for (const asset of newlyReferencedAssets) {
        if (staged?.path === asset.path) {
          reads.push({ path: asset.path, revision: null });
          continue;
        }
        const assetFile = latest.files.get(asset.path);
        if (!assetFile) throw new Error(`Referenced asset ${asset.path} is missing. Restore it through Host bundle import before preparing this Board.`);
        reads.push({ path: asset.path, revision: assetFile.revision });
      }
      if (!writes.length) { setNotice('No local changes to prepare.'); return; }
      const operationId = crypto.randomUUID();
      const change: ChangeIntent = {
        operationId,
        workspaceId: latest.workspace.workspaceId,
        baseWorkspaceRevision: latest.workspace.sourceRevision,
        reads: reads.sort((left, right) => left.path.localeCompare(right.path)),
        writes: writes.sort((left, right) => left.path.localeCompare(right.path)),
        message: `Update Atlas Board: ${activeSession.board.name}`,
        kind: staged ? 'asset' : 'document',
      };
      setNotice(staged ? 'Uploading image bytes in bounded Host chunks…' : 'Preparing this document change in the Host journal…');
      let preparedChange;
      if (staged) {
        const start = await host.beginAsset({
          operationId,
          workspaceId: latest.workspace.workspaceId,
          baseWorkspaceRevision: latest.workspace.sourceRevision,
          path: staged.path,
          sha256: staged.sha256,
          totalBytes: staged.bytes.byteLength,
          contentType: staged.mime,
        });
        if (start.operationId !== operationId || start.workspaceId !== latest.workspace.workspaceId || start.path !== staged.path || start.totalBytes !== staged.bytes.byteLength) {
          throw new Error('Host image upload acknowledgement does not match the staged asset.');
        }
        for (let offset = start.nextOffset; offset < staged.bytes.byteLength;) {
          const part = staged.bytes.subarray(offset, Math.min(offset + ASSET_CHUNK_BYTES, staged.bytes.byteLength));
          const receipt = await host.appendAsset({ uploadId: start.uploadId, offset, content: bytesToBase64(part) });
          if (receipt.uploadId !== start.uploadId || receipt.nextOffset !== offset + part.byteLength || receipt.receivedBytes !== offset + part.byteLength) {
            throw new Error('Host returned a mismatched image chunk acknowledgement.');
          }
          offset = receipt.nextOffset;
        }
        preparedChange = await host.prepareAsset(start.uploadId, change);
      } else preparedChange = await host.prepare(change);
      if (preparedChange.durableAck.operationId !== operationId
        || preparedChange.durableAck.workspaceId !== latest.workspace.workspaceId
        || !Number.isSafeInteger(preparedChange.durableAck.journalSequence)
        || preparedChange.durableAck.journalSequence < 1) {
        throw new Error('Host returned a durable journal acknowledgement for a different operation or workspace.');
      }
      const pending: PreparedOperation = {
        boardId: activeSession.board.boardId,
        operationId,
        boardText,
        sceneText: currentSession.sceneText,
        sceneWritten: sceneText !== undefined,
        ...(staged ? { assetPath: staged.path } : {}),
        preparedAtRevision: latest.workspace.sourceRevision,
        journalSequence: preparedChange.durableAck.journalSequence,
        changes: preparedChange.changes.map((item) => ({ path: item.path, operation: item.operation, bytes: item.bytes })),
      };
      publishPrepared(pending);
      setNotice(`Host journal ACK ${preparedChange.durableAck.journalSequence} received for ${operationId}. Awaiting Host review and commit.`);
    } catch (error) {
      const code = hostErrorCode(error);
      setNotice(`${code === 'REVISION_CONFLICT' ? 'Revision conflict' : code === 'QUOTA_EXCEEDED' ? 'Storage quota exceeded' : 'Prepare failed'}: ${errorMessage(error)}`);
    } finally {
      preparingRef.current = false;
      if (retryAfterConcurrentEdit) setAutoPrepareRetry((value) => value + 1);
    }
  };

  const prepareChangesRef = useRef(prepareChanges);
  prepareChangesRef.current = prepareChanges;
  useEffect(() => {
    if (!activeSession || !dirty || activeSession.conflict || prepared || (stagedAsset && stagedAsset.boardId !== activeSession.board.boardId)) return;
    const boardId = activeSession.board.boardId;
    const boardRevision = activeSession.board.revision;
    const sceneText = activeSession.sceneText;
    const timer = window.setTimeout(() => {
      const current = sessionsRef.current.get(boardId);
      if (activeBoardIdRef.current !== boardId || !current || current.board.revision !== boardRevision || current.sceneText !== sceneText) return;
      void prepareChangesRef.current();
    }, 450);
    return () => window.clearTimeout(timer);
  }, [activeSession?.board.boardId, activeSession?.board.revision, activeSession?.sceneText, activeSession?.conflict, dirty, prepared?.operationId, stagedAsset?.boardId, autoPrepareRetry]);

  const acceptConflict = (keepDraft: boolean) => {
    if (!activeSession?.conflict) return;
    const remote = activeSession.conflict;
    const nextSession = applyRemoteBaseline(activeSession, remote, keepDraft);
    replaceSession(activeSession.board.boardId, nextSession);
    historyRef.current.get(activeSession.board.boardId)?.replaceFromHost(keepDraft ? nextSession.board : remote.board);
    if (!keepDraft) setActiveViewId(nextSession.board.views[0]?.id ?? null);
    setNotice(keepDraft ? 'Kept the local draft on top of the latest Host revision. Review its changes before preparing.' : 'Reloaded the latest Host version.');
  };

  const undoRedo = (direction: 'undo' | 'redo') => {
    if (!activeBoardId) return;
    const history = historyRef.current.get(activeBoardId);
    if (!history) return;
    const board = direction === 'undo' ? history.undo() : history.redo();
    const current = sessionsRef.current.get(activeBoardId);
    if (current) replaceSession(activeBoardId, { ...current, board });
  };

  const onMainKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.closest('input,textarea,select,[contenteditable="true"]') || target.closest('.atlas-freeform-canvas'))) return;
    event.preventDefault();
    undoRedo(event.shiftKey ? 'redo' : 'undo');
  };

  const importBoard = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_BOARD_BYTES) throw new Error('Atlas Board import exceeds the 2 MiB document limit.');
      const imported: unknown = JSON.parse(await file.text());
      assertBoardIntegrity(imported);
      for (const asset of imported.assets) {
        const assetFile = filesRef.current.get(asset.path);
        if (!assetFile) throw new Error(`Asset ${asset.path} is not present in this Host Workspace. Use Host bundle import for Boards with attachments.`);
        await verifyAssetBytes(asset, await readFileBytes(host, assetFile));
      }
      const board = { ...imported, boardId: crypto.randomUUID(), revision: 0 } as BoardDocument;
      assertBoardIntegrity(board);
      const session = await makeLocalSession(board);
      const next = new Map(sessionsRef.current);
      next.set(board.boardId, session);
      historyRef.current.set(board.boardId, new AtlasCommandHistory(board));
      publishSessions(next);
      setActiveBoardId(board.boardId);
      setActiveViewId(board.views[0]?.id ?? null);
      setNotice(`Imported as ${session.path}; the existing Host Workspace was not changed.`);
    } catch (error) { setNotice(`Atlas import rejected: ${errorMessage(error)}`); }
  };

  const importScene = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !activeSession) return;
    try {
      if (file.size > MAX_SCENE_BYTES) throw new Error('Excalidraw scene exceeds the Host 2 MiB document limit. Reduce embedded image data before importing.');
      const sceneText = await file.text();
      const inspection = inspectExcalidrawScene(sceneText);
      if (inspection.status === 'read-only') throw new Error(inspection.message);
      const { sceneError: _sceneError, ...sessionWithoutSceneError } = activeSession;
      replaceSession(activeSession.board.boardId, { ...sessionWithoutSceneError, sceneText });
      const freeform = activeSession.board.views.find((view) => view.kind === 'freeform');
      if (freeform) void activateView(activeSession.board.boardId, freeform.id);
      setNotice(`Imported scene into the local draft for ${activeSession.scenePath}.`);
    } catch (error) { setNotice(`Excalidraw import rejected: ${errorMessage(error)}`); }
  };

  const addImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !activeSession) return;
    if (stagedAssetRef.current && stagedAssetRef.current.boardId !== activeSession.board.boardId) {
      setNotice('Prepare or remove the already staged image before adding one to another Board.');
      return;
    }
    try {
      if (file.size === 0 || file.size > MAX_IMAGE_BYTES) throw new Error('Image size must be between 1 byte and 10 MiB.');
      if (!IMAGE_MIME_TYPES.has(file.type as Asset['mime'])) throw new Error(`Unsupported image type ${file.type || '(unknown)'}. Choose PNG, JPEG, WebP, or SVG.`);
      const mime = file.type as Asset['mime'];
      const originalBytes = new Uint8Array(await file.arrayBuffer());
      const bytes = sanitizeImageBytes(originalBytes, mime);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Sanitized image size must be within the 10 MiB limit.');
      const digest = await sha256Hex(bytes);
      const path = `documents/assets/${digest}.${assetExtension(mime)}`;
      const existing = filesRef.current.get(path);
      if (existing) {
        await verifyAssetBytes({ id: 'existing', path, sha256: digest, bytes: bytes.byteLength, mime }, await readFileBytes(host, existing));
      } else publishStagedAsset({ boardId: activeSession.board.boardId, path, bytes, sha256: digest, mime });
      const asset: Asset = { id: createAtlasId('asset'), path, sha256: digest, bytes: bytes.byteLength, mime };
      const offset = activeSession.board.cards.length * 24;
      createCard({
        id: createAtlasId('card'), kind: 'image', assetId: asset.id, annotation: file.name,
        position: { x: 120 + offset, y: 120 + offset }, width: 320, height: 240,
      }, asset);
      setNotice(existing ? 'Added an image card using the matching content-addressed asset.' : `Added image ${file.name}; prepare it with the Board change to transfer bounded chunks.`);
    } catch (error) { setNotice(`Image import rejected: ${errorMessage(error)}`); }
  };

  const exportBoard = () => {
    if (!activeSession) return;
    downloadText(`${activeSession.board.boardId}.atlas.json`, serializeSessionBoard(activeSession));
  };

  const exportScene = async () => {
    if (!activeSession) return;
    try {
      if (activeSession.sceneText === null && activeSession.sceneError) {
        setNotice('The Host scene could not be read, so there is no raw scene available to export. Import a supported scene to replace it.');
        return;
      }
      const sceneText = activeSession.sceneText ?? await createEmptyExcalidrawScene();
      downloadText(`${activeSession.board.boardId}.excalidraw`, sceneText, 'application/json;charset=utf-8');
    } catch (error) { setNotice(`Excalidraw export failed: ${errorMessage(error)}`); }
  };

  const exportVector = async (format: 'png' | 'svg') => {
    if (!activeSession) return;
    if (activeSession.sceneError) { setNotice(`Canvas export is unavailable: ${activeSession.sceneError}`); return; }
    try {
      if (activeSession.sceneText === null && activeSession.sceneError) throw new Error('The Host scene could not be read. Import a supported scene before exporting PNG or SVG.');
      const sceneText = activeSession.sceneText ?? await createEmptyExcalidrawScene();
      const cardExport = await buildAtlasCardExportOverlay(activeSession.board, async (asset) => {
        const staged = stagedAssetRef.current;
        if (staged?.boardId === activeSession.board.boardId && staged.path === asset.path) return staged.bytes;
        const file = filesRef.current.get(asset.path);
        if (!file) throw new Error(`Image asset ${asset.path} is not available in the Host workspace.`);
        return readFileBytes(host, file);
      });
      const blob = await exportExcalidrawScene(sceneText, format, cardExport.overlay);
      downloadBlob(`${activeSession.board.boardId}.${format}`, blob);
      const missing = cardExport.unavailableImagePaths.length;
      setNotice(`${format.toUpperCase()} export downloaded${missing ? ` with ${missing} unavailable image card${missing === 1 ? '' : 's'} represented by a placeholder` : ''}. Export is a local file, not a Host commit.`);
    } catch (error) { setNotice(`${format.toUpperCase()} export failed: ${errorMessage(error)}`); }
  };

  const openStructuredCard = (cardId: string) => {
    if (!activeSession) return;
    const card = activeSession.board.cards.find((item) => item.id === cardId);
    if (card?.source) void openSource(card.source);
    if (card?.kind === 'provider-node' && card.nodeRef) navigateToNode(card.nodeRef);
    const view = activeSession.board.views.find((item) => item.kind === 'freeform');
    if (view) void activateView(activeSession.board.boardId, view.id);
    setFocusCardId(cardId);
  };

  const handleNewBoardName = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.currentTarget.value.trim()) renameBoard(event.currentTarget.value);
  };

  const canConnect = providers.some((provider) => provider.id === providerId && provider.features.includes('listNodes') && provider.features.includes('listEdges'));
  const canPrepare = Boolean(activeSession && dirty && !activeSession.conflict && !prepared && (!stagedAsset || stagedAsset.boardId === activeSession.board.boardId));

  return <div className="atlas-plugin" onKeyDown={onMainKeyDown}>
    <header className="atlas-app-header">
      <div className="atlas-brand"><span className="atlas-brand-mark" aria-hidden="true">A</span><div><strong>Atlas</strong><small>Graph and canvas workspace</small></div></div>
      <div className="atlas-header-actions">
        <button type="button" onClick={() => void createBoard()}>＋ New Board</button>
        <button type="button" onClick={() => boardImportRef.current?.click()}>Import Board</button>
        <button type="button" onClick={() => void refreshWorkspace()} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh Host files'}</button>
        <span className={`atlas-save-indicator ${prepared ? 'is-pending' : dirty ? 'is-dirty' : 'is-clean'}`} role="status">
          {prepared ? 'Prepared · awaiting Host commit' : dirty ? 'Local draft changes' : 'Host baseline loaded'}
        </span>
      </div>
      <input ref={boardImportRef} className="atlas-hidden-input" type="file" accept=".atlas.json,application/json" onChange={(event) => void importBoard(event)} />
    </header>

    {fatalError && <div className="atlas-alert atlas-alert-error" role="alert">{fatalError}<button type="button" onClick={() => setFatalError('')}>Dismiss</button></div>}
    {loading ? <div className="atlas-loading" role="status">Loading Host workspace files…</div> : <div className="atlas-shell">
      <nav className="atlas-board-nav" aria-label="Atlas Boards">
        <div className="atlas-nav-heading"><strong>Boards</strong><small>{sessions.size}</small></div>
        {[...sessions.values()].map((session) => <button
          type="button"
          key={session.board.boardId}
          className={`atlas-board-tab${session.board.boardId === activeBoardId ? ' is-active' : ''}${isSessionDirty(session) ? ' is-dirty' : ''}`}
          onClick={() => { setActiveBoardId(session.board.boardId); setActiveViewId(session.board.views[0]?.id ?? null); setFocusCardId(null); }}
          title={session.path}
        >
          <span className="atlas-board-tab-title">{session.board.name}</span>
          <small>{isSessionDirty(session) ? 'Draft' : 'Loaded'}</small>
        </button>)}
        {sessions.size === 0 && <p className="atlas-muted">No Atlas Boards in this Workspace.</p>}
        {invalidFiles.length > 0 && <section className="atlas-invalid-files">
          <strong>Read-only diagnostics ({invalidFiles.length})</strong>
          {invalidFiles.map((item) => <div key={`${item.path}:${item.revision}`}>
            <span>{item.path}: {item.message}</span>
            {item.rawText && <button type="button" onClick={() => downloadText(item.path.split('/').at(-1) ?? 'invalid.atlas.json', item.rawText)}>Download raw</button>}
          </div>)}
        </section>}
      </nav>

      <main className="atlas-main">
        {!activeSession ? <section className="atlas-empty-workspace">
          <div className="atlas-empty-symbol">◇</div><h1>Start an Atlas Board</h1>
          <p>Atlas stores manual graph, canvas, and timeline documents through the Host. The Host owns review and commit.</p>
          <button type="button" onClick={() => void createBoard()}>Create a Board</button>
        </section> : <>
          <section className="atlas-board-header">
            <div className="atlas-board-title-wrap">
              <label className="atlas-board-name-label">Board name
                <input key={`${activeSession.board.boardId}:${activeSession.board.name}`} defaultValue={activeSession.board.name} onBlur={handleNewBoardName} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} aria-label="Board name" />
              </label>
              <small className="atlas-path-label">{activeSession.path} · {activeSession.board.boardId}</small>
            </div>
            <div className="atlas-toolbar atlas-board-toolbar">
              <button type="button" onClick={() => undoRedo('undo')} disabled={!activeHistory?.canUndo}>Undo</button>
              <button type="button" onClick={() => undoRedo('redo')} disabled={!activeHistory?.canRedo}>Redo</button>
              <button type="button" className="atlas-primary-button" onClick={() => void prepareChanges()} disabled={!canPrepare}>{prepared ? 'Host review pending' : 'Prepare for Host review'}</button>
              <button type="button" onClick={exportBoard}>Export .atlas.json</button>
              <button type="button" onClick={() => void exportScene()}>Export .excalidraw</button>
              <button type="button" onClick={() => void exportVector('png')}>PNG</button>
              <button type="button" onClick={() => void exportVector('svg')}>SVG</button>
            </div>
          </section>

          <section className="atlas-view-header">
            <div className="atlas-view-tabs" role="tablist" aria-label="Board views">
              {activeSession.board.views.map((view) => <button type="button" key={view.id} role="tab" aria-selected={view.id === activeView?.id} className={view.id === activeView?.id ? 'is-active' : ''} onClick={() => setView(view.id)}>{view.name}<small>{view.kind}</small></button>)}
            </div>
            <div className="atlas-view-actions">
              {activeView && <label>View name<input key={`${activeView.id}:${activeView.name}`} defaultValue={activeView.name} aria-label="View name" onBlur={(event) => renameView(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>}
              <label>Add view<select value="" onChange={(event) => { if (event.currentTarget.value) createView(event.currentTarget.value as View['kind']); event.currentTarget.value = ''; }}>
                <option value="">Choose…</option><option value="graph">Graph</option><option value="freeform">Canvas</option><option value="board">Kanban</option><option value="timeline">Timeline</option><option value="storyboard">Storyboard</option>
              </select></label>
              <button type="button" onClick={removeView} disabled={activeSession.board.views.length <= 1}>Delete view</button>
            </div>
          </section>

          {activeSession.conflict && <section className="atlas-conflict" role="alert">
            <div><strong>Host revision conflict</strong><p>{activeSession.path} changed outside this draft. Choose which document version to continue from.</p></div>
            <button type="button" onClick={() => acceptConflict(false)}>Reload Host version</button>
            <button type="button" onClick={() => acceptConflict(true)}>Keep my draft on latest revision</button>
          </section>}
          {activeSession.externalDeleted && <section className="atlas-conflict" role="alert"><strong>This Board was removed from the Host Workspace; its local draft remains in memory.</strong><button type="button" onClick={() => void prepareChanges()}>Create it again through Host review</button></section>}
          {activeSession.sceneError && <div className="atlas-alert atlas-alert-warning" role="status">Canvas is read-only: {activeSession.sceneError}{activeSession.sceneText !== null ? ' Raw scene export remains available.' : ''}</div>}

          <section className="atlas-command-toolbar" aria-label="Atlas commands">
            {activeView?.kind === 'freeform' && <>
              <button type="button" onClick={createTextCard}>＋ Text card</button>
              <button type="button" onClick={createSourceCard} disabled={sourcePanel?.state !== 'ready'}>＋ Source card</button>
              <button type="button" onClick={() => assetInputRef.current?.click()} disabled={Boolean(stagedAsset && stagedAsset.boardId !== activeSession.board.boardId)}>＋ Image card</button>
              <button type="button" onClick={() => sceneImportRef.current?.click()}>Import .excalidraw</button>
              <input ref={assetInputRef} className="atlas-hidden-input" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(event) => void addImage(event)} />
              <input ref={sceneImportRef} className="atlas-hidden-input" type="file" accept=".excalidraw,application/json" onChange={(event) => void importScene(event)} />
            </>}
            {activeView?.kind === 'graph' && <>
              <label>Provider<select value={providerId} onChange={(event) => setProviderId(event.currentTarget.value)} disabled={providers.length === 0}>
                <option value="">Select provider</option>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.id} · {provider.version}</option>)}
              </select></label>
              <button type="button" onClick={() => void connectProvider()} disabled={!canConnect || !workspace || Boolean(graph?.providerIds.includes(providerId))}>Connect selected provider</button>
              {graph?.providerIds.map((connectedId) => <button type="button" key={connectedId} onClick={() => void disconnectProvider(connectedId)}>Disconnect {connectedId}</button>)}
              {providerStatus && <small className="atlas-status-inline">{providerStatus}</small>}
              {providerError && <small className="atlas-error-inline" role="alert">{providerError}</small>}
            </>}
          </section>

          {prepared && <section className="atlas-prepared" role="status">
            <div><strong>Durable Host journal ACK received.</strong><p>Operation {prepared.operationId} · sequence {prepared.journalSequence} · base revision {prepared.preparedAtRevision}. Host review and commit are pending.</p></div>
            <ul>{prepared.changes.map((change) => <li key={change.path}>{change.operation} {change.path} · {change.bytes} bytes</li>)}</ul>
          </section>}

          <section className="atlas-view-content" key={`${activeSession.board.boardId}:${activeView?.id ?? ''}`}>
            {activeView?.kind === 'graph' && <GraphCanvas
              board={activeSession.board}
              view={activeView}
              graph={graph}
              graphWorker={graphWorkerRef.current ?? disabledGraphWorker()}
              onBoardChange={(next) => acceptBoard(activeSession.board.boardId, next)}
              onSource={(source) => void openSource(source)}
              onLayout={runLayout}
              onCancelLayout={cancelLayout}
              searchResult={searchResult}
              onSearch={setSearchQuery}
              searchQuery={searchQuery}
              onAddProviderNode={addProviderNode}
              focusNodeId={focusNodeId}
              onFocusDone={() => setFocusNodeId(null)}
            />}
            {activeView?.kind === 'freeform' && <div className="atlas-canvas-shell">
              {activeSession.sceneError ? <div className="atlas-scene-readonly"><p>{activeSession.sceneError}</p>{activeSession.sceneText === null ? <p>Raw scene content is unavailable. Import a supported scene to replace it.</p> : <pre>{activeSession.sceneText.slice(0, 6000)}</pre>}</div> : activeSession.sceneText === null ? <div className="atlas-loading" role="status">Loading Canvas tools…</div> : <FreeformView
                board={activeSession.board}
                view={activeView}
                sceneText={activeSession.sceneText}
                assets={assetUrls}
                onBoardChange={(next) => acceptBoard(activeSession.board.boardId, next)}
                onSceneChange={(sceneText) => replaceSession(activeSession.board.boardId, { ...activeSession, sceneText })}
                onDuplicateCard={duplicateCard}
                onSource={(source) => void openSource(source)}
                onNavigateToNode={navigateToNode}
                focusCardId={focusCardId}
              />}
            </div>}
            {(activeView?.kind === 'board' || activeView?.kind === 'timeline' || activeView?.kind === 'storyboard') && <StructuredViews
              board={activeSession.board}
              view={activeView}
              onBoardChange={(next) => acceptBoard(activeSession.board.boardId, next)}
              onOpenCard={openStructuredCard}
            />}
          </section>

          {assetErrors.length > 0 && <section className="atlas-alert atlas-alert-warning" role="status"><strong>Asset diagnostics</strong><ul>{assetErrors.map((error) => <li key={error}>{error}</li>)}</ul></section>}
          {stagedAsset?.boardId === activeSession.board.boardId && <p className="atlas-staged-label">Image staged locally: {stagedAsset.path} · {stagedAsset.bytes.byteLength} bytes · it will be sent in bounded chunks with the next Host prepare.</p>}
        </>}
      </main>

      <aside className="atlas-host-sidebar">
        <section className="atlas-panel-section">
          <h2>Host state</h2>
          <p><strong>Workspace:</strong> {workspace?.workspaceId ?? 'Loading'}</p>
          <p><strong>Source revision:</strong> {workspace?.sourceRevision ?? '—'}</p>
          <p><strong>Files:</strong> {files.size}</p>
          <p><strong>Change authority:</strong> Host review and commit</p>
          <p className="atlas-muted">Atlas only prepares document intents. A durable journal ACK does not mean the Host has committed them.</p>
          {notice && <div className="atlas-notice" role="status">{notice}</div>}
        </section>
        {sourcePanel && <section className="atlas-panel-section atlas-source-inspector" aria-label="Source Inspector">
          <div className="atlas-source-heading"><h2>Source Inspector</h2><button type="button" onClick={() => setSourcePanel(null)} aria-label="Close source inspector">×</button></div>
          <p className="atlas-source-ref">{sourcePanel.source.path}<br />revision {sourcePanel.source.revision}<br />workspace {sourcePanel.source.workspaceId}</p>
          {sourcePanel.state === 'loading' ? <p>Opening the exact pinned Host revision…</p>
            : sourcePanel.state === 'ready' ? <>
              <p className="atlas-source-state is-ready">Pinned source revision is available.</p>
              <button type="button" onClick={createSourceCard} disabled={!activeSession}>Create Source card</button>
              <pre className="atlas-source-content">{sourcePanel.content}</pre>
            </>
              : <p className={`atlas-source-state is-${sourcePanel.state}`}>{sourceStateLabel(sourcePanel.state)}: {sourcePanel.message}</p>}
        </section>}
      </aside>
    </div>}
  </div>;
}

async function collectProviderPages<T extends { snapshot: SnapshotRef; items: unknown[]; nextCursor: string | null; complete: boolean }>(
  host: PluginHostClient,
  leaseId: string,
  method: 'listNodes' | 'listEdges',
  snapshot: SnapshotRef,
): Promise<T[]> {
  const pages: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let count = 0; count < 100_000; count += 1) {
    const result = await host.providerCall(leaseId, { method, params: { ...(cursor ? { cursor } : {}), limit: 500 } });
    if (!result || !Array.isArray(result.items) || !('snapshot' in result) || !('complete' in result) || !('nextCursor' in result)) {
      throw new Error(`Provider ${method} returned an invalid page.`);
    }
    if (!sameSnapshot(result.snapshot, snapshot)) throw new Error(`Provider ${method} changed snapshot during pagination.`);
    const page = result as T;
    pages.push(page);
    if (page.complete && page.nextCursor === null) return pages;
    if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error(`Provider ${method} returned an incomplete or repeated cursor.`);
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error(`Provider ${method} exceeded the pagination limit.`);
}

async function assembleProviderSnapshot(entries: Map<string, ConnectedProvider>): Promise<ProviderSnapshot> {
  const ordered = [...entries.values()].sort((left, right) => left.providerId.localeCompare(right.providerId));
  const first = ordered[0];
  if (!first) throw new Error('At least one provider snapshot is required.');
  for (const entry of ordered.slice(1)) {
    if (entry.snapshot.workspaceId !== first.snapshot.workspaceId
      || entry.snapshot.sourceRevision !== first.snapshot.sourceRevision
      || entry.snapshot.epoch !== first.snapshot.epoch) {
      throw new Error('Providers returned snapshots from different workspace source revisions or Host epochs.');
    }
  }
  const snapshot: SnapshotRef = ordered.length === 1
    ? first.snapshot
    : {
        workspaceId: first.snapshot.workspaceId,
        sourceRevision: first.snapshot.sourceRevision,
        providerRevision: `atlas-composite-v1:${await sha256Hex(new TextEncoder().encode(JSON.stringify(ordered.map((item) => [item.providerId, item.snapshot.providerRevision]))))}`,
        epoch: first.snapshot.epoch,
      };
  return {
    providerId: ordered.map((item) => item.providerId).join(' + '),
    providerIds: ordered.map((item) => item.providerId),
    snapshot,
    nodes: ordered.flatMap((item) => item.nodes),
    edges: ordered.flatMap((item) => item.edges),
  };
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function sourceStateLabel(state: SourcePanel['state']): string {
  switch (state) {
    case 'missing': return 'Source missing';
    case 'stale': return 'Pinned revision is stale';
    case 'denied': return 'Host denied access';
    case 'error': return 'Source unavailable';
    case 'loading': return 'Loading';
    case 'ready': return 'Ready';
  }
}

function providerErrorKind(error: unknown): string {
  const code = hostErrorCode(error);
  if (code === 'PERMISSION_DENIED') return 'Provider access denied';
  if (code === 'NOT_INSTALLED') return 'Provider not installed';
  if (code === 'DISABLED') return 'Provider disabled';
  if (code === 'TIMEOUT') return 'Provider timed out';
  if (code === 'PROVIDER_FAILED') return 'Provider failed';
  if (code === 'SNAPSHOT_STALE' || code === 'RESYNC_REQUIRED') return 'Provider snapshot stale';
  return 'Provider unavailable';
}

function hostErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown; details?: { code?: unknown } };
  return typeof value.code === 'string' ? value.code : typeof value.details?.code === 'string' ? value.details.code : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function stableSeed(input: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) value = Math.imul(value ^ input.charCodeAt(index), 0x01000193);
  return value >>> 0;
}

/** ReactFlow props remain mounted only while a provider Worker is live. */
function disabledGraphWorker(): GraphWorkerClient {
  return {
    replaceSnapshot: async () => { throw new Error('No graph Worker is connected.'); },
    replaceSnapshotFromPages: async () => { throw new Error('No graph Worker is connected.'); },
    applyDelta: async () => { throw new Error('No graph Worker is connected.'); },
    applyDeltaPages: async () => { throw new Error('No graph Worker is connected.'); },
    search: async () => { throw new Error('No graph Worker is connected.'); },
    neighbors: async () => { throw new Error('No graph Worker is connected.'); },
    shortestPath: async () => { throw new Error('No graph Worker is connected.'); },
    weakComponents: async () => { throw new Error('No graph Worker is connected.'); },
    cancelAll: () => undefined,
    close: () => undefined,
  };
}
