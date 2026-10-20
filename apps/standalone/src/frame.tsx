import React, { useEffect, useState, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { validateContract, assertContract, type PluginHostClient, type ProviderRequest } from '@scriptorium-atlas/contracts';
import { loaders, providerLoaders } from 'virtual:atlas-profile';
import { createHostClient } from './rpc-client.js';

type Endpoint = {dispatch(request: ProviderRequest, signal?: AbortSignal): Promise<unknown>};
type UiModule = { AtlasPlugin?: ComponentType<{host: PluginHostClient}>; StoryKnowledge?: ComponentType<{host: PluginHostClient}> };
const params = new URLSearchParams(location.search);
const plugin = params.get('plugin') ?? '';
const nonce = params.get('nonce') ?? '';
const parentOrigin = params.get('parentOrigin') ?? '';
const pluginId = plugin === 'atlas' ? 'scriptorium.atlas' : 'scriptorium.story-knowledge';

async function serveProvider(port: MessagePort, host: PluginHostClient, epoch: number) {
  let endpoint: Promise<Endpoint> | undefined;
  const controllers = new Map<string, AbortController>();
  port.addEventListener('message', event => {
    if (!validateContract('providerRpcRequest', event.data)) return;
    const request = event.data;
    if (request.epoch !== epoch || request.providerId !== pluginId || plugin !== 'story') return;
    if (request.payload.method === 'cancel') {
      controllers.get(request.payload.params.requestId)?.abort();
      const reply={type:'atlas.provider.response',protocolVersion:'atlas.graph/v1',requestId:request.requestId,providerId:pluginId,epoch,method:'cancel',ok:true,result:null,...('handle' in request?{handle:request.handle}:{})};
      assertContract('providerRpcResponse',reply); port.postMessage(reply);
      return;
    }
    const controller = new AbortController(); controllers.set(request.requestId, controller);
    const timeout = setTimeout(() => controller.abort(), Math.max(0, request.deadline - Date.now()));
    void (async () => {
      const base = { type: 'atlas.provider.response', protocolVersion: 'atlas.graph/v1', requestId: request.requestId, providerId: pluginId, epoch, method:request.payload.method, ...('handle' in request ? {handle:request.handle} : {}) };
      let reply: unknown;
      try {
        if (Date.now() >= request.deadline) throw new Error('TIMEOUT');
        if (!endpoint) {
          const load = providerLoaders[plugin];
          if (!load) throw new Error('NOT_INSTALLED');
          endpoint = load().then(module => (module as {createStoryProvider(host: PluginHostClient): Endpoint}).createStoryProvider(host));
        }
        const provider = await endpoint;
        const result = await provider.dispatch(request.payload, controller.signal);
        if (controller.signal.aborted) throw new Error('CANCELED');
        reply = { ...base, ok: true, result: result ?? null };
        assertContract('providerRpcResponse', reply);
      } catch (err) {
        const candidate = typeof err === 'object' && err && 'code' in err ? String(err.code) : String(err instanceof Error ? err.message : err);
        const code = validateContract('hostErrorCode', candidate) ? candidate : 'PROVIDER_FAILED';
        reply = { ...base, ok: false, error: { code, message: String(err).slice(0, 2048), retryable: true } };
      } finally { clearTimeout(timeout); controllers.delete(request.requestId); }
      port.postMessage(reply);
    })();
  });
}

function FrameApp({ port, epoch }: {port: MessagePort; epoch: number}) {
  const [ui, setUi] = useState<ComponentType<{host: PluginHostClient}>>();
  const [client] = useState(() => createHostClient(port, epoch));
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = loaders[plugin];
    if (!load) { setError('Pluginはこのprofileに含まれていません'); return; }
    void load().then(value => {
      const module = value as UiModule;
      const component = plugin === 'atlas' ? module.AtlasPlugin : module.StoryKnowledge;
      if (!component) throw new Error('Plugin UIがありません');
      if (active) setUi(() => component);
    }).catch(err => { if (active) setError(String(err)); });
    if (plugin === 'story') void serveProvider(port, client.host, epoch);
    return () => { active = false; client.close(); };
  }, [client, port, epoch]);
  const Ui = ui;
  return error ? <p role="alert">{error}</p> : Ui ? <Ui host={client.host}/> : <p role="status">Pluginを読み込んでいます…</p>;
}

try {
  const origin = new URL(parentOrigin);
  const expectedPort = Number(origin.port) + (plugin === 'atlas' ? 1 : 2);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || location.hostname !== origin.hostname || Number(location.port) !== expectedPort || !nonce || !loaders[plugin] || window.parent === window) throw new Error('Host originを検証できません');
  const start = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== parentOrigin || !validateContract('frameInit', event.data) || event.data.nonce !== nonce || event.ports.length !== 1) return;
    window.removeEventListener('message', start);
    createRoot(document.getElementById('root')!).render(<FrameApp port={event.ports[0]!} epoch={event.data.epoch}/>);
  };
  window.addEventListener('message', start);
  window.parent.postMessage({ type: 'atlas.frame.ready', pluginId, nonce }, parentOrigin);
} catch (err) { document.getElementById('root')!.textContent = String(err); }
