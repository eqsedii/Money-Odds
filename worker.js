// Money Odds — Cloudflare Worker
// PayHero for M-Pesa payments (both the main 7-day subscription and the
// one-time Exclusive slip), device restore for the main subscription,
// serving unlocked picks, pricing config, and an admin surface for
// managing Exclusive slips (publish, archive, grade) and manually
// unlocking via a pasted M-Pesa SMS.

const SUBSCRIPTION_DAYS = 7;
const KES_PRICE = 59;          // main 7-day subscription
const EXCLUSIVE_PRICE = 99;    // one-time, per VIP Golden Slip
const USD_PRICE = 2;
const MAX_EXCLUSIVE_HISTORY = 200;

// Known bookmaker domains → display name + brand color, for the badges shown
// on the VIP Golden Slip page. Falls back to a prettified bare domain name
// for anything not in this list, so an unrecognized site still shows
// something sensible instead of breaking.
const KNOWN_BOOKMAKERS = {
  "odibets.com": { name: "OdiBets", color: "#0FA958" },
  "betika.com": { name: "Betika", color: "#D0021B" },
  "sportpesa.com": { name: "SportPesa", color: "#00A99D" },
  "1xbet.com": { name: "1xBet", color: "#1E4DB7" },
  "melbet.com": { name: "Melbet", color: "#F5A623" },
  "mozzartbet.co.ke": { name: "Mozzart", color: "#E30613" },
  "betwinner.com": { name: "BetWinner", color: "#00A651" },
};

