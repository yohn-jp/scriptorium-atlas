import { useEffect, useMemo, useState } from 'react';
import type { BoardDocument, BoardView, TimelineAxis } from '@scriptorium-atlas/contracts';
import { applyAtlasCommand, createAtlasId } from '../commands/model.js';

export type StructuredViewsProps = {
  board: BoardDocument;
  view: BoardView;
  onBoardChange(board: BoardDocument): void;
  onOpenCard(cardId: string): void;
};

export function StructuredViews({ board, view, onBoardChange, onOpenCard }: StructuredViewsProps) {
  const dispatch = (command: Parameters<typeof applyAtlasCommand>[1]) => onBoardChange(applyAtlasCommand(board, command));
  if (view.kind === 'board') return <KanbanView {...{ board, view, dispatch, onOpenCard }} />;
  if (view.kind === 'timeline') return <TimelineView {...{ board, view, dispatch, onOpenCard }} />;
  if (view.kind === 'storyboard') return <StoryboardView {...{ board, view, dispatch, onOpenCard }} />;
  return null;
}

type InnerProps = {
  board: BoardDocument;
  view: BoardView;
  dispatch(command: Parameters<typeof applyAtlasCommand>[1]): void;
  onOpenCard(cardId: string): void;
};

function cardKindLabel(kind: BoardDocument['cards'][number]['kind']): string {
  switch (kind) {
    case 'text': return 'テキスト';
    case 'source': return 'ソース';
    case 'provider-node': return 'Providerノード';
    case 'image': return '画像';
  }
}

