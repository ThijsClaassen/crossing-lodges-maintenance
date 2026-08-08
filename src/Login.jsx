import { useState } from 'react'
import { supabase } from './supabaseClient.js'
import { T, css } from './theme.js'
import { LOGO_DATA } from './logo.js'

// Real Supabase Auth login, replacing the old shared staff/admin password
// checked against app_access (2026-08-08 — Maintenance 3b of the
// multi-tenant rebuild). No onLogin callback needed: a successful sign-in
// fires Supabase's own onAuthStateChange event, which App.jsx already
// listens for. Which company/companies the signed-in user can access is
// resolved separately, after login, by CompanyContext.jsx.
export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })

    setLoading(false)

    if (authError) {
      setError(authError.message === 'Invalid login credentials' ? 'Incorrect email or password.' : authError.message)
    }
  }

  return (
    <>
      <style>{css}</style>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: T.bg, padding: 24 }}>
        <img src={LOGO_DATA} alt="Crossing Lodges" style={{ width: 175, filter: 'brightness(0) invert(1) opacity(.9)', marginBottom: 6 }} />
        <div style={{ fontSize: 10, letterSpacing: '.2em', textTransform: 'uppercase', color: T.gold, fontWeight: 600, marginBottom: 6, opacity: 0.8 }}>Maintenance</div>
        <div style={{ fontSize: 11, color: T.muted, marginBottom: 28, letterSpacing: '.05em' }}>Stock Management</div>

        <form onSubmit={handleSubmit} style={{ width: '100%', maxWidth: 320, background: T.panel, border: `1px solid ${T.border}`, borderRadius: 12, padding: 24 }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: T.cream, fontFamily: "'Cormorant Garamond',serif", marginBottom: 16, textAlign: 'center' }}>Sign In</div>

          <div className="field">
            <label>Email</label>
            <input
              type="email"
              autoFocus
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ fontSize: 16 }}
            />
          </div>

          <div className="field">
            <label>Password</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ fontSize: 16 }}
            />
          </div>

          {error && <div style={{ color: T.danger, fontSize: 12, marginBottom: 10, textAlign: 'center' }}>{error}</div>}

          <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: '100%', justifyContent: 'center', padding: 11, fontSize: 14, opacity: loading ? 0.6 : 1 }}>
            {loading ? 'Checking...' : 'Sign In'}
          </button>
        </form>
      </div>
    </>
  )
}