function detectBookmaker(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const known = KNOWN_BOOKMAKERS[host];
    if (known) return { domain: host, name: known.name, color: known.color };
    const base = host.split(".")[0];
    const name = base.charAt(0).toUpperCase() + base.slice(1);
    return { domain: host, name, color: "#8B92A5" };
  } catch (e) {
    return null;
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function normalizePhone(phone) {
  let p = (phone || "").replace(/[^0-9]/g, "");
  if (p.startsWith("0")) p = "254" + p.slice(1);
  return p;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isAdmin(request, env) {
  const key = request.headers.get("x-admin-key");
  return !!env.ADMIN_API_KEY && key === env.ADMIN_API_KEY;
}

async function githubFetch(env, path) {
  const url = `https://api.github.com/repos/${env.PRIVATE_REPO}/contents/${path}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "money-odds-api-worker",
      Accept: "application/vnd.github.raw+json",
    },
  });
  if (!resp.ok) {
    throw new Error(`GitHub fetch failed ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

// ------------------------------------------------------------- main access

async function handleRestore(request, env) {
  const { searchParams } = new URL(request.url);
  const phone = normalizePhone(searchParams.get("phone"));
  if (!phone) return json({ error: "missing_phone" }, 400);
  const raw = await env.UNLOCKS.get(`phone:${phone}`);
  if (!raw) return json({ status: "not_found" });
  const data = JSON.parse(raw);
  if (data.expiry < Date.now()) return json({ status: "expired" });
  return json({ status: "active", token: data.token, expiry: data.expiry });
}

async function handleUnlockedPicks(request, env) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  if (!token) return json({ error: "missing_token" }, 400);
  const raw = await env.UNLOCKS.get(`token:${token}`);
  if (!raw) return json({ error: "invalid_or_expired" }, 403);
  const data = JSON.parse(raw);
  if (data.expiry < Date.now()) return json({ error: "expired" }, 403);
  try {
    const privateData = await githubFetch(env, "private_picks.json");
    return json({ ok: true, expiry: data.expiry, privateData });
  } catch (e) {
    return json({ error: "could_not_load_pick_data", detail: String(e) }, 502);
  }
}

// ------------------------------------------------------------- Exclusive
//
// KV "exclusive:current"  — the live, purchasable slip (no TTL, overwritten
//                            on publish). Shape:
//   { slip_id, created_at, combined_odds, price,
//     legs: [ { match, league, kickoff, pick, odds } ] }
//
// KV "exclusive:history"  — JSON array, newest first, of past slips, each
//                            with per-leg and overall results once graded:
//   { ...same fields as above, plus per leg "result": "win"|"loss"|null,
//     overall_result: "win"|"loss"|null, graded_at }

async function getCurrentSlip(env) {
  const raw = await env.UNLOCKS.get("exclusive:current");
  return raw ? JSON.parse(raw) : null;
}

async function getExclusiveHistory(env) {
  const raw = await env.UNLOCKS.get("exclusive:history");
  return raw ? JSON.parse(raw) : [];
}

async function saveExclusiveHistory(env, history) {
  await env.UNLOCKS.put("exclusive:history", JSON.stringify(history.slice(0, MAX_EXCLUSIVE_HISTORY)));
}

async function archiveCurrentSlip(env) {
  const current = await getCurrentSlip(env);
  if (!current) return null;
  const history = await getExclusiveHistory(env);
  history.unshift({
    ...current,
    legs: current.legs.map((l) => ({ ...l, result: null })),
    overall_result: null,
    graded_at: null,
  });
  await saveExclusiveHistory(env, history);
  return current;
}

function publicSlipTeaser(slip) {
  if (!slip) return null;
  return {
    slip_id: slip.slip_id,
    created_at: slip.created_at,
    combined_odds: slip.combined_odds,
    price: slip.price,
    leg_count: slip.legs.length,
    legs: slip.legs.map((l) => ({ match: l.match, league: l.league, kickoff: l.kickoff })),
  };
}

async function handleExclusiveCurrent(request, env) {
  const slip = await getCurrentSlip(env);
  return json({ ok: true, slip: publicSlipTeaser(slip) });
}

async function handleExclusiveHistory(request, env) {
  const history = await getExclusiveHistory(env);
  return json({ ok: true, history });
}

// ------------------------------------------------------------- Bookmaker links
//
// Fully independent of match slips — a standing list the admin adds to or
// removes from at any time. KV "exclusive:bookmakers" — JSON array:
//   [ { id, url, domain, name, color, added_at } ]
// Unlocked by the same Ksh 99 payment that unlocks the current match slip
// (see handleExclusiveUnlocked), but otherwise has nothing to do with it —
// no publish/archive/grade lifecycle, just add and remove.

async function getBookmakers(env) {
  const raw = await env.UNLOCKS.get("exclusive:bookmakers");
  return raw ? JSON.parse(raw) : [];
}

async function saveBookmakers(env, list) {
  await env.UNLOCKS.put("exclusive:bookmakers", JSON.stringify(list));
}

async function handleBookmakersCurrent(request, env) {
  const list = await getBookmakers(env);
  return json({ ok: true, bookmakers: list.map((b) => ({ name: b.name, domain: b.domain, color: b.color })) }); // no url pre-payment
}

async function handleAdminBookmakersList(request, env) {
  if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
  const list = await getBookmakers(env);
  return json({ ok: true, bookmakers: list });
}

async function handleAdminBookmakersAdd(request, env) {
  if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json_body" }, 400);
  }
  const url = (body.url || "").trim();
  if (!url) return json({ error: "missing_url" }, 400);

  const detected = detectBookmaker(url);
  if (!detected) return json({ error: "invalid_url" }, 400);

  const list = await getBookmakers(env);
  const normalized = url.toLowerCase();
  if (list.some((b) => b.url.toLowerCase() === normalized)) {
    return json({ error: "duplicate_link", note: "That exact link is already on the list." }, 409);
  }

  const entry = {
    id: `bm_${Date.now()}`,
    url,
    domain: detected.domain,
    name: (body.name || "").trim() || detected.name,
    color: detected.color,
    added_at: new Date().toISOString(),
  };
  list.unshift(entry);
  await saveBookmakers(env, list);
  return json({ ok: true, entry });
}

async function handleAdminBookmakersRemove(request, env) {
  if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json_body" }, 400);
  }
  if (!body.id) return json({ error: "missing_id" }, 400);

  const list = await getBookmakers(env);
  const filtered = list.filter((b) => b.id !== body.id);
  if (filtered.length === list.length) return json({ error: "not_found" }, 404);

  await saveBookmakers(env, filtered);
  return json({ ok: true, removed: body.id });
}

