import { assertContract, type PluginProviderRequest, type ProviderGrant, type ProviderLease, type ProviderRequest, type ProviderRpcResponse, type SnapshotRef, type WorkspaceHandle } from '@scriptorium-atlas/contracts';
import { assertProviderRequestScope, assertProviderResultScope } from './provider-scope.js';

export type FrameProviderConnection = {
  epoch: number;
  workspaceId: string;
  snapshot(workspace: WorkspaceHandle): Promise<SnapshotRef>;
  grants: ProviderGrant[];
  fail(reason: string): void;
  call(request: ProviderRequest, deadline: number): Promise<ProviderRpcResponse>;
};
const connections = new Map<string, FrameProviderConnection>();
const leases = new Map<string, {owner: string; providerId: string; handle: string; connection: FrameProviderConnection; lease: ProviderLease}>();
const owners=new Set<string>();
export function registerProviderOwner(owner:string){owners.add(owner);}

export function registerProvider(providerId: string, connection: FrameProviderConnection) {
  if (connections.has(providerId)) throw new Error('PROTOCOL_INVALID: Provider IDが重複しています');
  connections.set(providerId, connection);
  return () => {
    if (connections.get(providerId) === connection) connections.delete(providerId);
    for (const [id, entry] of leases) if (entry.connection === connection) leases.delete(id);
  };
}

export async function acquireProvider(owner: string, providerId: string, workspace: WorkspaceHandle): Promise<ProviderLease> {
  if(!owners.has(owner))throw new Error('CANCELED');
  if(leases.size>=64)throw new Error('OVERLOADED: Provider lease上限');
  const connection = connections.get(providerId);
  if (!connection || connection.workspaceId !== workspace.workspaceId) throw new Error('PROVIDER_FAILED: Provider Frameが利用できません');
  const deadline = Date.now() + 10_000;
  const requestedSnapshot = await connection.snapshot(workspace);
  assertContract('snapshotRef', requestedSnapshot);
  if (requestedSnapshot.workspaceId !== workspace.workspaceId || requestedSnapshot.sourceRevision !== workspace.sourceRevision || requestedSnapshot.epoch !== connection.epoch) throw new Error('SNAPSHOT_STALE');
  const response = await connection.call({ method: 'open', params: {
    workspaceId: workspace.workspaceId,
    requestedSnapshot, grants: connection.grants, deadline,
  } }, deadline);
  if (!response.ok) throw Object.assign(new Error(response.error.message), {code: response.error.code});
  assertContract('providerOpenResult', response.result);
  if(!owners.has(owner)||connections.get(providerId)!==connection||leases.size>=64){
    await connection.call({method:'close',params:{handle:response.result.handle}},Date.now()+5000).catch(()=>{});
    throw new Error(owners.has(owner)?'OVERLOADED':'CANCELED');
  }
  if (response.result.actualSnapshot.workspaceId !== workspace.workspaceId || response.result.actualSnapshot.sourceRevision !== workspace.sourceRevision || response.result.actualSnapshot.providerRevision !== requestedSnapshot.providerRevision || response.result.actualSnapshot.epoch !== connection.epoch) {
    await connection.call({method:'close',params:{handle:response.result.handle}},Date.now()+5000).catch(()=>{});
    throw new Error('SNAPSHOT_STALE');
  }
  const lease: ProviderLease = { leaseId: crypto.randomUUID(), providerId, snapshot: response.result.actualSnapshot, capabilities: response.result.capabilities };
  leases.set(lease.leaseId, {owner, providerId, handle: response.result.handle, connection, lease});
  return lease;
}

export async function callProvider(owner: string, leaseId: string, request: PluginProviderRequest) {
  const entry = leases.get(leaseId);
  if (!entry || entry.owner !== owner || connections.get(entry.providerId) !== entry.connection) throw new Error('PERMISSION_DENIED: 有効なleaseがありません');
  assertProviderRequestScope(entry.providerId, request);
  const routed = {...request, params: {...request.params, handle: entry.handle}};
  assertContract('providerRequest', routed);
  const response = await entry.connection.call(routed, Date.now() + 5000);
  if (leases.get(leaseId) !== entry || !owners.has(owner) || connections.get(entry.providerId) !== entry.connection) throw new Error('CANCELED');
  if (!response.ok) throw Object.assign(new Error(response.error.message), {code: response.error.code});
  assertContract('providerResult', response.result);
  assertContract(request.method === 'listEdges' ? 'graphEdgePage'
    : request.method === 'neighbors' ? 'neighborPage'
    : request.method === 'diff' ? 'graphDeltaPage' : 'providerPage', response.result);
  if (response.result.snapshot.workspaceId !== entry.lease.snapshot.workspaceId || response.result.snapshot.sourceRevision !== entry.lease.snapshot.sourceRevision || response.result.snapshot.providerRevision !== entry.lease.snapshot.providerRevision || response.result.snapshot.epoch !== entry.lease.snapshot.epoch) throw new Error('SNAPSHOT_STALE');
  try {
    assertProviderResultScope({providerId:entry.providerId,snapshot:entry.lease.snapshot,grants:entry.connection.grants,
      foreignProviderAllowed: providerId => {
        const target = connections.get(providerId);
        return !!target && target.workspaceId === entry.lease.snapshot.workspaceId
          && target.grants.some(grant => grant.capability === 'graph.read')
          && target.grants.some(grant => grant.capability === 'workspace.files.read' && !!grant.paths?.length);
      }}, request, response.result);
  } catch (error) {
    entry.connection.fail(`PROTOCOL_INVALID: ${String(error)}`);
    throw error;
  }
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
  owners.delete(owner);
  const active = [...leases.entries()].filter(([, entry]) => entry.owner === owner);
  for (const [id] of active) void releaseProvider(owner, id).catch(() => {});
}
