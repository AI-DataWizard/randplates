// db.js — IndexedDB wrapper (PRD §8: user-local, never sent anywhere).
// Object stores: pantry, cook_log, saved_plans, saved_recipes. Settings live in
// localStorage (PRD §2). Settings + data export/import for the Settings screen.

const DB_NAME = "randplates";
const DB_VERSION = 2;
const STORES = [
  "pantry",
  "cook_log",
  "saved_plans",
  "saved_recipes",
  "gap_log",
];

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: "id" });
        }
      }
      // P-441: the gap log — every review-queue item, per decode, idempotent
      // (deterministic ids mean re-decoding a caption overwrites, never
      // double-counts).
      const os = e.target.transaction.objectStore("gap_log");
      for (const idx of ["sessionId", "reasonCode", "candidate"]) {
        if (!os.indexNames.contains(idx)) os.createIndex(idx, idx);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Get one record by id. */
export async function get(store, id) {
  const db = await openDB();
  return reqAsPromise(tx(db, store).get(id));
}

/** Get all records from a store, sorted by created date. */
export async function getAll(store) {
  const db = await openDB();
  const rows = await reqAsPromise(tx(db, store, "readonly").getAll());
  return rows.sort((a, b) =>
    String(a.created_date || "").localeCompare(String(b.created_date || "")),
  );
}

/** Put (upsert) one record. Adds id/created_date automatically. */
export async function put(store, record) {
  const db = await openDB();
  const now = new Date().toISOString();
  const rec = { ...record };
  if (!rec.id)
    rec.id = crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (!rec.created_date) rec.created_date = now;
  rec.updated_date = now;
  await reqAsPromise(tx(db, store, "readwrite").put(rec));
  return rec;
}

/** Delete by id. */
export async function remove(store, id) {
  const db = await openDB();
  await reqAsPromise(tx(db, store, "readwrite").delete(id));
}

/** Clear a whole store (used by import). */
export async function clear(store) {
  const db = await openDB();
  await reqAsPromise(tx(db, store, "readwrite").clear());
}

/** True pantry item (pantry items use the ingredient id as their record id). */
export async function putPantryItem(item) {
  return put("pantry", { ...item, id: item.id }); // id = ingredient id (upsert)
}

/** Add a cook-log entry. id auto-generated. */
export async function logCook(entry) {
  return put("cook_log", entry);
}

/** Export ALL user data as one JSON blob (Settings screen / backup / template story). */
export async function exportAll() {
  const data = {};
  for (const s of STORES) data[s] = await getAll(s);
  return {
    app: "randplates",
    format_version: 1,
    exported: new Date().toISOString(),
    ...data,
    settings: getSettings(),
  };
}

/** Import a previously exported blob — MERGE semantics (P-546b):
 *  for every record the NEWER version wins (updated_date), so restoring an
 *  old backup never clobbers newer cooking. Settings merge shallowly with the
 *  imported values winning only for keys the backup actually carries. */
export async function importAll(blob) {
  if (!blob || blob.app !== "randplates")
    throw new Error("Not a RandPlates export file");
  const newer = (a, b) => {
    const ta = a?.updated_date ? Date.parse(a.updated_date) : 0;
    const tb = b?.updated_date ? Date.parse(b.updated_date) : 0;
    return ta >= tb; // ties -> imported wins (idempotent re-import)
  };
  let merged = 0,
    keptLocal = 0;
  for (const s of STORES) {
    const existing = await getAll(s);
    const byId = new Map(existing.map((r) => [r.id, r]));
    for (const rec of blob[s] || []) {
      if (!rec || typeof rec !== "object") continue;
      const cur = byId.get(rec.id);
      if (cur && !newer(rec, cur)) {
        keptLocal++;
        continue;
      } // local is newer
      byId.set(rec.id, rec);
      merged++;
    }
    await clear(s);
    for (const rec of byId.values()) {
      await reqAsPromise(tx(await openDB(), s, "readwrite").put(rec));
    }
  }
  if (blob.settings && typeof blob.settings === "object")
    setSettings(blob.settings);
  return { merged, keptLocal };
}

// ---- localStorage settings (PRD §2: settings are localStorage, not IndexedDB) ----

const SETTINGS_KEY = "randplates.settings";

export function getSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

export function setSettings(patch) {
  const merged = { ...getSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}