async function handleExclusiveUnlocked(request, env) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  if (!token) return json({ error: "missing_token" }, 400);

  const raw = await env.UNLOCKS.get(`exclusive-token:${token}`);
  if (!raw) return json({ error: "invalid_token" }, 403);
  const data = JSON.parse(raw);

  const slip = await getCurrentSlip(env);
  if (!slip || slip.slip_id !== data.slip_id) {
    return json({ ok: false, expired: true, note: "This slip has been replaced by a newer one — that purchase covered only its own slip." });
  }
  const bookmakers = await getBookmakers(env);
  return json({ ok: true, slip, bookmakers });
}

async function handleExclusiveRestore(request, env) {
  const { searchParams } = new URL(request.url);
  const phone = normalizePhone(searchParams.get("phone"));
  if (!phone) return json({ error: "missing_phone" }, 400);

  const raw = await env.UNLOCKS.get(`exclusive-phone:${phone}`);
  if (!raw) return json({ status: "not_found" });
  const data = JSON.parse(raw);

  const slip = await getCurrentSlip(env);
  if (!slip || slip.slip_id !== data.slip_id) {
    return json({ status: "expired", note: "That purchase was for an earlier slip — it doesn't cover the one currently live." });
  }
  const bookmakers = await getBookmakers(env);
  return json({ ok: true, token: data.token, slip, bookmakers });
}

// ---------------------------------------------------------------- admin

async function handleAdminExclusiveSlip(request, env) {
  if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json_body" }, 400);
  }

  const legs = Array.isArray(body.legs) ? body.legs : [];
  if (!legs.length) return json({ error: "no_legs_provided" }, 400);
  for (const l of legs) {
    if (!l.match || !l.pick) return json({ error: "each_leg_needs_match_and_pick" }, 400);
  }

  // The outgoing slip (if any) is preserved into history before being
  // overwritten, so nothing published is ever silently lost — you grade it
  // whenever the matches actually finish, independent of when you publish
  // the next one.
  await archiveCurrentSlip(env);

  const slip = {
    slip_id: `excl_${Date.now()}`,
    created_at: new Date().toISOString(),
    combined_odds: Number(body.combined_odds) || null,
    price: EXCLUSIVE_PRICE,
    legs: legs.map((l) => ({
      match: l.match,
      league: l.league || "",
      kickoff: l.kickoff || null,
      pick: l.pick,
      odds: l.odds != null ? Number(l.odds) : null,
    })),
  };

  await env.UNLOCKS.put("exclusive:current", JSON.stringify(slip));
  return json({ ok: true, slip_id: slip.slip_id });
}

async function handleAdminExclusiveCurrentFull(request, env) {
  if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
  const slip = await getCurrentSlip(env);
  return json({ ok: true, slip });
}

async function handleAdminExclusiveArchiveCurrent(request, env) {
  if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
  const archived = await archiveCurrentSlip(env);
  if (!archived) return json({ error: "no_active_slip" }, 400);
  await env.UNLOCKS.delete("exclusive:current");
  return json({ ok: true, archived_slip_id: archived.slip_id });
}

async function handleAdminExclusiveGrade(request, env) {
  if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json_body" }, 400);
  }

  if (!body.slip_id) return json({ error: "missing_slip_id" }, 400);

  const history = await getExclusiveHistory(env);
  const idx = history.findIndex((s) => s.slip_id === body.slip_id);
  if (idx === -1) return json({ error: "slip_not_found_in_history", note: "Only archived slips can be graded — publish a new slip or use /admin/exclusive-archive-current first." }, 404);

  const resultMap = {};
  (Array.isArray(body.legs) ? body.legs : []).forEach((l) => {
    resultMap[l.match] = l.result; // expected "win" or "loss"
  });

  history[idx] = {
    ...history[idx],
    legs: history[idx].legs.map((l) => ({ ...l, result: resultMap[l.match] ?? l.result ?? null })),
    overall_result: body.overall_result || null,
    graded_at: new Date().toISOString(),
  };

  await saveExclusiveHistory(env, history);
  return json({ ok: true, slip_id: body.slip_id });
}