function KanbanView({ board, view, dispatch, onOpenCard }: InnerProps) {
  const lanes = view.lanes ?? (view.laneIds ?? []).map((id) => ({ id, label: id, cardIds: [] as string[] }));
  const cardsById = new Map(board.cards.map((card) => [card.id, card]));

  const saveLanes = (next: typeof lanes) => dispatch({ type: 'view.set-lanes', viewId: view.id, lanes: next });
  const addLane = () => saveLanes([...lanes, { id: createAtlasId('lane'), label: `レーン ${lanes.length + 1}`, cardIds: [] }]);
  const renameLane = (laneId: string, label: string) => saveLanes(lanes.map((lane) => lane.id === laneId ? { ...lane, label } : lane));
  const removeLane = (laneId: string) => {
    if (lanes.length <= 1) return;
    const removed = lanes.find((lane) => lane.id === laneId);
    const remaining = lanes.filter((lane) => lane.id !== laneId);
    if (removed?.cardIds.length) remaining[0] = { ...remaining[0]!, cardIds: [...remaining[0]!.cardIds, ...removed.cardIds] };
    saveLanes(remaining);
  };
  const moveLane = (index: number, delta: -1 | 1) => {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= lanes.length) return;
    const next = [...lanes];
    [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
    saveLanes(next);
  };
  const reorderCard = (laneId: string, cardId: string, delta: -1 | 1) => {
    const lane = lanes.find((candidate) => candidate.id === laneId)!;
    const index = lane.cardIds.indexOf(cardId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= lane.cardIds.length) return;
    dispatch({ type: 'view.assign-card', viewId: view.id, laneId, cardId, index: target });
  };

  return <section className="atlas-structured-view atlas-kanban" aria-label="カンバンボード">
    <div className="atlas-view-heading"><div><h2>{view.name}</h2><p>カードのレーンと並び順は、このボードビューに保存されます。</p></div><button type="button" onClick={addLane}>＋ レーンを追加</button></div>
    <div className="atlas-lane-row">
      {lanes.map((lane, laneIndex) => <section className="atlas-lane" key={lane.id} aria-label={lane.label}>
        <header className="atlas-lane-header">
          <LaneLabelInput label={lane.label} onSave={(label) => renameLane(lane.id, label)} />
          <div className="atlas-button-pair">
            <button type="button" aria-label="レーンを左へ移動" disabled={laneIndex === 0} onClick={() => moveLane(laneIndex, -1)}>←</button>
            <button type="button" aria-label="レーンを右へ移動" disabled={laneIndex === lanes.length - 1} onClick={() => moveLane(laneIndex, 1)}>→</button>
            <button type="button" aria-label="レーンを削除" disabled={lanes.length <= 1} onClick={() => removeLane(lane.id)}>×</button>
          </div>
        </header>
        <div className="atlas-lane-cards">
          {lane.cardIds.map((id, index) => {
            const card = cardsById.get(id);
            if (!card) return null;
            return <article className="atlas-structured-card" key={id}>
              <button className="atlas-card-title" type="button" onClick={() => onOpenCard(id)}>{card.text?.split('\n')[0] ?? card.source?.path ?? card.nodeRef?.localId ?? cardKindLabel(card.kind)}</button>
              <p>{card.text?.slice(0, 120) ?? (card.source ? `${card.source.path} @ ${card.source.revision}` : cardKindLabel(card.kind))}</p>
              <footer>
                <button type="button" disabled={index === 0} aria-label="カードを上へ移動" onClick={() => reorderCard(lane.id, id, -1)}>↑</button>
                <button type="button" disabled={index === lane.cardIds.length - 1} aria-label="カードを下へ移動" onClick={() => reorderCard(lane.id, id, 1)}>↓</button>
                <label className="atlas-card-lane-select">移動先
                  <select value={lane.id} onChange={(event) => dispatch({ type: 'view.assign-card', viewId: view.id, laneId: event.currentTarget.value, cardId: id })}>
                    {lanes.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
                  </select>
                </label>
              </footer>
            </article>;
          })}
          {lane.cardIds.length === 0 && <p className="atlas-muted">このレーンにカードはありません。</p>}
        </div>
      </section>)}
    </div>
  </section>;
}

function TimelineView({ board, view, dispatch, onOpenCard }: InnerProps) {
  const axis = view.axis ?? 'unknown';
  const timeline = view.timeline ?? { range: { start: 0, end: 1 }, entries: [] };
  const allItems = useMemo(() => [
    ...board.nodes.map((node) => ({ id: node.id, title: node.label, kind: node.kind, card: false })),
    ...board.cards.map((card) => ({ id: card.id, title: card.text?.split('\n')[0] ?? card.source?.path ?? card.nodeRef?.localId ?? cardKindLabel(card.kind), kind: card.kind, card: true })),
  ], [board.nodes, board.cards]);
  const entryById = new Map(timeline.entries.map((entry) => [entry.itemId, entry.value]));
  const [start, setStart] = useState(String(timeline.range.start));
  const [end, setEnd] = useState(String(timeline.range.end));
  const [pendingAxis, setPendingAxis] = useState<TimelineAxis | null>(null);

  useEffect(() => { setStart(String(timeline.range.start)); setEnd(String(timeline.range.end)); }, [view.id, timeline.range.start, timeline.range.end]);

  const commit = (changes: { axis?: TimelineAxis; range?: { start: number; end: number }; values?: Map<string, number | null> }) => {
    const range = changes.range ?? timeline.range;
    const nextAxis = changes.axis ?? axis;
    const entries = allItems.map((item) => ({
      itemId: item.id,
      value: changes.values?.has(item.id) ? changes.values.get(item.id)! : (nextAxis === axis ? entryById.get(item.id) ?? null : null),
    }));
    dispatch({ type: 'view.timeline', viewId: view.id, axis: nextAxis, range, entries });
  };

  const updateValue = (itemId: string, text: string) => {
    const values = new Map<string, number | null>();
    for (const item of allItems) values.set(item.id, item.id === itemId ? (text === '' ? null : Number(text)) : entryById.get(item.id) ?? null);
    commit({ values });
  };

  const changeAxis = (nextAxis: TimelineAxis) => {
    if (nextAxis === axis) {
      setPendingAxis(null);
      return;
    }
    if (nextAxis !== axis && timeline.entries.some((entry) => entry.value !== null)) {
      setPendingAxis(nextAxis);
      return;
    }
    commit({ axis: nextAxis, values: new Map(allItems.map((item) => [item.id, null])) });
  };

  const confirmAxisChange = () => {
    if (!pendingAxis) return;
    commit({ axis: pendingAxis, values: new Map(allItems.map((item) => [item.id, null])) });
    setPendingAxis(null);
  };

  const saveRange = () => {
    const rangeStart = Number(start);
    const rangeEnd = Number(end);
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd < rangeStart) return;
    commit({ range: { start: rangeStart, end: rangeEnd } });
  };

  return <section className="atlas-structured-view atlas-timeline" aria-label="タイムライン">
    <div className="atlas-view-heading"><div><h2>{view.name}</h2><p>値は明示的に設定します。空欄は「不明」です。Atlasは並び順から日付を推測しません。</p></div></div>
    <div className="atlas-timeline-controls">
      <label>軸
        <select value={pendingAxis ?? axis} onChange={(event) => changeAxis(event.currentTarget.value as TimelineAxis)}>
          <option value="unknown">不明</option><option value="generic.time">一般時刻（エポックms）</option><option value="story.time">物語内時刻（エポックms）</option><option value="story.scene-order">物語のシーン順（順序番号）</option>
        </select>
      </label>
      <label>範囲の開始<input type="number" value={start} onChange={(event) => setStart(event.currentTarget.value)} onBlur={saveRange} /></label>
      <label>範囲の終了<input type="number" value={end} onChange={(event) => setEnd(event.currentTarget.value)} onBlur={saveRange} /></label>
      <button type="button" onClick={saveRange}>範囲を適用</button>
    </div>
    {pendingAxis && <div className="atlas-axis-confirm" role="group" aria-label="タイムライン軸変更の確認">
      <p>軸を変更すると、入力済みの値は「不明」に戻ります。{pendingAxis}へ変更しますか？</p>
      <button type="button" onClick={confirmAxisChange}>値を不明に戻して軸を変更</button>
      <button type="button" onClick={() => setPendingAxis(null)}>キャンセル</button>
    </div>}
    <div className="atlas-timeline-rows">
      {allItems.map((item) => {
        const value = entryById.get(item.id) ?? null;
        const fraction = value === null || timeline.range.end === timeline.range.start ? null
          : Math.max(0, Math.min(1, (value - timeline.range.start) / (timeline.range.end - timeline.range.start)));
        return <div className="atlas-timeline-row" key={item.id}>
          <div className="atlas-timeline-item">
            {item.card ? <button type="button" onClick={() => onOpenCard(item.id)}>{item.title}</button> : <strong>{item.title}</strong>}
            <small>{item.card ? cardKindLabel(item.kind as BoardDocument['cards'][number]['kind']) : item.kind} · {item.id}</small>
          </div>
          <div className="atlas-timeline-track" aria-hidden="true">
            <span className={value === null ? 'atlas-timeline-marker is-unknown' : 'atlas-timeline-marker'} style={fraction === null ? undefined : { left: `${fraction * 100}%`}}>{value === null ? '?' : ''}</span>
          </div>
          <label className="atlas-timeline-value">{axis === 'story.scene-order' ? '順序番号' : axis.endsWith('.time') ? 'エポック時刻（ms）' : '値'}
            <TimelineValueInput value={value} label={item.title} onCommit={(text) => updateValue(item.id, text)} />
          </label>
        </div>;
      })}
      {allItems.length === 0 && <p className="atlas-empty-state">グラフノードやカードを追加して、タイムラインに値を設定してください。</p>}
    </div>
  </section>;
}

