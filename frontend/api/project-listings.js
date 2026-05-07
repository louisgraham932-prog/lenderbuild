const { createClient } = require("@supabase/supabase-js");
const { rateLimit, getClientIp } = require("./_rateLimit");
const { sanitizeStr } = require("./_sanitize");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * /api/project-listings
 *
 * GET  — public list of all active project listings (from builder metadata)
 * POST action="create"  — builder creates a new project listing
 * POST action="update"  — builder updates an existing listing
 * POST action="delete"  — builder deletes a listing
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
  if (user.user_metadata?.role !== "builder") return res.status(403).json({ error: "Builders only" });

  const { action } = req.body || {};

  // ── CREATE ────────────────────────────────────────────────────────────────
  if (action === "create") {
    const {
      title, location, project_type, funding_needed,
      expected_return, timeline, description, photos, group_funding,
      syndicate_open, min_commitment,
    } = req.body;

    if (!title) return res.status(400).json({ error: "title required" });

    const newListing = {
      id:              crypto.randomUUID(),
      title:           sanitizeStr(title, 120),
      location:        sanitizeStr(location || "", 120),
      project_type:    sanitizeStr(project_type || "", 60),
      funding_needed:  funding_needed ? Number(funding_needed) : null,
      expected_return: sanitizeStr(expected_return || "", 100),
      timeline:        sanitizeStr(timeline || "", 100),
      description:     sanitizeStr(description || "", 1000),
      photos:          Array.isArray(photos) ? photos.slice(0, 5) : [],
      group_funding:   group_funding === true,
      syndicate_open:  syndicate_open === true,
      min_commitment:  min_commitment ? Number(min_commitment) : null,
      status:          "active",
      created_at:      new Date().toISOString(),
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
    const { listing_id, title, location, project_type, funding_needed, expected_return, timeline, description, photos, group_funding, syndicate_open, min_commitment } = req.body;
    if (!listing_id) return res.status(400).json({ error: "listing_id required" });

    const existing = user.user_metadata?.project_listings || [];
    const updated = existing.map(l => {
      if (l.id !== listing_id) return l;
      return {
        ...l,
        title:           sanitizeStr(title ?? l.title, 120),
        location:        sanitizeStr(location ?? l.location, 120),
        project_type:    sanitizeStr(project_type ?? l.project_type, 60),
        funding_needed:  funding_needed !== undefined ? (funding_needed ? Number(funding_needed) : null) : l.funding_needed,
        expected_return: sanitizeStr(expected_return ?? l.expected_return, 100),
        timeline:        sanitizeStr(timeline ?? l.timeline, 100),
        description:     sanitizeStr(description ?? l.description, 1000),
        photos:          photos !== undefined ? (Array.isArray(photos) ? photos.slice(0, 5) : l.photos) : l.photos,
        group_funding:   group_funding !== undefined ? group_funding === true : l.group_funding,
        syndicate_open:  syndicate_open !== undefined ? syndicate_open === true : l.syndicate_open,
        min_commitment:  min_commitment !== undefined ? (min_commitment ? Number(min_commitment) : null) : l.min_commitment,
        updated_at:      new Date().toISOString(),
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
    const { listing_id, builder_user_id, amount } = req.body;
    if (!listing_id || !builder_user_id || !amount) return res.status(400).json({ error: "listing_id, builder_user_id, amount required" });
    if (user.user_metadata?.role !== "lender") return res.status(403).json({ error: "Lenders only" });
    const lenderName = user.user_metadata?.name || user.email?.split("@")[0] || "Lender";
    const { error: upsertErr } = await supabase.from("syndicate_commitments").upsert({
      listing_id,
      builder_user_id,
      lender_user_id: user.id,
      lender_name: sanitizeStr(lenderName, 100),
      amount: Number(amount),
      status: "pending",
      committed_at: new Date().toISOString(),
    }, { onConflict: "listing_id,lender_user_id" });
    if (upsertErr) return res.status(500).json({ error: upsertErr.message });
    const { data: commitments } = await supabase.from("syndicate_commitments").select("*").eq("listing_id", listing_id);

    // Notify builder
    try {
      const { data: builderData } = await supabase.auth.admin.getUserById(builder_user_id);
      if (builderData?.user) {
        const builder = builderData.user;
        const fmtAmount = `£${Number(amount).toLocaleString("en-GB")}`;
        const builderListings = builder.user_metadata?.project_listings || [];
        const listing = builderListings.find(l => l.id === listing_id);
        const listingTitle = listing?.title || "your project";
        const fundingNeeded = listing?.funding_needed || 0;
        const totalNow = (commitments || []).reduce((s, c) => s + Number(c.amount), 0);
        const isFullyFunded = fundingNeeded > 0 && totalNow >= fundingNeeded;

        await supabase.from("notifications").insert({
          user_id: builder_user_id,
          type: isFullyFunded ? "syndicate_funded" : "syndicate_commitment",
          message: isFullyFunded
            ? `"${listingTitle}" is now fully funded — target of £${fundingNeeded.toLocaleString("en-GB")} reached!`
            : `${lenderName} committed ${fmtAmount} to "${listingTitle}"`,
        });

        if (builder.email && process.env.RESEND_API_KEY) {
          const subject = isFullyFunded
            ? `Your project is fully funded — "${listingTitle}"`
            : `New syndicate commitment: ${fmtAmount} — "${listingTitle}"`;
          const html = isFullyFunded
            ? `<p>Hi ${builder.user_metadata?.name || ""},</p><p>Great news — your syndicated project <strong>"${listingTitle}"</strong> has reached its funding target of £${fundingNeeded.toLocaleString("en-GB")} and is now fully funded!</p><p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`
            : `<p>Hi ${builder.user_metadata?.name || ""},</p><p><strong>${lenderName}</strong> has committed <strong>${fmtAmount}</strong> to your syndicated project <strong>"${listingTitle}"</strong>.</p><p>Total committed so far: £${totalNow.toLocaleString("en-GB")}${fundingNeeded ? ` of £${fundingNeeded.toLocaleString("en-GB")}` : ""}.</p><p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`;
          fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
            body: JSON.stringify({
              from: process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>",
              to: [builder.email],
              subject,
              html,
            }),
          }).catch(() => {});
        }
      }
    } catch (_) {}

    return res.status(200).json({ ok: true, commitments: commitments || [] });
  }

  // ── GET-SYNDICATE ─────────────────────────────────────────────────────────
  if (action === "get-syndicate") {
    const { listing_id } = req.body;
    if (!listing_id) return res.status(400).json({ error: "listing_id required" });
    const { data: commitments } = await supabase.from("syndicate_commitments").select("*").eq("listing_id", listing_id);
    return res.status(200).json({ commitments: commitments || [] });
  }

  return res.status(400).json({ error: "action must be create, update, delete, commit-syndicate, or get-syndicate" });

};