async function handleAdminExclusiveHistoryDelete(request, env) {
  if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json_body" }, 400);
  }
  if (!body.slip_id) return json({ error: "missing_slip_id" }, 400);

  const history = await getExclusiveHistory(env);
  const filtered = history.filter((s) => s.slip_id !== body.slip_id);
  if (filtered.length === history.length) return json({ error: "slip_not_found_in_history" }, 404);

  await saveExclusiveHistory(env, filtered);
  return json({ ok: true, deleted: body.slip_id });
}

async function handleAdminExclusiveHistoryRemoveLeg(request, env) {
  if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json_body" }, 400);
  }
  if (!body.slip_id || !body.match) return json({ error: "missing_slip_id_or_match" }, 400);

  const history = await getExclusiveHistory(env);
  const idx = history.findIndex((s) => s.slip_id === body.slip_id);
  if (idx === -1) return json({ error: "slip_not_found_in_history" }, 404);

  const before = history[idx].legs.length;
  history[idx] = {
    ...history[idx],
    legs: history[idx].legs.filter((l) => l.match !== body.match),
  };
  if (history[idx].legs.length === before) return json({ error: "match_not_found_on_slip" }, 404);

  await saveExclusiveHistory(env, history);
  return json({ ok: true, slip_id: body.slip_id, remaining_legs: history[idx].legs.length });
}

// M-Pesa SMS text format, confirmed against a real confirmation message:
//   "UIH7L6RH5L Confirmed. KSH59.00 sent to KCB Paybill AC for account
//    1261386019 on 17/9/26 at 12:00 PM New M-PESA balance is KSH0.00..."
function parseMpesaSms(text) {
  const codeMatch = text.match(/^([A-Z0-9]{8,12})\s+Confirmed/i);
  const amountMatch = text.match(/KSH\s*([\d,]+(?:\.\d{1,2})?)\s+sent/i);
  if (!codeMatch || !amountMatch) return null;
  return {
    transactionCode: codeMatch[1].toUpperCase(),
    amount: parseFloat(amountMatch[1].replace(/,/g, "")),
  };
}

async function handleAdminSmsPaste(request, env) {
  if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json_body" }, 400);
  }

  const text = body.message || "";
  const phoneHint = normalizePhone(body.phone || "");
  if (!text) return json({ error: "missing_message" }, 400);

  const parsed = parseMpesaSms(text);
  if (!parsed) return json({ error: "could_not_parse_message", note: "Paste the exact M-Pesa confirmation text." }, 400);

  const token = randomToken();
  const expiry = Date.now() + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000;

  if (parsed.amount === KES_PRICE) {
    if (!phoneHint) return json({ error: "missing_phone", note: "Main subscription unlock needs the customer's phone number too." }, 400);
    const record = JSON.stringify({ token, expiry, phone: phoneHint, source: "admin-sms-paste", transactionCode: parsed.transactionCode });
    await env.UNLOCKS.put(`phone:${phoneHint}`, record, { expirationTtl: SUBSCRIPTION_DAYS * 86400 + 3600 });
    await env.UNLOCKS.put(`token:${token}`, record, { expirationTtl: SUBSCRIPTION_DAYS * 86400 + 3600 });
    return json({ ok: true, unlocked: "subscription", phone: phoneHint, transactionCode: parsed.transactionCode });
  }

  if (parsed.amount === EXCLUSIVE_PRICE) {
    if (!phoneHint) return json({ error: "missing_phone", note: "VIP Golden Slip unlock needs the customer's phone number too, so they can restore access themselves without a code." }, 400);
    const slip = await getCurrentSlip(env);
    if (!slip) return json({ error: "no_active_slip" }, 400);
    const record = JSON.stringify({ token, slip_id: slip.slip_id, phone: phoneHint, source: "admin-sms-paste", transactionCode: parsed.transactionCode });
    await env.UNLOCKS.put(`exclusive-token:${token}`, record, { expirationTtl: 30 * 86400 });
    await env.UNLOCKS.put(`exclusive-phone:${phoneHint}`, record, { expirationTtl: 30 * 86400 });
    return json({ ok: true, unlocked: "exclusive", slip_id: slip.slip_id, phone: phoneHint, transactionCode: parsed.transactionCode, note: "No code needed — the customer can restore access themselves by entering that phone number on the VIP Golden Slip page." });
  }

  return json({ error: "amount_did_not_match_any_product", amount: parsed.amount, expected: [KES_PRICE, EXCLUSIVE_PRICE] }, 400);
}

