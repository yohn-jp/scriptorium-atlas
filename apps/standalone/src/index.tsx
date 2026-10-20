import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { openIndexedDbHost, type IndexedDbHostPort, type WorkspaceInfo, type PreparedProposal } from '@scriptorium-atlas/persistence/host';
import type { ChangeIntent, PreparedChange, WorkspaceHandle, VersionedFile } from '@scriptorium-atlas/contracts';
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
  const [files, setFiles] = useState<VersionedFile[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposals, setProposals] = useState<PreparedProposal[]>([]);
  const [selected, setSelected] = useState<VersionedFile>();
  const [sourceText, setSourceText] = useState('');
  const [newPath, setNewPath] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [atlasEnabled, setAtlasEnabled] = useState(profile !== 'story');
  const [storyEnabled, setStoryEnabled] = useState(profile !== 'atlas');
  const [storyGrant, setStoryGrant] = useState(false);

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
    const all: VersionedFile[] = [];
    let cursor: string | undefined;
    do {
      const page = await host.getSnapshotPage(workspace, cursor ? { cursor, limit: 100 } : {limit:100});
      all.push(...page.files); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    setCurrent(workspace); setFiles(all); setWorkspaces(await host.listWorkspaces());
  }
  async function open(workspaceId: string) {
    if (!host) return;
    setSelected(undefined); setSourceText(''); setProposals([]);
    await refresh(workspaceId);
    const recovery = await host.recover(workspaceId);
    setProposals(await host.listPending(workspaceId));
    setNotice(recovery.pendingOperationIds.length ? `復旧した承認待ちDraft: ${recovery.pendingOperationIds.length}件` : 'Workspaceを開きました。');
  }
  async function prepare(change: ChangeIntent) {
    if (!host || !current) throw new Error('Workspaceを開いてください');
    const proposal = await host.prepare(current, change);
    setProposals(await host.listPending(current.workspaceId));
    setNotice('Draftを耐久記録しました。確定には内容の確認と承認が必要です。');
    return proposal;
  }
  async function prepareFile() {
    if (!current) return;
    if (selected?.encoding === 'base64') throw new Error('バイナリFileはこのSource欄では編集できません。画像はAtlasの画像操作から更新してください。');
    const path = selected?.path ?? newPath;
    await prepare({ operationId: crypto.randomUUID(), workspaceId: current.workspaceId,
      baseWorkspaceRevision: current.sourceRevision,
      reads: [{ path, revision: selected?.revision ?? null }],
      writes: [{ path, content: sourceText, encoding: 'utf8' }], message: `${path} を編集`, kind: 'source' });
  }
  async function selectSource(file: VersionedFile) {
    if (selected && sourceText !== selected.content && !window.confirm('未提出の編集があります。別のSourceを開きますか？')) return;
    setSelected(file); setSourceText(file.content); setNewPath(file.path);
  }

  return <main data-theme={theme}>
    <header><div><h1>Scriptorium Atlas</h1><span>{profile} / Standalone</span></div>
      <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? 'ダーク表示' : 'ライト表示'}</button>
    </header>
    <p className="status">保存先: このブラウザのIndexedDB。Commitはローカル確定です。</p>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="status">{notice}</p>}
    <section aria-label="Workspace" className="workspace-controls">
      <label>Workspace名<input value={name} onChange={event => setName(event.target.value)} maxLength={256}/></label>
      <button disabled={!host || busy || !name.trim()} onClick={() => void run(async () => { const info = await host!.createWorkspace({ name }); await open(info.workspace.workspaceId); })}>空のWorkspaceを作成</button>
      <label>開く<select value={current?.workspaceId ?? ''} onChange={event => { if (event.target.value) void run(() => open(event.target.value)); }}><option value="">選択してください</option>{workspaces.map(info => <option key={info.workspace.workspaceId} value={info.workspace.workspaceId}>{info.name}</option>)}</select></label>
      <button disabled={!current || busy || !name.trim()} onClick={() => void run(async () => { await host!.renameWorkspace(current!.workspaceId, name); await refresh(current!.workspaceId); })}>名前を変更</button>
      <button disabled={!current} onClick={() => { setCurrent(undefined); setFiles([]); setSelected(undefined); setProposals([]); }}>閉じる</button>
      <label>Bundleをimport<input type="file" accept=".zip,application/zip" disabled={!host || busy} onChange={event => { const file = event.target.files?.[0]; if (file) void run(async () => { const info = await host!.importBundle(file); await open(info.workspace.workspaceId); }); event.target.value = ''; }}/></label>
      <button disabled={!host || !current || busy} onClick={() => void run(async () => download(await host!.export(current!.workspaceId), 'atlas-workspace.zip'))}>Bundleをexport</button>
    </section>
    {current && host && <>
      <section aria-label="Plugin controls" className="workspace-controls">
        {profile !== 'story' && <label><input type="checkbox" checked={atlasEnabled} onChange={event => setAtlasEnabled(event.target.checked)}/>Atlasを有効化</label>}
        {profile !== 'atlas' && <label><input type="checkbox" checked={storyEnabled} onChange={event => setStoryEnabled(event.target.checked)}/>Story Knowledgeを有効化</label>}
        {profile === 'combined' && <label><input type="checkbox" checked={storyGrant} onChange={event => setStoryGrant(event.target.checked)}/>AtlasへStory ProviderとSourceの読取りを許可</label>}
      </section>
      <div className="plugins">
        {atlasEnabled && <PluginFrame key={`atlas:${current.workspaceId}`} plugin="atlas" workspace={current} host={host} onPrepare={prepare} onSource={selectSource} theme={theme} storyGrant={storyGrant} storyEnabled={storyEnabled}/>}
        {storyEnabled && <PluginFrame key={`story:${current.workspaceId}`} plugin="story" workspace={current} host={host} onPrepare={prepare} onSource={selectSource} theme={theme} storyGrant={storyGrant} storyEnabled={storyEnabled}/>}
      </div>
      <section aria-label="変更の承認">
        <h2>変更の確認・ローカルCommit</h2>
        {proposals.length === 0 && <p>承認待ちの変更はありません。</p>}
        {proposals.map(proposal => <article key={proposal.prepared.preparedId}>
          <p>{proposal.change.message}</p>
          {proposal.changes.map(change => <details key={change.path} open><summary>{change.path}</summary><p>変更前 ({change.before?.revision ?? '新規'})</p><pre>{change.before?.content ?? 'ファイルなし'}</pre><p>変更後</p><pre>{change.after?.content ?? '削除'}</pre></details>)}
          <button disabled={busy} onClick={() => void run(async () => {
            const receipt = await host.commit(await host.getWorkspaceHandle(current.workspaceId), proposal.prepared.preparedId, true);
            setNotice(`ローカルCommit完了: ${JSON.stringify(receipt)}`);
            setProposals(items => items.filter(item => item.prepared.preparedId !== proposal.prepared.preparedId));
            await refresh(current.workspaceId);
          })}>この変更を承認してCommit</button>
          <button onClick={() => download(new Blob([JSON.stringify(proposal.change, null, 2)], {type:'application/json'}), `draft-${proposal.change.operationId}.json`)}>このDraftをexport</button>
        </article>)}
      </section>
      <details open={!!selected}><summary>Workspaceのファイル・Source</summary>
        <ul>{files.map(file => <li key={file.path}><button onClick={() => void selectSource(file)}>{file.path}</button><span> revision {file.revision.slice(0, 12)}</span></li>)}</ul>
        <label>相対Path<input value={newPath} onChange={event => { setNewPath(event.target.value); setSelected(undefined); }}/></label>
        <label>Source<textarea value={sourceText} onChange={event => setSourceText(event.target.value)} readOnly={selected?.encoding === 'base64'} rows={12}/></label>
        <p role="status">{sourceText !== (selected?.content ?? '') ? '未提出の編集があります。耐久記録前の内容は再読込で失われます。' : 'Sourceの編集内容に変更はありません。'}</p>
        <button disabled={busy || !newPath || selected?.encoding === 'base64'} onClick={() => void run(prepareFile)}>変更案を耐久記録して確認</button>
        {selected && <button onClick={() => download(new Blob([selected.encoding === 'base64' ? Uint8Array.from(atob(selected.content), value => value.charCodeAt(0)) : selected.content], {type:selected.contentType}), selected.path.split('/').at(-1)!)}>原文をダウンロード</button>}
      </details>
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App/>);
