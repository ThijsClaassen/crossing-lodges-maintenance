// Purchase slip storage helper — 2026-08-12.
//
// Uploads a slip photo to the shared "purchase-slips" Supabase Storage
// bucket and creates its purchase_slips record (see add_purchase_slips.sql
// in the Ops app folder — that migration is shared across all 4 apps that
// have purchases, run once against the shared project).
//
// Returns the new purchase_slips row, whose `id` is the slip_id to stash on
// whichever maint_purchases row(s) this photo covers — several rows can
// share one slip_id when one slip has several line items, which is exactly
// why this is a separate table rather than an image column per purchase row.
import { supabase } from './supabaseClient.js'
import { sb } from './sb.js'

const APP_NAME = 'maintenance'

export async function uploadPurchaseSlip({ companyId, locationId, blob, supplierGuess, dateGuess, slipTotalGuess }) {
  const path = `${companyId}/${APP_NAME}/${crypto.randomUUID()}.jpg`
  const { error: uploadError } = await supabase.storage
    .from('purchase-slips')
    .upload(path, blob, { contentType: 'image/jpeg', upsert: false })
  if (uploadError) throw new Error(`Could not save the slip photo: ${uploadError.message}`)

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const row = await sb.insert('purchase_slips', {
    company_id: companyId,
    app: APP_NAME,
    location_id: locationId || null,
    storage_path: path,
    supplier_guess: supplierGuess || null,
    date_guess: dateGuess || null,
    slip_total_guess: slipTotalGuess ?? null,
    uploaded_by: user?.id || null,
  })
  return row
}

// A signed, time-limited URL to view an already-uploaded slip — the bucket
// is private, so the object's own storage_path can't be opened directly.
export async function getSlipUrl(storagePath) {
  const { data, error } = await supabase.storage.from('purchase-slips').createSignedUrl(storagePath, 3600)
  if (error) throw new Error(error.message)
  return data.signedUrl
}
