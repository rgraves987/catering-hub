// Receives payment notifications from Stripe, renews the customer's access automatically,
// and adds a notification (with the customer's email) to the owner's Access tab.
// Set STRIPE_WEBHOOK_SECRET in Netlify to the endpoint's signing secret (starts with whsec_).
import crypto from "node:crypto";
import { json, accessStore, extendAccess, notify, dateOfUnix, addDays } from "../lib/common.mjs";

const TOLERANCE_SECONDS = 300;

function verify(raw, header, secret) {
  const parts = {};
  for (const kv of String(header || "").split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) (parts[kv.slice(0, i).trim()] ||= []).push(kv.slice(i + 1).trim());
  }
  const t = parts.t && parts.t[0], sigs = parts.v1 || [];
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(`${t}.${raw}`, "utf8").digest("hex"));
  return sigs.some((s) => { const b = Buffer.from(s); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
}

async function emailFor(st, { ref, customer, fallback }) {
  if (ref) { const u = await st.get("uid:" + ref, { type: "json" }); if (u && u.email) return u.email; }
  if (customer) { const c = await st.get("cus:" + customer, { type: "json" }); if (c && c.email) return c.email; }
  return String(fallback || "").toLowerCase();
}

async function credit(st, email, cents, currency, method, ref, until = "") {
  const amount = (cents || 0) / 100, cur = String(currency || "usd").toUpperCase();
  if (!email) {
    await notify(st, { type: "unmatched", amount, currency: cur, method, ref,
      msg: "Payment received, but it didn't match a customer. Record it by hand on this tab." });
    return;
  }
  if (await st.get("paid:" + ref)) return; // already credited
  const cfg = (await st.get("config", { type: "json" })) || {};
  const rec = await extendAccess(st, email, { days: cfg.defaultDays || 30, amount, currency: cur, method, ref, until });
  await st.setJSON("paid:" + ref, { at: new Date().toISOString() });
  await notify(st, { type: "payment", email, amount, currency: cur, method, ref, through: rec.paidThrough });
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json({ error: "STRIPE_WEBHOOK_SECRET is not set" }, 500);

  const raw = await req.text();
  if (!verify(raw, req.headers.get("stripe-signature"), secret)) return json({ error: "Bad signature" }, 400);

  let ev;
  try { ev = JSON.parse(raw); } catch { return json({ error: "Bad JSON" }, 400); }
  const st = accessStore();
  if (await st.get("evt:" + ev.id)) return json({ received: true, duplicate: true });

  const o = (ev.data && ev.data.object) || {};
  if (ev.type === "checkout.session.completed") {
    const email = await emailFor(st, { ref: o.client_reference_id, customer: o.customer,
      fallback: (o.customer_details && o.customer_details.email) || o.customer_email });
    if (o.customer && email) await st.setJSON("cus:" + o.customer, { email });
    // One-time payment link: credit now. Subscription link: the invoice.paid event credits it.
    if (o.mode === "payment" && o.payment_status === "paid") await credit(st, email, o.amount_total, o.currency, "Stripe", o.id);
  } else if (ev.type === "invoice.paid") {
    const email = await emailFor(st, { customer: o.customer, fallback: o.customer_email });
    // Subscriptions bill by calendar month (28-31 days), so access follows the billing period Stripe reports, plus 1 day of grace.
    const line = o.lines && o.lines.data && o.lines.data[0], end = line && line.period && line.period.end;
    const until = end ? addDays(dateOfUnix(end), 1) : "";
    if ((o.amount_paid || 0) > 0) await credit(st, email, o.amount_paid, o.currency, "Stripe subscription", o.id, until);
  } else if (ev.type === "invoice.payment_failed") {
    const email = await emailFor(st, { customer: o.customer, fallback: o.customer_email });
    await notify(st, { type: "failed", email, amount: (o.amount_due || 0) / 100, currency: String(o.currency || "usd").toUpperCase(),
      method: "Stripe subscription", ref: o.id, msg: "Subscription payment failed. Stripe will retry; access isn't extended until it's paid." });
  } else if (ev.type === "customer.subscription.deleted") {
    const email = await emailFor(st, { customer: o.customer });
    await notify(st, { type: "canceled", email, method: "Stripe subscription", ref: o.id,
      msg: "Subscription canceled. Their access runs to its current end date, then locks." });
  } else if (ev.type === "charge.refunded") {
    const email = await emailFor(st, { customer: o.customer, fallback: o.billing_details && o.billing_details.email });
    await notify(st, { type: "refund", email, amount: (o.amount_refunded || 0) / 100, currency: String(o.currency || "usd").toUpperCase(),
      method: "Stripe", ref: o.id, msg: "Payment refunded. Access wasn't changed; use Lock now or Set if needed." });
  }

  await st.setJSON("evt:" + ev.id, { at: new Date().toISOString(), type: ev.type });
  return json({ received: true });
};
