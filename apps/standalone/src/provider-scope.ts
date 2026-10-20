import { assertContract, type GraphEdge, type GraphNode, type NodeRef, type PluginProviderRequest, type ProviderGrant, type SnapshotRef, type SourceRef } from '@scriptorium-atlas/contracts';
import { validateRelativePath } from '@scriptorium-atlas/persistence/host';

export function assertProviderRequestScope(providerId: string, request: PluginProviderRequest): void {
  const refs = request.method === 'getNodes' ? request.params.refs : request.method === 'neighbors' ? [request.params.from] : [];
  if (refs.some(ref => ref.providerId !== providerId)) throw new Error('PERMISSION_DENIED: 別ProviderのIDは照会できません');
}

type Scope = {
  providerId: string;
  snapshot: SnapshotRef;
  grants: ProviderGrant[];
  foreignProviderAllowed(providerId: string): boolean;
};

export function assertProviderResultScope(scope: Scope, request: PluginProviderRequest, result: unknown): void {
  const invalid = (message: string): never => { throw new Error(`PROTOCOL_INVALID: ${message}`); };
  const owned = (ref: NodeRef) => {
    if (ref.providerId !== scope.providerId) invalid('Providerが別Providerのidentityを返しました');
  };
  const path = (value: string) => {
    try { validateRelativePath(value); } catch { invalid('Provider SourceのPathが不正です'); }
    const granted = scope.grants.some(grant => grant.capability === 'workspace.files.read' && grant.paths?.some(prefix =>
      value === prefix || prefix.endsWith('/') && value.startsWith(prefix)));
    if (!granted) invalid('Provider Sourceが許可されたPathの範囲外です');
  };
  const source = (value: SourceRef | undefined) => {
    if (!value) return;
    if (value.workspaceId !== scope.snapshot.workspaceId) invalid('Provider Sourceが別Workspaceを参照しています');
    path(value.path);
  };
  const node = (value: GraphNode) => { owned(value.ref); source(value.source); };
  const edge = (value: GraphEdge) => {
    owned(value.ref); source(value.source);
    for (const provenance of value.provenance ?? []) path(provenance.path);
    for (const endpoint of [value.from, value.to]) {
      if (endpoint.providerId !== scope.providerId && !scope.foreignProviderAllowed(endpoint.providerId)) invalid('Cross-provider Edgeの参照先が許可されていません');
    }
  };
  switch (request.method) {
    case 'listNodes':
    case 'getNodes':
      assertContract('providerPage', result);
      for (const item of result.items) node(item);
      break;
    case 'listEdges':
      assertContract('graphEdgePage', result);
      for (const item of result.items) edge(item);
      break;
    case 'neighbors':
      assertContract('neighborPage', result);
      for (const item of result.items) { node(item.node); for (const itemEdge of item.edges) edge(itemEdge); }
      break;
    case 'diff':
      assertContract('graphDeltaPage', result);
      for (const delta of result.items) {
        for (const key of ['workspaceId', 'sourceRevision', 'providerRevision', 'epoch'] as const) {
          if (delta.previousSnapshot[key] !== request.params.previousSnapshot[key] || delta.snapshot[key] !== scope.snapshot[key]) invalid('差分のSnapshotが要求と一致しません');
        }
        for (const value of delta.changedNodes ?? []) node(value);
        for (const value of delta.changedEdges ?? []) edge(value);
        for (const ref of [...delta.removedNodes ?? [], ...delta.removedEdges ?? []]) owned(ref);
      }
      break;
  }
}
