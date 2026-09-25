/*
 * Element screenshots in IndexedDB, in the extension's own origin, keyed by
 * note id.
 *
 * They used to live in storage.local, where every save and delete was pushed
 * through storage.onChanged into every tab's content script and every
 * extension page (100–300 KB per screenshot, tens of MB for a bulk delete or
 * an import). IndexedDB changes notify nobody.
 *
 * Only the storage writer (the background) uses this module: content scripts
 * run in the page's origin and can't reach this database, and a Firefox
 * extension page in a private window would see a separate, temporary one.
 * Everyone else reads screenshots through the background (see storage.ts).
 */

const DB_NAME = 'webmark';
const DB_VERSION = 1;
const STORE = 'screenshots';

/** Raster images only: an SVG data URL can carry script. */
const SCREENSHOT_DATA_URL = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]*$/i;

export function isScreenshotDataUrl(value: unknown): value is string {
  return typeof value === 'string' && SCREENSHOT_DATA_URL.test(value);
}

interface Connection {
  factory: IDBFactory;
  db: Promise<IDBDatabase>;
}

let connection: Connection | undefined;

function connect(factory: IDBFactory, onGone: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Never hold up a newer version or a deleteDatabase(); reconnect on next use.
      db.onversionchange = () => {
        db.close();
        onGone();
      };
      db.onclose = onGone;
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open the screenshot database'));
  });
}

/** The cached connection; a new one when the last closed or the IndexedDB factory changed (tests swap it). */
function database(): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB as IDBFactory | undefined;
  if (!factory) return Promise.reject(new Error('IndexedDB is not available'));
  if (connection?.factory === factory) return connection.db;

  const drop = () => {
    if (connection === current) connection = undefined;
  };
  const current: Connection = { factory, db: connect(factory, drop) };
  current.db.catch(drop);
  connection = current;
  return current.db;
}

async function transaction(mode: IDBTransactionMode): Promise<IDBTransaction> {
  try {
    return (await database()).transaction(STORE, mode);
  } catch (error) {
    // The connection was closed under us (InvalidStateError): retry once on a fresh one.
    if ((error as { name?: unknown } | null)?.name !== 'InvalidStateError') throw error;
    connection = undefined;
    return (await database()).transaction(STORE, mode);
  }
}

/** Run `body` in one transaction; resolves with its result once the transaction has committed. */
async function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => T): Promise<T> {
  const tx = await transaction(mode);
  return new Promise<T>((resolve, reject) => {
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('Screenshot database error'));
    tx.onabort = () => reject(tx.error ?? new Error('Screenshot database transaction aborted'));
    try {
      result = body(tx.objectStore(STORE));
    } catch (error) {
      reject(error);
      tx.abort();
    }
  });
}

/** Whether screenshots can be kept in IndexedDB in this context. */
export async function isAvailable(): Promise<boolean> {
  try {
    await database();
    return true;
  } catch {
    return false;
  }
}

export async function get(noteId: string): Promise<string | undefined> {
  const request = await run('readonly', (store) => store.get(noteId));
  return typeof request.result === 'string' ? request.result : undefined;
}

/** Which of `noteIds` have a screenshot. */
export async function has(noteIds: readonly string[]): Promise<Set<string>> {
  if (!noteIds.length) return new Set();
  const requests = await run('readonly', (store) => noteIds.map((id) => [id, store.getKey(id)] as const));
  return new Set(requests.filter(([, request]) => request.result !== undefined).map(([id]) => id));
}

export async function put(entries: Readonly<Record<string, string>>): Promise<void> {
  const list = Object.entries(entries);
  if (!list.length) return;
  await run('readwrite', (store) => list.forEach(([id, dataUrl]) => store.put(dataUrl, id)));
}

export async function remove(noteIds: readonly string[]): Promise<void> {
  if (!noteIds.length) return;
  await run('readwrite', (store) => noteIds.forEach((id) => store.delete(id)));
}

export async function clear(): Promise<void> {
  await run('readwrite', (store) => store.clear());
}
