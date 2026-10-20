import React, { useEffect, useMemo, useRef, useState } from 'react';
import { assertContract, validateContract, type ChangeIntent, type HostRpcRequest, type HostRpcResponse, type PreparedChange, type ProviderRequest, type ProviderRpcResponse, type VersionedFile, type WorkspaceHandle } from '@scriptorium-atlas/contracts';
import type { IndexedDbHostPort } from '@scriptorium-atlas/persistence/host';
import { metadata } from 'virtual:atlas-profile';
import { acquireProvider, callProvider, registerProvider, releaseOwner, releaseProvider } from './provider-broker.js';

let nextEpoch = 0;
const MAX_MESSAGE = 8 * 1024 * 1024;
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
type Props = {plugin: 'atlas'|'story'; workspace: WorkspaceHandle; host: IndexedDbHostPort; onPrepare(change: ChangeIntent): Promise<PreparedChange>; onSource(file: VersionedFile): Promise<void>; theme: string; storyGrant: boolean; storyEnabled: boolean};

export function PluginFrame(props: Props) {
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(true);
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | undefined>(undefined);
  const latest = useRef(props); latest.current = props;
  const session = useMemo(() => ({nonce: crypto.randomUUID(), epoch: ++nextEpoch}), [reload]);
  const pluginId = props.plugin === 'atlas' ? 'scriptorium.atlas' : 'scriptorium.story-knowledge';
  const origin = `${location.protocol}//${location.hostname}:${Number(location.port) + (props.plugin === 'atlas' ? 1 : 2)}`;
  const src = `${origin}/frame.html?plugin=${props.plugin}&nonce=${session.nonce}&parentOrigin=${encodeURIComponent(location.origin)}`;

  useEffect(() => {
    setError(''); setReady(false);
    let unregister: (() => void) | undefined;
    let active = true;
    const owner = `${pluginId}:${session.nonce}`;
    const pending = new Map<string, {resolve(value: ProviderRpcResponse):void; reject(err:Error):void; timer: ReturnType<typeof setTimeout>}>();
    const queue: Array<() => void> = [];
    const seenCalls = new Set<string>();
    let inFlightHost = 0;
    const fail = (message: string) => {
      if (!active) return;
      setError(message); setReady(false); port.current?.close(); port.current = undefined;
      unregister?.(); unregister = undefined;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
      pending.clear(); queue.length = 0; releaseOwner(owner);
    };
    function providerCall(request: ProviderRequest, deadline: number): Promise<ProviderRpcResponse> {
      if (!port.current || !active) return Promise.reject(new Error('PROVIDER_FAILED'));
      if (pending.size >= 4) {
        if (queue.length >= 64) return Promise.reject(new Error('OVERLOADED'));
        return new Promise((resolve, reject) => queue.push(() => providerCall(request, deadline).then(resolve, reject)));
      }
      if (deadline <= Date.now()) return Promise.reject(new Error('TIMEOUT'));
      const requestId = crypto.randomUUID();
      const message = {type:'atlas.provider.request', protocolVersion:'atlas.graph/v1', requestId, providerId:pluginId, epoch:session.epoch, deadline, payload:request, ...('handle' in request.params ? {handle:request.params.handle} : {})};
      assertContract('providerRpcRequest', message);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId); reject(new Error('TIMEOUT'));
          port.current?.postMessage({...message, requestId: crypto.randomUUID(), payload:{method:'cancel',params:{requestId}}});
          setTimeout(() => fail('TIMEOUT: Providerを停止しました。DraftはHostに保持されています。'), 500);
        }, deadline - Date.now());
        pending.set(requestId, {resolve,reject,timer}); port.current!.postMessage(message);
      });
    }
    const onReady = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow || !validateContract('frameReady', event.data) || event.data.nonce !== session.nonce || event.data.pluginId !== pluginId || port.current) return;
      const channel = new MessageChannel(); port.current = channel.port1;
      port.current.onmessageerror = () => fail('PROTOCOL_INVALID: MessageChannelを停止しました');
      port.current.onmessage = message => {
        const data: unknown = message.data;
        if (size(data) >= MAX_MESSAGE) { fail('PROTOCOL_INVALID: 過大message'); return; }
        if (validateContract('providerRpcResponse', data)) {
          if (data.epoch !== session.epoch || data.providerId !== pluginId) { fail('PROTOCOL_INVALID: stale provider'); return; }
          const entry = pending.get(data.requestId);
          if (!entry) return;
          clearTimeout(entry.timer); pending.delete(data.requestId); entry.resolve(data); queue.shift()?.();
          return;
        }
        if (!validateContract('hostRpcRequest', data) || data.epoch !== session.epoch) { fail('PROTOCOL_INVALID: Host request'); return; }
        if (seenCalls.has(data.callId) || inFlightHost >= 64) { fail('OVERLOADED: RPC重複または上限'); return; }
        seenCalls.add(data.callId); if (seenCalls.size > 4096) seenCalls.delete(seenCalls.values().next().value!);
        inFlightHost++;
        void dispatch(data).then(result => {
          const reply = {type:'atlas.host.response',protocolVersion:'atlas.host/v1',callId:data.callId,epoch:session.epoch,method:data.method,ok:true,result};
          assertContract('hostRpcResponse', reply);
          if (size(reply) >= MAX_MESSAGE) throw new Error('INVALID_INPUT: message budget');
          if (active) port.current?.postMessage(reply);
        }).catch(err => {
          const candidate = typeof err === 'object' && err && 'code' in err ? String(err.code) : String(err instanceof Error ? err.message : err).split(':')[0];
          const code = validateContract('hostErrorCode', candidate) ? candidate : 'UNAVAILABLE';
          const reply: HostRpcResponse = {type:'atlas.host.response',protocolVersion:'atlas.host/v1',callId:data.callId,epoch:session.epoch,method:data.method,ok:false,error:{code,message:String(err).slice(0,2048),retryable:true}};
          if (active) port.current?.postMessage(reply);
        }).finally(() => {inFlightHost--;});
      };
      port.current.start();
      event.source.postMessage({type:'atlas.frame.init',nonce:session.nonce,epoch:session.epoch}, {targetOrigin:origin,transfer:[channel.port2]});
      if (props.plugin === 'story') unregister = registerProvider(pluginId, {epoch:session.epoch,workspaceId:props.workspace.workspaceId,call:providerCall});
      setReady(true);
    };
    const storyPath = (path:string) => /^(bible|plot|manuscript)\//.test(path);
    const atlasPath = (path:string) => /\.(atlas\.json|excalidraw)$/.test(path) || path.startsWith('assets/');
    const canRead = (path:string) => props.plugin === 'story' ? storyPath(path) : atlasPath(path) || latest.current.storyGrant && storyPath(path);
    async function dispatch(request: HostRpcRequest): Promise<unknown> {
      const current = latest.current;
      const workspace = current.workspace;
      switch (request.method) {
        case 'snapshot': {
          const page = await current.host.getSnapshotPage(workspace, request.params);
          return {...page,workspace:{...page.workspace,epoch:session.epoch},files:page.files.filter(file => canRead(file.path))};
        }
        case 'list': {
          const page = await current.host.list(workspace, request.params);
          return {...page, files:page.files.filter(file => canRead(file.path))};
        }
        case 'read': {
          if (!canRead(request.params.path)) throw new Error('PERMISSION_DENIED');
          return current.host.read(workspace,request.params);
        }
        case 'prepare': {
          const {change} = request.params;
          if (change.workspaceId !== workspace.workspaceId || change.writes.some(write => !(props.plugin === 'story' ? storyPath(write.path) : atlasPath(write.path))) || change.reads.some(read => !canRead(read.path))) throw new Error('PERMISSION_DENIED');
          return current.onPrepare(change);
        }
        case 'requestSource': {
          const {ref} = request.params;
          if (ref.workspaceId !== workspace.workspaceId || !canRead(ref.path)) throw new Error('PERMISSION_DENIED');
          const file = await current.host.read(workspace,{path:ref.path,expectedRevision:ref.revision,maxBytes:2*1024*1024});
          assertContract('versionedFile',file); await current.onSource(file); return file;
        }
        case 'describeProviders': return Object.values(metadata).flatMap(value => value.providerDescriptor ? [value.providerDescriptor] : []);
        case 'acquireProvider': {
          if (!metadata['story']) throw new Error('NOT_INSTALLED');
          if (!current.storyEnabled) throw new Error('DISABLED');
          if (props.plugin === 'atlas' && !current.storyGrant) throw new Error('PERMISSION_DENIED');
          if (request.params.sourceRevision !== workspace.sourceRevision) throw new Error('SNAPSHOT_STALE');
          return acquireProvider(owner,request.params.providerId,workspace);
        }
        case 'providerCall': {
          if (props.plugin === 'atlas' && !current.storyGrant) throw new Error('PERMISSION_DENIED');
          return callProvider(owner,request.params.leaseId,request.params.request);
        }
        case 'releaseProvider': await releaseProvider(owner,request.params.leaseId); return null;
      }
    }
    window.addEventListener('message',onReady);
    const timer = setTimeout(() => {if (!port.current) fail('TIMEOUT: Pluginの起動に失敗しました');},10_000);
    return () => {
      active = false; clearTimeout(timer); window.removeEventListener('message',onReady); unregister?.(); releaseOwner(owner); port.current?.close(); port.current=undefined;
      for (const entry of pending.values()) {clearTimeout(entry.timer);entry.reject(new Error('CANCELED'));}
      pending.clear(); queue.length=0;
    };
  }, [props.plugin, props.workspace.workspaceId, pluginId, origin, session]);

  useEffect(() => {
    port.current?.postMessage({type:'atlas.workspace.changed',workspaceId:props.workspace.workspaceId,sourceRevision:props.workspace.sourceRevision,epoch:session.epoch});
  },[props.workspace.sourceRevision,props.workspace.workspaceId,session]);

  return <section className="plugin-panel" aria-label={props.plugin === 'atlas' ? 'Atlas Plugin' : 'Story Knowledge Plugin'}>
    <header><strong>{props.plugin === 'atlas' ? 'Atlas' : 'Story Knowledge'}</strong><span>{ready ? '接続中' : '未接続'}</span><button onClick={() => setVisible(value => !value)}>{visible ? 'UIを隠す' : 'UIを表示'}</button><button onClick={() => setReload(value => value+1)}>Pluginを再起動</button></header>
    {error ? <p role="alert">{error}</p> : <iframe hidden={!visible} ref={frame} title={props.plugin === 'atlas' ? 'Atlas' : 'Story Knowledge'} src={src} sandbox="allow-scripts allow-same-origin allow-downloads" referrerPolicy="no-referrer"/>}
  </section>;
}
