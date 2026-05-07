const { createClient } = require("@supabase/supabase-js");
const { rateLimit, getClientIp } = require("./_rateLimit");
const { sanitizeStr } = require("./_sanitize");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * POST /api/block-builder
 * Auth: lender JWT
 *
 * action: "block"  — block a builder and decline any pending request
 *   Body: { action: "block", builder_id }
 *
 * action: "report" — report a builder for review
 *   Body: { action: "report", builder_id, builder_name, reason }
 */
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = getClientIp(req);
  if (!rateLimit(`block:ip:${ip}`, 30, 60_000).allowed) {
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }

  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Unauthorised" });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });
  if (user.user_metadata?.role !== "lender") {
    return res.status(403).json({ error: "Forbidden: lenders only" });
  }

  if (!rateLimit(`api:${user.id}`, 100, 60_000).allowed) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }

  const action     = sanitizeStr(req.body?.action, 20);
  const builder_id = sanitizeStr(req.body?.builder_id, 100);

  if (!builder_id) return res.status(400).json({ error: "builder_id required" });

  // ── BLOCK ──────────────────────────────────────────────────────────────────
  if (action === "block") {
    const blocked       = user.user_metadata?.blocked_builders || [];
    const alreadyBlocked = blocked.some(b => b.builder_id === builder_id);

    const updatedBlocked = alreadyBlocked
      ? blocked
      : [...blocked, { builder_id, blocked_at: new Date().toISOString() }];

    const { error: lenderErr } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { ...user.user_metadata, blocked_builders: updatedBlocked },
    });
    if (lenderErr) return res.status(500).json({ error: lenderErr.message });

    // Decline any pending request from this builder in their own metadata
    const { data: builderData, error: fetchErr } = await supabase.auth.admin.getUserById(builder_id);
    if (!fetchErr && builderData?.user) {
      const builder     = builderData.user;
      const lenderName  = user.user_metadata?.name;
      const connections = builder.user_metadata?.connections || [];
      const updatedConns = connections.map(c =>
        c.lender_name === lenderName && c.status === "pending"
          ? { ...c, status: "declined", responded_at: new Date().toISOString() }
          : c
      );
      await supabase.auth.admin.updateUserById(builder_id, {
        user_metadata: { ...builder.user_metadata, connections: updatedConns },
      });
    }

    return res.status(200).json({ ok: true });
  }

  // ── REPORT ─────────────────────────────────────────────────────────────────
  if (action === "report") {
    const builder_name = sanitizeStr(req.body?.builder_name, 100);
    const reason       = sanitizeStr(req.body?.reason, 1000);

    if (!reason) return res.status(400).json({ error: "reason required" });

    const existing = user.user_metadata?.reported_builders || [];
    if (existing.some(r => r.builder_id === builder_id)) {
      return res.status(409).json({ error: "Already reported this user" });
    }

    const updated = [
      ...existing,
      {
        builder_id,
        builder_name:  builder_name || null,
        lender_name:   user.user_metadata?.name || null,
        reason,
        created_at:    new Date().toISOString(),
      },
    ];

    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { ...user.user_metadata, reported_builders: updated },
    });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "action must be 'block' or 'report'" });
};
