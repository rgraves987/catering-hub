// Owner-only: who has paid access and until when, payment settings, and payment notifications.
// GET  -> the owner gets everything; anyone else gets their own status and their own payment history.
// POST -> owner actions: extend (record a payment), setdate, lock, remove, config, seen.
import { json, getUser, withNetlify, isOwner, accessOn, accessStatus, accessStore, userKey, seenKey,
         todayStr, addDays, isDate, daysBetween, extendAccess, trialLength, DEFAULT_PRICE, update } from "../lib/common.mjs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanUrl = (u) => { u = String(u || "").trim(); return /^https:\/\/[^\s<>"]+$/.test(u) ? u.slice(0, 500) : ""; };

async function listAll() {
  const st = accessStore(), today = todayStr();
  const { blobs } = await st.list();
  const people = {}, notes = [];
  await Promise.all(blobs.map(async ({ key }) => {
    if (key.startsWith("user:")) {
      const r = await st.get(key, { type: "json" });
      if (r) people[r.email] = { ...(people[r.email] || {}), ...r };
    } else if (key.startsWith("seen:")) {
      const s = await st.get(key, { type: "json" }), email = key.slice(5);
      people[email] = { email, ...(people[email] || {}), lastSeen: s && s.at };
    } else if (key.startsWith("note:")) {
      const n = await st.get(key, { type: "json" });
      if (n) notes.push(n);
    }
  }));
  const list = Object.values(people).map((p) => ({
    email: p.email, paidThrough: p.paidThrough || null, lastSeen: p.lastSeen || null,
    log: p.log || [], created: p.created || null, trial: !!p.trial,
    daysLeft: p.paidThrough ? daysBetween(today, p.paidThrough) : null,
  })).sort((a, b) => a.email.localeCompare(b.email));
  const c = (await st.get("config", { type: "json" })) || {};
  notes.sort((a, b) => (a.at < b.at ? 1 : -1));
  return {
    owner: true, accessOn: accessOn(), today, list, notes: notes.slice(0, 100),
    stripeReady: !!process.env.STRIPE_WEBHOOK_SECRET,
    config: { contact: c.contact || "", defaultDays: c.defaultDays || 30, price: c.price !== undefined ? c.price : DEFAULT_PRICE, trialDays: trialLength(c),
              payLink: c.payLink || "", portalLink: c.portalLink || "", lastRead: c.lastRead || "" },
  };
}

const main = async (req, ctx) => {
  const user = await getUser(req, ctx);
  if (user instanceof Response) return user;
  const st = accessStore();

  if (!isOwner(user.email)) {
    if (req.method !== "GET") return json({ error: "Only the owner can change access" }, 403);
    const status = await accessStatus(user);
    const rec = await st.get(userKey(user.email), { type: "json" });
    const payments = ((rec && rec.log) || []).filter((x) => x.action === "payment")
      .map(({ at, amount, currency, method, days }) => ({ at, amount, currency, method, days }));
    return json({ ...status, payments });
  }

  if (req.method === "GET") return json(await listAll());
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let b;
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const today = todayStr(), now = new Date().toISOString();
  const cfg = (await st.get("config", { type: "json" })) || {};

  if (b.action === "config") {
    const days = Math.round(Number(b.defaultDays)), price = b.price === undefined || b.price === "" ? DEFAULT_PRICE : Math.round(Number(b.price) * 100) / 100;
    if (b.payLink && !cleanUrl(b.payLink)) return json({ error: "The payment link must start with https://" }, 400);
    if (b.portalLink && !cleanUrl(b.portalLink)) return json({ error: "The customer portal link must start with https://" }, 400);
    await update(st, "config", (c) => ({ ...(c || {}), contact: String(b.contact || "").slice(0, 300),
      defaultDays: days >= 1 && days <= 3660 ? days : 30, price: price >= 0 ? price : 0,
      payLink: cleanUrl(b.payLink), portalLink: cleanUrl(b.portalLink),
      trialDays: Math.max(0, Math.min(90, Math.round(Number(b.trialDays ?? trialLength(c || {}))) || 0)) }));
    return json(await listAll());
  }
  if (b.action === "seen") {
    await update(st, "config", (c) => ({ ...(c || {}), lastRead: now }));
    return json(await listAll());
  }

  const email = String(b.email || "").trim().toLowerCase();
  if (!EMAIL.test(email)) return json({ error: "Enter a valid email address." }, 400);

  if (b.action === "extend") {
    const days = Math.round(Number(b.days));
    if (!(days >= 1 && days <= 3660)) return json({ error: "Enter a number of days from 1 to 3660." }, 400);
    const amount = b.amount === undefined || b.amount === "" ? (cfg.price !== undefined ? cfg.price : DEFAULT_PRICE) : Number(b.amount);
    if (!(amount >= 0)) return json({ error: "Enter an amount of $0 or more." }, 400);
    await extendAccess(st, email, { days, amount, method: String(b.method || "").slice(0, 40), note: String(b.note || "").slice(0, 200) });
    return json(await listAll());
  }

  const note = String(b.note || "").slice(0, 200);
  if (b.action === "remove") {
    await Promise.all([st.delete(userKey(email)), st.delete(seenKey(email))]);
    return json(await listAll());
  }
  if (b.action !== "setdate" && b.action !== "lock") return json({ error: "Unknown action" }, 400);
  if (b.action === "setdate" && !isDate(b.date)) return json({ error: "Pick a date." }, 400);
  await update(st, userKey(email), (cur) => {
    const rec = cur || { email, paidThrough: null, created: now, log: [] };
    rec.log = rec.log || [];
    rec.trial = false;
    if (b.action === "setdate") {
      rec.paidThrough = b.date;
      rec.log.push({ at: now, action: "set date", through: b.date, note });
    } else {
      rec.paidThrough = addDays(today, -1);
      rec.log.push({ at: now, action: "locked", through: rec.paidThrough, note });
    }
    rec.log = rec.log.slice(-120);
    return rec;
  });
  return json(await listAll());
};

export const handler = withNetlify(async (req, ctx) => {
  try { return await main(req, ctx); }
  catch (e) { if (String(e.message || "").startsWith("Busy")) return json({ error: e.message }, 409); throw e; }
});
