import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { startOfflineSync } from './offline.js'

// Offline support (2026-08-26): crew work where there's no signal, so the app
// caches what it reads, queues what they write, and uploads it when coverage
// returns. Started before render so a queue left over from a previous session
// begins syncing the moment the app opens.
startOfflineSync()

// Service worker — what actually makes the app openable with no connection.
// Registered after load so it never competes with first paint, and failure is
// non-fatal: without it the app simply behaves as it always did.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed; app will need a connection to open.', err)
    })
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
