import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
  useReactFlow,
} from '@xyflow/react';
import type { BoardDocument, GraphNode, SnapshotRef } from '@scriptorium-atlas/contracts';
import { nodeKey } from '@scriptorium-atlas/graph';
import type { GraphWorkerClient } from '@scriptorium-atlas/graph/worker';
import type { BoardView } from '@scriptorium-atlas/contracts';
import { applyAtlasCommand, createAtlasId } from '../commands/model.js';

type FlowNode = Node<{ label: string; kind: string; origin: 'manual' | 'provider'; groupId?: string }>;
type ProviderSnapshot = { snapshot: SnapshotRef; nodes: GraphNode[]; edges: import('@scriptorium-atlas/contracts').GraphEdge[]; providerId: string };
type SearchResult = Awaited<ReturnType<GraphWorkerClient['search']>>;

export type GraphCanvasProps = {
  board: BoardDocument;
  view: BoardView;
  graph: ProviderSnapshot | null;
  graphWorker: GraphWorkerClient;
  onBoardChange(board: BoardDocument): void;
  onSource(source: NonNullable<BoardDocument['nodes'][number]['source']>): void;
  onLayout(kind: 'force' | 'layered' | 'timeline' | 'manual'): Promise<void>;
  onCancelLayout?(): void;
  searchResult: SearchResult | null;
  onSearch(query: string): void;
  searchQuery: string;
  onAddProviderNode(node: GraphNode): void;
  focusNodeId?: string | null;
  onFocusDone?(): void;
};

