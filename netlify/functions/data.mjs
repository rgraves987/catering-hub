// Saves and loads each signed-in person's Catering Hub data (jobs, payments, prices, menu items, settings).
// Every account gets its own record; nobody can read or change anyone else's.
// Accounts whose paid access has ended are refused (status 402) until the owner records a payment.
//
// Saves are atomic: the page sends the version tag (ETag) it last saw, and the save only happens if the
// stored record still has that tag. Otherwise the page gets the stored copy back (409) and merges it.
import { json, getUser, accessStatus, withNetlify, dataStore } from "../lib/common.mjs";

const MAX_BYTES = 4 * 1024 * 1024;

const main = async (req, ctx) => {
  const user = await getUser(req, ctx);
  if (user instanceof Response) return user;

  const access = await accessStatus(user);
  if (!access.ok) return json({ locked: true, ...access }, 402);

  const store = dataStore();
  const key = `user-${user.id}`;

  if (req.method === "GET") {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const rec = cur ? cur.data : null;
    return json({ data: rec ? rec.data : null, saved: rec ? rec.saved : null, etag: cur ? cur.etag || "" : "", access });
  }

  if (req.method === "PUT") {
    const text = await req.text();
    if (text.length > MAX_BYTES) return json({ error: "Too much data" }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: "Bad data" }, 400); }
    if (!body || typeof body.data !== "object" || body.data === null) return json({ error: "Bad data" }, 400);

    const rec = { saved: new Date().toISOString(), email: user.email, data: body.data };
    const w = body.etag
      ? await store.setJSON(key, rec, { onlyIfMatch: body.etag })
      : await store.setJSON(key, rec, { onlyIfNew: true });
    if (w.modified) return json({ etag: w.etag || "", saved: rec.saved, access });

    // Someone else (another device) saved first: send back what's stored so the page can merge.
    const cur = await store.getWithMetadata(key, { type: "json" });
    return json({ conflict: true, etag: cur ? cur.etag || "" : "", saved: cur && cur.data ? cur.data.saved : null,
      data: cur && cur.data ? cur.data.data : null }, 409);
  }

  return json({ error: "Method not allowed" }, 405);
};

export const handler = withNetlify(main);
