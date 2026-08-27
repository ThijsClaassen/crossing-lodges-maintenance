// Offline support: local cache + write queue + auto-sync (2026-08-26).
//
// Why this exists: crew work at places with no signal. They need to open the
// app, log what they did, and have it upload itself once they're back in
// coverage — without thinking about any of it.
//
// This app was a good candidate because every insert already generates its
// own row id client-side (`id: uid()`), so a queued write doesn't need a
// server round-trip to know what it created, and the four places that read
// an insert's return value only read back the row they just built.
//
// ---------------------------------------------------------------------------
// HOW IT WORKS
//
//   Reads   Every successful select is cached in IndexedDB keyed by its exact
//           request URL. Offline, the select is served from that cache, with
//           anything still sitting in the write queue applied on top — so work
//           logged offline is still visible after closing and reopening the
//           app, rather than seeming to vanish until sync.
//
//   Writes  Attempted normally when online. If the attempt fails because the
//           NETWORK failed (not because the server said no), the write is
//           appended to a durable queue and reported to the caller as success,
//           so the UI carries on exactly as it does online.
//
//   Sync    The queue is replayed oldest-first whenever the browser regains
//           connectivity, on app start, and on a slow timer. Strict FIFO
//           matters: it's what keeps a job card ahead of its own materials
//           rows, without this module needing to know anything about foreign
//           keys.
//
// ---------------------------------------------------------------------------
// DELIBERATE DECISIONS, AND THEIR LIMITS
//
//   * Only NETWORK failures queue. A 4xx/5xx is the server giving a real
//     answer — an RLS refusal, a constraint violation — and quietly retrying
//     that forever would turn a clear error into a silent one. Those still
//     throw, exactly as before.
//
//   * Replayed inserts go up as upsert-on-id. If the app dies between the
//     server accepting a write and the queue entry being removed, the replay
//     would otherwise insert it twice. Client-generated ids make this safe.
//
//   * Last-write-wins on conflicts. Two people editing the same row offline
//     means the later sync overwrites the earlier one, silently. For this
//     app's traffic — mostly new job cards, issues and progress logs, rarely
//     two people editing one row — that's an acceptable trade, but it IS a
//     trade and worth revisiting if it ever bites.
//
//   * Offline filtering understands `col=eq.value` only. That covers every
//     query these apps actually make (company_id, location_id, period). A
//     more exotic filter falls back to returning cached rows unfiltered
//     rather than guessing — over-showing beats losing someone's work.
//
//   * Not covered: slip photo upload (Supabase Storage, separate path), slip
//     scanning (calls the Claude API), and Yoco sync (reads live POS data).
//     All three genuinely need a connection. The app's manual-attach fallback
//     already covers the slip case.

const DB_NAME = 'cl-maintenance-offline'
const DB_VERSION = 1
const CACHE_STORE = 'select_cache'
const QUEUE_STORE = 'write_queue'

