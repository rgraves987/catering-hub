// Shared helpers: sign-in check, owner check, and paid-access rules.
import { getStore, connectLambda } from "@netlify/blobs";

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Returns the signed-in Netlify Identity user, or a Response to send back.
// 1) Netlify checks the login token itself and passes the verified user in (clientContext.user).
// 2) If that's missing, ask the site's Identity service directly, using the address Netlify provides.
export async function getUser(req, ctx = {}) {
  const authz = req.headers.get("authorization") || "";
  if (!authz.startsWith("Bearer ")) return json({ error: "Sign in required", detail: "no login token sent" }, 401);
  const cc = (ctx.lambda && ctx.lambda.clientContext) || {};
  if (cc.user && cc.user.sub && cc.user.email) {
    return { id: cc.user.sub, email: String(cc.user.email).toLowerCase() };
  }
  const bases = [];
  if (cc.identity && cc.identity.url) bases.push(cc.identity.url.replace(/\/$/, ""));
  bases.push(`${new URL(req.url).origin}/.netlify/identity`);
  const tried = [];
  for (const base of bases) {
    try {
      const r = await fetch(`${base}/user`, { headers: { authorization: authz } });
      if (r.ok) {
        const u = await r.json();
        if (u && u.id && u.email) return { id: u.id, email: String(u.email).toLowerCase() };
      }
      tried.push(r.status);
    } catch (e) {
      tried.push("unreachable");
    }
  }
  return json({ error: "Sign in required", detail: `login check failed (${tried.join(", ")})` }, 401);
}

// Runs a function in Netlify's classic mode, which is where Netlify verifies Identity logins for us.
export function withNetlify(fn) {
  return async (event, context) => {
    connectLambda(event);
    const h = event.headers || {};
    const url = event.rawUrl || `https://${h.host || "localhost"}${event.path || "/"}`;
    const method = event.httpMethod || "GET";
    const body = method === "GET" || method === "HEAD" ? undefined
      : event.isBase64Encoded ? Buffer.from(event.body || "", "base64") : event.body || "";
    let res;
    try {
      res = await fn(new Request(url, { method, headers: h, body }), { lambda: context });
    } catch (e) {
      console.error(e);
      res = json({ error: "Server error", detail: String((e && e.message) || e).slice(0, 200) }, 500);
    }
    return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
  };
}

// OWNER_EMAILS (Netlify environment variable): your email(s), comma-separated.
// Owners always have access and see the Access tab. If it's empty, paid access is switched off.
export const owners = () =>
  (process.env.OWNER_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
export const isOwner = (email) => owners().includes(String(email || "").toLowerCase());
export const accessOn = () => owners().length > 0;

// Dates are whole days in your time zone (ACCESS_TIMEZONE, default America/Chicago).
const tz = () => process.env.ACCESS_TIMEZONE || "America/Chicago";
export const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: tz() });
export const dateOfUnix = (sec) => new Date(sec * 1000).toLocaleDateString("en-CA", { timeZone: tz() });
export const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && !isNaN(Date.parse(d + "T00:00:00Z"));
export const addDays = (d, n) => {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};
export const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