// -------------------------------------------------------------------- PayHero
//
// Required secrets (Worker settings → Variables):
//   PAYHERO_AUTH_TOKEN     - exact Authorization header value from your
//                            PayHero dashboard (e.g. "Basic xxxxxxxx...")
//   PAYHERO_CHANNEL_ID     - from PayHero dashboard → Payment Channels
//   PAYHERO_WEBHOOK_SECRET - a long random string YOU generate
//   ADMIN_API_KEY          - a long random string YOU generate, separate
//                            from PAYHERO_WEBHOOK_SECRET, gates every
//                            /admin/* route for the admin panel

function payheroAuthHeader(env) {
  const raw = (env.PAYHERO_AUTH_TOKEN || "").trim();
  return raw.startsWith("Basic") ? raw : `Basic ${raw}`;
}

// Shared finalizers — used by BOTH the webhook (handlePayheroWebhook) and the
// direct-status fallback (handlePayheroCheck), so a payment gets unlocked the
// same way no matter which of the two paths notices it succeeded first.
async function finalizeSubscriptionUnlock(env, pending, { phone, transactionCode, source } = {}) {
  const finalPhone = normalizePhone(phone) || pending.phone;
  const token = randomToken();
  const expiry = Date.now() + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000;
  const record = JSON.stringify({
    token,
    expiry,
    phone: finalPhone,
    name: pending.name,
    source: source || "payhero",
    transactionCode: transactionCode || null,
  });
  await env.UNLOCKS.put(`phone:${finalPhone}`, record, { expirationTtl: SUBSCRIPTION_DAYS * 86400 + 3600 });
  await env.UNLOCKS.put(`token:${token}`, record, { expirationTtl: SUBSCRIPTION_DAYS * 86400 + 3600 });
  return { token, expiry };
}

async function finalizeExclusiveUnlock(env, pending, { phone, transactionCode, source } = {}) {
  const finalPhone = normalizePhone(phone) || pending.phone;
  const token = randomToken();
  const record = JSON.stringify({
    token,
    slip_id: pending.slip_id,
    phone: finalPhone,
    name: pending.name,
    source: source || "payhero",
    transactionCode: transactionCode || null,
  });
  await env.UNLOCKS.put(`exclusive-token:${token}`, record, { expirationTtl: 30 * 86400 });
  if (finalPhone) await env.UNLOCKS.put(`exclusive-phone:${finalPhone}`, record, { expirationTtl: 30 * 86400 });
  return { token };
}

// Direct status pull from PayHero — independent of whether the webhook ever
// reaches us. Used as a fallback by handlePayheroCheck whenever a reference
// is still sitting "pending" so a missed/misconfigured webhook doesn't leave
// the customer stuck waiting for a manual unlock.
async function checkPayheroTransactionStatus(env, reference) {
  const resp = await fetch(
    `https://backend.payhero.co.ke/api/v2/transaction-status?reference=${encodeURIComponent(reference)}`,
    { headers: { Authorization: payheroAuthHeader(env) } }
  );
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data) return null;
  return data; // { success, status: "QUEUED" | "SUCCESS" | "FAILED", reference, CheckoutRequestID }
}