// ---------------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------------

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: 'url' })
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        // seq is the queue's ordering guarantee — see FIFO note above.
        db.createObjectStore(QUEUE_STORE, { keyPath: 'seq', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function tx(store, mode, fn) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const s = t.objectStore(store)
    let out
    try {
      out = fn(s)
    } catch (e) {
      reject(e)
      return
    }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// ---------------------------------------------------------------------------
// Select cache
// ---------------------------------------------------------------------------

export async function cacheSelect(url, rows) {
  try {
    await tx(CACHE_STORE, 'readwrite', (s) => s.put({ url, rows, at: Date.now() }))
  } catch {
    // A full or unavailable IndexedDB must never break a working online app.
  }
}

export async function readCachedSelect(url) {
  try {
    const db = await openDb()
    const t = db.transaction(CACHE_STORE, 'readonly')
    const rec = await reqAsPromise(t.objectStore(CACHE_STORE).get(url))
    return rec ? rec.rows : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Write queue
// ---------------------------------------------------------------------------

export async function enqueue(entry) {
  const rec = { ...entry, at: Date.now(), tries: 0, lastError: null }
  await tx(QUEUE_STORE, 'readwrite', (s) => s.add(rec))
  notify()
}

export async function listQueue() {
  try {
    const db = await openDb()
    const t = db.transaction(QUEUE_STORE, 'readonly')
    const rows = await reqAsPromise(t.objectStore(QUEUE_STORE).getAll())
    return (rows || []).sort((a, b) => a.seq - b.seq)
  } catch {
    return []
  }
}

async function removeFromQueue(seq) {
  await tx(QUEUE_STORE, 'readwrite', (s) => s.delete(seq))
}

async function markFailed(seq, message) {
  const db = await openDb()
  const t = db.transaction(QUEUE_STORE, 'readwrite')
  const store = t.objectStore(QUEUE_STORE)
  const rec = await reqAsPromise(store.get(seq))
  if (rec) {
    rec.tries = (rec.tries || 0) + 1
    rec.lastError = message
    store.put(rec)
  }
}

export async function pendingCount() {
  return (await listQueue()).length
}

// Entries the server rejected outright (not a network problem). They stay in
// the queue so nothing is lost silently, but they're never retried blindly —
// a person has to look at them.
export async function listRejected() {
  return (await listQueue()).filter((e) => e.rejected)
}

export async function discardEntry(seq) {
  await removeFromQueue(seq)
  notify()
}

// ---------------------------------------------------------------------------
// Subscribers (the status pill in the header watches this)
// ---------------------------------------------------------------------------

const listeners = new Set()
let syncing = false

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

async function notify() {
  const queue = await listQueue()
  const state = {
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    syncing,
    pending: queue.filter((e) => !e.rejected).length,
    rejected: queue.filter((e) => e.rejected).length,
  }
  for (const fn of listeners) {
    try {
      fn(state)
    } catch {
      /* a broken subscriber must not stop the others */
    }
  }
}

export function offlineState() {
  return {
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    syncing,
  }
}

// ---------------------------------------------------------------------------
// Applying queued writes on top of cached reads
// ---------------------------------------------------------------------------

// Understands `col=eq.value` only — see the note at the top of this file.
function parseEqFilters(url) {
  const qi = url.indexOf('?')
  if (qi < 0) return { filters: {}, exact: true }
  const filters = {}
  let exact = true
  for (const part of url.slice(qi + 1).split('&')) {
    if (!part) continue
    const [rawKey, rawVal] = part.split('=')
    const key = decodeURIComponent(rawKey || '')
    const val = decodeURIComponent(rawVal || '')
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue
    if (val.startsWith('eq.')) filters[key] = val.slice(3)
    else exact = false
  }
  return { filters, exact }
}

function rowMatches(row, filters) {
  for (const [k, v] of Object.entries(filters)) {
    if (row[k] === undefined) return false
    if (String(row[k]) !== String(v)) return false
  }
  return true
}

// Rebuilds what a table would look like if the queue had already been applied.
export function applyQueueToRows(table, url, rows, queue) {
  const { filters, exact } = parseEqFilters(url)
  let out = Array.isArray(rows) ? [...rows] : []

  for (const entry of queue) {
    if (entry.table !== table || entry.rejected) continue

    if (entry.op === 'insert') {
      const payloads = Array.isArray(entry.payload) ? entry.payload : [entry.payload]
      for (const p of payloads) {
        if (exact && !rowMatches(p, filters)) continue
        if (p.id && out.some((r) => r.id === p.id)) continue
        out.push(p)
      }
    } else if (entry.op === 'update') {
      out = out.map((r) => (entry.matchId && r.id === entry.matchId ? { ...r, ...entry.payload } : r))
    } else if (entry.op === 'delete') {
      out = out.filter((r) => !(entry.matchId && r.id === entry.matchId))
    } else if (entry.op === 'upsert') {
      const payloads = Array.isArray(entry.payload) ? entry.payload : [entry.payload]
      for (const p of payloads) {
        if (exact && !rowMatches(p, filters)) continue
        const i = out.findIndex((r) => r.id && p.id && r.id === p.id)
        if (i >= 0) out[i] = { ...out[i], ...p }
        else out.push(p)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

// Is this a "the network didn't work" failure, as opposed to the server
// answering with an error? fetch() rejects with a TypeError for DNS/offline/
// CORS-preflight failures; anything that produced a real HTTP status is not.
export function isNetworkFailure(err) {
  if (!err) return false
  if (err.__httpStatus) return false
  return err instanceof TypeError || /network|failed to fetch|load failed/i.test(err.message || '')
}

let replayFn = null

// sb.js injects the raw request runner here, so this module never has to know
// about auth headers or Supabase URLs.
export function registerReplayer(fn) {
  replayFn = fn
}

export async function syncNow() {
  if (syncing || !replayFn) return { synced: 0, failed: 0, stopped: false }
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { synced: 0, failed: 0, stopped: true }

  syncing = true
  await notify()
  let synced = 0
  let failed = 0
  let stopped = false

  try {
    const queue = await listQueue()
    for (const entry of queue) {
      if (entry.rejected) continue
      try {
        await replayFn(entry)
        await removeFromQueue(entry.seq)
        synced++
      } catch (err) {
        if (isNetworkFailure(err)) {
          // Signal died again. Stop here rather than skipping ahead — order
          // is the only thing protecting foreign-key dependencies.
          stopped = true
          break
        }
        // A real rejection from the server. Flag it and move on; it stays in
        // the queue for a person to look at rather than blocking everything
        // behind it forever.
        await markRejected(entry.seq, err.message || String(err))
        failed++
      }
    }
  } finally {
    syncing = false
    await notify()
  }
  return { synced, failed, stopped }
}

async function markRejected(seq, message) {
  const db = await openDb()
  const t = db.transaction(QUEUE_STORE, 'readwrite')
  const store = t.objectStore(QUEUE_STORE)
  const rec = await reqAsPromise(store.get(seq))
  if (rec) {
    rec.rejected = true
    rec.lastError = message
    rec.tries = (rec.tries || 0) + 1
    store.put(rec)
  }
}

// Retry something previously rejected — after, say, fixing the underlying
// data problem. Clears the flag so the next sync picks it up again.
export async function retryRejected(seq) {
  const db = await openDb()
  const t = db.transaction(QUEUE_STORE, 'readwrite')
  const store = t.objectStore(QUEUE_STORE)
  const rec = await reqAsPromise(store.get(seq))
  if (rec) {
    rec.rejected = false
    rec.lastError = null
    store.put(rec)
  }
  await notify()
  return syncNow()
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let started = false

export function startOfflineSync() {
  if (started || typeof window === 'undefined') return
  started = true

  window.addEventListener('online', () => {
    notify()
    syncNow()
  })
  window.addEventListener('offline', () => notify())

  // Belt and braces: navigator.onLine lies on captive portals and some
  // Android builds, so also try on a slow timer and when the tab is refocused.
  setInterval(() => {
    if (navigator.onLine) syncNow()
  }, 60000)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.onLine) syncNow()
  })

  notify()
  syncNow()
}
