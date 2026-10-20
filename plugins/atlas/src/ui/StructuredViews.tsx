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

function KanbanView({ board, view, dispatch, onOpenCard }: InnerProps) {
  const lanes = view.lanes ?? (view.laneIds ?? []).map((id) => ({ id, label: id, cardIds: [] as string[] }));
  const cardsById = new Map(board.cards.map((card) => [card.id, card]));

  const saveLanes = (next: typeof lanes) => dispatch({ type: 'view.set-lanes', viewId: view.id, lanes: next });
  const addLane = () => saveLanes([...lanes, { id: createAtlasId('lane'), label: `Lane ${lanes.length + 1}`, cardIds: [] }]);
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

  return <section className="atlas-structured-view atlas-kanban" aria-label="Kanban board">
    <div className="atlas-view-heading"><div><h2>{view.name}</h2><p>Card lane membership and order are stored in this Board view.</p></div><button type="button" onClick={addLane}>＋ Add lane</button></div>
    <div className="atlas-lane-row">
      {lanes.map((lane, laneIndex) => <section className="atlas-lane" key={lane.id} aria-label={lane.label}>
        <header className="atlas-lane-header">
          <LaneLabelInput label={lane.label} onSave={(label) => renameLane(lane.id, label)} />
          <div className="atlas-button-pair">
            <button type="button" aria-label="Move lane left" disabled={laneIndex === 0} onClick={() => moveLane(laneIndex, -1)}>←</button>
            <button type="button" aria-label="Move lane right" disabled={laneIndex === lanes.length - 1} onClick={() => moveLane(laneIndex, 1)}>→</button>
            <button type="button" aria-label="Remove lane" disabled={lanes.length <= 1} onClick={() => removeLane(lane.id)}>×</button>
          </div>
        </header>
        <div className="atlas-lane-cards">
          {lane.cardIds.map((id, index) => {
            const card = cardsById.get(id);
            if (!card) return null;
            return <article className="atlas-structured-card" key={id}>
              <button className="atlas-card-title" type="button" onClick={() => onOpenCard(id)}>{card.text?.split('\n')[0] ?? card.source?.path ?? card.nodeRef?.localId ?? card.kind}</button>
              <p>{card.text?.slice(0, 120) ?? (card.source ? `${card.source.path} @ ${card.source.revision}` : card.kind)}</p>
              <footer>
                <button type="button" disabled={index === 0} aria-label="Move card up" onClick={() => reorderCard(lane.id, id, -1)}>↑</button>
                <button type="button" disabled={index === lane.cardIds.length - 1} aria-label="Move card down" onClick={() => reorderCard(lane.id, id, 1)}>↓</button>
                <label className="atlas-card-lane-select">Move to
                  <select value={lane.id} onChange={(event) => dispatch({ type: 'view.assign-card', viewId: view.id, laneId: event.currentTarget.value, cardId: id })}>
                    {lanes.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
                  </select>
                </label>
              </footer>
            </article>;
          })}
          {lane.cardIds.length === 0 && <p className="atlas-muted">No cards in this lane.</p>}
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
    ...board.cards.map((card) => ({ id: card.id, title: card.text?.split('\n')[0] ?? card.source?.path ?? card.nodeRef?.localId ?? card.kind, kind: card.kind, card: true })),
  ], [board.nodes, board.cards]);
  const entryById = new Map(timeline.entries.map((entry) => [entry.itemId, entry.value]));
  const [start, setStart] = useState(String(timeline.range.start));
  const [end, setEnd] = useState(String(timeline.range.end));

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
    if (nextAxis !== axis && timeline.entries.some((entry) => entry.value !== null)) {
      const accepted = window.confirm('Changing the axis clears known values to Unknown. Continue?');
      if (!accepted) return;
    }
    commit({ axis: nextAxis, values: new Map(allItems.map((item) => [item.id, null])) });
  };

  const saveRange = () => {
    const rangeStart = Number(start);
    const rangeEnd = Number(end);
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd < rangeStart) return;
    commit({ range: { start: rangeStart, end: rangeEnd } });
  };

  return <section className="atlas-structured-view atlas-timeline" aria-label="Timeline">
    <div className="atlas-view-heading"><div><h2>{view.name}</h2><p>Values are explicit; an empty value is Unknown. Atlas never infers dates from source order.</p></div></div>
    <div className="atlas-timeline-controls">
      <label>Axis
        <select value={axis} onChange={(event) => changeAxis(event.currentTarget.value as TimelineAxis)}>
          <option value="unknown">Unknown</option><option value="generic.time">Generic time (epoch ms)</option><option value="story.time">Story time (epoch ms)</option><option value="story.scene-order">Story scene order (ordinal)</option>
        </select>
      </label>
      <label>Range start<input type="number" value={start} onChange={(event) => setStart(event.currentTarget.value)} onBlur={saveRange} /></label>
      <label>Range end<input type="number" value={end} onChange={(event) => setEnd(event.currentTarget.value)} onBlur={saveRange} /></label>
      <button type="button" onClick={saveRange}>Apply range</button>
    </div>
    <div className="atlas-timeline-rows">
      {allItems.map((item) => {
        const value = entryById.get(item.id) ?? null;
        const fraction = value === null || timeline.range.end === timeline.range.start ? null
          : Math.max(0, Math.min(1, (value - timeline.range.start) / (timeline.range.end - timeline.range.start)));
        return <div className="atlas-timeline-row" key={item.id}>
          <div className="atlas-timeline-item">
            {item.card ? <button type="button" onClick={() => onOpenCard(item.id)}>{item.title}</button> : <strong>{item.title}</strong>}
            <small>{item.kind} · {item.id}</small>
          </div>
          <div className="atlas-timeline-track" aria-hidden="true">
            <span className={value === null ? 'atlas-timeline-marker is-unknown' : 'atlas-timeline-marker'} style={fraction === null ? undefined : { left: `${fraction * 100}%`}}>{value === null ? '?' : ''}</span>
          </div>
          <label className="atlas-timeline-value">{axis === 'story.scene-order' ? 'Ordinal' : axis.endsWith('.time') ? 'Epoch ms' : 'Value'}
            <TimelineValueInput value={value} label={item.title} onCommit={(text) => updateValue(item.id, text)} />
          </label>
        </div>;
      })}
      {allItems.length === 0 && <p className="atlas-empty-state">Add graph nodes or cards to put explicit values on this timeline.</p>}
    </div>
  </section>;
}

