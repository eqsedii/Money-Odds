/**
 * Money Odds — Payment & Unlock Worker
 *
 * Handles the full subscription flow:
 *  1. Frontend collects payment via IntaSend's Inline JS widget (public key only).
 *  2. IntaSend calls POST /webhook server-to-server once payment genuinely completes
 *     (this is the trustworthy source of truth — never trust the browser alone).
 *  3. Frontend polls GET /check-payment?api_ref=... until the webhook has landed.
 *  4. Once unlocked, frontend calls GET /unlocked-picks?token=... to get the real
 *     picks (fetched server-side from the private GitHub repo — never public).
 *  5. GET /restore?phone=... lets a returning subscriber get their token back on
 *     a new device without paying again, as long as their 7 days haven't lapsed.
 *
 * Required Worker secrets (set via Cloudflare dashboard → Settings → Variables):
 *   INTASEND_SECRET_KEY   - IntaSend API secret key (server-side only, never exposed)
 *   GITHUB_TOKEN          - fine-grained PAT, Contents: Read (+Write not needed here)
 *   PRIVATE_REPO          - e.g. "eqsedii/Money-Odds-Private"
 *
 * Required KV binding (Settings → Variables → KV Namespace Bindings):
 *   UNLOCKS               - bind to the money_odds_unlocks namespace
 *
 * Required IntaSend dashboard setup:
 *   Webhooks tab → add a webhook pointing to https://<your-worker>.workers.dev/webhook
 */

const SUBSCRIPTION_DAYS = 7;
const KES_PRICE = 59;
const USD_PRICE = 2;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function normalizePhone(phone) {
  // Normalize to a consistent key format: digits only, Kenyan 07... -> 2547...
  let p = (phone || "").replace(/[^0-9]/g, "");
  if (p.startsWith("0")) p = "254" + p.slice(1);
  return p;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function githubFetch(env, path) {
  const url = `https://api.github.com/repos/${env.PRIVATE_REPO}/contents/${path}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "money-odds-worker",
      Accept: "application/vnd.github.raw+json",
    },
  });
  if (!resp.ok) {
    throw new Error(`GitHub fetch failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------- handlers

async function handleWebhook(request, env) {
  // IntaSend posts payment event data here. We only trust "COMPLETE" states,
  // and only for payments whose api_ref matches our expected format.
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid JSON body" }, 400);
  }

  const state = body.state || body.status;
  const apiRef = body.api_ref || body.invoice?.api_ref;
  const phoneRaw = body.phone_number || body.customer?.phone_number || "";
  const invoiceId = body.invoice_id || body.invoice?.invoice_id || body.id;

  if (!apiRef || !apiRef.startsWith("moneyodds_")) {
    // Not one of ours — ignore quietly, IntaSend may send other event types.
    return json({ ok: true, ignored: true });
  }

  if (state !== "COMPLETE" && state !== "COMPLETED") {
    // Payment pending/failed — record nothing yet.
    return json({ ok: true, state });
  }

  const phone = normalizePhone(phoneRaw);
  const token = randomToken();
  const expiry = Date.now() + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000;

  const record = JSON.stringify({ token, expiry, phone, invoiceId });

  // Store by both phone (for /restore) and api_ref (for /check-payment polling)
  if (phone) {
    await env.UNLOCKS.put(`phone:${phone}`, record, { expirationTtl: SUBSCRIPTION_DAYS * 86400 + 3600 });
  }
  await env.UNLOCKS.put(`ref:${apiRef}`, record, { expirationTtl: 3600 }); // only needed briefly for polling
  await env.UNLOCKS.put(`token:${token}`, record, { expirationTtl: SUBSCRIPTION_DAYS * 86400 + 3600 });

  return json({ ok: true });
}

async function handleCheckPayment(request, env) {
  const { searchParams } = new URL(request.url);
  const apiRef = searchParams.get("api_ref");
  if (!apiRef) return json({ error: "missing api_ref" }, 400);

  const raw = await env.UNLOCKS.get(`ref:${apiRef}`);
  if (!raw) return json({ status: "pending" });

  const data = JSON.parse(raw);
  return json({ status: "complete", token: data.token, expiry: data.expiry });
}

async function handleRestore(request, env) {
  const { searchParams } = new URL(request.url);
  const phone = normalizePhone(searchParams.get("phone"));
  if (!phone) return json({ error: "missing phone" }, 400);

  const raw = await env.UNLOCKS.get(`phone:${phone}`);
  if (!raw) return json({ status: "not_found" });

  const data = JSON.parse(raw);
  if (data.expiry < Date.now()) return json({ status: "expired" });

  return json({ status: "active", token: data.token, expiry: data.expiry });
}

async function handleUnlockedPicks(request, env) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  if (!token) return json({ error: "missing token" }, 400);

  const raw = await env.UNLOCKS.get(`token:${token}`);
  if (!raw) return json({ error: "invalid_or_expired" }, 403);

  const data = JSON.parse(raw);
  if (data.expiry < Date.now()) return json({ error: "expired" }, 403);

  try {
    const privateData = await githubFetch(env, "private_picks.json");
    return json({ ok: true, expiry: data.expiry, data: privateData });
  } catch (e) {
    return json({ error: "could not load pick data", detail: String(e) }, 502);
  }
}

async function handlePricing() {
  return json({ kes: KES_PRICE, usd: USD_PRICE, days: SUBSCRIPTION_DAYS });
}

// ---------------------------------------------------------------- router

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/webhook" && request.method === "POST") {
        return await handleWebhook(request, env);
      }
      if (url.pathname === "/check-payment") {
        return await handleCheckPayment(request, env);
      }
      if (url.pathname === "/restore") {
        return await handleRestore(request, env);
      }
      if (url.pathname === "/unlocked-picks") {
        return await handleUnlockedPicks(request, env);
      }
      if (url.pathname === "/pricing") {
        return await handlePricing();
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "internal error", detail: String(e) }, 500);
    }
  },
};
