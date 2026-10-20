import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { openIndexedDbHost, type IndexedDbHostPort, type WorkspaceInfo, type PreparedProposal } from '@scriptorium-atlas/persistence/host';
import type { AssetUploadReceipt, ChangeIntent, WorkspaceHandle, WorkspaceSnapshotFile } from '@scriptorium-atlas/contracts';
import {sha256} from '@scriptorium-atlas/persistence/bytes';
import { profile } from 'virtual:atlas-profile';
import { PluginFrame } from './plugin-frame.js';
import './style.css';

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function App() {
  const [host, setHost] = useState<IndexedDbHostPort>();
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [current, setCurrent] = useState<WorkspaceHandle>();
  const activeWorkspaceId = useRef<string>();
  const sourcePanel = useRef<HTMLDetailsElement>(null);
  const [files, setFiles] = useState<WorkspaceSnapshotFile[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposals, setProposals] = useState<PreparedProposal[]>([]);
  const [uploads,setUploads]=useState<AssetUploadReceipt[]>([]);
  const [selected, setSelected] = useState<WorkspaceSnapshotFile>();
  const [sourceText, setSourceText] = useState('');
  const [newPath, setNewPath] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [atlasEnabled, setAtlasEnabled] = useState(profile !== 'story');
  const [storyEnabled, setStoryEnabled] = useState(profile !== 'atlas');
  const [storyGrant, setStoryGrant] = useState(false);
  const writable=host?.storageStatus.state==='ready';

  useEffect(() => {
    let active = true; let port: IndexedDbHostPort | undefined;
    void openIndexedDbHost().then(async value => {
      port = value;
      if (active) { setHost(value); setWorkspaces(await value.listWorkspaces()); }
      else value.close();
    }).catch(err => { if (active) setError(`保存領域を開けません。編集は利用できません: ${String(err)}`); });
    return () => { active = false; port?.close(); };
  }, []);

  async function run(task: () => Promise<void>) {
    setBusy(true); setError('');
    try { await task(); } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }
  async function refresh(workspaceId: string) {
    if (!host) return;
    const workspace = await host.getWorkspaceHandle(workspaceId);
    const all: WorkspaceSnapshotFile[] = [];
    let cursor: string | undefined;
    do {
      const page = await host.getSnapshotPage(workspace, cursor ? { cursor, limit: 100 } : {limit:100});
      all.push(...page.files); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const workspaceList = await host.listWorkspaces();
    const pendingAssets = await host.listPendingAssets(workspaceId);
    if (activeWorkspaceId.current !== workspaceId) return;
    setCurrent(workspace); setFiles(all); setWorkspaces(workspaceList);
    setUploads(pendingAssets);
  }
  async function open(workspaceId: string) {
    if (!host) return;
    activeWorkspaceId.current = workspaceId;
    setSelected(undefined); setSourceText(''); setProposals([]);
    await refresh(workspaceId);
    await inspectRecovery(workspaceId);
  }
  async function inspectRecovery(workspaceId:string) {
    if(!host)return;
    const recovery = await host.recover(workspaceId);
    const pending = await host.listPending(workspaceId);
    const pendingAssets = await host.listPendingAssets(workspaceId);
    if (activeWorkspaceId.current !== workspaceId) return;
    setProposals(pending);
    setUploads(pendingAssets);
    setNotice(recovery.unknownCommitIds.length ? `COMMIT_UNKNOWN: ${recovery.unknownCommitIds.join(', ')}。再確認してから同じ操作をretryしてください。` : recovery.pendingOperationIds.length ? `復旧したJournal操作: ${recovery.pendingOperationIds.length}件。確定済みFileとは区別して確認してください。` : 'Workspaceを開きました。');
  }
  async function prepare(change: ChangeIntent) {
    if (!host || !current) throw new Error('Workspaceを開いてください');
    const proposal = await host.prepare(current, change);
    const pending = await host.listPending(current.workspaceId);
    if (activeWorkspaceId.current !== current.workspaceId) return proposal;
    setProposals(pending);
    setNotice('Draftを耐久記録しました。確定には内容の確認と承認が必要です。');
    return proposal;
  }
  async function prepareAsset(uploadId:string,change:ChangeIntent) {
    if (!host || !current) throw new Error('Workspaceを開いてください');
    const proposal = await host.prepareAsset(current,uploadId,change);
    const pending = await host.listPending(current.workspaceId);
    if (activeWorkspaceId.current !== current.workspaceId) return proposal;
    setProposals(pending);
    setNotice('画像と文書のDraftを耐久記録しました。承認後に一括Commitされます。');
    return proposal;
  }
  async function prepareFile() {
    if (!current) return;
    if (selected && (!('content' in selected) || selected.encoding === 'base64')) throw new Error('バイナリFileはこのSource欄では編集できません。画像はAtlasの画像操作から更新してください。');
    const path = selected?.path ?? newPath;
    await prepare({ operationId: crypto.randomUUID(), workspaceId: current.workspaceId,
      baseWorkspaceRevision: current.sourceRevision,
      reads: [{ path, revision: selected?.revision ?? null }],
      writes: [{ path, content: sourceText, encoding: 'utf8' }], message: `${path} を編集`, kind: 'source' });
  }
  async function selectSource(file: WorkspaceSnapshotFile) {
    if (selected && 'content' in selected && sourceText !== selected.content && !window.confirm('未提出の編集があります。別のSourceを開きますか？')) return;
    if (!('content' in file) && file.encoding === 'utf8' && file.byteLength <= 2*1024*1024 && host && current) {
      const full = await host.read(current,{path:file.path,expectedRevision:file.revision,maxBytes:2*1024*1024});
      if ('updatedAt' in full) file = full;
    }
    setSelected(file); setSourceText('content' in file ? file.content : ''); setNewPath(file.path);
    if (sourcePanel.current) sourcePanel.current.open = true;
  }
  async function downloadSource(file:WorkspaceSnapshotFile) {
    const name = file.path.split('/').at(-1)!;
    if ('content' in file) {
      download(new Blob([file.encoding === 'base64' ? Uint8Array.from(atob(file.content),value=>value.charCodeAt(0)) : file.content],{type:file.contentType}),name); return;
    }
    if (!host || !current) throw new Error('Workspaceを開いてください');
    const chunks:ArrayBuffer[]=[]; let offset=0;
    while (offset < file.byteLength) {
      const chunk=await host.read(current,{path:file.path,expectedRevision:file.revision,offset,limit:1024*1024});
      if (!('nextOffset' in chunk) || chunk.offset!==offset || chunk.nextOffset<=offset || chunk.nextOffset>file.byteLength) throw new Error('INVALID_INPUT: File chunk');
      const bytes=Uint8Array.from(atob(chunk.content),value=>value.charCodeAt(0));
      if (bytes.byteLength!==chunk.nextOffset-offset) throw new Error('INVALID_INPUT: chunk byte length');
      chunks.push(bytes.buffer); offset=chunk.nextOffset;
    }
    const blob=new Blob(chunks,{type:file.contentType});
    if (await sha256(await blob.arrayBuffer())!==file.revision) throw new Error('INVALID_INPUT: File checksum');
    download(blob,name);
  }

  return <main data-theme={theme}>
    <header><div><h1>Scriptorium Atlas</h1><span>{profile} / Standalone</span></div>
      <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? 'ダーク表示' : 'ライト表示'}</button>
    </header>
    <p className="status">保存先: このブラウザのIndexedDB。Commitはローカル確定です。</p>
    {host&&host.storageStatus.state!=='ready'&&<p role="alert">READ_ONLY: {host.storageStatus.reason??'保存領域を利用できません'}。読取りと可能なデータのexportを利用してください。</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="status">{notice}</p>}
    <section aria-label="Workspace" className="workspace-controls">
      <label>Workspace名<input value={name} onChange={event => setName(event.target.value)} maxLength={256}/></label>
      <button disabled={!writable || busy || !name.trim()} onClick={() => void run(async () => { const info = await host!.createWorkspace({ name }); await open(info.workspace.workspaceId); })}>空のWorkspaceを作成</button>
      <label>開く<select value={current?.workspaceId ?? ''} onChange={event => { if (event.target.value) void run(() => open(event.target.value)); }}><option value="">選択してください</option>{workspaces.map(info => <option key={info.workspace.workspaceId} value={info.workspace.workspaceId}>{info.name}</option>)}</select></label>
      <button disabled={!writable || !current || busy || !name.trim()} onClick={() => void run(async () => { await host!.renameWorkspace(current!.workspaceId, name); await refresh(current!.workspaceId); })}>名前を変更</button>
      <button disabled={!current} onClick={() => { activeWorkspaceId.current=undefined; setCurrent(undefined); setFiles([]); setSelected(undefined); setProposals([]);setUploads([]); }}>閉じる</button>
      <label>Bundleをimport<input type="file" accept=".zip,application/zip" disabled={!writable || busy} onChange={event => { const file = event.target.files?.[0]; if (file) void run(async () => { const info = await host!.importBundle(file); await open(info.workspace.workspaceId); }); event.target.value = ''; }}/></label>
      <button disabled={!host || !current || busy} onClick={() => void run(async () => download(await host!.export(current!.workspaceId), 'atlas-workspace.zip'))}>Bundleをexport</button>
    </section>
    {current && host && <>
      <section aria-label="Plugin controls" className="workspace-controls">
        {profile !== 'story' && <label><input type="checkbox" checked={atlasEnabled} onChange={event => setAtlasEnabled(event.target.checked)}/>Atlasを有効化</label>}
        {profile !== 'atlas' && <label><input type="checkbox" checked={storyEnabled} onChange={event => setStoryEnabled(event.target.checked)}/>Story Knowledgeを有効化</label>}
        {profile === 'combined' && <label><input type="checkbox" checked={storyGrant} onChange={event => setStoryGrant(event.target.checked)}/>AtlasへStory ProviderとSourceの読取りを許可</label>}
      </section>
      <div className="plugins">
        {atlasEnabled && <PluginFrame key={`atlas:${current.workspaceId}`} plugin="atlas" workspace={current} host={host} onPrepare={prepare} onPrepareAsset={prepareAsset} onSource={selectSource} theme={theme} storyGrant={storyGrant} storyEnabled={storyEnabled}/>}
        {storyEnabled && <PluginFrame key={`story:${current.workspaceId}`} plugin="story" workspace={current} host={host} onPrepare={prepare} onPrepareAsset={prepareAsset} onSource={selectSource} theme={theme} storyGrant={storyGrant} storyEnabled={storyEnabled}/>}
      </div>
      <section aria-label="変更の承認">
        <h2>変更の確認・ローカルCommit</h2>
        <button disabled={busy} onClick={()=>void run(()=>inspectRecovery(current.workspaceId))}>復旧状態を再確認</button>
        {uploads.length>0&&<div role="status"><p>耐久記録中の画像Upload（Fileは未確定）</p><ul>{uploads.map(upload=><li key={upload.uploadId}>{upload.path}: {upload.nextOffset}/{upload.totalBytes} bytes / operation {upload.operationId}</li>)}</ul></div>}
        {proposals.length === 0 && <p>承認待ちの変更はありません。</p>}
        {proposals.map(proposal => <article key={proposal.prepared.preparedId}>
          <p>{proposal.change.message}</p>
          {proposal.files.map(change => <details key={change.path} open><summary>{change.path}</summary><p>変更前 ({change.before?.revision ?? '新規'})</p><pre>{change.before?.encoding === 'base64' ? `[${change.before.contentType} バイナリ]` : change.before?.content ?? 'ファイルなし'}</pre><p>変更後</p><pre>{change.after?.encoding === 'base64' ? `[${change.after.contentType} バイナリ / revision ${change.after.revision}]` : change.after?.content ?? '削除'}</pre></details>)}
          <button disabled={!writable || busy} onClick={() => void run(async () => {
            const receipt = await host.commit(await host.getWorkspaceHandle(current.workspaceId), proposal.prepared.preparedId, true);
            setNotice(`ローカルCommit完了: ${JSON.stringify(receipt)}`);
            setProposals(items => items.filter(item => item.prepared.preparedId !== proposal.prepared.preparedId));
            await refresh(current.workspaceId);
          })}>この変更を承認してCommit</button>
          <button onClick={() => download(new Blob([JSON.stringify(proposal.change, null, 2)], {type:'application/json'}), `draft-${proposal.change.operationId}.json`)}>このDraftをexport</button>
        </article>)}
      </section>
      <details ref={sourcePanel}><summary>Workspaceのファイル・Source</summary>
        <ul>{files.map(file => <li key={file.path}><button onClick={() => void selectSource(file)}>{file.path}</button><span> revision {file.revision.slice(0, 12)}</span></li>)}</ul>
        <label>相対Path<input value={newPath} onChange={event => { setNewPath(event.target.value); setSelected(undefined); }}/></label>
        <label>Source<textarea aria-label="Source" value={sourceText} onChange={event => setSourceText(event.target.value)} readOnly={!!selected && (!('content' in selected) || selected.encoding === 'base64')} rows={12}/></label>
        {selected && !('content' in selected) && <p>{selected.contentType} / {selected.byteLength} bytes。原文のダウンロード時に分割取得します。</p>}
        <p role="status">{sourceText !== (selected && 'content' in selected ? selected.content : '') ? '未提出の編集があります。耐久記録前の内容は再読込で失われます。' : 'Sourceの編集内容に変更はありません。'}</p>
        <button disabled={!writable || busy || !newPath || !!selected && (!('content' in selected) || selected.encoding === 'base64')} onClick={() => void run(prepareFile)}>変更案を耐久記録して確認</button>
        {selected && <button onClick={() => void run(()=>downloadSource(selected))}>原文をダウンロード</button>}
      </details>
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App/>);
