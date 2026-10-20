import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import '@xyflow/react/dist/style.css';
import '@scriptorium-atlas/canvas/ui.css';
import './atlas.css';
import type {
  Asset,
  BoardDocument,
  BoardView,
  ChangeIntent,
  GraphDelta,
  GraphDeltaPage,
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
import { applyGraphDeltaPages, combineGraphDeltaPages, createGraphIndex, nodeKey, sameSnapshot } from '@scriptorium-atlas/graph';
import { createGraphWorkerClient } from '@scriptorium-atlas/graph/worker';
import type { GraphWorkerClient } from '@scriptorium-atlas/graph/worker';
import { createLayoutWorkerClient } from '@scriptorium-atlas/layout/worker';
import type { LayoutWorkerClient } from '@scriptorium-atlas/layout/worker';
import type { LayoutInput } from '@scriptorium-atlas/layout';
import { serializeBoard } from '@scriptorium-atlas/persistence/board';
import { assembleProviderSnapshot } from './provider-snapshot.js';
import type { ConnectedProvider, ProviderSnapshot } from './provider-snapshot.js';
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
import { isCurrentLayoutRequest, layoutErrorNotice, LAYOUT_CANCELLED_NOTICE } from './layout-notice.js';
import { initialWorkspaceRefreshStatus, reduceWorkspaceRefreshStatus } from './workspace-refresh.js';
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
  const workspaceRef = useRef(workspace);
  const [files, setFiles] = useState<Map<string, WorkspaceFile>>(() => new Map());
  const filesRef = useRef(files);
  const [invalidFiles, setInvalidFiles] = useState<InvalidBoardFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [refreshStatus, dispatchRefreshStatus] = useReducer(reduceWorkspaceRefreshStatus, initialWorkspaceRefreshStatus);
  const fatalError = refreshStatus.fatalError;
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
  const [refreshingProviders, setRefreshingProviders] = useState(false);
  const refreshingProvidersRef = useRef(false);
  const [graph, setGraph] = useState<ProviderSnapshot | null>(null);
  const graphRef = useRef<ProviderSnapshot | null>(graph);
  const graphWorkerRef = useRef<GraphWorkerClient | null>(null);
  const layoutWorkerRef = useRef<LayoutWorkerClient | null>(null);
  const layoutRequestSequenceRef = useRef(0);
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
    dispatchRefreshStatus({ type: 'started', sequence });
    if (initial) setLoading(true);
    else setRefreshing(true);
    try {
      const inventory = await loadAtlasInventory(host);
      if (sequence !== refreshSequenceRef.current) return inventory;
      workspaceRef.current = inventory.workspace;
      setWorkspace(inventory.workspace);
      if ([...providerEntriesRef.current.values()].some((provider) => provider.snapshot.sourceRevision !== inventory.workspace.sourceRevision)) {
        setProviderStatus('ワークスペースのソースリビジョンが変わりました。接続中Providerを更新してください。');
      }
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
        setNotice(`Hostのコミットを確認しました（操作ID: ${commitObserved.operationId}）。ジャーナルの永続化ACKとHostのコミットは別の状態です。`);
      }
      if (!activeBoardIdRef.current && next.size > 0) {
        const id = next.keys().next().value as string | undefined;
        if (id) { activeBoardIdRef.current = id; setActiveBoardId(id); setActiveViewId(next.get(id)!.board.views[0]?.id ?? null); }
      }
      if (initial && next.size === 0 && inventory.invalid.length === 0) setNotice('Atlasボードを作成して始めましょう。変更はHostのレビューに送信されます。');
      dispatchRefreshStatus({ type: 'succeeded', sequence });
      return inventory;
    } catch (error) {
      dispatchRefreshStatus({
        type: 'failed',
        sequence,
        message: `${initial ? 'Hostワークスペースを読み込めませんでした' : 'Hostワークスペースを更新できませんでした'}: ${errorMessage(error)}`,
      });
      throw error;
    } finally {
      if (sequence === refreshSequenceRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [host, dispatchRefreshStatus, publishFiles, publishPrepared, publishSessions, publishStagedAsset]);

  useEffect(() => {
    void refreshWorkspace(true).catch(() => undefined);
    const unsubscribe = host.subscribeWorkspace(() => {
      // Host changes, including grant updates, invalidate opaque inventory cursors; start again at page one.
      void refreshWorkspace().catch(() => undefined);
    });
    return () => {
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
    }).catch((error) => { if (active) setProviderError(`Providerの検出に失敗しました: ${errorMessage(error)}`); });
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
        if (!controller.signal.aborted) setProviderError(`グラフ検索に失敗しました: ${errorMessage(error)}`);
      });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [activeSession, activeView, graph, searchQuery]);

  useEffect(() => {
    if (!workspace || !graph || graph.snapshot.sourceRevision === workspace.sourceRevision) return;
    setProviderStatus('ワークスペースのソースリビジョンが変わりました。接続中Providerを更新してください。');
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
      setNotice('Canvasを読み込んでいます…');
      try {
        const sceneText = await createEmptyExcalidrawScene();
        const current = sessionsRef.current.get(boardId);
        if (current?.sceneText === null) replaceSession(boardId, { ...current, sceneText });
      } catch (error) {
        setNotice(`Canvasを開けませんでした: ${errorMessage(error)}`);
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
      setNotice(`${session.path}をローカル下書きとして作成しました。準備ができたらHostレビュー用に変更を送ってください。`);
    } catch (error) { dispatchRefreshStatus({ type: 'set-error', message: `ボードを作成できませんでした: ${errorMessage(error)}` }); }
  }, [dispatchRefreshStatus, makeLocalSession, publishSessions]);

  const createView = useCallback((kind: View['kind']) => {
    if (!activeSession) return;
    const id = createAtlasId('view');
    const name = ({ graph: 'グラフ', freeform: 'キャンバス', board: 'ボード', timeline: 'タイムライン', storyboard: 'ストーリーボード' } as const)[kind];
    const common = { id, kind, name, viewport: { x: 0, y: 0, zoom: 1 } };
    let view: BoardView;
    if (kind === 'graph') view = { ...common, kind, pins: [] };
    else if (kind === 'board') view = { ...common, kind, laneIds: ['lane-unassigned'], lanes: [{ id: 'lane-unassigned', label: '未割り当て', cardIds: [] }] };
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
    const currentWorkspace = workspace;
    const previousEntries = providerEntriesRef.current;
    const generation = refreshSequenceRef.current;
    if (!currentWorkspace || !providerId) return;
    const descriptor = providers.find((item) => item.id === providerId);
    if (!descriptor) { setProviderError(`Provider ${providerId}がHostから検出されませんでした。`); return; }
    if (!descriptor.features.includes('listNodes') || !descriptor.features.includes('listEdges')) {
      setProviderError(`${providerId}はページ単位のノード一覧とエッジ一覧の両方を提供していません。`);
      return;
    }
    if (previousEntries.has(providerId)) {
      setProviderError(`${providerId}はすでに接続されています。`);
      return;
    }
    setProviderError('');
    setProviderStatus(`${providerId}に接続しています…`);
    let acquiredLeaseId: string | null = null;
    let candidateWorker: GraphWorkerClient | null = null;
    try {
      const lease = await host.acquireProvider(providerId, currentWorkspace.sourceRevision);
      acquiredLeaseId = lease.leaseId;
      if (lease.providerId !== providerId || lease.snapshot.workspaceId !== currentWorkspace.workspaceId || lease.snapshot.sourceRevision !== currentWorkspace.sourceRevision) {
        await host.releaseProvider(lease.leaseId).catch(() => undefined);
        acquiredLeaseId = null;
        throw new Error('ProviderリースのProvider ID、ワークスペース、またはソースリビジョンが一致しません。');
      }
      const nodePages = await collectProviderPages<ProviderPage>(host, lease.leaseId, 'listNodes', lease.snapshot);
      const edgePages = await collectProviderPages<GraphEdgePage>(host, lease.leaseId, 'listEdges', lease.snapshot);
      const entry: ConnectedProvider = { providerId, leaseId: lease.leaseId, snapshot: lease.snapshot, nodes: nodePages.flatMap((page) => page.items), edges: edgePages.flatMap((page) => page.items) };
      const candidateEntries = new Map(previousEntries);
      candidateEntries.set(providerId, entry);
      const combined = await assembleProviderSnapshot(candidateEntries);
      candidateWorker = createGraphWorkerClient();
      await candidateWorker.replaceSnapshot(combined.snapshot, combined.nodes, combined.edges);
      const entriesAtSwap = providerEntriesRef.current;
      const workspaceAtSwap = workspaceRef.current;
      if (refreshSequenceRef.current !== generation
        || entriesAtSwap !== previousEntries
        || entriesAtSwap.size !== previousEntries.size
        || [...previousEntries].some(([id, previous]) => entriesAtSwap.get(id) !== previous)
        || !workspaceAtSwap
        || workspaceAtSwap.workspaceId !== currentWorkspace.workspaceId
        || workspaceAtSwap.sourceRevision !== currentWorkspace.sourceRevision) {
        throw new Error('ワークスペースまたは接続中Providerが変わりました。現在のGraphを保ったまま接続を破棄しました。');
      }
      graphWorkerRef.current?.close();
      graphWorkerRef.current = candidateWorker;
      candidateWorker = null;
      providerEntriesRef.current = candidateEntries;
      acquiredLeaseId = null;
      publishGraph(combined);
      setProviderStatus(`${combined.providerIds.join(' + ')}: ノード ${combined.nodes.length} 件、エッジ ${combined.edges.length} 件を共通ソースリビジョンから読み込みました。`);
    } catch (error) {
      candidateWorker?.close();
      if (acquiredLeaseId) await host.releaseProvider(acquiredLeaseId).catch(() => undefined);
      setProviderError(`${providerErrorKind(error)}: ${errorMessage(error)}`);
      setProviderStatus('Providerを追加できませんでした。既存のスナップショットとボードデータは変更されていません。');
    }
  };

  const refreshProviders = async () => {
    const currentWorkspace = workspace;
    const previousEntries = providerEntriesRef.current;
    const refreshGeneration = refreshSequenceRef.current;
    if (!currentWorkspace || previousEntries.size === 0 || refreshingProvidersRef.current) return;
    refreshingProvidersRef.current = true;
    setRefreshingProviders(true);
    setProviderError('');
    setProviderStatus('新しいProviderスナップショットを取得しています…');

    const acquiredLeases: string[] = [];
    const stagedEntries = new Map<string, ConnectedProvider>();
    const providerDeltas: GraphDelta[] = [];
    let fullResyncUsed = false;
    let candidateWorker: GraphWorkerClient | null = null;
    try {
      const ordered = [...previousEntries.values()].sort((left, right) => left.providerId.localeCompare(right.providerId));
      for (const previous of ordered) {
        const lease = await host.acquireProvider(previous.providerId, currentWorkspace.sourceRevision);
        acquiredLeases.push(lease.leaseId);
        if (lease.providerId !== previous.providerId
          || lease.snapshot.workspaceId !== currentWorkspace.workspaceId
          || lease.snapshot.sourceRevision !== currentWorkspace.sourceRevision) {
          throw new Error(`Provider ${previous.providerId}の新しいリースが現在のワークスペースリビジョンに一致しません。`);
        }

        const descriptor = providers.find((item) => item.id === previous.providerId);
        let nextNodes: GraphNode[];
        let nextEdges: GraphEdge[];
        if (descriptor?.features.includes('diff')) {
          try {
            const pages = await collectProviderDeltaPages(host, lease.leaseId, previous.snapshot, lease.snapshot);
            const previousIndex = createGraphIndex({ snapshot: previous.snapshot, nodes: previous.nodes, edges: previous.edges });
            const nextIndex = applyGraphDeltaPages(previousIndex, pages);
            if (!sameSnapshot(nextIndex.snapshot, lease.snapshot)) throw new Error(`Provider ${previous.providerId}の差分先が新しいリースと一致しません。`);
            const delta = combineGraphDeltaPages(previous.snapshot, pages);
            providerDeltas.push(delta);
            nextNodes = [...nextIndex.nodes];
            nextEdges = [...nextIndex.edges];
          } catch (error) {
            if (hostErrorCode(error) !== 'RESYNC_REQUIRED') throw error;
            fullResyncUsed = true;
            const full = await fetchProviderSnapshot(host, lease.leaseId, lease.snapshot);
            nextNodes = full.nodes;
            nextEdges = full.edges;
          }
        } else {
          fullResyncUsed = true;
          const full = await fetchProviderSnapshot(host, lease.leaseId, lease.snapshot);
          nextNodes = full.nodes;
          nextEdges = full.edges;
        }

        stagedEntries.set(previous.providerId, {
          providerId: previous.providerId,
          leaseId: lease.leaseId,
          snapshot: lease.snapshot,
          nodes: nextNodes,
          edges: nextEdges,
        });
      }

      const currentEntries = providerEntriesRef.current;
      if (currentEntries !== previousEntries || currentEntries.size !== previousEntries.size
        || [...previousEntries].some(([id, entry]) => currentEntries.get(id) !== entry)) {
        throw new Error('更新中に接続Providerが変更されました。もう一度更新してください。');
      }
      const latestWorkspace = workspaceRef.current;
      if (!latestWorkspace || latestWorkspace.workspaceId !== currentWorkspace.workspaceId || latestWorkspace.sourceRevision !== currentWorkspace.sourceRevision) {
        throw new Error('更新中にワークスペースのソースリビジョンが変わりました。もう一度更新してください。');
      }
      const combined = await assembleProviderSnapshot(stagedEntries);
      const previousCombined = await assembleProviderSnapshot(previousEntries);
      if (!graphRef.current || !sameSnapshot(graphRef.current.snapshot, previousCombined.snapshot)) {
        throw new Error('更新前のGraphスナップショットが接続Provider一覧と一致しません。再接続してください。');
      }

      candidateWorker = createGraphWorkerClient();
      if (!fullResyncUsed) {
        const combinedDelta: GraphDelta = {
          previousSnapshot: previousCombined.snapshot,
          snapshot: combined.snapshot,
          changedNodes: providerDeltas.flatMap((delta) => delta.changedNodes ?? []),
          removedNodes: providerDeltas.flatMap((delta) => delta.removedNodes ?? []),
          changedEdges: providerDeltas.flatMap((delta) => delta.changedEdges ?? []),
          removedEdges: providerDeltas.flatMap((delta) => delta.removedEdges ?? []),
        };
        await candidateWorker.replaceSnapshot(previousCombined.snapshot, previousCombined.nodes, previousCombined.edges);
        try {
          await candidateWorker.applyDelta(combinedDelta);
        } catch (error) {
          if (hostErrorCode(error) !== 'RESYNC_REQUIRED') throw error;
          candidateWorker.close();
          candidateWorker = createGraphWorkerClient();
          fullResyncUsed = true;
          await candidateWorker.replaceSnapshot(combined.snapshot, combined.nodes, combined.edges);
        }
      } else {
        await candidateWorker.replaceSnapshot(combined.snapshot, combined.nodes, combined.edges);
      }

      const entriesAtSwap = providerEntriesRef.current;
      const workspaceAtSwap = workspaceRef.current;
      if (refreshSequenceRef.current !== refreshGeneration
        || entriesAtSwap !== previousEntries
        || entriesAtSwap.size !== previousEntries.size
        || [...previousEntries].some(([id, entry]) => entriesAtSwap.get(id) !== entry)
        || !workspaceAtSwap
        || workspaceAtSwap.workspaceId !== currentWorkspace.workspaceId
        || workspaceAtSwap.sourceRevision !== currentWorkspace.sourceRevision) {
        throw new Error('更新中にワークスペースまたはProvider状態が変わりました。現在のGraphを保ったまま更新を破棄しました。');
      }

      const oldWorker = graphWorkerRef.current;
      graphWorkerRef.current = candidateWorker;
      candidateWorker = null;
      providerEntriesRef.current = stagedEntries;
      publishGraph(combined);
      oldWorker?.close();

      const released = await Promise.allSettled(ordered.map((entry) => host.releaseProvider(entry.leaseId)));
      const releaseFailures = released.filter((result) => result.status === 'rejected').length;
      setProviderStatus(`${combined.providerIds.join(' + ')}を更新しました。ノード ${combined.nodes.length} 件、エッジ ${combined.edges.length} 件${fullResyncUsed ? '（全件再同期）' : '（差分適用）'}。${releaseFailures ? `古いリース ${releaseFailures} 件を解放できませんでした。` : ''}`);
    } catch (error) {
      candidateWorker?.close();
      await Promise.allSettled(acquiredLeases.map((leaseId) => host.releaseProvider(leaseId)));
      setProviderError(`${providerErrorKind(error)}: ${errorMessage(error)}`);
      setProviderStatus('Providerを更新できませんでした。現在のGraphスナップショット、ボード、ピンは変更されていません。');
    } finally {
      refreshingProvidersRef.current = false;
      setRefreshingProviders(false);
    }
  };

  const disconnectProvider = async (disconnectedId: string) => {
    const previousEntries = providerEntriesRef.current;
    const currentWorkspace = workspaceRef.current;
    const generation = refreshSequenceRef.current;
    const removed = previousEntries.get(disconnectedId);
    if (!removed || !currentWorkspace) return;
    const candidateEntries = new Map(previousEntries);
    candidateEntries.delete(disconnectedId);
    let candidateWorker: GraphWorkerClient | null = null;
    try {
      let combined: ProviderSnapshot | null = null;
      if (candidateEntries.size > 0) {
        combined = await assembleProviderSnapshot(candidateEntries);
        candidateWorker = createGraphWorkerClient();
        await candidateWorker.replaceSnapshot(combined.snapshot, combined.nodes, combined.edges);
      }

      const entriesAtSwap = providerEntriesRef.current;
      const workspaceAtSwap = workspaceRef.current;
      if (refreshSequenceRef.current !== generation
        || entriesAtSwap !== previousEntries
        || entriesAtSwap.size !== previousEntries.size
        || [...previousEntries].some(([id, previous]) => entriesAtSwap.get(id) !== previous)
        || !workspaceAtSwap
        || workspaceAtSwap.workspaceId !== currentWorkspace.workspaceId
        || workspaceAtSwap.sourceRevision !== currentWorkspace.sourceRevision) {
        throw new Error('ワークスペースまたは接続中Providerが変わりました。現在のGraphを保ったまま切断を破棄しました。');
      }

      graphWorkerRef.current?.close();
      graphWorkerRef.current = candidateWorker;
      candidateWorker = null;
      providerEntriesRef.current = candidateEntries;
      publishGraph(combined);
      if (!combined) setSearchResult(null);
      await host.releaseProvider(removed.leaseId);
      setProviderStatus(candidateEntries.size ? `接続中: ${[...candidateEntries.keys()].join(' + ')}。` : 'Providerを切断しました。保存済みボード参照は未解決項目として残ります。');
    } catch (error) {
      candidateWorker?.close();
      setProviderError(`Providerの切断に失敗しました: ${errorMessage(error)}`);
    }
  };

  const runLayout = async (kind: 'force' | 'layered' | 'timeline' | 'manual') => {
    if (!activeSession || !activeView || activeView.kind !== 'graph') return;
    const requestSequence = ++layoutRequestSequenceRef.current;
    const board = activeSession.board;
    const snapshot = graph?.snapshot;
    const worker = layoutWorkerRef.current ?? createLayoutWorkerClient();
    layoutWorkerRef.current = worker;
    const revision = { boardRevision: board.revision, ...(snapshot ? { snapshot } : {}) };
    worker.updateRevision(revision);
    const layoutName = ({ force: '力学', layered: '階層', timeline: 'タイムライン', manual: '手動' } as const)[kind];
    setNotice(`${layoutName}レイアウトを計算しています…`);
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
      if (!isCurrentLayoutRequest(requestSequence, layoutRequestSequenceRef.current)) return;
      const current = sessionsRef.current.get(board.boardId);
      const currentSnapshot = graphRef.current?.snapshot;
      const snapshotMatches = snapshot ? Boolean(result.snapshot && currentSnapshot && sameSnapshot(snapshot, currentSnapshot) && sameSnapshot(result.snapshot, snapshot)) : !result.snapshot;
      if (!current || current.board.revision !== result.boardRevision || !snapshotMatches) {
        setNotice('古いレイアウト結果を破棄しました。現在のボードとProviderスナップショットで再計算してください。');
        return;
      }
      const positions = result.positions.map(({ nodeId, position }) => ({ id: nodeId, position }));
      acceptBoard(board.boardId, applyAtlasCommand(current.board, { type: 'node.apply-layout', positions }));
      setNotice(`${layoutName}レイアウトを1回のUndo操作として適用しました。端点が未解決のエッジ: ${result.unresolvedEdgeIds.length}件。`);
    } catch (error) {
      if (!isCurrentLayoutRequest(requestSequence, layoutRequestSequenceRef.current)) return;
      setNotice(layoutErrorNotice(error, errorMessage(error)));
    }
  };

  const cancelLayout = () => {
    layoutRequestSequenceRef.current += 1;
    layoutWorkerRef.current?.cancel();
    setNotice(LAYOUT_CANCELLED_NOTICE);
  };

  const prepareChanges = async () => {
    if (!activeSession || activeSession.conflict) return;
    if (preparingRef.current) return;
    if (preparedRef.current) { setNotice('Hostレビューの操作がすでに保留中です。コミットまたは解決を待ってから次の変更を準備してください。'); return; }
    const staged = stagedAssetRef.current;
    if (staged && staged.boardId !== activeSession.board.boardId) { setNotice('別のボードを準備する前に、画像アップロードを完了してください。'); return; }
    preparingRef.current = true;
    let retryAfterConcurrentEdit = false;
    setNotice('Hostの最新リビジョンを確認しています…');
    try {
      const latest = await loadAtlasInventory(host);
      workspaceRef.current = latest.workspace;
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
        setNotice('Hostのリビジョンが変わりました。このボードを準備する前に、外部編集との競合を解決してください。');
        return;
      }
      const currentSession = sessionsRef.current.get(activeSession.board.boardId) ?? activeSession;
      if (currentSession.board.revision !== activeSession.board.revision || currentSession.sceneText !== activeSession.sceneText) {
        retryAfterConcurrentEdit = true;
        setNotice('Hostのファイル一覧を読み込んでいる間にローカル下書きが変わりました。もう一度「レビュー用に準備」を実行してください。');
        return;
      }
      const boardText = serializeSessionBoard(currentSession);
      if (new TextEncoder().encode(boardText).byteLength > MAX_BOARD_BYTES) throw new Error('Atlasボードがドキュメント上限の2 MiBを超えています。');
      const writes: ChangeIntent['writes'] = [];
      const reads: ChangeIntent['reads'] = [];
      if (activeSession.baseBoardText === null || boardText !== activeSession.baseBoardText || wasDeleted) {
        writes.push({ path: activeSession.path, content: boardText, encoding: 'utf8' });
        reads.push({ path: activeSession.path, revision: currentBoardFile?.revision ?? null });
      }
      let sceneText: string | undefined;
      if (activeSession.sceneText !== null && (activeSession.baseSceneText === null || activeSession.sceneText !== activeSession.baseSceneText)) {
        if (activeSession.sceneError) throw new Error(`Excalidrawシーンは読み取り専用です: ${activeSession.sceneError}`);
        if (new TextEncoder().encode(activeSession.sceneText).byteLength > MAX_SCENE_BYTES) throw new Error('ExcalidrawシーンがHostの2 MiB上限を超えています。生シーンをエクスポートし、埋め込み画像を小さくするか、より小さなシーンをインポートしてください。');
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
        if (!assetFile) throw new Error(`参照アセット ${asset.path} が見つかりません。ボードを準備する前にHostバンドルのインポートで復元してください。`);
        reads.push({ path: asset.path, revision: assetFile.revision });
      }
      if (!writes.length) { setNotice('準備するローカル変更はありません。'); return; }
      const operationId = crypto.randomUUID();
      const change: ChangeIntent = {
        operationId,
        workspaceId: latest.workspace.workspaceId,
        baseWorkspaceRevision: latest.workspace.sourceRevision,
        reads: reads.sort((left, right) => left.path.localeCompare(right.path)),
        writes: writes.sort((left, right) => left.path.localeCompare(right.path)),
        message: `Atlasボードを更新: ${activeSession.board.name}`,
        kind: staged ? 'asset' : 'document',
      };
      setNotice(staged ? '画像データを分割してHostへアップロードしています…' : 'ドキュメント変更をHostジャーナルに準備しています…');
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
          throw new Error('Host画像アップロードの応答が、準備中のアセットと一致しません。');
        }
        for (let offset = start.nextOffset; offset < staged.bytes.byteLength;) {
          const part = staged.bytes.subarray(offset, Math.min(offset + ASSET_CHUNK_BYTES, staged.bytes.byteLength));
          const receipt = await host.appendAsset({ uploadId: start.uploadId, offset, content: bytesToBase64(part) });
          if (receipt.uploadId !== start.uploadId || receipt.nextOffset !== offset + part.byteLength || receipt.receivedBytes !== offset + part.byteLength) {
            throw new Error('Hostの画像チャンク応答が一致しません。');
          }
          offset = receipt.nextOffset;
        }
        preparedChange = await host.prepareAsset(start.uploadId, change);
      } else preparedChange = await host.prepare(change);
      if (preparedChange.durableAck.operationId !== operationId
        || preparedChange.durableAck.workspaceId !== latest.workspace.workspaceId
        || !Number.isSafeInteger(preparedChange.durableAck.journalSequence)
        || preparedChange.durableAck.journalSequence < 1) {
        throw new Error('Hostの永続化ジャーナルACKが、異なる操作またはワークスペースを示しています。');
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
      setNotice(`HostジャーナルACKを受信しました（操作ID: ${operationId}、連番: ${preparedChange.durableAck.journalSequence}）。Hostのレビューとコミットを待っています。`);
    } catch (error) {
      const code = hostErrorCode(error);
      const failure = code === 'REVISION_CONFLICT' ? 'リビジョンの競合' : code === 'QUOTA_EXCEEDED' ? '保存容量の上限超過' : '変更の準備に失敗';
      setNotice(`${failure}${code ? ` (${code})` : ''}: ${errorMessage(error)}`);
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
    setNotice(keepDraft ? '最新のHostリビジョンにローカル下書きを重ねました。変更内容を確認してから準備してください。' : '最新のHostバージョンを読み込みました。');
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
      if (file.size > MAX_BOARD_BYTES) throw new Error('Atlasボードのインポートファイルが2 MiBの上限を超えています。');
      const imported: unknown = JSON.parse(await file.text());
      assertBoardIntegrity(imported);
      for (const asset of imported.assets) {
        const assetFile = filesRef.current.get(asset.path);
        if (!assetFile) throw new Error(`アセット ${asset.path} はこのHostワークスペースにありません。添付ファイルを含むボードはHostバンドルからインポートしてください。`);
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
      setNotice(`${session.path}としてインポートしました。既存のHostワークスペースは変更されていません。`);
    } catch (error) { setNotice(`Atlasボードをインポートできませんでした: ${errorMessage(error)}`); }
  };

  const importScene = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !activeSession) return;
    try {
      if (file.size > MAX_SCENE_BYTES) throw new Error('ExcalidrawシーンがHostの2 MiB上限を超えています。埋め込み画像を小さくしてからインポートしてください。');
      const sceneText = await file.text();
      const inspection = inspectExcalidrawScene(sceneText);
      if (inspection.status === 'read-only') throw new Error(inspection.message);
      const { sceneError: _sceneError, ...sessionWithoutSceneError } = activeSession;
      replaceSession(activeSession.board.boardId, { ...sessionWithoutSceneError, sceneText });
      const freeform = activeSession.board.views.find((view) => view.kind === 'freeform');
      if (freeform) void activateView(activeSession.board.boardId, freeform.id);
      setNotice(`シーンを${activeSession.scenePath}のローカル下書きにインポートしました。`);
    } catch (error) { setNotice(`Excalidrawシーンをインポートできませんでした: ${errorMessage(error)}`); }
  };

  const addImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !activeSession) return;
    if (stagedAssetRef.current && stagedAssetRef.current.boardId !== activeSession.board.boardId) {
      setNotice('別のボードに画像を追加する前に、準備中の画像を送信するか取り除いてください。');
      return;
    }
    try {
      if (file.size === 0 || file.size > MAX_IMAGE_BYTES) throw new Error('画像サイズは1バイト以上、10 MiB以下にしてください。');
      if (!IMAGE_MIME_TYPES.has(file.type as Asset['mime'])) throw new Error(`画像形式 ${file.type || '(不明)'} は対応していません。PNG、JPEG、WebP、SVGを選んでください。`);
      const mime = file.type as Asset['mime'];
      const originalBytes = new Uint8Array(await file.arrayBuffer());
      const bytes = sanitizeImageBytes(originalBytes, mime);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('安全化後の画像サイズは10 MiB以下にしてください。');
      const digest = await sha256Hex(bytes);
      const path = `assets/${digest}.${assetExtension(mime)}`;
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
      setNotice(existing ? '同じコンテンツアドレスのアセットを使って画像カードを追加しました。' : `画像 ${file.name} を追加しました。ボードの変更を準備すると、分割してHostへ送信します。`);
    } catch (error) { setNotice(`画像をインポートできませんでした: ${errorMessage(error)}`); }
  };

  const exportBoard = () => {
    if (!activeSession) return;
    downloadText(`${activeSession.board.boardId}.atlas.json`, serializeSessionBoard(activeSession));
  };

  const exportScene = async () => {
    if (!activeSession) return;
    try {
      if (activeSession.sceneText === null && activeSession.sceneError) {
        setNotice('Hostシーンを読み込めなかったため、エクスポートできる生データがありません。対応するシーンをインポートして置き換えてください。');
        return;
      }
      const sceneText = activeSession.sceneText ?? await createEmptyExcalidrawScene();
      downloadText(`${activeSession.board.boardId}.excalidraw`, sceneText, 'application/json;charset=utf-8');
    } catch (error) { setNotice(`Excalidrawのエクスポートに失敗しました: ${errorMessage(error)}`); }
  };

  const exportVector = async (format: 'png' | 'svg') => {
    if (!activeSession) return;
    if (activeSession.sceneError) { setNotice(`Canvasをエクスポートできません: ${activeSession.sceneError}`); return; }
    try {
      if (activeSession.sceneText === null && activeSession.sceneError) throw new Error('Hostシーンを読み込めませんでした。PNGまたはSVGのエクスポート前に、対応するシーンをインポートしてください。');
      const sceneText = activeSession.sceneText ?? await createEmptyExcalidrawScene();
      const cardExport = await buildAtlasCardExportOverlay(activeSession.board, async (asset) => {
        const staged = stagedAssetRef.current;
        if (staged?.boardId === activeSession.board.boardId && staged.path === asset.path) return staged.bytes;
        const file = filesRef.current.get(asset.path);
        if (!file) throw new Error(`画像アセット ${asset.path} はHostワークスペースにありません。`);
        return readFileBytes(host, file);
      }, graph);
      const blob = await exportExcalidrawScene(sceneText, format, cardExport.overlay);
      downloadBlob(`${activeSession.board.boardId}.${format}`, blob);
      const missing = cardExport.unavailableImagePaths.length;
      setNotice(`${format.toUpperCase()}をダウンロードしました${missing ? `。画像を読み込めなかったカード ${missing} 件はプレースホルダーで表示しています` : ''}。ローカルへのエクスポートであり、Hostへのコミットではありません。`);
    } catch (error) { setNotice(`${format.toUpperCase()}のエクスポートに失敗しました: ${errorMessage(error)}`); }
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
      <div className="atlas-brand"><span className="atlas-brand-mark" aria-hidden="true">A</span><div><strong>Atlas</strong><small>グラフとキャンバスの作業領域</small></div></div>
      <div className="atlas-header-actions">
        <button type="button" onClick={() => void createBoard()}>＋ 新しいボード</button>
        <button type="button" onClick={() => boardImportRef.current?.click()}>ボードをインポート</button>
        <button type="button" onClick={() => void refreshWorkspace().catch(() => undefined)} disabled={refreshing}>{refreshing ? '更新中…' : 'Hostファイルを更新'}</button>
        <span className={`atlas-save-indicator ${prepared ? 'is-pending' : dirty ? 'is-dirty' : 'is-clean'}`} role="status">
          {prepared ? '準備済み・Hostコミット待ち' : dirty ? 'ローカル下書きに変更あり' : 'Hostの基準状態を読み込み済み'}
        </span>
      </div>
      <input ref={boardImportRef} className="atlas-hidden-input" type="file" accept=".atlas.json,application/json" onChange={(event) => void importBoard(event)} />
    </header>

    {fatalError && <div className="atlas-alert atlas-alert-error" role="alert">{fatalError}<button type="button" onClick={() => dispatchRefreshStatus({ type: 'clear-error' })}>閉じる</button></div>}
    {loading ? <div className="atlas-loading" role="status">Hostワークスペースのファイルを読み込んでいます…</div> : <div className="atlas-shell">
      <nav className="atlas-board-nav" aria-label="Atlasボード">
        <div className="atlas-nav-heading"><strong>ボード</strong><small>{sessions.size}</small></div>
        {[...sessions.values()].map((session) => <button
          type="button"
          key={session.board.boardId}
          className={`atlas-board-tab${session.board.boardId === activeBoardId ? ' is-active' : ''}${isSessionDirty(session) ? ' is-dirty' : ''}`}
          onClick={() => { setActiveBoardId(session.board.boardId); setActiveViewId(session.board.views[0]?.id ?? null); setFocusCardId(null); }}
          title={session.path}
        >
          <span className="atlas-board-tab-title">{session.board.name}</span>
          <small>{isSessionDirty(session) ? '下書き' : '読み込み済み'}</small>
        </button>)}
        {sessions.size === 0 && <p className="atlas-muted">このワークスペースにAtlasボードはありません。</p>}
        {invalidFiles.length > 0 && <section className="atlas-invalid-files">
          <strong>読み取り専用の診断情報（{invalidFiles.length}）</strong>
          {invalidFiles.map((item) => <div key={`${item.path}:${item.revision}`}>
            <span>{item.path}: {item.message}</span>
            {item.rawText && <button type="button" onClick={() => downloadText(item.path.split('/').at(-1) ?? 'invalid.atlas.json', item.rawText)}>生データをダウンロード</button>}
          </div>)}
        </section>}
      </nav>

      <main className="atlas-main">
        {!activeSession ? <section className="atlas-empty-workspace">
          <div className="atlas-empty-symbol">◇</div><h1>Atlasボードを作成</h1>
          <p>Atlasは手動のグラフ、キャンバス、タイムライン文書をHost経由で保存します。レビューとコミットはHostが行います。</p>
          <button type="button" onClick={() => void createBoard()}>ボードを作成</button>
        </section> : <>
          <section className="atlas-board-header">
            <div className="atlas-board-title-wrap">
              <label className="atlas-board-name-label">ボード名
                <input key={`${activeSession.board.boardId}:${activeSession.board.name}`} defaultValue={activeSession.board.name} onBlur={handleNewBoardName} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) event.currentTarget.blur(); }} aria-label="ボード名" />
              </label>
              <small className="atlas-path-label">{activeSession.path} · {activeSession.board.boardId}</small>
            </div>
            <div className="atlas-toolbar atlas-board-toolbar">
              <button type="button" onClick={() => undoRedo('undo')} disabled={!activeHistory?.canUndo}>元に戻す</button>
              <button type="button" onClick={() => undoRedo('redo')} disabled={!activeHistory?.canRedo}>やり直す</button>
              <button type="button" className="atlas-primary-button" onClick={() => void prepareChanges()} disabled={!canPrepare}>{prepared ? 'Hostレビュー待ち' : 'Hostレビュー用に準備'}</button>
              <button type="button" onClick={exportBoard}>.atlas.jsonをエクスポート</button>
              <button type="button" onClick={() => void exportScene()}>.excalidrawをエクスポート</button>
              <button type="button" onClick={() => void exportVector('png')}>PNG</button>
              <button type="button" onClick={() => void exportVector('svg')}>SVG</button>
            </div>
          </section>

          <section className="atlas-view-header">
            <div className="atlas-view-tabs" role="tablist" aria-label="ボードのビュー">
              {activeSession.board.views.map((view) => <button type="button" key={view.id} role="tab" aria-selected={view.id === activeView?.id} className={view.id === activeView?.id ? 'is-active' : ''} onClick={() => setView(view.id)}>{view.name}<small>{{ graph: 'グラフ', freeform: 'キャンバス', board: 'ボード', timeline: 'タイムライン', storyboard: 'ストーリーボード' }[view.kind]}</small></button>)}
            </div>
            <div className="atlas-view-actions">
              {activeView && <label>ビュー名<input key={`${activeView.id}:${activeView.name}`} defaultValue={activeView.name} aria-label="ビュー名" onBlur={(event) => renameView(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) event.currentTarget.blur(); }} /></label>}
              <label>ビューを追加<select value="" onChange={(event) => { if (event.currentTarget.value) createView(event.currentTarget.value as View['kind']); event.currentTarget.value = ''; }}>
                <option value="">選択…</option><option value="graph">グラフ</option><option value="freeform">キャンバス</option><option value="board">カンバン</option><option value="timeline">タイムライン</option><option value="storyboard">ストーリーボード</option>
              </select></label>
              <button type="button" onClick={removeView} disabled={activeSession.board.views.length <= 1}>ビューを削除</button>
            </div>
          </section>

          {activeSession.conflict && <section className="atlas-conflict" role="alert">
            <div><strong>Hostリビジョンの競合</strong><p>{activeSession.path}がこの下書き以外で変更されました。続ける文書のバージョンを選択してください。</p></div>
            <button type="button" onClick={() => acceptConflict(false)}>Hostのバージョンを再読み込み</button>
            <button type="button" onClick={() => acceptConflict(true)}>最新リビジョンに下書きを保持</button>
          </section>}
          {activeSession.externalDeleted && <section className="atlas-conflict" role="alert"><strong>このボードはHostワークスペースから削除されました。ローカル下書きはメモリ上に残っています。</strong><button type="button" onClick={() => void prepareChanges()}>Hostレビューを通じて再作成</button></section>}
          {activeSession.sceneError && <div className="atlas-alert atlas-alert-warning" role="status">Canvasは読み取り専用です: {activeSession.sceneError}{activeSession.sceneText !== null ? ' 生シーンをエクスポートできます。' : ''}</div>}

          <section className="atlas-command-toolbar" aria-label="Atlasの操作">
            {activeView?.kind === 'freeform' && <>
              <button type="button" onClick={createTextCard}>＋ テキストカード</button>
              <button type="button" onClick={createSourceCard} disabled={sourcePanel?.state !== 'ready'}>＋ ソースカード</button>
              <button type="button" onClick={() => assetInputRef.current?.click()} disabled={Boolean(stagedAsset && stagedAsset.boardId !== activeSession.board.boardId)}>＋ 画像カード</button>
              <button type="button" onClick={() => sceneImportRef.current?.click()}>.excalidrawをインポート</button>
              <input ref={assetInputRef} className="atlas-hidden-input" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(event) => void addImage(event)} />
              <input ref={sceneImportRef} className="atlas-hidden-input" type="file" accept=".excalidraw,application/json" onChange={(event) => void importScene(event)} />
            </>}
            {activeView?.kind === 'graph' && <>
              <label>Providerを選択<select value={providerId} onChange={(event) => setProviderId(event.currentTarget.value)} disabled={providers.length === 0}>
                <option value="">Providerを選択</option>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.id} · {provider.version}</option>)}
              </select></label>
              <button type="button" onClick={() => void connectProvider()} disabled={!canConnect || !workspace || refreshingProviders || Boolean(graph?.providerIds.includes(providerId))}>選択したProviderを接続</button>
              {graph?.providerIds.length ? <button type="button" onClick={() => void refreshProviders()} disabled={!workspace || refreshingProviders} aria-label="接続中Providerを更新">
                {refreshingProviders ? 'Providerを更新中…' : '接続中Providerを更新'}
              </button> : null}
              {graph?.providerIds.map((connectedId) => <button type="button" key={connectedId} onClick={() => void disconnectProvider(connectedId)} disabled={refreshingProviders}>{connectedId}を切断</button>)}
              {providerStatus && <small className="atlas-status-inline">{providerStatus}</small>}
              {providerError && <small className="atlas-error-inline" role="alert">{providerError}</small>}
            </>}
          </section>

          {prepared && <section className="atlas-prepared" role="status">
            <div><strong>Hostジャーナルの永続化ACKを受信しました。</strong><p>操作ID {prepared.operationId} · 連番 {prepared.journalSequence} · 基準リビジョン {prepared.preparedAtRevision}。Hostのレビューとコミットを待っています。</p></div>
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
              {activeSession.sceneError ? <div className="atlas-scene-readonly"><p>{activeSession.sceneError}</p>{activeSession.sceneText === null ? <p>生シーンを読み込めません。対応するシーンをインポートして置き換えてください。</p> : <pre>{activeSession.sceneText.slice(0, 6000)}</pre>}</div> : activeSession.sceneText === null ? <div className="atlas-loading" role="status">Canvasを読み込んでいます…</div> : <FreeformView
                key={activeSession.board.boardId}
                board={activeSession.board}
                view={activeView}
                sceneText={activeSession.sceneText}
                assets={assetUrls}
                graph={graph}
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

          {assetErrors.length > 0 && <section className="atlas-alert atlas-alert-warning" role="status"><strong>アセットの診断情報</strong><ul>{assetErrors.map((error) => <li key={error}>{error}</li>)}</ul></section>}
          {stagedAsset?.boardId === activeSession.board.boardId && <p className="atlas-staged-label">画像をローカルで準備しました: {stagedAsset.path} · {stagedAsset.bytes.byteLength}バイト · 次回Hostレビュー用に準備すると分割して送信されます。</p>}
        </>}
      </main>

      <aside className="atlas-host-sidebar">
        <section className="atlas-panel-section">
          <h2>Hostの状態</h2>
          <p><strong>ワークスペース:</strong> {workspace?.workspaceId ?? '読み込み中'}</p>
          <p><strong>ソースリビジョン:</strong> {workspace?.sourceRevision ?? '—'}</p>
          <p><strong>ファイル数:</strong> {files.size}</p>
          <p><strong>変更の確定:</strong> Hostのレビューとコミット</p>
          <p className="atlas-muted">Atlasはドキュメント変更をHostに準備します。永続化ジャーナルACKはHostのコミット完了を意味しません。</p>
          {notice && <div className="atlas-notice" role="status">{notice}</div>}
        </section>
        {sourcePanel && <section className="atlas-panel-section atlas-source-inspector" aria-label="ソースの詳細">
          <div className="atlas-source-heading"><h2>ソースの詳細</h2><button type="button" onClick={() => setSourcePanel(null)} aria-label="ソースの詳細を閉じる">×</button></div>
          <p className="atlas-source-ref">{sourcePanel.source.path}<br />リビジョン {sourcePanel.source.revision}<br />ワークスペース {sourcePanel.source.workspaceId}</p>
          {sourcePanel.state === 'loading' ? <p>固定したHostリビジョンを開いています…</p>
            : sourcePanel.state === 'ready' ? <>
              <p className="atlas-source-state is-ready">固定したソースリビジョンを利用できます。</p>
              <button type="button" onClick={createSourceCard} disabled={!activeSession}>ソースカードを作成</button>
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
      throw new Error(`Providerの${method}応答ページが不正です。`);
    }
    if (!sameSnapshot(result.snapshot, snapshot)) throw new Error(`Providerの${method}ページ取得中にスナップショットが変わりました。`);
    const page = result as T;
    pages.push(page);
    if (page.complete && page.nextCursor === null) return pages;
    if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error(`Providerの${method}から未完了または重複したカーソルが返されました。`);
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error(`Providerの${method}ページ数が上限を超えました。`);
}

async function collectProviderDeltaPages(
  host: PluginHostClient,
  leaseId: string,
  previousSnapshot: SnapshotRef,
  targetSnapshot: SnapshotRef,
): Promise<GraphDeltaPage[]> {
  const pages: GraphDeltaPage[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let count = 0; count < 100_000; count += 1) {
    const result = await host.providerCall(leaseId, {
      method: 'diff',
      params: { previousSnapshot, ...(cursor ? { cursor } : {}), limit: 500 },
    });
    if (!result || !Array.isArray(result.items) || !('snapshot' in result) || !('complete' in result) || !('nextCursor' in result)) {
      throw new Error('Providerのdiff応答ページが不正です。');
    }
    const page = result as GraphDeltaPage;
    if (!sameSnapshot(page.snapshot, targetSnapshot)) throw new Error('Providerのdiffページが新しいリースのスナップショットと一致しません。');
    if (page.complete !== (page.nextCursor === null)) throw new Error('Providerのdiffページ完了状態とカーソルが一致しません。');
    pages.push(page);
    if (page.complete) return pages;
    const nextCursor = page.nextCursor;
    if (!nextCursor || cursors.has(nextCursor)) throw new Error('Providerのdiffページでカーソルが欠落または重複しています。');
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error('Providerのdiffページ数が上限を超えました。');
}

async function fetchProviderSnapshot(
  host: PluginHostClient,
  leaseId: string,
  snapshot: SnapshotRef,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const nodePages = await collectProviderPages<ProviderPage>(host, leaseId, 'listNodes', snapshot);
  const edgePages = await collectProviderPages<GraphEdgePage>(host, leaseId, 'listEdges', snapshot);
  return {
    nodes: nodePages.flatMap((page) => page.items),
    edges: edgePages.flatMap((page) => page.items),
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
    case 'missing': return 'ソースが見つかりません';
    case 'stale': return '固定したリビジョンが古くなっています';
    case 'denied': return 'Hostがアクセスを拒否しました';
    case 'error': return 'ソースを利用できません';
    case 'loading': return '読み込み中';
    case 'ready': return '利用可能';
  }
}

function providerErrorKind(error: unknown): string {
  const code = hostErrorCode(error);
  if (code === 'PERMISSION_DENIED') return 'Providerへのアクセスが拒否されました';
  if (code === 'NOT_INSTALLED') return 'Providerがインストールされていません';
  if (code === 'DISABLED') return 'Providerは無効です';
  if (code === 'TIMEOUT') return 'Providerがタイムアウトしました';
  if (code === 'PROVIDER_FAILED') return 'Providerでエラーが発生しました';
  if (code === 'SNAPSHOT_STALE' || code === 'RESYNC_REQUIRED') return 'Providerスナップショットが古くなっています';
  return 'Providerを利用できません';
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
    replaceSnapshot: async () => { throw new Error('グラフWorkerが接続されていません。'); },
    replaceSnapshotFromPages: async () => { throw new Error('グラフWorkerが接続されていません。'); },
    applyDelta: async () => { throw new Error('グラフWorkerが接続されていません。'); },
    applyDeltaPages: async () => { throw new Error('グラフWorkerが接続されていません。'); },
    search: async () => { throw new Error('グラフWorkerが接続されていません。'); },
    neighbors: async () => { throw new Error('グラフWorkerが接続されていません。'); },
    shortestPath: async () => { throw new Error('グラフWorkerが接続されていません。'); },
    weakComponents: async () => { throw new Error('グラフWorkerが接続されていません。'); },
    cancelAll: () => undefined,
    close: () => undefined,
  };
}