function GraphCanvasBody(props: GraphCanvasProps) {
  const { fitView } = useReactFlow<FlowNode, Edge>();
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [analysis, setAnalysis] = useState<string>('');
  const [focusRefs, setFocusRefs] = useState<Set<string> | null>(null);
  const [pathFrom, setPathFrom] = useState('');
  const [pathTo, setPathTo] = useState('');
  const [filterDraft, setFilterDraft] = useState(props.view.filter?.query ?? '');
  const [labelDraft, setLabelDraft] = useState('');
  const [annotationDraft, setAnnotationDraft] = useState('');
  const [edgeLabelDraft, setEdgeLabelDraft] = useState('');

  const graphNodeByKey = useMemo(() => new Map(props.graph?.nodes.map((node) => [nodeKey(node.ref), node]) ?? []), [props.graph?.nodes]);
  const boardNodes = useMemo(() => props.board.nodes.filter((node) => {
    const query = filterDraft.normalize('NFC').toLocaleLowerCase();
    const filters = props.view.filter;
    if (filters?.kinds?.length && !filters.kinds.includes(node.kind)) return false;
    if (filters?.providers?.length && (!node.ref || !filters.providers.includes(node.ref.providerId))) return false;
    if (props.view.visibleNodeIds && !props.view.visibleNodeIds.includes(node.id)) return false;
    if (focusRefs && (!node.ref || !focusRefs.has(nodeKey(node.ref)))) return false;
    if (query) {
      const providerNode = node.ref ? graphNodeByKey.get(nodeKey(node.ref)) : undefined;
      const values = [node.label, node.id, node.kind, node.ref?.providerId, node.ref?.localId, node.annotation, node.source?.path,
        ...(providerNode?.aliases ?? []), ...(providerNode?.tags ?? []), providerNode?.source?.path].filter(Boolean);
      if (!values.some((value) => value!.normalize('NFC').toLocaleLowerCase().includes(query))) return false;
    }
    return true;
  }), [props.board.nodes, props.view.filter, props.view.visibleNodeIds, focusRefs, filterDraft, graphNodeByKey]);

  const nodes = useMemo<FlowNode[]>(() => boardNodes.map((item) => ({
    id: item.id,
    position: positions[item.id] ?? item.position,
    selected: selectedNodeIds.includes(item.id),
    draggable: true,
    connectable: true,
    data: { label: item.label, kind: item.kind, origin: item.origin, ...(item.groupId ? { groupId: item.groupId } : {}) },
    className: [item.origin === 'provider' ? 'atlas-flow-provider' : 'atlas-flow-manual', item.groupId ? 'atlas-flow-grouped' : ''].filter(Boolean).join(' '),
    style: { borderColor: selectedNodeIds.includes(item.id) ? 'var(--atlas-accent)' : undefined },
  })), [boardNodes, positions, selectedNodeIds]);

  const edges = useMemo<Edge[]>(() => {
    const nodeIdByRef = new Map(props.board.nodes.filter((node) => node.ref).map((node) => [nodeKey(node.ref!), node.id]));
    const visible = new Set(boardNodes.map((node) => node.id));
    const savedEdges = props.board.edges
      .filter((edge) => visible.has(edge.from) && visible.has(edge.to))
      .map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      label: edge.label,
      selectable: true,
      deletable: edge.meaning === 'visual',
      animated: false,
      style: edge.meaning === 'semantic' ? { strokeDasharray: '5 4', stroke: '#675f71' } : { stroke: '#376b8d' },
      labelStyle: { fill: '#45404b', fontSize: 11 },
    }));
    const savedSemanticRefs = new Set(props.board.edges.filter((edge) => edge.meaning === 'semantic' && edge.ref).map((edge) => nodeKey(edge.ref!)));
    const providerEdges = props.graph?.edges.flatMap((edge) => {
      const from = nodeIdByRef.get(nodeKey(edge.from));
      const to = nodeIdByRef.get(nodeKey(edge.to));
      if (!from || !to || !visible.has(from) || !visible.has(to) || savedSemanticRefs.has(nodeKey(edge.ref))) return [];
      const label = edge.kind;
      return [{
        id: `provider:${nodeKey(edge.ref)}`,
        source: from,
        target: to,
        label,
        selectable: true,
        deletable: false,
        focusable: true,
        style: { strokeDasharray: '5 4', stroke: '#675f71' },
        labelStyle: { fill: '#45404b', fontSize: 11 },
      } satisfies Edge];
    }) ?? [];
    return [...savedEdges, ...providerEdges];
  }, [props.board.edges, props.board.nodes, props.graph?.edges, boardNodes]);

  useEffect(() => {
    setPositions({});
    setFocusRefs(null);
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
  }, [props.board.boardId, props.view.id]);

  useEffect(() => {
    if (!props.focusNodeId || !props.board.nodes.some((node) => node.id === props.focusNodeId)) return;
    setSelectedNodeIds([props.focusNodeId]);
    void fitView({ nodes: [{ id: props.focusNodeId }], padding: 0.4, duration: 250 });
    props.onFocusDone?.();
  }, [props.focusNodeId, props.board.revision, props.board.nodes, fitView, props.onFocusDone]);

  useEffect(() => setFilterDraft(props.view.filter?.query ?? ''), [props.view.id, props.view.filter?.query]);

  const dispatch = useCallback((command: Parameters<typeof applyAtlasCommand>[1]) => {
    props.onBoardChange(applyAtlasCommand(props.board, command));
  }, [props.board, props.onBoardChange]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setPositions((current) => {
      const next = { ...current };
      for (const change of changes) {
        if (change.type === 'position' && change.position) next[change.id] = change.position;
      }
      return next;
    });
    setSelectedNodeIds((current) => {
      let ids = [...current];
      for (const change of changes) {
        if (change.type === 'select') {
          ids = change.selected ? [...new Set([...ids, change.id])] : ids.filter((id) => id !== change.id);
        } else if (change.type === 'remove') {
          ids = ids.filter((id) => id !== change.id);
        }
      }
      return ids;
    });
  }, []);

  const onNodeDragStop = useCallback((_event: unknown, node: FlowNode) => {
    dispatch({ type: 'view.move-node', viewId: props.view.id, nodeId: node.id, position: node.position, pin: true });
    setPositions((current) => { const next = { ...current }; delete next[node.id]; return next; });
  }, [dispatch, props.view.id]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    dispatch({ type: 'edge.create', edge: {
      id: createAtlasId('edge'), from: connection.source, to: connection.target, meaning: 'visual',
    } });
  }, [dispatch]);

  const onSelectionChange = useCallback(({ nodes: selected, edges: selectedEdges }: OnSelectionChangeParams) => {
    setSelectedNodeIds(selected.map((node) => node.id));
    setSelectedEdgeIds(selectedEdges.map((edge) => edge.id));
  }, []);

  const selectedNode = props.board.nodes.find((node) => node.id === selectedNodeIds.at(-1));
  const selectedEdge = props.board.edges.find((edge) => edge.id === selectedEdgeIds.at(-1));
  const selectedGraphNode = selectedNode?.ref && props.graph?.nodes.find((node) => nodeKey(node.ref) === nodeKey(selectedNode.ref));

  useEffect(() => {
    setLabelDraft(selectedNode?.label ?? '');
    setAnnotationDraft(selectedNode?.annotation ?? '');
  }, [selectedNode?.id, selectedNode?.label, selectedNode?.annotation]);

  useEffect(() => setEdgeLabelDraft(selectedEdge?.label ?? ''), [selectedEdge?.id, selectedEdge?.label]);

  const addManualNode = () => {
    const label = window.prompt('ノード名');
    if (!label?.trim()) return;
    const offset = props.board.nodes.length * 28;
    dispatch({ type: 'node.create', node: {
      id: createAtlasId('node'), origin: 'manual', kind: 'generic.note', label: label.trim(),
      position: { x: 80 + offset, y: 80 + offset },
    } });
  };

  const duplicateSelectedNode = () => {
    if (!selectedNode || selectedNode.origin !== 'manual') return;
    dispatch({ type: 'node.duplicate', id: selectedNode.id, newId: createAtlasId('node') });
  };

  const groupSelection = () => {
    if (selectedNodeIds.length < 2) return;
    dispatch({ type: 'node.group', ids: selectedNodeIds, groupId: createAtlasId('group') });
  };

  const removeSelection = () => {
    const edgeIds = selectedEdgeIds.filter((id) => props.board.edges.find((edge) => edge.id === id)?.meaning === 'visual');
    if (selectedNodeIds.length || edgeIds.length) dispatch({ type: 'graph.delete-selection', nodeIds: selectedNodeIds, edgeIds });
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
  };

  const onGraphKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input,textarea,select,[contenteditable="true"]')) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && (selectedNodeIds.length || selectedEdgeIds.length)) {
      event.preventDefault();
      removeSelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'g') {
      event.preventDefault();
      groupSelection();
      return;
    }
    const delta = event.key === 'ArrowLeft' ? { x: -10, y: 0 }
      : event.key === 'ArrowRight' ? { x: 10, y: 0 }
        : event.key === 'ArrowUp' ? { x: 0, y: -10 }
          : event.key === 'ArrowDown' ? { x: 0, y: 10 } : null;
    if (delta && selectedNodeIds.length) {
      event.preventDefault();
      const selected = props.board.nodes.filter((node) => selectedNodeIds.includes(node.id));
      dispatch({
        type: 'view.move-nodes', viewId: props.view.id, pin: true,
        positions: selected.map((node) => ({ nodeId: node.id, position: { x: node.position.x + delta.x, y: node.position.y + delta.y } })),
      });
    }
  };

  const focusNeighbors = async (direction: 'in' | 'out' | 'both', depth: 1 | 2 | 3) => {
    if (!selectedNode?.ref || !props.graph) return;
    try {
      const result = await props.graphWorker.neighbors({ from: selectedNode.ref, direction, depth, limit: 5000 });
      setFocusRefs(new Set([nodeKey(result.from), ...result.nodes.map((entry) => nodeKey(entry.ref))]));
      setAnalysis(`${result.nodes.length} 件の近傍を表示しました${result.unresolved.length ? `。未解決参照 ${result.unresolved.length} 件` : ''}${result.complete ? '' : '（上限により一部）'}`);
    } catch (error) { setAnalysis(errorMessage(error)); }
  };

  const findPath = async () => {
    const from = props.board.nodes.find((node) => node.id === pathFrom)?.ref;
    const to = props.board.nodes.find((node) => node.id === pathTo)?.ref;
    if (!from || !to) { setAnalysis('経路の両端にProviderノードを選んでください。'); return; }
    try {
      const result = await props.graphWorker.shortestPath({ from, to, maxHops: 64, maxVisited: 10_000 });
      if (result.status === 'found') {
        const labels = result.nodes.map((node, index) => node?.label ?? result.refs[index]!.localId);
        setFocusRefs(new Set(result.refs.map(nodeKey)));
        setAnalysis(`最短経路 ${result.hops} hop: ${labels.join(' → ')}`);
      } else setAnalysis(result.status === 'bounded' ? '探索上限に達しました。範囲を絞って再試行してください。' : 'このSnapshotに経路はありません。');
    } catch (error) { setAnalysis(errorMessage(error)); }
  };

  const groupComponents = async () => {
    try {
      const components = await props.graphWorker.weakComponents();
      const boardRefToNode = new Map(props.board.nodes.filter((node) => node.ref).map((node) => [nodeKey(node.ref!), node.id]));
      const groups: Array<{ groupId: string; ids: string[] }> = [];
      let grouped = 0;
      for (const component of components) {
        const ids = component.refs.map((ref) => boardRefToNode.get(nodeKey(ref))).filter((id): id is string => Boolean(id));
        if (ids.length < 2) continue;
        groups.push({ ids, groupId: createAtlasId('group') });
        grouped += ids.length;
      }
      if (groups.length) dispatch({ type: 'node.apply-groups', groups });
      setAnalysis(`${components.length} weak component。Board内の ${grouped} ノードをcomponentごとにGroup化しました。`);
    } catch (error) { setAnalysis(errorMessage(error)); }
  };

  const saveNodeLabel = () => {
    if (selectedNode && selectedNode.origin === 'manual' && labelDraft !== selectedNode.label) dispatch({ type: 'node.update', id: selectedNode.id, patch: { label: labelDraft } });
  };
  const saveNodeAnnotation = () => {
    if (selectedNode && annotationDraft !== (selectedNode.annotation ?? '')) dispatch({ type: 'node.update', id: selectedNode.id, patch: { annotation: annotationDraft } });
  };
  const saveEdgeLabel = () => {
    if (selectedEdge?.meaning === 'visual' && edgeLabelDraft !== (selectedEdge.label ?? '')) {
      dispatch({ type: 'edge.update', id: selectedEdge.id, patch: { label: edgeLabelDraft } });
    }
  };

  const searchMatches = props.searchResult?.items ?? [];
  const filters = props.view.filter;
  const fit = () => { void fitView({ padding: 0.2, duration: 250 }); };

  return (
    <div className="atlas-graph-layout" onKeyDown={onGraphKeyDown} tabIndex={0}>
      <section className="atlas-graph-main" aria-label="Graph workspace">
        <div className="atlas-toolbar atlas-graph-toolbar">
          <button type="button" onClick={addManualNode}>＋ Manual node</button>
          <button type="button" onClick={groupSelection} disabled={selectedNodeIds.length < 2}>Group selection</button>
          <button type="button" onClick={duplicateSelectedNode} disabled={selectedNode?.origin !== 'manual'}>Duplicate node</button>
          <button type="button" onClick={removeSelection} disabled={!selectedNodeIds.length && !selectedEdgeIds.length}>Delete selection</button>
          <span className="atlas-toolbar-separator" />
          <button type="button" onClick={fit}>Fit</button>
          <button type="button" onClick={() => void props.onLayout('force')}>Force</button>
          <button type="button" onClick={() => void props.onLayout('layered')}>Layered</button>
          <button type="button" onClick={() => void props.onLayout('timeline')}>Timeline layout</button>
          <button type="button" onClick={() => void props.onLayout('manual')}>Manual positions</button>
          <button type="button" onClick={props.onCancelLayout}>Cancel layout</button>
          <button type="button" onClick={() => setFocusRefs(null)} disabled={!focusRefs}>Clear focus</button>
        </div>
        <div className="atlas-graph-flow">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            defaultViewport={props.view.viewport}
            onMoveEnd={(_event, viewport) => dispatch({ type: 'view.viewport', viewId: props.view.id, viewport })}
            fitView={!props.view.viewport}
            fitViewOptions={{ padding: 0.2 }}
            deleteKeyCode={null}
            selectionOnDrag
            panOnDrag={[1, 2]}
            selectionMode="partial"
            minZoom={0.1}
            maxZoom={3}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#ddd8d0" gap={22} />
            <MiniMap pannable zoomable nodeColor={(node) => node.data?.origin === 'provider' ? '#83a8a2' : '#d5a65b'} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {boardNodes.length === 0 && <div className="atlas-empty-graph">Search a read-only source or add a manual node to start mapping.</div>}
        </div>
      </section>

      <aside className="atlas-inspector" aria-label="Graph inspector and search">
        <section className="atlas-panel-section">
          <h3>Search and filter</h3>
          <label className="atlas-field">Search provider snapshot
            <input value={props.searchQuery} onChange={(event) => props.onSearch(event.currentTarget.value)} placeholder="name, id, alias, tag, type, path" />
          </label>
          <label className="atlas-field">Board filter
            <input
              value={filterDraft}
              onChange={(event) => setFilterDraft(event.currentTarget.value)}
              onBlur={() => dispatch({ type: 'view.filter', viewId: props.view.id, filter: { ...filters, query: filterDraft } })}
              placeholder="Filter visible nodes"
            />
          </label>
          <label className="atlas-field">Node kinds
            <select multiple size={3} value={filters?.kinds ?? []} onChange={(event) => dispatch({ type: 'view.filter', viewId: props.view.id, filter: { ...filters, kinds: [...event.currentTarget.selectedOptions].map((option) => option.value) } })}>
              {[...new Set([...props.board.nodes.map((node) => node.kind), ...(props.graph?.nodes.map((node) => node.kind) ?? [])])].sort().map((kind) => <option value={kind} key={kind}>{kind}</option>)}
            </select>
          </label>
          {props.graph && <label className="atlas-field">Provider filter
            <select multiple size={2} value={filters?.providers ?? []} onChange={(event) => dispatch({ type: 'view.filter', viewId: props.view.id, filter: { ...filters, providers: [...event.currentTarget.selectedOptions].map((option) => option.value) } })}>
              {[...new Set(props.graph.nodes.map((node) => node.ref.providerId))].sort().map((id) => <option value={id} key={id}>{id}</option>)}
            </select>
          </label>}
          {props.graph && <p className="atlas-muted">Source: {props.graph.providerId} · snapshot {props.graph.snapshot.providerRevision}</p>}
          {!props.graph && <p className="atlas-muted">Connect a provider from the toolbar to search its read-only snapshot.</p>}
          <div className="atlas-search-results">
            {searchMatches.slice(0, 30).map(({ node, matchedFields }) => {
              const present = props.board.nodes.some((candidate) => candidate.ref && nodeKey(candidate.ref) === nodeKey(node.ref));
            const addCard = () => {
              const duplicateOffset = props.board.cards.length * 24;
              dispatch({ type: 'card.create', card: {
                id: createAtlasId('card'), kind: 'provider-node', nodeRef: node.ref,
                ...(node.source ? { source: node.source } : {}), text: node.label,
                position: { x: 120 + duplicateOffset, y: 120 + duplicateOffset }, width: 280, height: 150,
              } });
            };
              return <div className="atlas-search-hit" key={nodeKey(node.ref)}>
                <div><strong>{node.label}</strong><small>{node.kind} · {matchedFields.join(', ') || 'all'}</small></div>
                <button type="button" onClick={() => props.onAddProviderNode(node)}>{present ? 'Reveal' : 'Add node'}</button>
                <button type="button" onClick={addCard}>Card</button>
              </div>;
            })}
            {props.searchResult && <small className="atlas-muted">{props.searchResult.totalMatches} match{props.searchResult.complete ? '' : ' · limited'}</small>}
          </div>
        </section>

        <section className="atlas-panel-section">
          <h3>Selected node</h3>
          {selectedNode ? <>
            <label className="atlas-field">Name
              <input value={labelDraft} disabled={selectedNode.origin === 'provider'} onChange={(event) => setLabelDraft(event.currentTarget.value)} onBlur={saveNodeLabel} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
            </label>
            <p className="atlas-muted">{selectedNode.kind} · {selectedNode.origin === 'provider' ? `Provider ref ${selectedNode.ref?.providerId}/${selectedNode.ref?.localId}` : `Local ID ${selectedNode.id}`}</p>
            <label className="atlas-field">Annotation
              <textarea value={annotationDraft} rows={3} onChange={(event) => setAnnotationDraft(event.currentTarget.value)} onBlur={saveNodeAnnotation} />
            </label>
            {selectedNode.ref && <button type="button" onClick={() => void focusNeighbors('both', 1)} disabled={!props.graph}>Focus neighbors</button>}
            {selectedNode.source && <button type="button" onClick={() => props.onSource(selectedNode.source!)}>Open source</button>}
            <label className="atlas-field">Use as path start
              <select value={pathFrom} onChange={(event) => setPathFrom(event.currentTarget.value)}><option value="">Select node</option>{props.board.nodes.filter((node) => node.ref).map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select>
            </label>
            <label className="atlas-field">Path destination
              <select value={pathTo} onChange={(event) => setPathTo(event.currentTarget.value)}><option value="">Select node</option>{props.board.nodes.filter((node) => node.ref).map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select>
            </label>
            <button type="button" onClick={() => void findPath()} disabled={!props.graph}>Find shortest path</button>
          </> : <p className="atlas-muted">Select a node to inspect or open its pinned source revision.</p>}
          {selectedEdge && <label className="atlas-field">Visual edge label
            <input value={edgeLabelDraft} disabled={selectedEdge.meaning !== 'visual'} onChange={(event) => setEdgeLabelDraft(event.currentTarget.value)} onBlur={saveEdgeLabel} />
          </label>}
          <div className="atlas-neighbor-actions">
            <button type="button" onClick={() => void focusNeighbors('in', 1)} disabled={!selectedNode?.ref || !props.graph}>In 1</button>
            <button type="button" onClick={() => void focusNeighbors('out', 2)} disabled={!selectedNode?.ref || !props.graph}>Out 2</button>
            <button type="button" onClick={() => void focusNeighbors('both', 3)} disabled={!selectedNode?.ref || !props.graph}>Both 3</button>
            <button type="button" onClick={() => void groupComponents()} disabled={!props.graph}>Group components</button>
          </div>
          {selectedGraphNode && <details><summary>Provider metadata</summary><pre>{JSON.stringify({ aliases: selectedGraphNode.aliases ?? [], tags: selectedGraphNode.tags ?? [], source: selectedGraphNode.source ?? null, status: selectedGraphNode.status ?? 'available', meta: selectedGraphNode.meta ?? {} }, null, 2)}</pre></details>}
          {analysis && <p className="atlas-analysis" role="status">{analysis}</p>}
        </section>
        <p className="atlas-muted atlas-key-hint">Drag to pin · Shift-drag to select · Ctrl/⌘+Z undo · Delete removes selection</p>
      </aside>
    </div>
  );
}

export function GraphCanvas(props: GraphCanvasProps) {
  return <ReactFlowProvider><GraphCanvasBody {...props} /></ReactFlowProvider>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
