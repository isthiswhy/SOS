# DCCS SOS — iOS PWA build

This turns your existing web UI into an installable iPhone "app" (Add to Home
Screen), no App Store and no Mac needed. It works back to iOS 11.3+ Safari.

## Files
- `index.html` — your original app, with PWA meta tags + manifest link + service worker added
- `manifest.webmanifest` — app name, icons, standalone display mode
- `sw.js` — service worker; caches only the local app shell (index.html, icons)
  so the app opens fast/offline. It never touches your Apps Script API calls,
  Google Fonts, Tailwind, or Leaflet/map tiles — those always hit the network.
- `icons/` — generated app icons matching your red/dark theme

## How to install on iPhone (2 steps)
1. **Host these files somewhere with HTTPS.** iOS will not let you "Add to
   Home Screen" as a real app from `file://` or plain HTTP. Easiest free
   options:
   - **GitHub Pages** — push this folder to a repo, enable Pages in repo
     Settings, done.
   - **Netlify / Vercel** — drag-and-drop the folder in their dashboard.
   - Or your own server/subdomain if you already have hosting.
2. On the iPhone, open the hosted URL in **Safari** (must be Safari, not
   Chrome), tap the Share icon → **Add to Home Screen**. It now launches
   full-screen with your SOS icon, no browser bar.

## Important — please read before relying on this for real emergencies
Your Android build has a native foreground service (`SosService.kt`) that
keeps GPS updating, polls the server, and rings the siren **even when the
phone is locked or the app is closed**, and it can bypass silent/DND.

**iOS Safari does not allow that for web apps**, PWA or not. Concretely:
- The app only runs — polls for alerts, updates your location, plays the
  siren — **while it's open and on screen**. Lock the phone or switch apps
  and iOS suspends it within seconds.
- It cannot ring through silent mode or Do Not Disturb like a real iOS
  notification/alarm can.
- Live camera streaming stops the moment the app is backgrounded.

So on iPhone, this PWA works great for: opening the app and hitting the SOS
button, watching the map and chat while the app is open, and testing/setup.
It will **not** reliably wake someone up or keep broadcasting location if
they've locked their phone and put it in their pocket — which, for an
emergency alarm app, is a real gap.

**If always-on background alerting on iOS matters to you**, the only way to
get real parity with the Android service is a native iOS app using
Apple's Critical Alerts / VoIP push / Live Activities entitlements — that
needs Xcode, an Apple Developer account, and Apple's approval for the
Critical Alerts capability. That's a separate, larger build — let me know if
you want to go that route and I can help scope it.

## Push notifications
This build now also supports real push notifications (alert arrives even with
the app closed, on both iOS and Android) — see `push-worker/README.md` for
setup. It still can't bypass silent mode/DND on iOS; only a native app with
Apple's Critical Alerts entitlement can do that.
