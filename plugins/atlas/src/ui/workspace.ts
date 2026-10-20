import type { BoardDocument, PluginHostClient, WorkspaceSnapshotPage } from '@scriptorium-atlas/contracts';
import { assertBoardIntegrity } from '@scriptorium-atlas/contracts';
import { inspectExcalidrawScene } from '@scriptorium-atlas/canvas/io';
import { serializeBoard } from '@scriptorium-atlas/persistence/board';
import { readFileText, readWorkspaceSnapshot, type WorkspaceFile } from './host-utils.js';

const MAX_SCENE_BYTES = 2 * 1024 * 1024;

export type BoardBaseline = {
  board: BoardDocument;
  boardText: string;
  sceneText: string | null;
  boardRevision: string | null;
  sceneRevision: string | null;
  sceneError?: string;
};

export type BoardSession = {
  board: BoardDocument;
  originalBoard: BoardDocument;
  originalText: string;
  baseBoardText: string | null;
  sceneText: string | null;
  baseSceneText: string | null;
  path: string;
  scenePath: string;
  boardFileRevision: string | null;
  sceneFileRevision: string | null;
  sceneError?: string;
  conflict?: BoardBaseline;
  externalDeleted?: boolean;
};

export type InvalidBoardFile = {
  path: string;
  revision: string;
  rawText: string;
  message: string;
};

export type AtlasInventory = {
  workspace: WorkspaceSnapshotPage['workspace'];
  files: Map<string, WorkspaceFile>;
  boards: Map<string, BoardSession>;
  invalid: InvalidBoardFile[];
};

const clone = <T>(value: T): T => structuredClone(value);

export function scenePathForBoard(boardPath: string): string {
  return boardPath.replace(/\.atlas\.json$/i, '.excalidraw');
}

export function makeBoardPath(boardId: string): string {
  return `documents/${boardId}.atlas.json`;
}

export function serializeSessionBoard(session: BoardSession): string {
  return serializeBoard(session.board, { board: session.originalBoard, content: session.originalText });
}

export function isSessionDirty(session: BoardSession): boolean {
  return session.baseBoardText === null
    || serializeSessionBoard(session) !== session.baseBoardText
    || (session.sceneText !== null && session.sceneText !== session.baseSceneText);
}

function parseBoardDocument(text: string): BoardDocument {
  const parsed: unknown = JSON.parse(text);
  assertBoardIntegrity(parsed);
  return parsed;
}

async function loadSession(
  host: PluginHostClient,
  boardPath: string,
  boardFile: WorkspaceFile,
  files: Map<string, WorkspaceFile>,
): Promise<{ session: BoardSession; boardText: string }> {
  const boardText = await readFileText(host, boardFile);
  if (new TextEncoder().encode(boardText).byteLength > 2 * 1024 * 1024) throw new Error('Atlas Board exceeds the 2 MiB document limit.');
  const board = parseBoardDocument(boardText);
  const scenePath = scenePathForBoard(boardPath);
  const sceneFile = files.get(scenePath);
  let sceneText: string | null = null;
  let sceneLoadError: string | undefined;
  if (sceneFile) {
    try { sceneText = await readFileText(host, sceneFile); }
    catch (error) { sceneLoadError = `The scene could not be read from the Host: ${error instanceof Error ? error.message : String(error)}`; }
  }
  const sceneBytes = sceneText === null ? 0 : new TextEncoder().encode(sceneText).byteLength;
  const sceneSizeError = sceneBytes > MAX_SCENE_BYTES
    ? `This Excalidraw scene is ${sceneBytes} bytes; Host documents are limited to 2 MiB. Raw scene export is available.`
    : undefined;
  const sceneInspection = sceneText === null ? null : inspectExcalidrawScene(sceneText);
  const sceneError = sceneLoadError ?? sceneSizeError ?? (sceneInspection?.status === 'read-only' ? sceneInspection.message : undefined);
  const originalBoard = clone(board);
  return {
    boardText,
    session: {
      board,
      originalBoard,
      originalText: boardText,
      baseBoardText: boardText,
      baseSceneText: sceneFile ? sceneText : null,
      sceneText,
      path: boardPath,
      scenePath,
      boardFileRevision: boardFile.revision,
      sceneFileRevision: sceneFile?.revision ?? null,
      ...(sceneError ? { sceneError } : {}),
    },
  };
}

export async function loadAtlasInventory(host: PluginHostClient): Promise<AtlasInventory> {
  const { workspace, files } = await readWorkspaceSnapshot(host);
  const boards = new Map<string, BoardSession>();
  const invalid: InvalidBoardFile[] = [];
  const candidates = [...files.entries()].filter(([path]) => path.toLowerCase().endsWith('.atlas.json'));
  for (const [path, file] of candidates) {
    try {
      const loaded = await loadSession(host, path, file, files);
      if (boards.has(loaded.session.board.boardId)) {
        invalid.push({ path, revision: file.revision, rawText: loaded.boardText, message: `Board ID ${loaded.session.board.boardId} appears in more than one file.` });
        continue;
      }
      boards.set(loaded.session.board.boardId, loaded.session);
    } catch (error) {
      let rawText = '';
      try { rawText = await readFileText(host, file); } catch { /* keep metadata-only diagnostics */ }
      invalid.push({ path, revision: file.revision, rawText, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { workspace, files, boards, invalid };
}

export function baselineFromSession(session: BoardSession): BoardBaseline {
  return {
    board: clone(session.board),
    boardText: serializeSessionBoard(session),
    sceneText: session.sceneText,
    boardRevision: session.boardFileRevision,
    sceneRevision: session.sceneFileRevision,
    ...(session.sceneError ? { sceneError: session.sceneError } : {}),
  };
}

export function applyRemoteBaseline(session: BoardSession, baseline: BoardBaseline, keepLocalDraft: boolean): BoardSession {
  const { conflict: _conflict, externalDeleted: _externalDeleted, sceneError: _oldSceneError, ...withoutConflict } = session;
  if (!keepLocalDraft) {
    return {
      ...withoutConflict,
      board: clone(baseline.board),
      originalBoard: clone(baseline.board),
      originalText: baseline.boardText,
      baseBoardText: baseline.boardText,
      sceneText: baseline.sceneText,
      baseSceneText: baseline.sceneRevision === null ? null : baseline.sceneText,
      boardFileRevision: baseline.boardRevision,
      sceneFileRevision: baseline.sceneRevision,
      ...(baseline.sceneError ? { sceneError: baseline.sceneError } : {}),
    };
  }
  const keepSceneDraft = session.sceneText !== null && session.sceneText !== session.baseSceneText;
  return {
    ...withoutConflict,
    board: { ...session.board, revision: Math.max(session.board.revision, baseline.board.revision) + 1 },
    originalBoard: clone(baseline.board),
    originalText: baseline.boardText,
    baseBoardText: baseline.boardText,
    sceneText: keepSceneDraft ? session.sceneText : baseline.sceneText,
    baseSceneText: baseline.sceneRevision === null ? null : baseline.sceneText,
    boardFileRevision: baseline.boardRevision,
    sceneFileRevision: baseline.sceneRevision,
    ...(baseline.sceneError ? { sceneError: baseline.sceneError } : {}),
  };
}
