# Webhook integration for external systems

CrowdPay can `POST` JSON payloads to your HTTPS URL when lifecycle events occur. Configure endpoints and signing secrets under **Developer** in the app, or via `POST /api/webhooks` (JWT or API key with `developer` scope).

## Supported events

| Event | When it fires |
|-------|----------------|
| `campaign.funded` | A campaign’s `raised_amount` reaches `target_amount` (detected when a contribution is indexed). |
| `contribution.received` | A new contribution row is created from the ledger monitor. |
| `milestone.approved` | A milestone is approved by the platform operator (`POST /api/milestones/:id/approve`). |
| `withdrawal.completed` | A withdrawal is fully signed and submitted to Stellar (`status` becomes `submitted`). |

Deliveries are attempted immediately and, on failure, retried **up to 5 times** with exponential backoff (1s, 2s, 4s, … capped at 30s). A background poller also picks up due retries every 5 seconds.

## HTTP request

- **Method:** `POST`
- **Body:** UTF-8 JSON (the `payload` object documented per event).
- **Headers:**
  - `Content-Type: application/json`
  - `X-CrowdPay-Event`: event name (e.g. `contribution.received`)
  - `X-CrowdPay-Timestamp`: Unix epoch **seconds** at which the delivery was signed. Reject deliveries whose timestamp is more than **5 minutes** away from your current clock (in either direction).
  - `X-CrowdPay-Delivery-Id`: unique delivery UUID. It is stable across retries of the same delivery — use it for idempotency (store processed ids and ignore duplicates).
  - `X-CrowdPay-Signature`: `sha256=<hex>` where `<hex>` is **HMAC-SHA256** of the string `` `${timestamp}.${rawBody}` `` (the `X-CrowdPay-Timestamp` value, a literal `.`, then the **raw request body bytes**) using your endpoint’s **webhook secret** (shown once when the endpoint is created).

## Replay protection

Every delivery is signed together with its timestamp, so a captured request cannot be replayed indefinitely:

1. **Check the timestamp.** Parse `X-CrowdPay-Timestamp` as epoch seconds and reject the delivery if it is more than 5 minutes in the past or future.
2. **Verify the HMAC.** Recompute the signature over `` `${timestamp}.${rawBody}` `` and compare it in constant time. Because the timestamp is part of the signed payload, an attacker cannot alter it to bypass step 1.
3. **Deduplicate by delivery id.** Keep a record of processed `X-CrowdPay-Delivery-Id` values (e.g. for at least 24 hours) and ignore any delivery you have already handled. Retries of the same delivery reuse the same id.

## Verifying the signature (Node.js)

```javascript
const crypto = require('crypto');

const MAX_SKEW_SECONDS = 5 * 60;

function verifyCrowdPayWebhook(rawBodyBuffer, headers, secret, seenDeliveryIds) {
  const timestamp = headers['x-crowdpay-timestamp'];
  const signatureHeader = headers['x-crowdpay-signature'];
  const deliveryId = headers['x-crowdpay-delivery-id'];

  // 1. Timestamp freshness (±5 minutes).
  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > MAX_SKEW_SECONDS) return false;

  // 2. HMAC over `${timestamp}.${rawBody}`.
  const match = /^sha256=(.+)$/.exec(signatureHeader || '');
  if (!match) return false;
  const signedPayload = Buffer.concat([
    Buffer.from(`${timestamp}.`, 'utf8'),
    rawBodyBuffer,
  ]);
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const provided = Buffer.from(match[1], 'hex');
  if (provided.length !== expected.length / 2) return false;
  if (!crypto.timingSafeEqual(provided, Buffer.from(expected, 'hex'))) return false;

  // 3. Idempotency by delivery id.
  if (!deliveryId || seenDeliveryIds.has(deliveryId)) return false;
  seenDeliveryIds.add(deliveryId);
  return true;
}
```

Use the **raw** body string (before JSON parsing) so the signature matches what CrowdPay signed, and always verify in the order above: timestamp → HMAC → delivery-id deduplication.

## API keys (server-to-server)

Create keys with `POST /api/api-keys`. Send `Authorization: Bearer cp_live_<secret>` on CrowdPay API requests.

**Scopes:**

- `read` — all `GET`/`HEAD` authenticated routes (and public routes stay public).
- `write` — create/update resources except withdrawal **mutations** and developer routes.
- `withdrawals` — withdrawal actions (`POST` under `/api/withdrawals` except pure reads).
- `developer` — manage API keys and webhooks (`/api/api-keys`, `/api/webhooks`).
- `full` — equivalent to all of the above.

Set `API_KEY_PEPPER` in production (falls back to `JWT_SECRET` only for local dev).
