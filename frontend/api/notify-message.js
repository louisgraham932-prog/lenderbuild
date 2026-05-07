const { createClient } = require("@supabase/supabase-js");
const { rateLimit, getClientIp } = require("./_rateLimit");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * POST /api/notify-message
 *
 * action === "start-conversation" (or omitted body.action):
 *   Body: { action: "start-conversation", other_name, other_role }
 *   Finds or creates a conversation between the caller and the named user.
 *   Returns: { conversation }
 *
 * action === "notify" (or body.conversation_id present):
 *   Body: { conversation_id }
 *   Sends an email notification to the other party. Fire-and-forget — always 200.
 */
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = getClientIp(req);
  if (!rateLimit(`notify-msg:ip:${ip}`, 60, 60_000).allowed) {
    return res.status(200).json({ ok: true });
  }

  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Unauthorised" });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });

  if (!rateLimit(`api:${user.id}`, 100, 60_000).allowed) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }

  // ── Community flag alert: notify admin of auto-flagged message ───────────
  if (req.body?.action === "community-flag-alert") {
    const { message_id, flag_reason, message_content, user_name } = req.body;
    const ADMIN_EMAIL  = process.env.ADMIN_EMAIL  || "louisgraham932@gmail.com";
    const PLATFORM_URL = process.env.CLIENT_URL   || "https://www.lenderbuild.co.uk";
    const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>";
    if (process.env.RESEND_API_KEY) {
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        body: JSON.stringify({
          from: FROM_EMAIL, to: [ADMIN_EMAIL],
          subject: "⚠️ Auto-flagged community message — LenderBuild",
          html: `<p>A community message was automatically flagged and hidden.</p>
<p><strong>User:</strong> ${user_name || "Unknown"}</p>
<p><strong>Reason:</strong> ${flag_reason || "keyword match"}</p>
<p><strong>Content:</strong> <em>${(message_content || "").replace(/</g,"&lt;").slice(0, 500)}</em></p>
<p><strong>Message ID:</strong> ${message_id || ""}</p>
<p><a href="${PLATFORM_URL}">Review in admin panel → Community Moderation</a></p>`,
        }),
      }).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  }

  // ── Start or find a conversation ──────────────────────────────────────────
  if (req.body?.action === "start-conversation" || req.body?.other_name) {
    const myRole  = user.user_metadata?.role;
    const myName  = user.user_metadata?.name || user.email;
    const { other_name, other_role } = req.body || {};

    if (!other_name || !other_role) return res.status(400).json({ error: "other_name and other_role required" });
    if (!((myRole === "builder" && other_role === "lender") || (myRole === "lender" && other_role === "builder"))) {
      return res.status(400).json({ error: "Conversations must be between a lender and a builder" });
    }

    let otherUser = null;
    let page = 1;
    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return res.status(500).json({ error: error.message });
      otherUser = data.users.find(u => u.user_metadata?.role === other_role && u.user_metadata?.name === other_name) || null;
      if (otherUser || data.users.length < 1000) break;
      page++;
    }

    if (!otherUser) return res.status(404).json({ error: `${other_role} "${other_name}" not found` });

    let lender_id, builder_id, lender_name, builder_name;
    if (myRole === "builder") {
      builder_id = user.id;      builder_name = myName;
      lender_id  = otherUser.id; lender_name  = other_name;
    } else {
      lender_id  = user.id;      lender_name  = myName;
      builder_id = otherUser.id; builder_name = other_name;
    }

    const { data: existing } = await supabase
      .from("conversations").select("*")
      .eq("lender_id", lender_id).eq("builder_id", builder_id).maybeSingle();
    if (existing) return res.status(200).json({ conversation: existing });

    const { data: created, error: insertErr } = await supabase
      .from("conversations")
      .insert({ lender_id, builder_id, lender_name, builder_name })
      .select().single();

    if (insertErr) {
      if (insertErr.code === "23505") {
        const { data: retry } = await supabase.from("conversations").select("*")
          .eq("lender_id", lender_id).eq("builder_id", builder_id).maybeSingle();
        return res.status(200).json({ conversation: retry });
      }
      return res.status(500).json({ error: insertErr.message });
    }

    return res.status(200).json({ conversation: created });
  }

  // ── Email notification (fire-and-forget) ──────────────────────────────────
  if (!process.env.RESEND_API_KEY) return res.status(200).json({ ok: true });

  const { conversation_id } = req.body || {};
  if (!conversation_id) return res.status(200).json({ ok: true });

  const { data: convo } = await supabase.from("conversations").select("*").eq("id", conversation_id).maybeSingle();
  if (!convo) return res.status(200).json({ ok: true });

  const recipientId = user.id === convo.lender_id ? convo.builder_id : convo.lender_id;
  const senderName  = user.user_metadata?.name || user.email?.split("@")[0] || "Someone";

  // In-app notification (fire-and-forget)
  supabase.from("notifications").insert({
    user_id: recipientId,
    type: "message",
    message: `${senderName} sent you a message`,
  }).then(() => {}).catch(() => {});

  if (!process.env.RESEND_API_KEY) return res.status(200).json({ ok: true });

  const { data: recipientData } = await supabase.auth.admin.getUserById(recipientId);
  const recipientEmail = recipientData?.user?.email;
  if (!recipientEmail) return res.status(200).json({ ok: true });

  const platformUrl   = process.env.CLIENT_URL || "https://www.lenderbuild.co.uk";
  const recipientName = recipientData.user.user_metadata?.name || "";

  fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>",
      to:   [recipientEmail],
      subject: `${senderName} sent you a message`,
      html: `<p>Hi ${recipientName},</p><p><strong>${senderName}</strong> sent you a message on LenderBuild.</p><p><a href="${platformUrl}">View it on LenderBuild</a></p>`,
    }),
  }).catch(() => {});

  return res.status(200).json({ ok: true });
};
