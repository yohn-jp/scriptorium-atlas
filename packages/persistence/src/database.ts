import { asPersistenceError, fail } from './errors.js';

export const DATABASE_NAME = 'scriptorium-atlas-v1';
export const DATABASE_VERSION = 1;
export const STORE_NAMES = ['workspaces', 'files', 'journal', 'receipts'] as const;

export type StoreName = (typeof STORE_NAMES)[number];

export interface DatabaseOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
}

export function openDatabase(options: DatabaseOptions = {}): Promise<IDBDatabase> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) return Promise.reject(asPersistenceError(new Error('IndexedDB is unavailable.')));
  const databaseName = options.databaseName ?? DATABASE_NAME;
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, DATABASE_VERSION);
    } catch (error) {
      reject(asPersistenceError(error));
      return;
    }
    request.onupgradeneeded = event => {
      const database = request.result;
      const oldVersion = event.oldVersion;
      if (oldVersion === 0) createV1Schema(database);
      else if (oldVersion < DATABASE_VERSION) {
        reject(new Error(`No migration is defined from IndexedDB schema ${oldVersion}.`));
        request.transaction?.abort();
      }
    };
    request.onblocked = () => reject(asPersistenceError(new DOMException('Database upgrade is blocked.', 'InvalidStateError')));
    request.onerror = () => reject(asPersistenceError(request.error));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function createV1Schema(database: IDBDatabase): void {
  database.createObjectStore('workspaces', { keyPath: 'workspaceId' });

  const files = database.createObjectStore('files', { keyPath: ['workspaceId', 'path'] });
  files.createIndex('byWorkspace', 'workspaceId', { unique: false });
  files.createIndex('byWorkspacePath', ['workspaceId', 'path'], { unique: true });
  files.createIndex('byWorkspacePathRevision', ['workspaceId', 'path', 'revision'], { unique: true });

  const journal = database.createObjectStore('journal', { keyPath: ['workspaceId', 'operationId'] });
  journal.createIndex('byPreparedId', 'preparedId', { unique: true });
  journal.createIndex('byWorkspaceState', ['workspaceId', 'state'], { unique: false });

  const receipts = database.createObjectStore('receipts', { keyPath: ['workspaceId', 'operationId'] });
  receipts.createIndex('byWorkspaceCommittedAt', ['workspaceId', 'committedAt'], { unique: false });
}

export function readonlyTransaction(database: IDBDatabase, storeNames: StoreName[]): IDBTransaction {
  return database.transaction(storeNames, 'readonly');
}

export function strictTransaction(database: IDBDatabase, storeNames: StoreName[]): IDBTransaction {
  try {
    return database.transaction(storeNames, 'readwrite', { durability: 'strict' });
  } catch (error) {
    fail('STORAGE_UNAVAILABLE', 'This browser cannot start strict-durability IndexedDB transactions.', {
      cause: error instanceof Error ? error.name : 'unknown'
    });
  }
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new DOMException('IndexedDB request failed.', 'UnknownError'));
  });
}

export function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new DOMException('IndexedDB transaction aborted.', 'AbortError'));
    transaction.onerror = () => reject(transaction.error ?? new DOMException('IndexedDB transaction failed.', 'UnknownError'));
  });
}

export async function readRequest<T>(database: IDBDatabase, storeName: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const transaction = readonlyTransaction(database, [storeName]);
  const done = transactionResult(transaction);
  const result = requestResult(transaction.objectStore(storeName).get(key) as IDBRequest<T | undefined>);
  const [value] = await Promise.all([result, done]);
  return value;
}

export async function readAllByIndex<T>(
  database: IDBDatabase,
  storeName: StoreName,
  indexName: string,
  key: IDBValidKey
): Promise<T[]> {
  const transaction = readonlyTransaction(database, [storeName]);
  const done = transactionResult(transaction);
  const result = requestResult(transaction.objectStore(storeName).index(indexName).getAll(key) as IDBRequest<T[]>);
  const [values] = await Promise.all([result, done]);
  return values;
}

export async function readAll<T>(database: IDBDatabase, storeName: StoreName): Promise<T[]> {
  const transaction = readonlyTransaction(database, [storeName]);
  const done = transactionResult(transaction);
  const result = requestResult(transaction.objectStore(storeName).getAll() as IDBRequest<T[]>);
  const [values] = await Promise.all([result, done]);
  return values;
}

export async function writeOne(database: IDBDatabase, storeName: StoreName, value: unknown): Promise<void> {
  const transaction = strictTransaction(database, [storeName]);
  const done = transactionResult(transaction);
  transaction.objectStore(storeName).put(value);
  await done.catch(error => {
    throw asPersistenceError(error);
  });
}

export function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // The transaction may already have aborted after the original failure.
  }
}
