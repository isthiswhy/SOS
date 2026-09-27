# DCCS SOS — Web Push setup

Adds real push notifications (alert arrives even if the app/browser tab is
closed) on top of the PWA. This is on top of the iOS PWA build from before —
install that first.

## What was added
- `sw.js` (in the main PWA folder) — now has `push` and `notificationclick`
  handlers that show a system notification and focus/open the app on tap.
- `index.html` — after the person allows Notifications, it subscribes to push
  and sends the subscription to your backend via a new `subscribe` API action.
- `push-worker/` (this folder) — a small Cloudflare Worker that does the actual
  signing + encryption (VAPID/RFC 8292, aes128gcm/RFC 8291) and sends to
  Apple/Google/Mozilla's push service. This step needs real crypto that Google
  Apps Script can't do on its own, which is why it's a separate small Worker
  rather than more Apps Script code.
- `push-worker/Code.gs` — your exact backend (`Code (1).gs`) with the push
  pieces added: a `subscribe` action, a `subscribe_()` handler, and a
  `broadcastPush_()` call inside `trigger_()`. Every addition is marked
  `// ADDED`. Replace your live Code.gs with this file.

## Already generated for you
```
VAPID_PUBLIC_KEY  = BKycqtoGPs8BqJDYA2ORdKZQUxqOfqlcC7XBC_s9vs4yFINQn2YdhmncGLdBuwJ8O4m7Y1amj-xNH5L0HpG5iVk
VAPID_PRIVATE_KEY = MZLUaFZ0hVODR-lJJea2knmGX5z07or-CYpkSjD0URA
```
The public key is already baked into `index.html`. Keep the private key
secret — it's only pasted into the Worker's secrets (step 2 below), never into
any file you'd upload publicly.

## 1. Deploy the push-sender Worker (free Cloudflare account)
```bash
cd push-worker
npm install
npx wrangler login
npx wrangler secret put VAPID_PRIVATE_KEY   # paste MZLUaFZ0hVODR-lJJea2knmGX5z07or-CYpkSjD0URA
npx wrangler secret put PUSH_SECRET         # make up any long random string, e.g. from `openssl rand -hex 32`
npx wrangler deploy
```
This prints your Worker URL, e.g. `https://dccs-sos-push.<you>.workers.dev`.

## 2. Update your Apps Script backend
1. Open your Apps Script project (the one behind your current Server URL).
2. Replace the whole contents of `Code.gs` with `push-worker/Code.gs` from
   this zip (it's your exact file with the push pieces added — search
   `ADDED` to see every change).
3. In `CONFIG.PUSH_WORKER_URL`, paste your real Worker URL from step 1
   (replacing the `<your-subdomain>` placeholder).
4. In the Apps Script editor: Project Settings → Script properties → add
   `PUSH_SECRET` with the same random string you set in step 1
   (`wrangler secret put PUSH_SECRET`) — both sides must match exactly.
5. Deploy → Manage deployments → Edit → New version.

## 3. Test
Open the app on a phone, Add to Home Screen (iOS) or just open it (Android),
allow Notifications, then trigger an alarm from a second device. The first
phone should get a system notification even with the app closed.

## Still true, even with push working
- iOS: push respects the phone's normal sound/silent settings — it cannot
  override silent mode or Do Not Disturb the way a phone-call-style Critical
  Alert can. That still needs a native app with Apple's Critical Alerts
  entitlement.
- The notification tells them to open the app; it doesn't itself keep sharing
  their GPS in the background — that still only happens while the app's open.
- iOS requires the PWA to be installed via Add to Home Screen before push
  will work at all — a plain Safari tab can't subscribe.