async function handlePayheroInitiate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json_body" }, 400);
  }

  const phone = normalizePhone(body.phone);
  if (!phone) return json({ error: "missing_phone" }, 400);
  const name = (body.name || "").trim() || null;
  const kind = body.kind === "exclusive" ? "exclusive" : "subscription";

  if (!env.PAYHERO_AUTH_TOKEN || !env.PAYHERO_CHANNEL_ID) {
    return json({ error: "server_misconfigured", detail: "PayHero credentials not set" }, 500);
  }
  if (!env.PAYHERO_WEBHOOK_SECRET) {
    return json({ error: "server_misconfigured", detail: "PAYHERO_WEBHOOK_SECRET not set" }, 500);
  }

  let amount = KES_PRICE;
  let slipId = null;
  let desc = "MoneyOdds 7-day access";

  if (kind === "exclusive") {
    const slip = await getCurrentSlip(env);
    if (!slip) return json({ error: "no_active_slip" }, 400);
    amount = EXCLUSIVE_PRICE;
    slipId = slip.slip_id;
    desc = "MoneyOdds Exclusive slip";
  }

  const externalRef = `moneyodds_${Date.now()}`;

  const resp = await fetch("https://backend.payhero.co.ke/api/v2/payments", {
    method: "POST",
    headers: {
      Authorization: payheroAuthHeader(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount,
      phone_number: phone,
      channel_id: Number(env.PAYHERO_CHANNEL_ID),
      provider: "m-pesa",
      external_reference: externalRef,
      customer_name: name || "MoneyOdds customer",
      callback_url: `${new URL(request.url).origin}/payhero-webhook?key=${env.PAYHERO_WEBHOOK_SECRET}`,
    }),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    return json({ error: "payhero_request_failed", detail: data }, 502);
  }

  await env.UNLOCKS.put(
    `payhero-pending:${externalRef}`,
    JSON.stringify({ status: "pending", phone, name, kind, slip_id: slipId, amount }),
    { expirationTtl: 600 }
  );

  return json({ ok: true, externalReference: externalRef });
}

async function handlePayheroWebhook(request, env) {
  const url = new URL(request.url);
  if (!env.PAYHERO_WEBHOOK_SECRET || url.searchParams.get("key") !== env.PAYHERO_WEBHOOK_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json_body" }, 400);
  }

  const r = body.response || {};
  const externalRef = r.ExternalReference;
  if (!externalRef) return json({ ok: true, ignored: true });

  const pendingRaw = await env.UNLOCKS.get(`payhero-pending:${externalRef}`);
  if (!pendingRaw) {
    return json({ error: "no_matching_pending_request" }, 404);
  }
  const pending = JSON.parse(pendingRaw);

  if (r.Status !== "Success" || Number(r.ResultCode) !== 0) {
    await env.UNLOCKS.put(`payhero-pending:${externalRef}`, JSON.stringify({ ...pending, status: "failed" }), { expirationTtl: 600 });
    return json({ ok: true, status: "failed" });
  }

  if (Number(r.Amount) !== Number(pending.amount)) {
    return json({ ok: true, ignored: true, note: "Amount mismatch — not unlocking." });
  }

  const phone = normalizePhone(r.Phone) || pending.phone;

  // The direct-status poll in handlePayheroCheck may have already finalized
  // this same reference (e.g. it noticed success a couple seconds before
  // this webhook arrived) — if so, leave its result alone rather than
  // minting a second token for the same payment.
  const alreadyRaw = await env.UNLOCKS.get(`payhero-pending:${externalRef}`);
  const already = alreadyRaw ? JSON.parse(alreadyRaw) : null;
  if (already && already.status === "complete") {
    return json({ ok: true, unlocked: true, kind: already.kind, already_finalized: true });
  }

  if (pending.kind === "exclusive") {
    const { token } = await finalizeExclusiveUnlock(env, pending, { phone, transactionCode: r.MpesaReceiptNumber, source: "payhero-webhook" });
    await env.UNLOCKS.put(`payhero-pending:${externalRef}`, JSON.stringify({ status: "complete", token, kind: "exclusive", slip_id: pending.slip_id }), { expirationTtl: 600 });
    return json({ ok: true, unlocked: true, kind: "exclusive" });
  }

  const { token, expiry } = await finalizeSubscriptionUnlock(env, pending, { phone, transactionCode: r.MpesaReceiptNumber, source: "payhero-webhook" });
  await env.UNLOCKS.put(`payhero-pending:${externalRef}`, JSON.stringify({ status: "complete", token, expiry, kind: "subscription" }), { expirationTtl: 600 });

  return json({ ok: true, unlocked: true, kind: "subscription" });
}

