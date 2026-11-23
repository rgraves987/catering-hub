// Saves and loads each signed-in person's Catering Hub data (jobs, payments, prices, menu items, settings).
// Every account gets its own record; nobody can read or change anyone else's.
// Accounts whose paid access has ended are refused (status 402) until the owner records a payment.
import { getStore } from "@netlify/blobs";
import { json, getUser, accessStatus } from "../lib/common.mjs";

const MAX_BYTES = 4 * 1024 * 1024;

export default async (req) => {
  const user = await getUser(req);
  if (user instanceof Response) return user;

  const access = await accessStatus(user);
  if (!access.ok) return json({ locked: true, ...access }, 402);

  const store = getStore({ name: "catering-hub-data", consistency: "strong" });
  const key = `user-${user.id}`;

  if (req.method === "GET") {
    const rec = await store.get(key, { type: "json" });
    return json({ ...(rec || { rev: 0, data: null }), access });
  }

  if (req.method === "PUT") {
    const text = await req.text();
    if (text.length > MAX_BYTES) return json({ error: "Too much data" }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: "Bad data" }, 400); }
    if (!body || typeof body.data !== "object" || body.data === null) return json({ error: "Bad data" }, 400);

    const cur = await store.get(key, { type: "json" });
    const rev = cur ? cur.rev || 0 : 0;
    // Another device saved since this one last loaded: send back the latest so the page can merge it.
    if (body.baseRev !== rev) return json({ conflict: true, rev, data: cur ? cur.data : null }, 409);

    const rec = { rev: rev + 1, saved: new Date().toISOString(), email: user.email, data: body.data };
    await store.setJSON(key, rec);
    return json({ rev: rec.rev, saved: rec.saved, access });
  }

  return json({ error: "Method not allowed" }, 405);
};
