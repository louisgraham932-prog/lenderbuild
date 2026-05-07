const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { rateLimit, getClientIp } = require("./_rateLimit");
const { sanitizeStr } = require("./_sanitize");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PLATFORM_URL = process.env.CLIENT_URL || "https://www.lenderbuild.co.uk";
const ADMIN_EMAIL  = process.env.ADMIN_EMAIL  || "louisgraham932@gmail.com";
const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>";

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) return;
  fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: FROM_EMAIL, to: Array.isArray(to) ? to : [to], subject, html }),
  }).catch(() => {});
}

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().split("T")[0];
}

function generateRepayments(dealId, returnType, params, totalLoan) {
  const rows = [];
  const prefix = `REP-${dealId.slice(0, 6).toUpperCase()}`;
  const startDate = params.repayment_start_date
    ? new Date(params.repayment_start_date)
    : (() => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d; })();

  if (returnType === "fixed_interest") {
    const r = (params.interest_rate || 0) / 100 / 12;
    const n = Math.max(1, params.loan_term_months || 12);
    const monthly = r === 0
      ? totalLoan / n
      : totalLoan * r / (1 - Math.pow(1 + r, -n));
    const amt = Math.round(monthly * 100) / 100;
    for (let i = 0; i < n; i++) {
      rows.push({
        deal_id: dealId,
        payment_index: i + 1,
        amount: amt,
        due_date: addMonths(startDate, i),
        status: "scheduled",
        confirmation_number: `${prefix}-${String(i + 1).padStart(3, "0")}`,
      });
    }
  } else if (returnType === "rental_split") {
    const monthly = Math.round((params.estimated_monthly_rental || 0) * (params.rental_split_pct || 0) / 100 * 100) / 100;
    if (monthly <= 0) return rows;
    const n = Math.min(360, Math.ceil(totalLoan / monthly) || 12);
    for (let i = 0; i < n; i++) {
      rows.push({
        deal_id: dealId,
        payment_index: i + 1,
        amount: monthly,
        due_date: addMonths(startDate, i),
        status: "scheduled",
        confirmation_number: `${prefix}-${String(i + 1).padStart(3, "0")}`,
      });
    }
  }
  // equity_stake has no scheduled repayments — payout on sale is ad hoc
  return rows;
}

