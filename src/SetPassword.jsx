import { useState } from 'react'
import { supabase } from './supabaseClient.js'
import { T, css } from './theme.js'

// Shown once, right after someone lands back in the app from an invite or
// password-reset email link — same component/purpose as the other apps'
// (2026-08-08). Without this, a freshly-invited user would land on the app
// with a valid session but no password they could actually log back in
// with next time.
export default function SetPassword({ onDone }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    if (password.length < 8) {
      setError('Use at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }

    setSaving(true)
    const { error: updateErr } = await supabase.auth.updateUser({ password })
    setSaving(false)

    if (updateErr) {
      setError(updateErr.message)
      return
    }

    onDone()
  }

  return (
    <>
      <style>{css}</style>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: T.bg, padding: 24 }}>
        <form onSubmit={handleSubmit} style={{ width: '100%', maxWidth: 320, background: T.panel, border: `1px solid ${T.border}`, borderRadius: 12, padding: 24 }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: T.cream, fontFamily: "'Cormorant Garamond',serif", marginBottom: 8, textAlign: 'center' }}>Set your password</div>
          <div style={{ fontSize: 12, color: T.muted, marginBottom: 18, textAlign: 'center' }}>Choose a password for your account — you'll use this to log in from now on.</div>

          <div className="field">
            <input
              type="password"
              placeholder="New password"
              autoFocus
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ fontSize: 16 }}
            />
          </div>
          <div className="field">
            <input
              type="password"
              placeholder="Confirm password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              style={{ fontSize: 16 }}
            />
          </div>

          {error && <div style={{ color: T.danger, fontSize: 12, marginBottom: 10, textAlign: 'center' }}>{error}</div>}

          <button type="submit" className="btn btn-primary" disabled={saving} style={{ width: '100%', justifyContent: 'center', padding: 11, fontSize: 14, opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving...' : 'Set password and continue'}
          </button>
        </form>
      </div>
    </>
  )
}
