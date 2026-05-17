const { createClient } = require("@supabase/supabase-js");
const { rateLimit, getClientIp } = require("./_rateLimit");
const { sanitizeStr } = require("./_sanitize");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PLATFORM_URL = process.env.CLIENT_URL || "https://www.lenderbuild.co.uk";

/**
 * /api/project-listings
 *
 * GET  — public list of all active project listings (from builder metadata)
 * POST action="create"           — builder creates a new project listing
 * POST action="update"           — builder updates an existing listing
 * POST action="delete"           — builder deletes a listing
 * POST action="commit-syndicate" — lender commits funds to a syndicated listing
 * POST action="get-syndicate"    — any authenticated user gets syndicate totals
 * POST action="builder-commitments" — builder sees all committed lenders for their listing
 */
module.exports = async function handler(req, res) {
  // ── GET: public listing ───────────────────────────────────────────────────
  if (req.method === "GET") {
    const { data: usersPage, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (error) return res.status(500).json({ error: error.message });

    const listings = [];
    for (const u of (usersPage?.users || [])) {
      if (u.user_metadata?.role !== "builder") continue;
      const userListings = u.user_metadata?.project_listings || [];
      for (const listing of userListings) {
        if (listing.status !== "active") continue;
        listings.push({
          ...listing,
          user_id: u.id,
          builder_name: u.user_metadata?.name || "Anonymous",
          builder_avatar_url: u.user_metadata?.avatar_url || null,
        });
      }
    }

    // Syndicate totals (service key bypasses RLS)
    const syndicateTotals = {};
    try {
      const { data: synCmts } = await supabase.from("syndicate_commitments").select("listing_id, amount");
      for (const c of synCmts || []) {
        if (!syndicateTotals[c.listing_id]) syndicateTotals[c.listing_id] = { total: 0, count: 0 };
        syndicateTotals[c.listing_id].total += Number(c.amount);
        syndicateTotals[c.listing_id].count++;
      }
    } catch (_) {}

    // Sort by created_at descending
    listings.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return res.status(200).json({ listings, syndicate_totals: syndicateTotals });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ── All POST routes require auth ──────────────────────────────────────────
  const ip = getClientIp(req);
  if (!rateLimit(`project-listings:ip:${ip}`, 30, 60_000).allowed) {
    return res.status(429).json({ error: "Too many requests." });
  }

  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Unauthorised" });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });

  const { action } = req.body || {};
  const userRole = user.user_metadata?.role;

  // ── CREATE ────────────────────────────────────────────────────────────────
  if (action === "create") {
    if (userRole !== "builder") return res.status(403).json({ error: "Builders only" });

    const {
      title, location, project_type, funding_needed,
      expected_return, timeline, description, photos, group_funding,
      syndicate_open, min_commitment, syndicate_max_lenders,
      syndicate_return_type, syndicate_interest_rate, syndicate_loan_term_months,
      syndicate_rental_share_pct, syndicate_monthly_rental, syndicate_equity_pct,
    } = req.body;

    if (!title) return res.status(400).json({ error: "title required" });

    const newListing = {
      id:                           crypto.randomUUID(),
      title:                        sanitizeStr(title, 120),
      location:                     sanitizeStr(location || "", 120),
      project_type:                 sanitizeStr(project_type || "", 60),
      funding_needed:               funding_needed ? Number(funding_needed) : null,
      expected_return:              sanitizeStr(expected_return || "", 100),
      timeline:                     sanitizeStr(timeline || "", 100),
      description:                  sanitizeStr(description || "", 1000),
      photos:                       Array.isArray(photos) ? photos.slice(0, 5) : [],
      group_funding:                group_funding === true,
      syndicate_open:               syndicate_open === true,
      min_commitment:               min_commitment ? Number(min_commitment) : null,
      syndicate_return_type:        syndicate_open && syndicate_return_type ? sanitizeStr(syndicate_return_type, 30) : null,
      syndicate_interest_rate:      syndicate_open && syndicate_return_type === "fixed_interest" ? (Number(syndicate_interest_rate) || null) : null,
      syndicate_loan_term_months:   syndicate_open && syndicate_loan_term_months ? (Number(syndicate_loan_term_months) || null) : null,
      syndicate_rental_share_pct:   syndicate_open && syndicate_return_type === "rental_split" ? (Number(syndicate_rental_share_pct) || null) : null,
      syndicate_monthly_rental:     syndicate_open && syndicate_return_type === "rental_split" ? (Number(syndicate_monthly_rental) || null) : null,
      syndicate_equity_pct:         syndicate_open && syndicate_return_type === "equity_stake" ? (Number(syndicate_equity_pct) || null) : null,
      syndicate_max_lenders:        syndicate_open && syndicate_max_lenders ? (Number(syndicate_max_lenders) || null) : null,
      status:                       "active",
      created_at:                   new Date().toISOString(),
    };

    const existing = user.user_metadata?.project_listings || [];
    const updated = [...existing, newListing];

    const { error: updateErr } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { ...user.user_metadata, project_listings: updated },
    });
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    return res.status(200).json({ ok: true, listing: newListing });
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────
  if (action === "update") {
    if (userRole !== "builder") return res.status(403).json({ error: "Builders only" });

    const {
      listing_id, title, location, project_type, funding_needed,
      expected_return, timeline, description, photos,
      group_funding, syndicate_open, min_commitment, syndicate_max_lenders,
      syndicate_return_type, syndicate_interest_rate, syndicate_loan_term_months,
      syndicate_rental_share_pct, syndicate_monthly_rental, syndicate_equity_pct,
    } = req.body;
    if (!listing_id) return res.status(400).json({ error: "listing_id required" });

    const existing = user.user_metadata?.project_listings || [];
    const updated = existing.map(l => {
      if (l.id !== listing_id) return l;
      const newSynOpen = syndicate_open !== undefined ? syndicate_open === true : l.syndicate_open;
      return {
        ...l,
        title:                        sanitizeStr(title ?? l.title, 120),
        location:                     sanitizeStr(location ?? l.location, 120),
        project_type:                 sanitizeStr(project_type ?? l.project_type, 60),
        funding_needed:               funding_needed !== undefined ? (funding_needed ? Number(funding_needed) : null) : l.funding_needed,
        expected_return:              sanitizeStr(expected_return ?? l.expected_return, 100),
        timeline:                     sanitizeStr(timeline ?? l.timeline, 100),
        description:                  sanitizeStr(description ?? l.description, 1000),
        photos:                       photos !== undefined ? (Array.isArray(photos) ? photos.slice(0, 5) : l.photos) : l.photos,
        group_funding:                group_funding !== undefined ? group_funding === true : l.group_funding,
        syndicate_open:               newSynOpen,
        min_commitment:               min_commitment !== undefined ? (min_commitment ? Number(min_commitment) : null) : l.min_commitment,
        syndicate_return_type:        syndicate_return_type !== undefined ? (newSynOpen && syndicate_return_type ? sanitizeStr(syndicate_return_type, 30) : null) : l.syndicate_return_type,
        syndicate_interest_rate:      syndicate_interest_rate !== undefined ? (newSynOpen && syndicate_return_type === "fixed_interest" ? (Number(syndicate_interest_rate) || null) : null) : l.syndicate_interest_rate,
        syndicate_loan_term_months:   syndicate_loan_term_months !== undefined ? (newSynOpen && syndicate_loan_term_months ? (Number(syndicate_loan_term_months) || null) : null) : l.syndicate_loan_term_months,
        syndicate_rental_share_pct:   syndicate_rental_share_pct !== undefined ? (newSynOpen && syndicate_return_type === "rental_split" ? (Number(syndicate_rental_share_pct) || null) : null) : l.syndicate_rental_share_pct,
        syndicate_monthly_rental:     syndicate_monthly_rental !== undefined ? (newSynOpen && syndicate_return_type === "rental_split" ? (Number(syndicate_monthly_rental) || null) : null) : l.syndicate_monthly_rental,
        syndicate_equity_pct:         syndicate_equity_pct !== undefined ? (newSynOpen && syndicate_return_type === "equity_stake" ? (Number(syndicate_equity_pct) || null) : null) : l.syndicate_equity_pct,
        syndicate_max_lenders:        syndicate_max_lenders !== undefined ? (newSynOpen && syndicate_max_lenders ? (Number(syndicate_max_lenders) || null) : null) : l.syndicate_max_lenders,
        updated_at:                   new Date().toISOString(),
      };
    });

    const { error: updateErr } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { ...user.user_metadata, project_listings: updated },
    });
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    return res.status(200).json({ ok: true });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (action === "delete") {
    if (userRole !== "builder") return res.status(403).json({ error: "Builders only" });

    const { listing_id } = req.body;
    if (!listing_id) return res.status(400).json({ error: "listing_id required" });

    const existing = user.user_metadata?.project_listings || [];
    const updated = existing.filter(l => l.id !== listing_id);

    const { error: updateErr } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { ...user.user_metadata, project_listings: updated },
    });
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    return res.status(200).json({ ok: true });
  }

  // ── COMMIT-SYNDICATE ──────────────────────────────────────────────────────
  if (action === "commit-syndicate") {
    if (userRole !== "lender") return res.status(403).json({ error: "Lenders only" });

    const { listing_id, builder_user_id, amount } = req.body;
    if (!listing_id || !builder_user_id || !amount) return res.status(400).json({ error: "listing_id, builder_user_id, amount required" });

    const commitAmount = Number(amount);
    if (!Number.isFinite(commitAmount) || commitAmount <= 0) return res.status(400).json({ error: "Invalid amount" });

    const lenderName = user.user_metadata?.name || user.email?.split("@")[0] || "Lender";

    const { error: upsertErr } = await supabase.from("syndicate_commitments").upsert({
      listing_id,
      builder_user_id,
      lender_user_id: user.id,
      lender_name: sanitizeStr(lenderName, 100),
      amount: commitAmount,
      status: "pending",
      committed_at: new Date().toISOString(),
    }, { onConflict: "listing_id,lender_user_id" });
    if (upsertErr) return res.status(500).json({ error: upsertErr.message });

    const { data: commitments } = await supabase
      .from("syndicate_commitments")
      .select("*")
      .eq("listing_id", listing_id);

    // Determine if just became fully funded
    let builderData, listing, listingTitle, fundingNeeded, totalNow, isFullyFunded;
    try {
      const { data: bd } = await supabase.auth.admin.getUserById(builder_user_id);
      builderData = bd?.user;
      const builderListings = builderData?.user_metadata?.project_listings || [];
      listing = builderListings.find(l => l.id === listing_id);
      listingTitle = listing?.title || "your project";
      fundingNeeded = listing?.funding_needed || 0;
      totalNow = (commitments || []).reduce((s, c) => s + Number(c.amount), 0);
      isFullyFunded = fundingNeeded > 0 && totalNow >= fundingNeeded;
    } catch (_) {}

    const fmtGbp = n => `£${Number(n).toLocaleString("en-GB")}`;

    // Notify builder
    try {
      if (builderData) {
        await supabase.from("notifications").insert({
          user_id: builder_user_id,
          type: isFullyFunded ? "syndicate_funded" : "syndicate_commitment",
          message: isFullyFunded
            ? `"${listingTitle}" is now fully funded — target of ${fmtGbp(fundingNeeded)} reached!`
            : `${lenderName} committed ${fmtGbp(commitAmount)} to "${listingTitle}"`,
        });

        if (builderData.email && process.env.RESEND_API_KEY) {
          const subject = isFullyFunded
            ? `Your project is fully funded — "${listingTitle}"`
            : `New syndicate commitment: ${fmtGbp(commitAmount)} — "${listingTitle}"`;
          const html = isFullyFunded
            ? `<p>Hi ${builderData.user_metadata?.name || ""},</p><p>Great news — your syndicated project <strong>"${listingTitle}"</strong> has reached its funding target of ${fmtGbp(fundingNeeded)} and is now fully funded!</p><p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`
            : `<p>Hi ${builderData.user_metadata?.name || ""},</p><p><strong>${lenderName}</strong> has committed <strong>${fmtGbp(commitAmount)}</strong> to your syndicated project <strong>"${listingTitle}"</strong>.</p><p>Total committed so far: ${fmtGbp(totalNow)}${fundingNeeded ? ` of ${fmtGbp(fundingNeeded)}` : ""}.</p><p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`;
          fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
            body: JSON.stringify({
              from: process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>",
              to: [builderData.email],
              subject,
              html,
            }),
          }).catch(() => {});
        }
      }
    } catch (_) {}

    // When fully funded: notify all other committed lenders
    if (isFullyFunded) {
      const otherLenders = (commitments || []).filter(c => c.lender_user_id !== user.id);
      for (const lc of otherLenders) {
        try {
          const mySharePct = fundingNeeded > 0 ? ((Number(lc.amount) / fundingNeeded) * 100).toFixed(1) : null;
          const myFinderFee = (Number(lc.amount) * 0.01).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

          await supabase.from("notifications").insert({
            user_id: lc.lender_user_id,
            type: "syndicate_funded",
            message: `"${listingTitle}" is now fully funded! Your commitment of ${fmtGbp(lc.amount)} is confirmed.`,
          });

          if (process.env.RESEND_API_KEY) {
            const { data: lenderUserData } = await supabase.auth.admin.getUserById(lc.lender_user_id);
            const lenderEmail = lenderUserData?.user?.email;
            if (lenderEmail) {
              fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
                body: JSON.stringify({
                  from: process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>",
                  to: [lenderEmail],
                  subject: `Project fully funded — "${listingTitle}"`,
                  html: `<p>Hi ${lc.lender_name},</p>
<p>The syndicated project <strong>"${listingTitle}"</strong> has reached its funding target of ${fmtGbp(fundingNeeded)} and is now fully funded!</p>
<p><strong>Your commitment:</strong> ${fmtGbp(lc.amount)}${mySharePct ? ` (${mySharePct}% share)` : ""}</p>
<p><strong>Your proportional finder's fee:</strong> £${myFinderFee}</p>
<p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`,
                }),
              }).catch(() => {});
            }
          }
        } catch (_) {}
      }
    }

    return res.status(200).json({ ok: true, commitments: commitments || [] });
  }

  // ── GET-SYNDICATE ─────────────────────────────────────────────────────────
  if (action === "get-syndicate") {
    const { listing_id } = req.body;
    if (!listing_id) return res.status(400).json({ error: "listing_id required" });
    const { data: commitments } = await supabase.from("syndicate_commitments").select("*").eq("listing_id", listing_id);
    return res.status(200).json({ commitments: commitments || [] });
  }

  // ── BUILDER-COMMITMENTS ───────────────────────────────────────────────────
  // Builder sees all lenders' names and amounts for their own listing.
  if (action === "builder-commitments") {
    if (userRole !== "builder") return res.status(403).json({ error: "Builders only" });

    const { listing_id } = req.body;
    if (!listing_id) return res.status(400).json({ error: "listing_id required" });

    // Verify this listing belongs to the authenticated builder
    const builderListings = user.user_metadata?.project_listings || [];
    const listing = builderListings.find(l => l.id === listing_id);
    if (!listing) return res.status(403).json({ error: "Listing not found or not yours" });

    const { data: commitments, error: cmtErr } = await supabase
      .from("syndicate_commitments")
      .select("id, lender_user_id, lender_name, amount, status, committed_at")
      .eq("listing_id", listing_id)
      .order("committed_at", { ascending: true });

    if (cmtErr) return res.status(500).json({ error: cmtErr.message });
    return res.status(200).json({ commitments: commitments || [] });
  }

  return res.status(400).json({ error: "action must be create, update, delete, commit-syndicate, get-syndicate, or builder-commitments" });
};