module.exports = async function handler(req, res) {

  // ── Stripe webhook ────────────────────────────────────────────────────────
  if (req.method === "POST" && req.headers["stripe-signature"]) {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(400).end();
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const webhookSecret = process.env.STRIPE_MILESTONE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
    let event;
    try {
      const rawBody = req.rawBody || (typeof req.body === "string" ? req.body : JSON.stringify(req.body));
      event = stripe.webhooks.constructEvent(rawBody, req.headers["stripe-signature"], webhookSecret);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.metadata?.type === "milestone_payment" && session.metadata?.milestone_id) {
        await supabase.from("milestones").update({ status: "paid" })
          .eq("id", session.metadata.milestone_id).eq("status", "approved");
      }

      if (session.metadata?.type === "finder_fee" && session.metadata?.deal_id) {
        await supabase.from("deals").update({ finder_fee_status: "paid" })
          .eq("id", session.metadata.deal_id);
      }

      if (session.metadata?.type === "repayment" && session.metadata?.repayment_id) {
        const repId = session.metadata.repayment_id;
        const { data: rep } = await supabase
          .from("repayments")
          .select("*, deals(lender_id, builder_id, lender_name, builder_name, title)")
          .eq("id", repId).maybeSingle();

        if (rep) {
          await supabase.from("repayments").update({
            status: "paid",
            paid_at: new Date().toISOString(),
            stripe_session_id: session.id,
          }).eq("id", repId);

          // Notify lender of repayment received
          if (rep.deals?.lender_id) {
            const { data: lenderData } = await supabase.auth.admin.getUserById(rep.deals.lender_id);
            if (lenderData?.user?.email) {
              sendEmail(lenderData.user.email,
                `Repayment received — ${rep.deals.title}`,
                `<p>Hi ${lenderData.user.user_metadata?.name || ""},</p>
<p>A repayment of <strong>${rep.amount >= 0 ? "£" + Number(rep.amount).toLocaleString() : ""}</strong> has been received from <strong>${rep.deals.builder_name}</strong> on the deal <em>"${rep.deals.title}"</em>.</p>
<p><strong>Confirmation:</strong> ${rep.confirmation_number}</p>
<p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`
              );
            }
          }
        }
      }
    }
    return res.status(200).json({ received: true });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const ip = getClientIp(req);
  if (!rateLimit(`deals:ip:${ip}`, 30, 60_000).allowed) return res.status(429).json({ error: "Too many requests." });

  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Unauthorised" });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });

  if (!rateLimit(`api:${user.id}`, 100, 60_000).allowed) return res.status(429).json({ error: "Too many requests." });

  const role = user.user_metadata?.role;

  // ── GET: list deals ───────────────────────────────────────────────────────
  if (req.method === "GET") {
    const { data: deals, error } = await supabase
      .from("deals")
      .select("*, milestones(*)")
      .or(`lender_id.eq.${user.id},builder_id.eq.${user.id}`)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const dealIds = (deals || []).map(d => d.id);
    let dealDocsMap = {}, disputesMap = {}, repaymentsMap = {};

    if (dealIds.length > 0) {
      const [{ data: docs }, { data: dispList }, { data: repList }] = await Promise.all([
        supabase.from("deal_documents").select("*").in("deal_id", dealIds),
        supabase.from("disputes").select("*").in("deal_id", dealIds),
        supabase.from("repayments").select("*").in("deal_id", dealIds).order("payment_index", { ascending: true }),
      ]);

      (docs || []).forEach(d => { if (!dealDocsMap[d.deal_id]) dealDocsMap[d.deal_id] = []; dealDocsMap[d.deal_id].push(d); });
      (dispList || []).forEach(d => { if (!disputesMap[d.deal_id]) disputesMap[d.deal_id] = []; disputesMap[d.deal_id].push(d); });
      (repList || []).forEach(r => { if (!repaymentsMap[r.deal_id]) repaymentsMap[r.deal_id] = []; repaymentsMap[r.deal_id].push(r); });

      // Check for newly missed repayments (fire-and-forget emails, sync status update)
      const today = new Date().toISOString().split("T")[0];
      const newlyMissed = (repList || []).filter(r => r.status === "scheduled" && r.due_date < today && !r.missed_alert_sent);
      if (newlyMissed.length > 0) {
        const missedIds = newlyMissed.map(r => r.id);
        await supabase.from("repayments").update({ status: "missed", missed_alert_sent: true }).in("id", missedIds);
        newlyMissed.forEach(r => { r.status = "missed"; }); // update local copy

        // Group by deal to send one email per deal per missed batch
        const byDeal = {};
        newlyMissed.forEach(r => { if (!byDeal[r.deal_id]) byDeal[r.deal_id] = []; byDeal[r.deal_id].push(r); });

        for (const [dealId, reps] of Object.entries(byDeal)) {
          const deal = (deals || []).find(d => d.id === dealId);
          if (!deal) continue;
          const amounts = reps.map(r => `£${Number(r.amount).toLocaleString()} (due ${r.due_date})`).join(", ");
          const html = (name) =>
            `<p>Hi ${name},</p><p>A repayment on the deal <em>"${deal.title}"</em> has been missed: <strong>${amounts}</strong>.</p><p>Please log in to resolve this immediately.</p><p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`;
          for (const uid of [deal.lender_id, deal.builder_id].filter(Boolean)) {
            const { data: uData } = await supabase.auth.admin.getUserById(uid);
            if (uData?.user?.email) sendEmail(uData.user.email, `Missed repayment — ${deal.title}`, html(uData.user.user_metadata?.name || ""));
          }
        }
      }
    }

    const enriched = (deals || []).map(d => ({
      ...d,
      deal_documents: dealDocsMap[d.id] || [],
      disputes: disputesMap[d.id] || [],
      repayments: repaymentsMap[d.id] || [],
    }));

    return res.status(200).json({ deals: enriched });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { action } = req.body || {};

  // ── POST create ───────────────────────────────────────────────────────────
  if (!action || action === "create") {
    if (role !== "lender") return res.status(403).json({ error: "Lenders only" });

    const {
      builder_name, title, milestones, property_value,
      return_type, interest_rate, loan_term_months,
      rental_split_pct, estimated_monthly_rental, equity_pct,
      repayment_start_date,
    } = req.body || {};

    if (!builder_name || !title) return res.status(400).json({ error: "builder_name and title required" });
    if (!Array.isArray(milestones) || milestones.length === 0 || milestones.length > 6)
      return res.status(400).json({ error: "1 to 6 milestones required" });
    for (const m of milestones) {
      if (!m.title || !m.amount || Number(m.amount) <= 0)
        return res.status(400).json({ error: "Each milestone needs a title and positive amount" });
    }

    let builderUser = null;
    let page = 1;
    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) break;
      builderUser = data.users.find(u => u.user_metadata?.role === "builder" && u.user_metadata?.name === builder_name) || null;
      if (builderUser || data.users.length < 1000) break;
      page++;
    }

    const { data: deal, error: dealErr } = await supabase.from("deals").insert({
      lender_id:                user.id,
      builder_id:               builderUser?.id || null,
      lender_name:              sanitizeStr(user.user_metadata?.name || "", 100),
      builder_name:             sanitizeStr(builder_name, 100),
      title:                    sanitizeStr(title, 200),
      status:                   "active",
      property_value:           property_value ? Number(property_value) : null,
      return_type:              return_type || null,
      interest_rate:            interest_rate ? Number(interest_rate) : null,
      loan_term_months:         loan_term_months ? Number(loan_term_months) : null,
      rental_split_pct:         rental_split_pct ? Number(rental_split_pct) : null,
      estimated_monthly_rental: estimated_monthly_rental ? Number(estimated_monthly_rental) : null,
      equity_pct:               equity_pct ? Number(equity_pct) : null,
      repayment_start_date:     repayment_start_date || null,
    }).select().single();

    if (dealErr) return res.status(500).json({ error: dealErr.message });

    const milestoneRows = milestones.map((m, i) => ({
      deal_id: deal.id, title: sanitizeStr(m.title, 200),
      description: sanitizeStr(m.description || "", 500),
      amount: Number(m.amount), order_index: i + 1, status: "pending", due_date: m.due_date || null,
    }));
    const { error: msErr } = await supabase.from("milestones").insert(milestoneRows);
    if (msErr) return res.status(500).json({ error: msErr.message });

    // Generate repayment schedule
    if (return_type && return_type !== "equity_stake") {
      const totalLoan = milestones.reduce((s, m) => s + Number(m.amount), 0);
      const repRows = generateRepayments(deal.id, return_type, {
        interest_rate: Number(interest_rate) || 0,
        loan_term_months: Number(loan_term_months) || 12,
        rental_split_pct: Number(rental_split_pct) || 0,
        estimated_monthly_rental: Number(estimated_monthly_rental) || 0,
        repayment_start_date,
      }, totalLoan);
      if (repRows.length > 0) await supabase.from("repayments").insert(repRows);
    }

    const lenderName = user.user_metadata?.name || "A lender";
    if (builderUser?.email) {
      sendEmail(builderUser.email, `${lenderName} has set up a milestone deal with you`,
        `<p>Hi ${builderUser.user_metadata?.name || ""},</p>
<p><strong>${lenderName}</strong> has created a milestone payment deal with you on LenderBuild: <em>${sanitizeStr(title, 200)}</em></p>
<p>Before any milestone funds can be released, you must upload four required documents and both parties must confirm the legal charge. Log in to view your project.</p>
<p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`
      );
    }
    if (builderUser?.id) {
      supabase.from("notifications").insert({ user_id: builderUser.id, type: "deal_created", message: `${lenderName} created a milestone deal with you: ${sanitizeStr(title, 200)}` }).then(() => {}).catch(() => {});
    }

    return res.status(200).json({ ok: true, deal });
  }

  // ── POST action="complete" ────────────────────────────────────────────────
  if (action === "complete") {
    if (role !== "builder") return res.status(403).json({ error: "Builders only" });

    const { milestone_id, photo_url } = req.body;
    if (!milestone_id) return res.status(400).json({ error: "milestone_id required" });

    const { data: milestone } = await supabase.from("milestones")
      .select("*, deals!inner(builder_id, lender_id, lender_name, title, frozen, legal_confirmed_lender, legal_confirmed_builder, deal_id:id)")
      .eq("id", milestone_id).maybeSingle();

    if (!milestone) return res.status(404).json({ error: "Milestone not found" });
    if (milestone.deals.builder_id !== user.id) return res.status(403).json({ error: "Forbidden" });
    if (milestone.status !== "pending") return res.status(400).json({ error: "Milestone is not pending" });
    if (milestone.deals.frozen) return res.status(400).json({ error: "This deal is frozen due to an active dispute." });

    if (milestone.order_index === 1) {
      // Check required docs
      const { data: docs } = await supabase.from("deal_documents").select("doc_type, status").eq("deal_id", milestone.deal_id);
      const required = ["site_insurance", "public_liability", "personal_guarantee", "solicitor_confirmation"];
      const approved = new Set((docs || []).filter(d => d.status === "approved").map(d => d.doc_type));
      if (required.some(r => !approved.has(r)))
        return res.status(400).json({ error: "All four required documents must be uploaded and approved before milestone 1 can be marked complete." });

      // Check legal charge confirmation
      if (!milestone.deals.legal_confirmed_lender || !milestone.deals.legal_confirmed_builder)
        return res.status(400).json({ error: "Both parties must confirm the legal charge checklist before milestone 1 can be marked complete." });
    }

    const { error: updateErr } = await supabase.from("milestones").update({
      status: "completed", completion_photo_url: photo_url || null, completed_at: new Date().toISOString(),
    }).eq("id", milestone_id);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    const builderName = user.user_metadata?.name || "Your builder";
    const { data: lenderData } = await supabase.auth.admin.getUserById(milestone.deals.lender_id);
    if (lenderData?.user?.email) {
      sendEmail(lenderData.user.email, `Milestone completed — ${milestone.title}`,
        `<p>Hi ${lenderData.user.user_metadata?.name || ""},</p>
<p><strong>${builderName}</strong> has marked <em>"${milestone.title}"</em> as complete on deal <em>"${milestone.deals.title}"</em>.</p>
${photo_url ? `<p><a href="${photo_url}">View completion photo</a></p>` : ""}
<p><a href="${PLATFORM_URL}">Approve on LenderBuild</a></p>`
      );
    }
    supabase.from("notifications").insert({ user_id: milestone.deals.lender_id, type: "milestone_complete", message: `${builderName} marked milestone "${milestone.title}" as complete` }).then(() => {}).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  // ── POST action="approve" ─────────────────────────────────────────────────
  if (action === "approve") {
    if (role !== "lender") return res.status(403).json({ error: "Lenders only" });

    const { milestone_id } = req.body;
    if (!milestone_id) return res.status(400).json({ error: "milestone_id required" });

    const { data: milestone } = await supabase.from("milestones")
      .select("*, deals!inner(lender_id, builder_id, builder_name, title, frozen)")
      .eq("id", milestone_id).maybeSingle();

    if (!milestone) return res.status(404).json({ error: "Milestone not found" });
    if (milestone.deals.lender_id !== user.id) return res.status(403).json({ error: "Forbidden" });
    if (milestone.status !== "completed") return res.status(400).json({ error: "Milestone must be marked complete first" });
    if (milestone.deals.frozen) return res.status(400).json({ error: "This deal is frozen due to an active dispute." });
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "Payment processing not configured" });

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const amountPence = Math.round(Number(milestone.amount) * 100);
    if (amountPence < 50) return res.status(400).json({ error: "Amount too small to process" });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price_data: { currency: "gbp", product_data: { name: `Milestone: ${milestone.title}`, description: `Deal: ${milestone.deals.title}` }, unit_amount: amountPence }, quantity: 1 }],
      mode: "payment",
      success_url: `${PLATFORM_URL}?milestone_paid=${milestone_id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PLATFORM_URL}?milestone_cancelled=${milestone_id}`,
      metadata: { milestone_id, type: "milestone_payment" },
    });

    await supabase.from("milestones").update({ status: "approved", approved_at: new Date().toISOString(), stripe_session_id: session.id }).eq("id", milestone_id);

    const lenderName = user.user_metadata?.name || "Your lender";
    if (milestone.deals.builder_id) {
      const { data: builderData } = await supabase.auth.admin.getUserById(milestone.deals.builder_id);
      if (builderData?.user?.email) {
        sendEmail(builderData.user.email, `Milestone approved — ${milestone.title}`,
          `<p>Hi ${builderData.user.user_metadata?.name || ""},</p>
<p><strong>${lenderName}</strong> approved milestone <em>"${milestone.title}"</em> — payment of <strong>£${Number(milestone.amount).toLocaleString()}</strong> is being released.</p>
<p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`
        );
      }
    }
    if (milestone.deals.builder_id) {
      supabase.from("notifications").insert({ user_id: milestone.deals.builder_id, type: "milestone_approved", message: `${lenderName} approved milestone "${milestone.title}" — payment releasing` }).then(() => {}).catch(() => {});
    }
    return res.status(200).json({ ok: true, checkout_url: session.url });
  }

  // ── POST action="finder-fee" ──────────────────────────────────────────────
  if (action === "finder-fee") {
    if (role !== "lender") return res.status(403).json({ error: "Lenders only" });

    const { deal_id } = req.body;
    if (!deal_id) return res.status(400).json({ error: "deal_id required" });

    const { data: deal } = await supabase.from("deals").select("*, milestones(*)").eq("id", deal_id).maybeSingle();
    if (!deal) return res.status(404).json({ error: "Deal not found" });
    if (deal.lender_id !== user.id) return res.status(403).json({ error: "Forbidden" });
    if (deal.finder_fee_status === "paid") return res.status(200).json({ already_paid: true });

    const totalValue = (deal.milestones || []).reduce((s, m) => s + Number(m.amount), 0);
    const feePence = Math.round(totalValue * 0.01 * 100);
    if (feePence < 50) return res.status(400).json({ error: "Deal value too small for finder's fee" });
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "Payment processing not configured" });

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price_data: { currency: "gbp", product_data: { name: `Finder's fee — ${deal.title}`, description: `1% of £${totalValue.toLocaleString()} total deal value` }, unit_amount: feePence }, quantity: 1 }],
      mode: "payment",
      success_url: `${PLATFORM_URL}?finder_fee_paid=${deal_id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PLATFORM_URL}?finder_fee_cancelled=${deal_id}`,
      metadata: { deal_id, type: "finder_fee" },
    });

    await supabase.from("deals").update({ finder_fee_session_id: session.id }).eq("id", deal_id);
    return res.status(200).json({ ok: true, checkout_url: session.url });
  }

  // ── POST action="upload-deal-doc" ─────────────────────────────────────────
  if (action === "upload-deal-doc") {
    if (role !== "builder") return res.status(403).json({ error: "Builders only" });

    const { deal_id, doc_type, file_path } = req.body;
    if (!deal_id || !doc_type || !file_path) return res.status(400).json({ error: "deal_id, doc_type, and file_path required" });

    const allowed = ["site_insurance", "public_liability", "personal_guarantee", "solicitor_confirmation"];
    if (!allowed.includes(doc_type)) return res.status(400).json({ error: "Invalid doc_type" });

    const { data: deal } = await supabase.from("deals").select("id, builder_id, title").eq("id", deal_id).maybeSingle();
    if (!deal) return res.status(404).json({ error: "Deal not found" });
    if (deal.builder_id !== user.id) return res.status(403).json({ error: "Forbidden" });

    const { error: upsertErr } = await supabase.from("deal_documents").upsert(
      { deal_id, doc_type, file_path, status: "pending", uploaded_at: new Date().toISOString() },
      { onConflict: "deal_id,doc_type" }
    );
    if (upsertErr) return res.status(500).json({ error: upsertErr.message });

    sendEmail(ADMIN_EMAIL, `Deal document pending review — ${doc_type}`,
      `<p>Builder uploaded a required project document for deal <em>"${deal.title}"</em>: ${doc_type.replace(/_/g, " ")}.</p><p><a href="${PLATFORM_URL}">Review in admin panel</a></p>`
    );
    return res.status(200).json({ ok: true });
  }

  // ── POST action="raise-dispute" ───────────────────────────────────────────
  if (action === "raise-dispute") {
    const { deal_id, reason } = req.body;
    if (!deal_id || !reason) return res.status(400).json({ error: "deal_id and reason required" });

    const { data: deal } = await supabase.from("deals").select("id, lender_id, builder_id, lender_name, builder_name, title").eq("id", deal_id).maybeSingle();
    if (!deal) return res.status(404).json({ error: "Deal not found" });
    if (deal.lender_id !== user.id && deal.builder_id !== user.id) return res.status(403).json({ error: "Forbidden" });

    const { data: existing } = await supabase.from("disputes").select("id").eq("deal_id", deal_id).eq("status", "open").maybeSingle();
    if (existing) return res.status(400).json({ error: "An open dispute already exists for this deal." });

    const raisedByName = user.user_metadata?.name || user.email;
    const cleanReason = sanitizeStr(reason, 1000);

    await Promise.all([
      supabase.from("disputes").insert({ deal_id, raised_by: user.id, raised_by_role: role, raised_by_name: raisedByName, reason: cleanReason, status: "open" }),
      supabase.from("deals").update({ frozen: true }).eq("id", deal_id),
    ]);

    const otherPartyId = user.id === deal.lender_id ? deal.builder_id : deal.lender_id;
    if (otherPartyId) {
      const { data: otherData } = await supabase.auth.admin.getUserById(otherPartyId);
      if (otherData?.user?.email) {
        sendEmail(otherData.user.email, `Dispute raised — ${deal.title}`,
          `<p><strong>${raisedByName}</strong> raised a dispute on <em>"${deal.title}"</em>: ${cleanReason}</p><p>Payments frozen. Contact us at <a href="mailto:${ADMIN_EMAIL}">${ADMIN_EMAIL}</a>.</p>`
        );
      }
    }
    sendEmail(ADMIN_EMAIL, `URGENT: Dispute raised — ${deal.title}`,
      `<p>Dispute on <em>"${deal.title}"</em> raised by ${raisedByName} (${role}): ${cleanReason}</p><p><a href="${PLATFORM_URL}">Review in admin panel</a></p>`
    );
    return res.status(200).json({ ok: true });
  }

  // ── POST action="confirm-legal" ───────────────────────────────────────────
  if (action === "confirm-legal") {
    const { deal_id, solicitor_name, solicitor_ref } = req.body;
    if (!deal_id) return res.status(400).json({ error: "deal_id required" });

    const { data: deal } = await supabase.from("deals").select("id, lender_id, builder_id").eq("id", deal_id).maybeSingle();
    if (!deal) return res.status(404).json({ error: "Deal not found" });
    if (deal.lender_id !== user.id && deal.builder_id !== user.id) return res.status(403).json({ error: "Forbidden" });

    const field = user.id === deal.lender_id ? "legal_confirmed_lender" : "legal_confirmed_builder";
    const updates = { [field]: true };
    if (solicitor_name) updates.legal_solicitor_name = sanitizeStr(solicitor_name, 200);
    if (solicitor_ref)  updates.legal_solicitor_ref  = sanitizeStr(solicitor_ref, 200);

    const { error: upErr } = await supabase.from("deals").update(updates).eq("id", deal_id);
    if (upErr) return res.status(500).json({ error: upErr.message });

    return res.status(200).json({ ok: true });
  }

  // ── POST action="make-repayment" ──────────────────────────────────────────
  if (action === "make-repayment") {
    if (role !== "builder") return res.status(403).json({ error: "Builders only" });

    const { repayment_id } = req.body;
    if (!repayment_id) return res.status(400).json({ error: "repayment_id required" });

    const { data: rep } = await supabase.from("repayments")
      .select("*, deals(builder_id, lender_id, title, frozen)")
      .eq("id", repayment_id).maybeSingle();

    if (!rep) return res.status(404).json({ error: "Repayment not found" });
    if (rep.deals.builder_id !== user.id) return res.status(403).json({ error: "Forbidden" });
    if (!["scheduled", "missed"].includes(rep.status)) return res.status(400).json({ error: "This repayment has already been paid or is not due." });
    if (rep.deals.frozen) return res.status(400).json({ error: "Deal is frozen due to an active dispute." });
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "Payment processing not configured" });

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const amountPence = Math.round(Number(rep.amount) * 100);
    if (amountPence < 50) return res.status(400).json({ error: "Repayment amount too small to process" });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price_data: { currency: "gbp", product_data: { name: `Repayment ${rep.confirmation_number}`, description: `Deal: ${rep.deals.title}` }, unit_amount: amountPence }, quantity: 1 }],
      mode: "payment",
      success_url: `${PLATFORM_URL}?repayment_paid=${repayment_id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PLATFORM_URL}?repayment_cancelled=${repayment_id}`,
      metadata: { repayment_id, type: "repayment" },
    });

    await supabase.from("repayments").update({ status: "processing", stripe_session_id: session.id }).eq("id", repayment_id);
    return res.status(200).json({ ok: true, checkout_url: session.url });
  }

  return res.status(400).json({ error: "Unknown action" });
};
