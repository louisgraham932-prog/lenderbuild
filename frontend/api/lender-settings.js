const { createClient } = require("@supabase/supabase-js");
const { rateLimit, getClientIp } = require("./_rateLimit");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * GET /api/lender-settings
 * Public — returns a map of lender_name → { lender_id, accepting_requests, listing_active }
 *
 * POST /api/lender-settings
 * Auth: lender JWT
 * Body: { accepting_requests?: boolean, listing_active?: boolean }
 * Updates the calling lender's own metadata settings.
 */
module.exports = async function handler(req, res) {
  const ip = getClientIp(req);
  if (!rateLimit(`lender-settings:ip:${ip}`, 60, 60_000).allowed) {
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }

  if (req.method === "GET") {
    const settings = {};
    let page = 1;

    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return res.status(500).json({ error: error.message });

      for (const u of data.users) {
        if (u.user_metadata?.role === "lender" && u.user_metadata?.name) {
          settings[u.user_metadata.name] = {
            lender_id:          u.id,
            accepting_requests: u.user_metadata.accepting_requests !== false,
            listing_active:     u.user_metadata.listing_active     !== false,
          };
        }
      }

      if (data.users.length < 1000) break;
      page++;
    }

    return res.status(200).json({ settings });
  }

  if (req.method === "POST") {
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "Unauthorised" });

    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });
    if (user.user_metadata?.role !== "lender") {
      return res.status(403).json({ error: "Forbidden: lenders only" });
    }

    const { accepting_requests, listing_active } = req.body || {};
    const patch = {};
    if (accepting_requests !== undefined) patch.accepting_requests = Boolean(accepting_requests);
    if (listing_active     !== undefined) patch.listing_active     = Boolean(listing_active);

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { ...user.user_metadata, ...patch },
    });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