// Storage. Classic-mode functions (the ones that check logins) can't use Netlify's "strong" reads,
// so every read-then-save goes through update(), which saves only if nobody changed the record in between.
// The Stripe receiver runs in modern mode and also gets fresh reads (strong = true).
export const accessStore = (strong = false) => getStore(strong ? { name: "catering-hub-access", consistency: "strong" } : { name: "catering-hub-access" });
export const dataStore = () => getStore({ name: "catering-hub-data" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read a JSON record, change it with fn, and save it atomically. fn gets the current value (or null)
// and returns the new value, or undefined to leave it as is. Retries if another save got there first.
export async function update(st, key, fn, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const cur = await st.getWithMetadata(key, { type: "json" });
    const next = await fn(cur ? structuredClone(cur.data) : null);
    if (next === undefined) return cur ? cur.data : null;
    const r = cur && cur.etag
      ? await st.setJSON(key, next, { onlyIfMatch: cur.etag })
      : await st.setJSON(key, next, { onlyIfNew: true });
    if (r.modified) return next;
    await sleep(200 * (i + 1));
  }
  throw new Error("Busy: someone else was saving at the same moment. Please try again in a minute.");
}
export const userKey = (email) => "user:" + String(email).toLowerCase();
export const seenKey = (email) => "seen:" + String(email).toLowerCase();
export const trialKey = (email) => "trialused:" + String(email).toLowerCase();
// Free trial for new users, in days (0 = no trial). Set on the Access tab; default 3.
export const trialLength = (cfg) => { const n = Math.round(Number(cfg && cfg.trialDays)); return cfg && cfg.trialDays !== undefined && n >= 0 && n <= 90 ? n : 3; };

// Is this person allowed in right now?
export async function accessStatus(user) {
  const owner = isOwner(user.email);
  if (!accessOn() || owner) return { ok: true, owner };
  const st = accessStore();
  const [rec, cfg, seen] = await Promise.all([
    st.get(userKey(user.email), { type: "json" }),
    st.get("config", { type: "json" }),
    st.get(seenKey(user.email), { type: "json" }),
  ]);
  // Remember when each account was last used (at most once an hour), so you can see it on the Access tab,
  // and which email goes with this account ID, so online payments can be matched to it.
  const now = new Date().toISOString();
  if (!seen || Date.now() - Date.parse(seen.at || 0) > 36e5) {
    await Promise.all([st.setJSON(seenKey(user.email), { at: now }), st.setJSON("uid:" + user.id, { email: user.email })]);
  }
  const pub = publicConfig(cfg);
  let r = rec;
  // First sign-in of a new invited user: start the free trial, once per email address.
  // (Kept even if you later remove their access record, so the trial can't be restarted.)
  if (!r) {
    const trialDays = trialLength(cfg);
    const used = await st.get(trialKey(user.email), { type: "json" });
    if (trialDays > 0 && !used) {
      const through = addDays(todayStr(), trialDays - 1);
      const fresh = { email: user.email, paidThrough: through, created: now, trial: true,
            log: [{ at: now, action: "trial", days: trialDays, through }] };
      const w = await st.setJSON(userKey(user.email), fresh, { onlyIfNew: true });
      if (w.modified) {
        r = fresh;
        await st.setJSON(trialKey(user.email), { at: now, days: trialDays });
        await notify(st, { type: "trial", email: user.email, through,
          msg: `Started a ${trialDays}-day free trial (first sign-in).` });
      } else {
        r = await st.get(userKey(user.email), { type: "json" }); // another request just created it
      }
    }
  }
  const trial = !!(r && r.trial);
  if (!r || !r.paidThrough) return { ok: false, reason: "inactive", ...pub };
  const left = daysBetween(todayStr(), r.paidThrough);
  if (left < 0) return { ok: false, reason: trial ? "trialEnded" : "expired", paidThrough: r.paidThrough, ...pub };
  return { ok: true, owner: false, trial, paidThrough: r.paidThrough, daysLeft: left, ...pub };
}

// Subscription price until you set your own on the Access tab ($10 per 30-day period).
export const DEFAULT_PRICE = 10;

// What customers are allowed to see from your settings.
export const publicConfig = (cfg) => ({
  contact: (cfg && cfg.contact) || "",
  payLink: (cfg && cfg.payLink) || "",
  portalLink: (cfg && cfg.portalLink) || "",
  price: cfg && cfg.price !== undefined ? cfg.price : DEFAULT_PRICE,
});

// Add paid days to an account (used for manual payments and Stripe payments).
// Paid while still active: added to the current end date. Lapsed or new: starts today.
// until: for subscriptions, the paid billing period's end date. Access runs to whichever is later.
export async function extendAccess(st, email, { days, amount = 0, currency = "USD", method = "", note = "", ref = "", until = "" }) {
  email = String(email).toLowerCase();
  const now = new Date().toISOString(), today = todayStr();
  return update(st, userKey(email), (cur) => {
    const rec = cur || { email, paidThrough: null, created: now, log: [] };
    rec.log = rec.log || [];
    rec.trial = false;
    const active = rec.paidThrough && rec.paidThrough >= today;
    let d = days;
    if (until) {
      const before = rec.paidThrough;
      rec.paidThrough = active && before > until ? before : until;
      d = daysBetween(active ? before : addDays(today, -1), rec.paidThrough);
    } else {
      rec.paidThrough = active ? addDays(rec.paidThrough, d) : addDays(today, d - 1);
    }
    rec.log.push({ at: now, action: "payment", days: d, through: rec.paidThrough,
      amount: Math.round(Number(amount || 0) * 100) / 100, currency, method, note, ref });
    rec.log = rec.log.slice(-120);
    return rec;
  });
}

// A notification for your Access tab (payments in, failed payments, cancellations).
export async function notify(st, n) {
  const at = new Date().toISOString();
  await st.setJSON(`note:${at}-${Math.random().toString(36).slice(2, 8)}`, { at, ...n });
}