function LaneLabelInput({ label, onSave }: { label: string; onSave(value: string): void }) {
  const [draft, setDraft] = useState(label);
  useEffect(() => setDraft(label), [label]);
  return <input aria-label="Lane label" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} onBlur={() => {
    const next = draft.trim();
    if (next && next !== label) onSave(next);
    else setDraft(label);
  }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />;
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
  return <input type="number" aria-label={`${label} timeline value`} aria-invalid={invalid} value={draft} placeholder="Unknown" onChange={(event) => setDraft(event.currentTarget.value)} onBlur={commitDraft} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />;
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
  return <section className="atlas-structured-view atlas-storyboard" aria-label="Storyboard">
    <div className="atlas-view-heading"><div><h2>{view.name}</h2><p>Scene order is explicit and independent of dates.</p></div></div>
    <ol className="atlas-storyboard-list">
      {ids.map((id, index) => {
        const card = cardsById.get(id);
        if (!card) return null;
        return <li className="atlas-storyboard-card" key={id}>
          <div className="atlas-storyboard-order">{String(index + 1).padStart(2, '0')}</div>
          <button type="button" className="atlas-storyboard-content" onClick={() => onOpenCard(id)}>
            <strong>{card.text?.split('\n')[0] ?? card.source?.path ?? card.nodeRef?.localId ?? card.kind}</strong>
            <span>{card.text?.slice(0, 180) ?? (card.source ? `${card.source.path} @ ${card.source.revision}` : card.kind)}</span>
          </button>
          <div className="atlas-button-pair"><button type="button" disabled={index === 0} onClick={() => move(id, -1)}>↑</button><button type="button" disabled={index === ids.length - 1} onClick={() => move(id, 1)}>↓</button></div>
        </li>;
      })}
      {!ids.length && <li className="atlas-empty-state">Create cards to build an ordered storyboard.</li>}
    </ol>
  </section>;
}
