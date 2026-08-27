// Lightweight Supabase REST wrapper — same pattern as crossing-lodges-food,
// crossing-lodges-HR-Linen, and crossing-lodges-ops (small bundle, no SDK
// version dependency, plain fetch calls against PostgREST). Extracted out
// of App.jsx during the multi-tenant rebuild (2026-08-08), same reason as
// Ops's: keeps Login.jsx/SetPassword.jsx/CompanyContext.jsx from needing a
// circular import back into App.jsx.
//
// Points at the SAME Supabase project as Finance Dashboard/Food Stock/
// HR-Linen/Ops so they all share one database.
//
// Note this app's select() takes a raw PostgREST filter STRING (e.g.
// "role=eq.admin"), not a filters object — same convention as Ops's sb.js,
// kept as-is rather than changed to avoid rewriting every call site.
//
// Made session-aware 2026-08-08 (Maintenance 3b of the multi-tenant
// rebuild): headers() now reads the real Supabase Auth session and sends
// the user's own access token instead of only the anon key, so RLS's
// auth.uid() resolves to the logged-in user rather than nobody. Every call
// site was grepped and updated to `await headers()` from the start — see
// [[feedback-git-and-async-gotchas]] for why that matters.

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient.js'
import {
  cacheSelect,
  readCachedSelect,
  enqueue,
  listQueue,
  applyQueueToRows,
  isNetworkFailure,
  registerReplayer,
} from './offline.js'

const SB_URL = SUPABASE_URL

// Last token we successfully saw, kept in memory as an offline fallback.
// getSession() reads localStorage, but if the access token has expired it
// tries to refresh — which needs the network. Offline that throws, and
// without this fallback every queued write would fail to even build its
// headers. The token it falls back on may well be stale; that's fine, since
// the request it's attached to is about to fail on the network anyway and
// get queued. What matters is that header-building never throws.
let lastKnownToken = null

async function headers(extra = {}) {
  let token = lastKnownToken
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (session?.access_token) {
      token = session.access_token
      lastKnownToken = token
    }
  } catch {
    // Offline, or refresh failed — fall through to lastKnownToken.
  }
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...extra,
  }
}

// Transient clock-skew retry (2026-08-26).
//
// Supabase sometimes rejects a perfectly valid token with PGRST303 ("JWT
// issued at future"): its Auth service mints the token using one node's
// clock, PostgREST validates it against another, and if Auth is a second or
// two ahead the token looks like it hasn't been issued yet. It's transient,
// server-side, and nothing to do with this app or the user's device — the
// same request succeeds moments later.
//
// So: retry once after a short pause, then let the error surface normally.
// Deliberately NOT "fixed" by adding clock leeway or skipping iat
// verification — that's a real signature check, and weakening it to paper
// over infrastructure drift would weaken auth for every user. If this starts
// happening a lot, the actual fix is a Supabase support ticket, not more
// retries here.
const CLOCK_SKEW_RETRY_MS = 1500

async function isClockSkewError(res) {
  if (res.ok) return false
  try {
    const body = await res.clone().text()
    return body.includes('PGRST303') || body.includes('JWT issued at future')
  } catch {
    return false
  }
}

// buildInit is a function, not an object, so the retry rebuilds its headers
// and picks up a refreshed access token if the client rotated one meanwhile.
async function sbFetch(url, buildInit) {
  let res = await fetch(url, await buildInit())
  if (await isClockSkewError(res)) {
    await new Promise((r) => setTimeout(r, CLOCK_SKEW_RETRY_MS))
    res = await fetch(url, await buildInit())
  }
  return res
}

// --- Offline layer (2026-08-26) -------------------------------------------
//
// Crew work where there's no signal. Reads fall back to a local cache, writes
// fall into a durable queue that uploads itself once coverage returns. See
// offline.js for the full reasoning; the important part here is that ONLINE
// BEHAVIOUR IS UNCHANGED — same requests, same return values, same thrown
// errors. The offline paths only engage when a request fails for network
// reasons, so nothing about the normal case got slower or looser.

// Turns a non-ok response into the same Error shape as before, but tagged so
// offline.js can tell "the server said no" apart from "there was no network".
async function httpError(res) {
  const err = new Error(await res.text())
  err.__httpStatus = res.status
  return err
}

async function runRequest(url, buildInit) {
  const res = await sbFetch(url, buildInit)
  if (!res.ok) throw await httpError(res)
  return res
}

