// Public: someone on the sign-in page asks for an invitation.
// Saves the request for the owner's Access tab and adds a notification. No login needed.
import { json, accessStore, notify } from "../lib/common.mjs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PENDING = 300;
const clean = (v, n) => String(v || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  // Spam trap: a hidden field people never see. Bots fill it in; pretend it worked.
  if (b.website) return json({ ok: true });

  const email = clean(b.email, 200).toLowerCase();
  if (!EMAIL.test(email)) return json({ error: "Please enter a valid email address." }, 400);
  const name = clean(b.name, 100);
  if (!name) return json({ error: "Please enter your name." }, 400);

  const st = accessStore(true);
  const key = "req:" + email;
  const existing = await st.get(key, { type: "json" });
  if (!existing) {
    const { blobs } = await st.list({ prefix: "req:" });
    if (blobs.length >= MAX_PENDING) return json({ error: "We're not taking new requests right now. Please try again later." }, 429);
  }
  const at = new Date().toISOString();
  const rec = {
    email, name, at,
    phone: clean(b.phone, 40), business: clean(b.business, 120), message: clean(b.message, 500),
    status: existing && existing.status === "invited" ? "invited" : "new",
    invitedAt: existing && existing.invitedAt || null, count: (existing && existing.count || 0) + 1,
  };
  await st.setJSON(key, rec);
  // One notification per person per day, so repeat clicks don't flood the Access tab.
  if (!existing || Date.parse(at) - Date.parse(existing.at) > 864e5) {
    await notify(st, { type: "request", email, msg: `${name}${rec.business ? " (" + rec.business + ")" : ""} asked for an invitation.` });
  }
  return json({ ok: true });
};
