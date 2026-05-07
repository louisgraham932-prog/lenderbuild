const { createClient } = require("@supabase/supabase-js");
const { rateLimit, getClientIp } = require("./_rateLimit");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // IP-level rate limit
  const ip = getClientIp(req);
  if (!rateLimit(`respond:ip:${ip}`, 60, 60_000).allowed) {
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }

  // Verify the caller's JWT and confirm they are a lender
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Unauthorised" });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });
  if (user.user_metadata?.role !== "lender") {
    return res.status(403).json({ error: "Forbidden: lenders only" });
  }

  // Per-user rate limit: 100 calls per minute
  if (!rateLimit(`api:${user.id}`, 100, 60_000).allowed) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }

  const lenderName = user.user_metadata?.name;
  const { builder_id, action } = req.body || {};

  if (!builder_id || !["accepted", "declined"].includes(action)) {
    return res.status(400).json({ error: "builder_id and action (accepted|declined) required" });
  }

  // Fetch the builder's current metadata
  const { data: builderData, error: fetchErr } = await supabase.auth.admin.getUserById(builder_id);
  if (fetchErr || !builderData?.user) {
    return res.status(404).json({ error: "Builder not found" });
  }

  const builder = builderData.user;
  const connections = builder.user_metadata?.connections || [];

  // Find and update the matching connection entry
  let found = false;
  const updated = connections.map(conn => {
    if (conn.lender_name === lenderName && conn.status === "pending") {
      found = true;
      return { ...conn, status: action, responded_at: new Date().toISOString() };
    }
    return conn;
  });

  if (!found) {
    return res.status(404).json({ error: "Pending request not found" });
  }

  const { error: updateErr } = await supabase.auth.admin.updateUserById(builder_id, {
    user_metadata: { ...builder.user_metadata, connections: updated },
  });

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // When accepted, create a conversation between lender and builder
  if (action === "accepted") {
    const builderName = builder.user_metadata?.name || builder.email;
    await supabase.from("conversations").upsert(
      {
        lender_id:   user.id,
        builder_id:  builder_id,
        lender_name: lenderName,
        builder_name: builderName,
      },
      { onConflict: "lender_id,builder_id", ignoreDuplicates: true }
    );
    supabase.from("notifications").insert({
      user_id: builder_id,
      type: "connection_accepted",
      message: `${lenderName} accepted your connection request`,
    }).then(() => {}).catch(() => {});
  }

  // Email notification to builder (best-effort)
  if (builder.email && process.env.RESEND_API_KEY) {
    const platformUrl = process.env.CLIENT_URL || "https://www.lenderbuild.co.uk";
    const verb = action === "accepted" ? "accepted" : "declined";
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>",
        to: [builder.email],
        subject: `${lenderName} ${verb} your connection request`,
        html: `<p>Hi ${builder.user_metadata?.name || ""},</p><p><strong>${lenderName}</strong> has ${verb} your connection request on LenderBuild.</p><p><a href="${platformUrl}">View it on LenderBuild</a></p>`,
      }),
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true, action });
};
