// DCCS SOS - push-sender Worker
//
// Your Apps Script backend calls POST /broadcast (server-to-server, with the
// PUSH_SECRET bearer token) whenever an alarm fires. This Worker signs a VAPID
// JWT and encrypts the payload per RFC 8291/8292 using Web Crypto (works on
// Workers, unlike the Node "web-push" package) and forwards it to each
// subscriber's push service (Apple/Google/Mozilla's endpoint - never your
// server), where it turns into a real iOS/Android notification.
//
// Deploy: see README.md in this folder.

import { buildPushPayload } from '@block65/webcrypto-web-push';

function unauthorized() {
  return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'dccs-sos-push' });
    }

    if (request.method !== 'POST' || url.pathname !== '/broadcast') {
      return json({ ok: false, error: 'not_found' }, 404);
    }

    // Simple shared-secret auth - only your Apps Script backend should call this.
    const auth = request.headers.get('authorization') || '';
    if (auth !== `Bearer ${env.PUSH_SECRET}`) return unauthorized();

    let body;
    try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }

    const { subscriptions, title, message, tag, url: clickUrl } = body || {};
    if (!Array.isArray(subscriptions) || !subscriptions.length) {
      return json({ ok: false, error: 'no_subscriptions' }, 400);
    }

    const vapid = {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY
    };

    const pushMessage = {
      data: JSON.stringify({
        title: title || 'DCCS SOS',
        body: message || 'Someone in your network needs help.',
        tag: tag || 'dccs-sos-alarm',
        url: clickUrl || './'
      }),
      options: { ttl: 60 }
    };

    const expired = [];
    const errors = [];
    let sent = 0;

    await Promise.all(subscriptions.map(async (sub) => {
      try {
        const payload = await buildPushPayload(pushMessage, sub, vapid);
        const res = await fetch(sub.endpoint, payload);
        if (res.status === 201 || res.status === 200) {
          sent++;
        } else if (res.status === 404 || res.status === 410) {
          // Subscription is gone (app uninstalled, permission revoked, etc.) - tell
          // the caller so it can stop trying to push to this endpoint.
          expired.push(sub.endpoint);
        } else {
          errors.push({ endpoint: sub.endpoint, status: res.status });
        }
      } catch (e) {
        errors.push({ endpoint: sub.endpoint, error: String(e) });
      }
    }));

    return json({ ok: true, sent, expired, errors });
  }
};
