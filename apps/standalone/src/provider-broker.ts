import { assertContract, type PluginProviderRequest, type ProviderLease, type ProviderRequest, type ProviderRpcResponse, type WorkspaceHandle } from '@scriptorium-atlas/contracts';

export type FrameProviderConnection = {
  epoch: number;
  workspaceId: string;
  call(request: ProviderRequest, deadline: number): Promise<ProviderRpcResponse>;
};
const connections = new Map<string, FrameProviderConnection>();
const leases = new Map<string, {owner: string; providerId: string; handle: string; connection: FrameProviderConnection; lease: ProviderLease}>();

export function registerProvider(providerId: string, connection: FrameProviderConnection) {
  if (connections.has(providerId)) throw new Error('PROTOCOL_INVALID: Provider IDが重複しています');
  connections.set(providerId, connection);
  return () => {
    if (connections.get(providerId) === connection) connections.delete(providerId);
    for (const [id, entry] of leases) if (entry.connection === connection) leases.delete(id);
  };
}

export async function acquireProvider(owner: string, providerId: string, workspace: WorkspaceHandle): Promise<ProviderLease> {
  const connection = connections.get(providerId);
  if (!connection || connection.workspaceId !== workspace.workspaceId) throw new Error('PROVIDER_FAILED: Provider Frameが利用できません');
  const deadline = Date.now() + 10_000;
  const revisionHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(workspace.sourceRevision)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const response = await connection.call({ method: 'open', params: {
    workspaceId: workspace.workspaceId,
    requestedSnapshot: { workspaceId: workspace.workspaceId, sourceRevision: workspace.sourceRevision, providerRevision: `story-v1:${revisionHash}`, epoch: connection.epoch },
    grants: [{ capability: 'workspace.files.read', paths: ['bible/', 'plot/', 'manuscript/'] }, {capability: 'graph.read'}], deadline,
  } }, deadline);
  if (!response.ok) throw Object.assign(new Error(response.error.message), {code: response.error.code});
  assertContract('providerOpenResult', response.result);
  if (response.result.actualSnapshot.workspaceId !== workspace.workspaceId || response.result.actualSnapshot.sourceRevision !== workspace.sourceRevision || response.result.actualSnapshot.epoch !== connection.epoch) throw new Error('SNAPSHOT_STALE');
  const lease: ProviderLease = { leaseId: crypto.randomUUID(), providerId, snapshot: response.result.actualSnapshot, capabilities: response.result.capabilities };
  leases.set(lease.leaseId, {owner, providerId, handle: response.result.handle, connection, lease});
  return lease;
}

export async function callProvider(owner: string, leaseId: string, request: PluginProviderRequest) {
  const entry = leases.get(leaseId);
  if (!entry || entry.owner !== owner || connections.get(entry.providerId) !== entry.connection) throw new Error('PERMISSION_DENIED: 有効なleaseがありません');
  const routed = {...request, params: {...request.params, handle: entry.handle}};
  assertContract('providerRequest', routed);
  const response = await entry.connection.call(routed, Date.now() + 5000);
  if (!response.ok) throw Object.assign(new Error(response.error.message), {code: response.error.code});
  assertContract('providerResult', response.result);
  if (JSON.stringify(response.result.snapshot) !== JSON.stringify(entry.lease.snapshot)) throw new Error('SNAPSHOT_STALE');
  return response.result;
}

export async function releaseProvider(owner: string, leaseId: string) {
  const entry = leases.get(leaseId);
  if (!entry) return;
  if (entry.owner !== owner) throw new Error('PERMISSION_DENIED');
  leases.delete(leaseId);
  await entry.connection.call({method: 'close', params: {handle: entry.handle}}, Date.now() + 5000);
}

export function releaseOwner(owner: string) {
  const active = [...leases.entries()].filter(([, entry]) => entry.owner === owner);
  for (const [id] of active) void releaseProvider(owner, id).catch(() => {});
}