// offline.js replays queue entries through this, so it never needs to know
// about auth headers or the Supabase URL.
registerReplayer(async (entry) => {
  const { table, op, payload, matchId } = entry
  if (op === 'insert' || op === 'upsert') {
    // Replayed as upsert-on-id: if the app died between the server accepting
    // this and the queue entry being cleared, replaying must not duplicate
    // it. Safe because every row here carries a client-generated id.
    const onConflict = entry.onConflict || 'id'
    await runRequest(`${SB_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, async () => ({
      method: 'POST',
      headers: await headers({ Prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify(payload),
    }))
  } else if (op === 'update') {
    await runRequest(`${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(matchId)}`, async () => ({
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify(payload),
    }))
  } else if (op === 'delete') {
    await runRequest(`${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(matchId)}`, async () => ({
      method: 'DELETE',
      headers: await headers(),
    }))
  }
})

export const sb = {
  async select(t, f = '') {
    const url = `${SB_URL}/rest/v1/${t}?${f}&order=created_at.asc`
    try {
      const r = await runRequest(url, async () => ({ headers: await headers() }))
      const rows = await r.json()
      cacheSelect(url, rows) // fire-and-forget; caching must never delay a read
      // Even online, anything still queued hasn't reached the server yet, so
      // fold it in — otherwise a row the user just added would disappear on
      // the next refresh while its upload is still in flight.
      const queue = await listQueue()
      return queue.length ? applyQueueToRows(t, url, rows, queue) : rows
    } catch (err) {
      if (!isNetworkFailure(err)) throw err
      const cached = await readCachedSelect(url)
      if (cached == null) {
        // Never cached this query while online, so there's genuinely nothing
        // to show. An empty list is the honest answer — better than an error
        // that makes the whole screen fail.
        const queue = await listQueue()
        return applyQueueToRows(t, url, [], queue)
      }
      const queue = await listQueue()
      return applyQueueToRows(t, url, cached, queue)
    }
  },

  async insert(t, row) {
    const url = `${SB_URL}/rest/v1/${t}`
    try {
      const r = await runRequest(url, async () => ({
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify(row),
      }))
      const d = await r.json()
      return Array.isArray(d) ? d[0] : d
    } catch (err) {
      if (!isNetworkFailure(err)) throw err
      await enqueue({ table: t, op: 'insert', payload: row })
      // Callers use the returned row (4 places do). Every row already carries
      // its own client-generated id, so handing back what we were given is
      // exactly what the server would have echoed.
      return Array.isArray(row) ? row[0] : row
    }
  },

  async update(t, id, patch) {
    const url = `${SB_URL}/rest/v1/${t}?id=eq.${encodeURIComponent(id)}`
    try {
      await runRequest(url, async () => ({
        method: 'PATCH',
        headers: await headers(),
        body: JSON.stringify(patch),
      }))
    } catch (err) {
      if (!isNetworkFailure(err)) throw err
      await enqueue({ table: t, op: 'update', matchId: id, payload: patch })
    }
  },

  async delete(t, id) {
    const url = `${SB_URL}/rest/v1/${t}?id=eq.${encodeURIComponent(id)}`
    try {
      await runRequest(url, async () => ({
        method: 'DELETE',
        headers: await headers(),
      }))
    } catch (err) {
      if (!isNetworkFailure(err)) throw err
      await enqueue({ table: t, op: 'delete', matchId: id })
    }
  },
}

// Lodges for the current company. Loaded from the shared `locations` table
// at login (see CompanyContext.jsx) instead of being hardcoded, so a second
// company's own lodges work without a code change (2026-08-26).
//
// Deliberately a MUTABLE module array rather than React state: this app
// already reads LOCATIONS synchronously in a number of places, some outside
// components, and converting every one to a hook would be a large change for
// no visible benefit today. CompanyContext fills this in BEFORE it renders
// any children, and refills it on company switch, so by the time anything
// reads it, it's correct. The array identity never changes — contents are
// replaced in place — so existing dependency arrays keep behaving as before.
export const LOCATIONS = []

// Only 'lodge' rows: the shared locations table also holds an 'overhead'
// (head office) row that the Finance Dashboard uses for non-lodge costs and
// that this app has never shown. Ordering is by created_at, not id, because
// the established display order is ZC, EC, SC — which alphabetical order
// would reshuffle to EC, SC, ZC.
export function setLocations(rows) {
  LOCATIONS.length = 0
  for (const r of rows || []) {
    if (r.type && r.type !== 'lodge') continue
    LOCATIONS.push({ id: r.id, name: r.name, type: r.type ?? null })
  }
  refreshLocColors()
}

// Per-lodge accent colours. Previously a hardcoded { ZC: ..., EC: ..., SC: ... }
// map; now assigned by position from a fixed palette so any lodge list works.
// The first three palette entries are the exact colours ZC/EC/SC have always
// had, and setLocations preserves their order, so nothing changes visually.
const LOC_PALETTE = ['#B8935A', '#5B8CC4', '#7BAE7F', '#C4795B', '#8C7BC4', '#C4B45B', '#5BC4B4']


export const LOC_COLORS = {}

function refreshLocColors() {
  for (const k of Object.keys(LOC_COLORS)) delete LOC_COLORS[k]
  LOCATIONS.forEach((l, i) => {
    LOC_COLORS[l.id] = LOC_PALETTE[i % LOC_PALETTE.length]
  })
}
