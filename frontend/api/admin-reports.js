const { createClient } = require("@supabase/supabase-js");
const { rateLimit, getClientIp } = require("./_rateLimit");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PLATFORM_URL = process.env.CLIENT_URL || "https://www.lenderbuild.co.uk";
const ADMIN_EMAIL  = process.env.ADMIN_EMAIL  || "lenderbuild.support@gmail.com";
const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>";

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: FROM_EMAIL, to: Array.isArray(to) ? to : [to], subject, html }),
  }).catch(() => {});
}

const DOC_LABELS = {
  photo_id: "Photo ID", selfie: "Selfie with ID", site_photos: "Site photos", planning: "Planning permission docs",
  site_insurance: "Site insurance certificate", public_liability: "Public liability insurance",
  personal_guarantee: "Personal guarantee", solicitor_confirmation: "Solicitor confirmation of legal charge",
};

/**
 * GET /api/admin-reports
 * POST /api/admin-reports
 * Auth: admin JWT (role === "admin")
 */
module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = getClientIp(req);
  if (!rateLimit(`admin:ip:${ip}`, 30, 60_000).allowed) {
    return res.status(429).json({ error: "Too many requests." });
  }

  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Unauthorised" });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });
  if (user.user_metadata?.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: admins only" });
  }

  // ── POST: admin actions ───────────────────────────────────────────────────
  if (req.method === "POST") {
    const { action, target_user_id, user_role, submission_id, decision, dispute_id, resolution_notes, deal_doc_id } = req.body || {};

    // ── set-user-role ──────────────────────────────────────────────────────
    if (action === "set-user-role") {
      if (!target_user_id) return res.status(400).json({ error: "target_user_id required" });
      const allowedRoles = [null, "verified_pro"];
      if (!allowedRoles.includes(user_role ?? null)) return res.status(400).json({ error: "Invalid role" });

      const { error: upErr } = await supabase
        .from("profiles")
        .update({ user_role: user_role || null })
        .eq("id", target_user_id);

      if (upErr) return res.status(500).json({ error: upErr.message });
      return res.status(200).json({ ok: true });
    }

    // ── review-document (profile verification docs) ────────────────────────
    if (action === "review-document") {
      if (!submission_id) return res.status(400).json({ error: "submission_id required" });
      if (!["approved", "rejected"].includes(decision)) return res.status(400).json({ error: "decision must be approved or rejected" });
      const rejection_reason = req.body?.rejection_reason || "";

      const { data: sub, error: subErr } = await supabase
        .from("document_submissions")
        .select("*")
        .eq("id", submission_id)
        .maybeSingle();
      if (subErr || !sub) return res.status(404).json({ error: "Submission not found" });

      const { error: upErr } = await supabase
        .from("document_submissions")
        .update({ status: decision, reviewed_at: new Date().toISOString() })
        .eq("id", submission_id);
      if (upErr) return res.status(500).json({ error: upErr.message });

      const { data: { user: targetUser } } = await supabase.auth.admin.getUserById(sub.user_id);
      const currentDocs = targetUser?.user_metadata?.verified_documents || [];
      const newDocs = decision === "approved"
        ? (currentDocs.includes(sub.document_type) ? currentDocs : [...currentDocs, sub.document_type])
        : currentDocs.filter(d => d !== sub.document_type);
      await supabase.auth.admin.updateUserById(sub.user_id, {
        user_metadata: { ...targetUser?.user_metadata, verified_documents: newDocs },
      });

      const userEmail = targetUser?.email;
      const userName  = targetUser?.user_metadata?.name || "there";
      const docLabel  = DOC_LABELS[sub.document_type] || sub.document_type;

      if (userEmail) {
        const subject = decision === "approved"
          ? `Your ${docLabel} has been verified on LenderBuild`
          : `Document update: ${docLabel} on LenderBuild`;
        const html = decision === "approved"
          ? `<p>Hi ${userName},</p><p>Great news — your <strong>${docLabel}</strong> has been reviewed and approved. A verified badge will now appear on your profile.</p><p><a href="${PLATFORM_URL}">View your profile</a></p><p>Thanks,<br/>The LenderBuild team</p>`
          : `<p>Hi ${userName},</p><p>Unfortunately your <strong>${docLabel}</strong> could not be approved${rejection_reason ? `: <em>${rejection_reason}</em>` : ""}.</p><p>Please re-upload a clear, valid document and resubmit.</p><p><a href="${PLATFORM_URL}">Go to LenderBuild</a></p><p>Thanks,<br/>The LenderBuild team</p>`;
        await sendEmail(userEmail, subject, html);
      }

      return res.status(200).json({ ok: true });
    }

    // ── approve-deal-doc: admin approves a project-specific document ───────
    if (action === "approve-deal-doc" || action === "reject-deal-doc") {
      if (!deal_doc_id) return res.status(400).json({ error: "deal_doc_id required" });
      const newStatus = action === "approve-deal-doc" ? "approved" : "rejected";
      const rejReason = req.body?.rejection_reason || "";

      const { data: doc, error: docErr } = await supabase
        .from("deal_documents")
        .select("*, deals(builder_id, lender_id, title)")
        .eq("id", deal_doc_id)
        .maybeSingle();
      if (docErr || !doc) return res.status(404).json({ error: "Document not found" });

      const { error: upErr } = await supabase
        .from("deal_documents")
        .update({ status: newStatus, reviewed_at: new Date().toISOString(), rejection_reason: rejReason || null })
        .eq("id", deal_doc_id);
      if (upErr) return res.status(500).json({ error: upErr.message });

      const docLabel = DOC_LABELS[doc.doc_type] || doc.doc_type;

      // Notify builder
      if (doc.deals?.builder_id) {
        const { data: builderData } = await supabase.auth.admin.getUserById(doc.deals.builder_id);
        if (builderData?.user?.email) {
          await sendEmail(builderData.user.email,
            newStatus === "approved"
              ? `Document approved: ${docLabel} — ${doc.deals.title}`
              : `Document rejected: ${docLabel} — ${doc.deals.title}`,
            newStatus === "approved"
              ? `<p>Hi ${builderData.user.user_metadata?.name || ""},</p><p>Your <strong>${docLabel}</strong> for the deal <em>"${doc.deals.title}"</em> has been approved.</p>${
                  ["site_insurance","public_liability","personal_guarantee","solicitor_confirmation"].every(t =>
                    t === doc.doc_type ? true : false
                  ) ? "" : `<p>Once all four required documents are approved, milestone 1 will be unlocked.</p>`
                }<p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`
              : `<p>Hi ${builderData.user.user_metadata?.name || ""},</p><p>Your <strong>${docLabel}</strong> for the deal <em>"${doc.deals.title}"</em> was rejected${rejReason ? `: <em>${rejReason}</em>` : ""}.</p><p>Please re-upload a valid document.</p><p><a href="${PLATFORM_URL}">Go to LenderBuild</a></p>`
          );
        }
      }

      return res.status(200).json({ ok: true });
    }

    // ── resolve-dispute: admin resolves a dispute ──────────────────────────
    if (action === "resolve-dispute") {
      if (!dispute_id) return res.status(400).json({ error: "dispute_id required" });

      const { data: dispute, error: dispErr } = await supabase
        .from("disputes")
        .select("*, deals(lender_id, builder_id, title)")
        .eq("id", dispute_id)
        .maybeSingle();
      if (dispErr || !dispute) return res.status(404).json({ error: "Dispute not found" });

      await Promise.all([
        supabase.from("disputes").update({
          status: "resolved",
          resolved_at: new Date().toISOString(),
          resolution_notes: resolution_notes || "",
        }).eq("id", dispute_id),
        supabase.from("deals").update({ frozen: false }).eq("id", dispute.deal_id),
      ]);

      // Notify both parties
      const notifyIds = [dispute.deals?.lender_id, dispute.deals?.builder_id].filter(Boolean);
      for (const uid of notifyIds) {
        const { data: uData } = await supabase.auth.admin.getUserById(uid);
        if (uData?.user?.email) {
          await sendEmail(uData.user.email, `Dispute resolved — ${dispute.deals.title}`,
            `<p>Hi ${uData.user.user_metadata?.name || ""},</p>
<p>The dispute on deal <em>"${dispute.deals.title}"</em> has been resolved by our admin team.</p>
${resolution_notes ? `<p><strong>Resolution:</strong> ${resolution_notes}</p>` : ""}
<p>Milestone payments on this deal have been unfrozen and can now proceed.</p>
<p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`
          );
        }
      }

      return res.status(200).json({ ok: true });
    }

    // ── escalate-dispute: admin escalates a dispute ────────────────────────
    if (action === "escalate-dispute") {
      if (!dispute_id) return res.status(400).json({ error: "dispute_id required" });

      const { data: dispute } = await supabase
        .from("disputes")
        .select("*, deals(lender_id, builder_id, title)")
        .eq("id", dispute_id)
        .maybeSingle();
      if (!dispute) return res.status(404).json({ error: "Dispute not found" });

      await supabase.from("disputes").update({ status: "escalated" }).eq("id", dispute_id);

      const notifyIds = [dispute.deals?.lender_id, dispute.deals?.builder_id].filter(Boolean);
      for (const uid of notifyIds) {
        const { data: uData } = await supabase.auth.admin.getUserById(uid);
        if (uData?.user?.email) {
          await sendEmail(uData.user.email, `Dispute escalated — ${dispute.deals?.title}`,
            `<p>Hi ${uData.user.user_metadata?.name || ""},</p>
<p>The dispute on deal <em>"${dispute.deals?.title}"</em> has been escalated and is under urgent review by our team.</p>
${resolution_notes ? `<p><strong>Notes:</strong> ${resolution_notes}</p>` : ""}
<p>All payments remain frozen. We will contact you directly with next steps.</p>
<p>If you have not already, please email us at <a href="mailto:${ADMIN_EMAIL}">${ADMIN_EMAIL}</a> with any supporting evidence.</p>`
          );
        }
      }

      return res.status(200).json({ ok: true });
    }

    // ── moderate-message: admin approves or removes a community or group message
    if (action === "moderate-message") {
      const { message_id, decision, message_table = "community_messages" } = req.body;
      if (!message_id) return res.status(400).json({ error: "message_id required" });
      if (!["approve", "remove"].includes(decision)) return res.status(400).json({ error: "decision must be approve or remove" });
      if (!["community_messages", "group_messages"].includes(message_table)) return res.status(400).json({ error: "invalid message_table" });

      if (decision === "remove") {
        await supabase.from(message_table).update({ hidden: true, flagged: false }).eq("id", message_id);
      } else {
        await supabase.from(message_table).update({ hidden: false, flagged: false }).eq("id", message_id);
      }
      return res.status(200).json({ ok: true });
    }

    // ── ban-user: admin bans a user from community chat ───────────────────────
    if (action === "ban-user") {
      const { target_user_id: ban_uid, ban_user_name, ban_reason, ban_type, banned_until } = req.body;
      if (!ban_uid) return res.status(400).json({ error: "target_user_id required" });

      const { error: banErr } = await supabase.from("community_bans").upsert({
        user_id:      ban_uid,
        user_name:    ban_user_name || "",
        reason:       ban_reason || "",
        ban_type:     ban_type || "temporary",
        banned_until: ban_type === "permanent" ? null : (banned_until || new Date(Date.now() + 86400000).toISOString()),
        banned_at:    new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (banErr) return res.status(500).json({ error: banErr.message });

      // Notify user
      const { data: banTarget } = await supabase.auth.admin.getUserById(ban_uid);
      if (banTarget?.user?.email) {
        await sendEmail(banTarget.user.email, "Community chat access suspended — LenderBuild",
          `<p>Hi ${banTarget.user.user_metadata?.name || ""},</p>
<p>Your access to LenderBuild community chat has been suspended${ban_type === "permanent" ? " permanently" : " for 24 hours"} due to a violation of our community guidelines.</p>
${ban_reason ? `<p><strong>Reason:</strong> ${ban_reason}</p>` : ""}
<p>If you believe this is in error, please contact us at <a href="mailto:${ADMIN_EMAIL}">${ADMIN_EMAIL}</a>.</p>
<p>The LenderBuild team</p>`
        );
      }
      return res.status(200).json({ ok: true });
    }

    // ── unban-user: admin removes a community ban ─────────────────────────────
    if (action === "unban-user") {
      const { ban_id } = req.body;
      if (!ban_id) return res.status(400).json({ error: "ban_id required" });
      await supabase.from("community_bans").delete().eq("id", ban_id);
      return res.status(200).json({ ok: true });
    }

    // ── chase-finder-fee ───────────────────────────────────────────────────
    if (action === "chase-finder-fee") {
      const { deal_id } = req.body;
      if (!deal_id) return res.status(400).json({ error: "deal_id required" });

      const { data: deal } = await supabase
        .from("deals")
        .select("id, title, builder_id, builder_name, lender_name, agreed_amount, finder_fee_status")
        .eq("id", deal_id)
        .maybeSingle();
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      if (deal.finder_fee_status === "paid") return res.status(400).json({ error: "Fee already paid" });

      const { data: builderAuth } = await supabase.auth.admin.getUserById(deal.builder_id);
      const builderEmail = builderAuth?.user?.email;
      if (!builderEmail) return res.status(404).json({ error: "Builder email not found" });

      const fee = (Number(deal.agreed_amount) * 0.01).toFixed(2);
      await sendEmail(
        builderEmail,
        `Action required: LenderBuild finder's fee outstanding — £${Number(fee).toLocaleString()}`,
        `<p>Hi ${deal.builder_name},</p>
<p>A reminder that your LenderBuild finder's fee of <strong>£${Number(fee).toLocaleString()}</strong> (1% of your £${Number(deal.agreed_amount).toLocaleString()} deal with ${deal.lender_name}) is still outstanding.</p>
<p>The finder's fee must be paid before milestone payments can be released. Please log in to complete payment.</p>
<p><a href="${PLATFORM_URL}">Pay finder's fee on LenderBuild</a></p>
<p>If you have any questions, please contact us at <a href="mailto:${ADMIN_EMAIL}">${ADMIN_EMAIL}</a>.</p>`
      );

      return res.status(200).json({ ok: true, emailed: builderEmail });
    }

    return res.status(400).json({ error: "Unknown action" });
  }

  // ── GET ?type=community-mod: community moderation data ───────────────────
  if (req.query.type === "community-mod") {
    const [reportsRes, flaggedRes, bansRes, volumeRes, groupReportsRes, flaggedGroupRes] = await Promise.all([
      supabase.from("community_reports")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100),
      supabase.from("community_messages")
        .select("id, user_id, user_name, channel, content, flag_reason, created_at, report_count, hidden, flagged")
        .or("flagged.eq.true,report_count.gt.0")
        .order("created_at", { ascending: false })
        .limit(100),
      supabase.from("community_bans")
        .select("*")
        .order("banned_at", { ascending: false }),
      supabase.from("community_messages")
        .select("created_at")
        .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order("created_at", { ascending: true }),
      supabase.from("group_reports")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100),
      supabase.from("group_messages")
        .select("id, user_id, user_name, group_id, content, flag_reason, created_at, report_count, hidden, flagged")
        .or("flagged.eq.true,report_count.gt.0")
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    // Build hourly volume for the last 24h
    const hourBuckets = {};
    const now = new Date();
    for (let i = 23; i >= 0; i--) {
      const h = new Date(now - i * 3600000);
      hourBuckets[h.getUTCHours()] = { hour: `${String(h.getUTCHours()).padStart(2,"0")}:00`, count: 0 };
    }
    for (const m of (volumeRes.data || [])) {
      const h = new Date(m.created_at).getUTCHours();
      if (hourBuckets[h]) hourBuckets[h].count++;
    }
    const volume = Object.values(hourBuckets);

    return res.status(200).json({
      reports:       reportsRes.data       || [],
      messages:      flaggedRes.data       || [],
      bans:          bansRes.data          || [],
      volume,
      groupReports:  groupReportsRes.data  || [],
      groupMessages: flaggedGroupRes.data  || [],
    });
  }

  // ── GET ?type=documents: list pending profile verification docs ───────────
  if (req.query.type === "documents") {
    const { data: subs, error: subErr } = await supabase
      .from("document_submissions")
      .select("*")
      .eq("status", "pending")
      .order("submitted_at", { ascending: true });
    if (subErr) return res.status(500).json({ error: subErr.message });

    const userIds = [...new Set((subs || []).map(s => s.user_id))];
    const profileMap = {};
    if (userIds.length > 0) {
      const { data: profiles } = await supabase.from("profiles").select("id, full_name").in("id", userIds);
      (profiles || []).forEach(p => { profileMap[p.id] = p; });
    }

    const { data: authPage } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const emailMap = {};
    (authPage?.users || []).forEach(u => { emailMap[u.id] = u.email; });

    const enriched = await Promise.all((subs || []).map(async s => {
      const { data: signedData } = await supabase.storage
        .from("builder-documents")
        .createSignedUrl(s.file_path, 3600);
      return {
        ...s,
        user_name:   profileMap[s.user_id]?.full_name || "Unknown",
        user_email:  emailMap[s.user_id] || "",
        preview_url: signedData?.signedUrl || null,
      };
    }));

    return res.status(200).json({ submissions: enriched });
  }

  // ── GET ?type=users: list all users for role management ───────────────────
  if (req.query.type === "users") {
    const { data: profiles, error: pErr } = await supabase
      .from("profiles")
      .select("id, full_name, role, sequential_id, user_role")
      .order("sequential_id", { ascending: true });
    if (pErr) return res.status(500).json({ error: pErr.message });

    const { data: authPage } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const emailMap = {};
    (authPage?.users || []).forEach(u => { emailMap[u.id] = u.email; });

    const users = (profiles || []).map(p => ({
      id: p.id,
      full_name: p.full_name,
      email: emailMap[p.id] || "",
      auth_role: p.role,
      sequential_id: p.sequential_id,
      user_role: p.user_role,
    }));
    return res.status(200).json({ users });
  }

  // ── GET ?type=disputes: list all disputes ─────────────────────────────────
  if (req.query.type === "disputes") {
    const { data: disputes, error: dispErr } = await supabase
      .from("disputes")
      .select("*, deals(title, lender_name, builder_name)")
      .order("created_at", { ascending: false });
    if (dispErr) return res.status(500).json({ error: dispErr.message });
    return res.status(200).json({ disputes: disputes || [] });
  }

  // ── GET ?type=deal-docs: list pending project-specific documents ───────────
  if (req.query.type === "deal-docs") {
    const { data: docs, error: docErr } = await supabase
      .from("deal_documents")
      .select("*, deals(title, builder_id, lender_id, builder_name)")
      .eq("status", "pending")
      .order("uploaded_at", { ascending: true });
    if (docErr) return res.status(500).json({ error: docErr.message });

    const enriched = await Promise.all((docs || []).map(async d => {
      const { data: signedData } = await supabase.storage
        .from("builder-documents")
        .createSignedUrl(d.file_path, 3600);
      return { ...d, preview_url: signedData?.signedUrl || null };
    }));

    return res.status(200).json({ deal_docs: enriched });
  }

  // ── GET ?type=defaults: check for overdue milestones and send alerts ───────
  if (req.query.type === "defaults") {
    const now = new Date();
    const { data: overdue } = await supabase
      .from("milestones")
      .select("*, deals!inner(id, builder_id, lender_id, title, lender_name, builder_name, flagged_default)")
      .eq("status", "pending")
      .lt("due_date", now.toISOString().split("T")[0])
      .not("due_date", "is", null);

    const results = [];
    for (const m of (overdue || [])) {
      const dueDate = new Date(m.due_date);
      const daysOverdue = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
      const alertLevel = m.last_default_alert || 0;
      const deal = m.deals;

      let sent = false;

      if (daysOverdue >= 14 && alertLevel < 14) {
        // Flag deal as in default and alert admin
        await supabase.from("deals").update({ flagged_default: true }).eq("id", deal.id);
        await supabase.from("milestones").update({ last_default_alert: 14 }).eq("id", m.id);

        sendEmail(ADMIN_EMAIL, `URGENT: Deal in default — ${deal.title}`,
          `<p>A deal has been flagged as in default on LenderBuild and requires urgent attention.</p>
<p><strong>Deal:</strong> ${deal.title}</p>
<p><strong>Lender:</strong> ${deal.lender_name}</p>
<p><strong>Builder:</strong> ${deal.builder_name}</p>
<p><strong>Milestone:</strong> ${m.title} — £${Number(m.amount).toLocaleString()}</p>
<p><strong>Days overdue:</strong> ${daysOverdue}</p>
<p><a href="${PLATFORM_URL}">Review in admin panel</a></p>`
        );

        // Urgent email to both parties
        for (const uid of [deal.lender_id, deal.builder_id].filter(Boolean)) {
          const { data: uData } = await supabase.auth.admin.getUserById(uid);
          if (uData?.user?.email) {
            sendEmail(uData.user.email, `URGENT: Milestone overdue by 14 days — ${deal.title}`,
              `<p>Hi ${uData.user.user_metadata?.name || ""},</p>
<p>The milestone <em>"${m.title}"</em> on deal <em>"${deal.title}"</em> is now <strong>${daysOverdue} days overdue</strong>.</p>
<p>This deal has been flagged as in default in our admin panel. Our team will be reviewing this urgently.</p>
<p>Please log in or contact us immediately at <a href="mailto:${ADMIN_EMAIL}">${ADMIN_EMAIL}</a>.</p>`
            );
          }
        }
        sent = true;
      } else if (daysOverdue >= 7 && alertLevel < 7) {
        await supabase.from("milestones").update({ last_default_alert: 7 }).eq("id", m.id);

        for (const uid of [deal.lender_id, deal.builder_id].filter(Boolean)) {
          const { data: uData } = await supabase.auth.admin.getUserById(uid);
          if (uData?.user?.email) {
            sendEmail(uData.user.email, `Warning: Milestone overdue by 7 days — ${deal.title}`,
              `<p>Hi ${uData.user.user_metadata?.name || ""},</p>
<p><strong>Warning:</strong> The milestone <em>"${m.title}"</em> on deal <em>"${deal.title}"</em> is now <strong>${daysOverdue} days overdue</strong>.</p>
<p>If this is not resolved within 7 days, the deal will be flagged as in default.</p>
<p>Please log in to address this or contact us at <a href="mailto:${ADMIN_EMAIL}">${ADMIN_EMAIL}</a>.</p>
<p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`
            );
          }
        }
        sent = true;
      } else if (daysOverdue >= 1 && alertLevel < 1) {
        await supabase.from("milestones").update({ last_default_alert: 1 }).eq("id", m.id);

        // Day 1: reminder to builder only
        if (deal.builder_id) {
          const { data: builderData } = await supabase.auth.admin.getUserById(deal.builder_id);
          if (builderData?.user?.email) {
            sendEmail(builderData.user.email, `Reminder: Milestone past due — ${deal.title}`,
              `<p>Hi ${builderData.user.user_metadata?.name || ""},</p>
<p>This is a reminder that the milestone <em>"${m.title}"</em> on deal <em>"${deal.title}"</em> was due on <strong>${m.due_date}</strong> and has not yet been marked complete.</p>
<p>Please log in to mark it complete or contact your lender if there is a delay.</p>
<p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`
            );
          }
        }
        sent = true;
      }

      results.push({ milestone_id: m.id, days_overdue: daysOverdue, alert_sent: sent });
    }

    const { data: defaults } = await supabase
      .from("deals")
      .select("*, milestones(*)")
      .eq("flagged_default", true)
      .order("created_at", { ascending: false });

    return res.status(200).json({ checked: results.length, alerts_sent: results.filter(r => r.alert_sent).length, flagged_defaults: defaults || [] });
  }

  // ── GET ?type=deals: all confirmed deals + revenue summary ───────────────
  if (req.query.type === "deals") {
    const { data: deals, error: dealErr } = await supabase
      .from("deals")
      .select("id, title, builder_name, lender_name, agreed_amount, finder_fee_status, deal_confirmed_at, created_at")
      .order("created_at", { ascending: false });
    if (dealErr) return res.status(500).json({ error: dealErr.message });

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const allDeals = deals || [];
    const paidDeals = allDeals.filter(d => d.finder_fee_status === "paid");
    const totalRevenue = paidDeals.reduce((s, d) => s + (Number(d.agreed_amount) * 0.01 || 0), 0);
    const monthRevenue = paidDeals.filter(d => (d.deal_confirmed_at || d.created_at) >= monthStart)
      .reduce((s, d) => s + (Number(d.agreed_amount) * 0.01 || 0), 0);
    const unpaidDeals = allDeals.filter(d => d.deal_confirmed_at && d.finder_fee_status !== "paid");

    return res.status(200).json({
      deals: allDeals,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      month_revenue: Math.round(monthRevenue * 100) / 100,
      unpaid_count:  unpaidDeals.length,
    });
  }

  // ── GET: main report (reports + flagged users) ─────────────────────────────
  const reports = [];
  const flaggedUsers = [];
  let page = 1;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return res.status(500).json({ error: error.message });

    for (const u of data.users) {
      const reported = u.user_metadata?.reported_builders || [];
      for (const r of reported) reports.push(r);
      if (u.user_metadata?.flagged) {
        flaggedUsers.push({
          user_id:     u.id,
          email:       u.email,
          name:        u.user_metadata?.name || u.email,
          role:        u.user_metadata?.role,
          flagged_at:  u.user_metadata?.flagged_at,
          flag_reason: u.user_metadata?.flag_reason,
        });
      }
    }

    if (data.users.length < 1000) break;
    page++;
  }

  reports.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  flaggedUsers.sort((a, b) => new Date(b.flagged_at) - new Date(a.flagged_at));

  const counts = {};
  for (const r of reports) counts[r.builder_id] = (counts[r.builder_id] || 0) + 1;
  const enriched = reports.map(r => ({ ...r, total_reports_for_builder: counts[r.builder_id] }));

  return res.status(200).json({ reports: enriched, flagged_users: flaggedUsers });
};