async function handlePayheroCheck(request, env) {
  const { searchParams } = new URL(request.url);
  const ref = searchParams.get("ref");
  if (!ref) return json({ error: "missing_ref" }, 400);

  const raw = await env.UNLOCKS.get(`payhero-pending:${ref}`);
  if (!raw) return json({ status: "pending" });
  const pending = JSON.parse(raw);

  // Webhook (or an earlier poll) already resolved this one — nothing more to do.
  if (pending.status === "complete" || pending.status === "failed") {
    return json(pending);
  }

  // Still pending — ask PayHero directly instead of only waiting on their
  // webhook, so a missed/misconfigured callback doesn't strand the customer.
  const statusResp = await checkPayheroTransactionStatus(env, ref).catch(() => null);
  if (!statusResp) return json(pending); // couldn't reach PayHero right now — keep polling

  if (statusResp.status === "SUCCESS") {
    let updated;
    if (pending.kind === "exclusive") {
      const { token } = await finalizeExclusiveUnlock(env, pending, { source: "payhero-poll" });
      updated = { status: "complete", token, kind: "exclusive", slip_id: pending.slip_id };
    } else {
      const { token, expiry } = await finalizeSubscriptionUnlock(env, pending, { source: "payhero-poll" });
      updated = { status: "complete", token, expiry, kind: "subscription" };
    }
    await env.UNLOCKS.put(`payhero-pending:${ref}`, JSON.stringify(updated), { expirationTtl: 600 });
    return json(updated);
  }

  if (statusResp.status === "FAILED") {
    const updated = { ...pending, status: "failed" };
    await env.UNLOCKS.put(`payhero-pending:${ref}`, JSON.stringify(updated), { expirationTtl: 600 });
    return json(updated);
  }

  // QUEUED — PayHero hasn't resolved it yet either; keep polling.
  return json(pending);
}

// -------------------------------------------------------------------- Misc

async function handlePricing(env) {
  return json({
    kes: KES_PRICE,
    exclusive_kes: EXCLUSIVE_PRICE,
    usd: USD_PRICE,
    days: SUBSCRIPTION_DAYS,
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === "/payhero-initiate" && request.method === "POST") return await handlePayheroInitiate(request, env);
      if (url.pathname === "/payhero-webhook" && request.method === "POST") return await handlePayheroWebhook(request, env);
      if (url.pathname === "/payhero-check") return await handlePayheroCheck(request, env);
      if (url.pathname === "/restore") return await handleRestore(request, env);
      if (url.pathname === "/unlocked-picks") return await handleUnlockedPicks(request, env);
      if (url.pathname === "/pricing") return await handlePricing(env);

      if (url.pathname === "/exclusive-current") return await handleExclusiveCurrent(request, env);
      if (url.pathname === "/exclusive-history") return await handleExclusiveHistory(request, env);
      if (url.pathname === "/exclusive-unlocked") return await handleExclusiveUnlocked(request, env);
      if (url.pathname === "/exclusive-restore") return await handleExclusiveRestore(request, env);
      if (url.pathname === "/bookmakers-current") return await handleBookmakersCurrent(request, env);

      if (url.pathname === "/admin/exclusive-slip" && request.method === "POST") return await handleAdminExclusiveSlip(request, env);
      if (url.pathname === "/admin/exclusive-current-full") return await handleAdminExclusiveCurrentFull(request, env);
      if (url.pathname === "/admin/exclusive-archive-current" && request.method === "POST") return await handleAdminExclusiveArchiveCurrent(request, env);
      if (url.pathname === "/admin/exclusive-grade" && request.method === "POST") return await handleAdminExclusiveGrade(request, env);
      if (url.pathname === "/admin/exclusive-history-delete" && request.method === "POST") return await handleAdminExclusiveHistoryDelete(request, env);
      if (url.pathname === "/admin/exclusive-history-remove-leg" && request.method === "POST") return await handleAdminExclusiveHistoryRemoveLeg(request, env);
      if (url.pathname === "/admin/bookmakers-list") return await handleAdminBookmakersList(request, env);
      if (url.pathname === "/admin/bookmakers-add" && request.method === "POST") return await handleAdminBookmakersAdd(request, env);
      if (url.pathname === "/admin/bookmakers-remove" && request.method === "POST") return await handleAdminBookmakersRemove(request, env);
      if (url.pathname === "/admin/sms-paste" && request.method === "POST") return await handleAdminSmsPaste(request, env);

      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "internal_error", detail: String(e) }, 500);
    }
  },
};
