import { validateContract, assertContract, type HostRpcRequest, type HostRpcResponse, type PluginHostClient, type WorkspaceChanged } from '@scriptorium-atlas/contracts';

type Method = HostRpcRequest['method'];
type Params<M extends Method> = Extract<HostRpcRequest, { method: M }>['params'];
type Result<M extends Method> = Extract<HostRpcResponse, { method: M; ok: true }> extends {result: infer R} ? R : never;
const MAX_MESSAGE = 8 * 1024 * 1024;
const encodedSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function createHostClient(port: MessagePort, epoch: number): { host: PluginHostClient; close(): void } {
  const pending = new Map<string, { method: Method; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(event: WorkspaceChanged) => void>();
  let closed = false;
  function close() {
    closed = true; port.close();
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('HOST_UNAVAILABLE')); }
    pending.clear(); listeners.clear();
  }
  port.addEventListener('messageerror', close);
  port.addEventListener('message', event => {
    const data: unknown = event.data;
    if (encodedSize(data) >= MAX_MESSAGE) { close(); return; }
    if (validateContract('workspaceChanged', data)) {
      if (data.epoch !== epoch) return;
      for (const listener of listeners) listener(data);
      return;
    }
    if (validateContract('providerRpcRequest', data)) return;
    if (!validateContract('hostRpcResponse', data) || data.epoch !== epoch) { close(); return; }
    const entry = pending.get(data.callId);
    if (!entry || data.method !== entry.method) return;
    clearTimeout(entry.timer); pending.delete(data.callId);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(Object.assign(new Error(`${data.error.code}: ${data.error.message}`), { code: data.error.code }));
  });
  port.start();
  function call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    if (closed) return Promise.reject(new Error('HOST_UNAVAILABLE'));
    if (pending.size >= 64) return Promise.reject(new Error('OVERLOADED'));
    const callId = crypto.randomUUID();
    const request = { type: 'atlas.host.request', protocolVersion: 'atlas.host/v1', callId, epoch, method, params };
    assertContract('hostRpcRequest', request);
    if (encodedSize(request) >= MAX_MESSAGE) return Promise.reject(new Error('INVALID_INPUT: メッセージが大きすぎます'));
    return new Promise<Result<M>>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(callId); reject(new Error('TIMEOUT')); }, method==='snapshot'||method==='acquireProvider'?10_000:5000);
      pending.set(callId, { method, resolve: value => resolve(value as Result<M>), reject, timer });
      port.postMessage(request);
    });
  }
  const host: PluginHostClient = {
    snapshot: (query = {}) => call('snapshot', query),
    list: (query = {}) => call('list', query),
    read: query => call('read', query),
    prepare: change => call('prepare', { change }),
    beginAsset: asset => call('beginAsset', {asset}),
    appendAsset: chunk => call('appendAsset', chunk),
    prepareAsset: (uploadId, change) => call('prepareAsset', {uploadId,change}),
    requestSource: ref => call('requestSource', { ref }),
    describeProviders: () => call('describeProviders', {}),
    acquireProvider: (providerId, sourceRevision) => call('acquireProvider', { providerId, sourceRevision }),
    providerCall: (leaseId, request) => call('providerCall', { leaseId, request }),
    releaseProvider: async leaseId => { await call('releaseProvider', { leaseId }); },
    subscribeWorkspace: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { host, close };
}
