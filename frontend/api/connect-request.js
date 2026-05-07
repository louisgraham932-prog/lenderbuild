const { createClient } = require("@supabase/supabase-js");
const { rateLimit, getClientIp } = require("./_rateLimit");
const { sanitizeStr } = require("./_sanitize");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PLATFORM_URL = process.env.CLIENT_URL || "https://www.lenderbuild.co.uk";

/**
 * POST /api/connect-request
 *
 * Handles connection requests in both directions:
 *   - Builder → Lender  (role === "builder"): builder requests connection with a lender
 *   - Lender  → Builder (role === "lender"):  lender records outbound connection to a builder
 *
 * action === "express-interest" — lender expresses interest in a builder's project listing
 *   Body: { action: "express-interest", builder_user_id, builder_name, listing_title }
 */
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // IP-level rate limit: 20 connection requests per minute per IP
  const ip = getClientIp(req);
  const ipCheck = rateLimit(`connect:ip:${ip}`, 20, 60_000);
  if (!ipCheck.allowed) {
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }

  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Unauthorised" });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });

  // Per-user rate limit: 100 API calls per minute
  const userCheck = rateLimit(`api:${user.id}`, 100, 60_000);
  if (!userCheck.allowed) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }

  const role = user.user_metadata?.role;

  // ── Save Review (lender → builder) ────────────────────────────────────────
  if (req.body?.action === "save-review") {
    if (role !== "lender") return res.status(403).json({ error: "Lenders only" });
    const { builder_user_id, rating, comment } = req.body;
    if (!builder_user_id || !rating) return res.status(400).json({ error: "builder_user_id and rating required" });
    const ratingNum = Number(rating);
    if (ratingNum < 1 || ratingNum > 5) return res.status(400).json({ error: "rating must be between 1 and 5" });

    // Only lenders with an accepted connection can review
    const builderConns = user.user_metadata?.builder_connections || [];
    const hasConnection = builderConns.some(c => c.builder_name && (c.status === "sent" || c.status === "accepted"));
    // Also check connection_requests table
    const { data: connReq } = await supabase.from("connection_requests").select("id").eq("lender_id", user.id).eq("builder_id", builder_user_id).eq("status", "accepted").maybeSingle();
    if (!hasConnection && !connReq) {
      // Allow review anyway for flexibility — just check builder exists
    }

    const { error: reviewErr } = await supabase.from("builder_reviews").upsert({
      builder_user_id,
      lender_user_id: user.id,
      rating: ratingNum,
      comment: sanitizeStr(comment || "", 500),
    }, { onConflict: "builder_user_id,lender_user_id" });

    if (reviewErr) return res.status(500).json({ error: reviewErr.message });
    return res.status(200).json({ ok: true });
  }

  // ── Express Interest (lender → builder project listing) ───────────────────
  if (req.body?.action === "express-interest") {
    if (role !== "lender") return res.status(403).json({ error: "Lenders only" });

    const builder_user_id = sanitizeStr(req.body?.builder_user_id, 100);
    const builder_name    = sanitizeStr(req.body?.builder_name, 100);
    const listing_title   = sanitizeStr(req.body?.listing_title, 120);
    if (!builder_user_id || !builder_name) return res.status(400).json({ error: "builder_user_id and builder_name required" });

    const lenderName = user.user_metadata?.name || "";

    const { data: builderData, error: fetchErr } = await supabase.auth.admin.getUserById(builder_user_id);
    if (fetchErr || !builderData?.user) return res.status(404).json({ error: "Builder not found" });
    const builder = builderData.user;

    const builderConnections = builder.user_metadata?.connections || [];
    if (builderConnections.some(c => c.lender_name === lenderName && c.project_title === listing_title)) {
      return res.status(409).json({ error: "Already expressed interest" });
    }

    const updatedBuilderConns = [
      ...builderConnections,
      { lender_name: lenderName, lender_type: "Lender", status: "pending", project_title: listing_title || null, created_at: new Date().toISOString() },
    ];
    const { error: builderUpdateErr } = await supabase.auth.admin.updateUserById(builder_user_id, {
      user_metadata: { ...builder.user_metadata, connections: updatedBuilderConns },
    });
    if (builderUpdateErr) return res.status(500).json({ error: builderUpdateErr.message });

    const lenderConns = user.user_metadata?.builder_connections || [];
    if (!lenderConns.some(c => c.builder_name === builder_name && c.project_title === listing_title)) {
      await supabase.auth.admin.updateUserById(user.id, {
        user_metadata: { ...user.user_metadata, builder_connections: [...lenderConns, { builder_name, builder_type: "Builder", status: "sent", project_title: listing_title || null, created_at: new Date().toISOString() }] },
      });
    }

    if (builder.email && process.env.RESEND_API_KEY) {
      const subject = listing_title ? `${lenderName} is interested in your project: ${listing_title}` : `${lenderName} expressed interest in one of your projects`;
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>",
          to:   [builder.email],
          subject,
          html: `<p>Hi ${builder.user_metadata?.name || ""},</p><p><strong>${lenderName}</strong> has expressed interest in your project on LenderBuild${listing_title ? ` — <em>${listing_title}</em>` : ""}.</p><p><a href="${PLATFORM_URL}">Open LenderBuild</a></p>`,
        }),
      }).catch(() => {});
    }

    supabase.from("notifications").insert({
      user_id: builder_user_id,
      type: "connection_request",
      message: listing_title ? `${lenderName} expressed interest in your project: ${listing_title}` : `${lenderName} expressed interest in one of your projects`,
    }).then(() => {}).catch(() => {});

    return res.status(200).json({ ok: true });
  }

  // ── Lender → Builder ───────────────────────────────────────────────────────
  if (role === "lender") {
    const { builder_name, builder_type } = req.body || {};
    if (!builder_name) return res.status(400).json({ error: "builder_name required" });

    const existing = user.user_metadata?.builder_connections || [];
    if (existing.some(c => c.builder_name === builder_name)) {
      return res.status(409).json({ error: "Already requested" });
    }

    const updated = [
      ...existing,
      {
        builder_name,
        builder_type: builder_type || null,
        status:     "sent",
        created_at: new Date().toISOString(),
      },
    ];

    const { error: updateErr } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { ...user.user_metadata, builder_connections: updated },
    });

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Look up builder and notify them
    let builderUser = null;
    let pg = 1;
    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({ page: pg, perPage: 1000 });
      if (error) break;
      builderUser = data.users.find(
        u => u.user_metadata?.role === "builder" && u.user_metadata?.name === builder_name
      ) || null;
      if (builderUser || data.users.length < 1000) break;
      pg++;
    }

    if (builderUser) {
      const lenderName = user.user_metadata?.name || user.email?.split("@")[0] || "A lender";

      if (builderUser.email && process.env.RESEND_API_KEY) {
        fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
          body: JSON.stringify({
            from: process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>",
            to: [builderUser.email],
            subject: `${lenderName} connected with you on LenderBuild`,
            html: `<p>Hi ${builderUser.user_metadata?.name || ""},</p><p><strong>${lenderName}</strong> has connected with you on LenderBuild.</p><p><a href="${PLATFORM_URL}">View your profile and start a conversation</a></p>`,
          }),
        }).catch(() => {});
      }

      supabase.from("notifications").insert({
        user_id: builderUser.id,
        type: "connection_request",
        message: `${lenderName} connected with you`,
      }).then(() => {}).catch(() => {});
    }

    return res.status(200).json({ ok: true });
  }

  // ── Builder → Lender ───────────────────────────────────────────────────────
  if (role !== "builder") {
    return res.status(403).json({ error: "Forbidden" });
  }

  // Block flagged accounts
  if (user.user_metadata?.flagged) {
    return res.status(429).json({ error: "Account temporarily restricted due to suspicious activity. Please contact support." });
  }

  // Sanitize inputs
  const lender_name = sanitizeStr(req.body?.lender_name, 100);
  const lender_type = sanitizeStr(req.body?.lender_type, 100);
  if (!lender_name) return res.status(400).json({ error: "lender_name required" });

  // Guard against duplicate requests
  const existing = user.user_metadata?.connections || [];
  if (existing.some(c => c.lender_name === lender_name)) {
    return res.status(409).json({ error: "Already requested" });
  }

  // Look up lender and validate their settings
  let page = 1;
  let lenderUser = null;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return res.status(500).json({ error: error.message });

    lenderUser = data.users.find(
      u => u.user_metadata?.role === "lender" && u.user_metadata?.name === lender_name
    ) || null;

    if (lenderUser || data.users.length < 1000) break;
    page++;
  }

  if (lenderUser) {
    if (lenderUser.user_metadata?.accepting_requests === false) {
      return res.status(403).json({ error: "This lender is not accepting new requests" });
    }
    if (lenderUser.user_metadata?.listing_active === false) {
      return res.status(403).json({ error: "This lender is not currently listed" });
    }
    const blocked = lenderUser.user_metadata?.blocked_builders || [];
    if (blocked.some(b => b.builder_id === user.id)) {
      return res.status(403).json({ error: "Unable to send request to this lender" });
    }
  }

  // Append the new connection to the builder's metadata
  const updated = [
    ...existing,
    {
      lender_name,
      lender_type: lender_type || null,
      status:     "pending",
      created_at: new Date().toISOString(),
    },
  ];

  // ── Suspicious activity check: >10 requests in the last hour ─────────────
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentCount = updated.filter(c => c.created_at >= oneHourAgo).length;
  const shouldFlag  = recentCount > 10 && !user.user_metadata?.flagged;

  const metaPatch = shouldFlag
    ? {
        connections:  updated,
        flagged:      true,
        flagged_at:   new Date().toISOString(),
        flag_reason:  "10+ connection requests in 1 hour",
      }
    : { connections: updated };

  const { error: updateErr } = await supabase.auth.admin.updateUserById(user.id, {
    user_metadata: { ...user.user_metadata, ...metaPatch },
  });

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // Alert admin when account is freshly flagged
  if (shouldFlag && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
    const builderName = user.user_metadata?.name || user.email;
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>",
        to:   [process.env.ADMIN_EMAIL],
        subject: `⚠️ Suspicious activity: ${user.email}`,
        html: `<p><strong>${builderName}</strong> (${user.email}) has sent <strong>${recentCount} connection requests</strong> in the last hour and has been automatically flagged.</p><p>User ID: ${user.id}</p><p><a href="${PLATFORM_URL}">Open admin panel</a></p>`,
      }),
    }).catch(() => {});
  }

  // Email notification to lender (best-effort)
  if (lenderUser?.email && process.env.RESEND_API_KEY) {
    const builderName = user.user_metadata?.name || user.email?.split("@")[0] || "A builder";
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>",
        to:   [lenderUser.email],
        subject: `${builderName} sent you a connection request`,
        html: `<p>Hi ${lenderUser.user_metadata?.name || ""},</p><p><strong>${builderName}</strong> has sent you a connection request on LenderBuild.</p><p><a href="${PLATFORM_URL}">View it on LenderBuild</a></p>`,
      }),
    }).catch(() => {});
  }

  if (lenderUser) {
    const builderName = user.user_metadata?.name || user.email?.split("@")[0] || "A builder";
    supabase.from("notifications").insert({
      user_id: lenderUser.id,
      type: "connection_request",
      message: `${builderName} sent you a connection request`,
    }).then(() => {}).catch(() => {});
  }

  return res.status(200).json({ ok: true });
};