function LaneLabelInput({ label, onSave }: { label: string; onSave(value: string): void }) {
  const [draft, setDraft] = useState(label);
  useEffect(() => setDraft(label), [label]);
  return <input aria-label="レーン名" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} onBlur={() => {
    const next = draft.trim();
    if (next && next !== label) onSave(next);
    else setDraft(label);
  }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) event.currentTarget.blur(); }} />;
}

function TimelineValueInput({ value, label, onCommit }: { value: number | null; label: string; onCommit(text: string): void }) {
  const initial = value === null ? '' : String(value);
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(initial); setInvalid(false); }, [initial]);
  const commitDraft = () => {
    if (draft !== '' && !Number.isFinite(Number(draft))) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (draft !== initial) onCommit(draft);
  };
  return <input type="number" aria-label={`${label} のタイムライン値`} aria-invalid={invalid} value={draft} placeholder="不明" onChange={(event) => setDraft(event.currentTarget.value)} onBlur={commitDraft} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) event.currentTarget.blur(); }} />;
}

function StoryboardView({ board, view, dispatch, onOpenCard }: InnerProps) {
  const orderedIds = view.cardOrder ?? [];
  const ids = [...orderedIds.filter((id) => board.cards.some((card) => card.id === id)), ...board.cards.map((card) => card.id).filter((id) => !orderedIds.includes(id))];
  const cardsById = new Map(board.cards.map((card) => [card.id, card]));
  const move = (id: string, delta: -1 | 1) => {
    const index = ids.indexOf(id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target]!, next[index]!];
    dispatch({ type: 'view.reorder-cards', viewId: view.id, cardIds: next });
  };
  return <section className="atlas-structured-view atlas-storyboard" aria-label="ストーリーボード">
    <div className="atlas-view-heading"><div><h2>{view.name}</h2><p>シーンの順序は明示的に設定し、日付とは独立して管理します。</p></div></div>
    <ol className="atlas-storyboard-list">
      {ids.map((id, index) => {
        const card = cardsById.get(id);
        if (!card) return null;
        return <li className="atlas-storyboard-card" key={id}>
          <div className="atlas-storyboard-order">{String(index + 1).padStart(2, '0')}</div>
          <button type="button" className="atlas-storyboard-content" onClick={() => onOpenCard(id)}>
            <strong>{card.text?.split('\n')[0] ?? card.source?.path ?? card.nodeRef?.localId ?? cardKindLabel(card.kind)}</strong>
            <span>{card.text?.slice(0, 180) ?? (card.source ? `${card.source.path} @ ${card.source.revision}` : cardKindLabel(card.kind))}</span>
          </button>
          <div className="atlas-button-pair"><button type="button" aria-label="シーンを前へ移動" disabled={index === 0} onClick={() => move(id, -1)}>↑</button><button type="button" aria-label="シーンを後ろへ移動" disabled={index === ids.length - 1} onClick={() => move(id, 1)}>↓</button></div>
        </li>;
      })}
      {!ids.length && <li className="atlas-empty-state">カードを作成して、順序付きのストーリーボードを組み立ててください。</li>}
    </ol>
  </section>;
}
