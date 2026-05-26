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

    // Auto-create a funding room when the listing is group funding
    let fundingRoomId = null;
    if (newListing.group_funding) {
      const { data: room } = await supabase.from("funding_rooms").insert({
        listing_id:      newListing.id,
        builder_id:      user.id,
        target_amount:   newListing.funding_needed || 0,
        committed_amount: 0,
        status:          "open",
      }).select().single().catch(() => ({ data: null }));
      fundingRoomId = room?.id || null;
    }

    return res.status(200).json({ ok: true, listing: newListing, funding_room_id: fundingRoomId });
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

  // ── FUNDING-ROOM-JOIN ─────────────────────────────────────────────────────
  if (action === "funding-room-join") {
    if (userRole !== "lender") return res.status(403).json({ error: "Lenders only" });
    const { listing_id, builder_user_id, amount } = req.body;
    if (!listing_id || !builder_user_id || !amount) return res.status(400).json({ error: "listing_id, builder_user_id, amount required" });
    const joinAmount = Number(amount);
    if (!Number.isFinite(joinAmount) || joinAmount <= 0) return res.status(400).json({ error: "Invalid amount" });

    const { data: bd } = await supabase.auth.admin.getUserById(builder_user_id);
    const builderListings = bd?.user?.user_metadata?.project_listings || [];
    const listing = builderListings.find(l => l.id === listing_id);
    if (!listing || !listing.group_funding) return res.status(404).json({ error: "Listing not found" });

    // Find or create room
    let { data: room } = await supabase.from("funding_rooms").select("*").eq("listing_id", listing_id).single().catch(() => ({ data: null }));
    if (!room) {
      const { data: newRoom, error: createErr } = await supabase.from("funding_rooms").insert({
        listing_id, builder_id: builder_user_id,
        target_amount: listing.funding_needed || 0, committed_amount: 0, status: "open",
      }).select().single();
      if (createErr) return res.status(500).json({ error: createErr.message });
      room = newRoom;
    }
    if (room.status === "fully_funded") return res.status(400).json({ error: "Room is already fully funded" });

    const lenderName = sanitizeStr(user.user_metadata?.name || user.email?.split("@")[0] || "Lender", 100);
    const { error: memberErr } = await supabase.from("funding_room_members").upsert({
      room_id: room.id, lender_id: user.id, lender_name: lenderName,
      amount: joinAmount, joined_at: new Date().toISOString(),
    }, { onConflict: "room_id,lender_id" });
    if (memberErr) return res.status(500).json({ error: memberErr.message });

    const { data: members } = await supabase.from("funding_room_members").select("amount").eq("room_id", room.id);
    const totalCommitted = (members || []).reduce((s, m) => s + Number(m.amount), 0);
    const newStatus = room.target_amount > 0 && totalCommitted >= room.target_amount ? "fully_funded" : "open";
    const { data: updatedRoom } = await supabase.from("funding_rooms")
      .update({ committed_amount: totalCommitted, status: newStatus }).eq("id", room.id).select().single().catch(() => ({ data: null }));

    const fmtGbp = n => `£${Number(n).toLocaleString("en-GB")}`;
    await supabase.from("funding_room_messages").insert({
      room_id: room.id, sender_id: user.id, sender_name: "System",
      message: `${lenderName} committed ${fmtGbp(joinAmount)} to the room.`, is_system: true,
    }).catch(() => {});

    try {
      await supabase.from("notifications").insert({
        user_id: builder_user_id, type: "funding_room_join",
        message: `${lenderName} committed ${fmtGbp(joinAmount)} to "${listing.title || "your project"}"`,
      });
    } catch (_) {}

    return res.status(200).json({ ok: true, room: updatedRoom || { ...room, committed_amount: totalCommitted, status: newStatus } });
  }

  // ── FUNDING-ROOM-LEAVE ────────────────────────────────────────────────────
  if (action === "funding-room-leave") {
    if (userRole !== "lender") return res.status(403).json({ error: "Lenders only" });
    const { room_id } = req.body;
    if (!room_id) return res.status(400).json({ error: "room_id required" });

    const { data: room } = await supabase.from("funding_rooms").select("*").eq("id", room_id).single().catch(() => ({ data: null }));
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (room.status === "fully_funded") return res.status(400).json({ error: "Cannot leave a fully funded room" });

    const { error: deleteErr } = await supabase.from("funding_room_members").delete().eq("room_id", room_id).eq("lender_id", user.id);
    if (deleteErr) return res.status(500).json({ error: deleteErr.message });

    const { data: members } = await supabase.from("funding_room_members").select("amount").eq("room_id", room_id);
    const totalCommitted = (members || []).reduce((s, m) => s + Number(m.amount), 0);
    await supabase.from("funding_rooms").update({ committed_amount: totalCommitted }).eq("id", room_id).catch(() => {});

    const lenderName = sanitizeStr(user.user_metadata?.name || user.email?.split("@")[0] || "Lender", 100);
    await supabase.from("funding_room_messages").insert({
      room_id, sender_id: user.id, sender_name: "System",
      message: `${lenderName} has withdrawn their commitment and left the room.`, is_system: true,
    }).catch(() => {});

    return res.status(200).json({ ok: true });
  }

  // ── FUNDING-ROOM-GET ──────────────────────────────────────────────────────
  if (action === "funding-room-get") {
    const { room_id } = req.body;
    if (!room_id) return res.status(400).json({ error: "room_id required" });

    const { data: room } = await supabase.from("funding_rooms").select("*").eq("id", room_id).single().catch(() => ({ data: null }));
    if (!room) return res.status(404).json({ error: "Room not found" });

    const isBuilder = room.builder_id === user.id;
    const isMember = isBuilder ? true : !!(await supabase.from("funding_room_members").select("id").eq("room_id", room_id).eq("lender_id", user.id).single().catch(() => ({ data: null }))).data;
    if (!isMember) return res.status(403).json({ error: "Not authorised" });

    const [{ data: members }, { data: messages }, { data: bd }] = await Promise.all([
      supabase.from("funding_room_members").select("*").eq("room_id", room_id).order("joined_at", { ascending: true }),
      supabase.from("funding_room_messages").select("*").eq("room_id", room_id).order("created_at", { ascending: true }).limit(300),
      supabase.auth.admin.getUserById(room.builder_id),
    ]);

    const builder = bd?.user;
    const builderListings = builder?.user_metadata?.project_listings || [];
    const listing = builderListings.find(l => l.id === room.listing_id);

    return res.status(200).json({
      room, members: members || [], messages: messages || [],
      builder_name: builder?.user_metadata?.name || "Builder",
      builder_avatar_url: builder?.user_metadata?.avatar_url || null,
      listing,
    });
  }

  // ── FUNDING-ROOM-LIST ─────────────────────────────────────────────────────
  if (action === "funding-room-list") {
    if (userRole === "lender") {
      const { data: memberships } = await supabase.from("funding_room_members").select("room_id, amount").eq("lender_id", user.id);
      const roomIds = (memberships || []).map(m => m.room_id);
      if (!roomIds.length) return res.status(200).json({ rooms: [] });
      const { data: rooms } = await supabase.from("funding_rooms").select("*").in("id", roomIds).order("created_at", { ascending: false });
      const builderIds = [...new Set((rooms || []).map(r => r.builder_id))];
      const builderMap = {};
      for (const bid of builderIds) {
        const { data: bdr } = await supabase.auth.admin.getUserById(bid).catch(() => ({ data: null }));
        if (bdr?.user) builderMap[bid] = { name: bdr.user.user_metadata?.name || "Builder", listings: bdr.user.user_metadata?.project_listings || [] };
      }
      const amountMap = {};
      for (const m of memberships || []) amountMap[m.room_id] = Number(m.amount);
      const enriched = (rooms || []).map(r => {
        const bm = builderMap[r.builder_id] || {};
        const listing = (bm.listings || []).find(l => l.id === r.listing_id);
        return { ...r, builder_name: bm.name || "Builder", listing_title: listing?.title || "Untitled project", my_amount: amountMap[r.id] || 0 };
      });
      return res.status(200).json({ rooms: enriched });
    }
    if (userRole === "builder") {
      const { data: rooms } = await supabase.from("funding_rooms").select("*").eq("builder_id", user.id).order("created_at", { ascending: false });
      const myListings = user.user_metadata?.project_listings || [];
      const listingMap = {};
      for (const l of myListings) listingMap[l.id] = l;
      const enriched = (rooms || []).map(r => ({ ...r, listing_title: listingMap[r.listing_id]?.title || "Untitled project" }));
      return res.status(200).json({ rooms: enriched });
    }
    return res.status(403).json({ error: "Not authorised" });
  }

  // ── FUNDING-ROOM-JOIN-POST ────────────────────────────────────────────────
  // Lender joins a funding room linked to a community post (not a project listing)
  if (action === "funding-room-join-post") {
    if (userRole !== "lender") return res.status(403).json({ error: "Lenders only" });
    const { post_id, post_author_id, amount } = req.body;
    if (!post_id || !post_author_id || !amount) return res.status(400).json({ error: "post_id, post_author_id, amount required" });
    const joinAmount = Number(amount);
    if (!Number.isFinite(joinAmount) || joinAmount <= 0) return res.status(400).json({ error: "Invalid amount" });

    // Find the funding room by listing_id = post_id
    let { data: room } = await supabase.from("funding_rooms").select("*").eq("listing_id", post_id).single().catch(() => ({ data: null }));
    if (!room) return res.status(404).json({ error: "Funding room not found for this post" });
    if (room.status === "fully_funded") return res.status(400).json({ error: "Room is already fully funded" });

    const lenderName = sanitizeStr(user.user_metadata?.name || user.email?.split("@")[0] || "Lender", 100);
    const { error: memberErr } = await supabase.from("funding_room_members").upsert({
      room_id: room.id, lender_id: user.id, lender_name: lenderName,
      amount: joinAmount, joined_at: new Date().toISOString(), status: "committed",
    }, { onConflict: "room_id,lender_id" });
    if (memberErr) return res.status(500).json({ error: memberErr.message });

    const { data: members } = await supabase.from("funding_room_members").select("amount").eq("room_id", room.id);
    const totalCommitted = (members || []).reduce((s, m) => s + Number(m.amount), 0);
    const newStatus = room.target_amount > 0 && totalCommitted >= room.target_amount ? "fully_funded" : "open";
    await supabase.from("funding_rooms").update({ committed_amount: totalCommitted, status: newStatus }).eq("id", room.id).catch(() => {});

    const fmtGbp = n => `£${Number(n).toLocaleString("en-GB")}`;
    await supabase.from("funding_room_messages").insert({
      room_id: room.id, sender_id: user.id, sender_name: "System",
      message: `${lenderName} committed ${fmtGbp(joinAmount)} to the room.`, is_system: true,
    }).catch(() => {});

    try {
      await supabase.from("notifications").insert({
        user_id: post_author_id, type: "funding_room_join",
        message: `${lenderName} committed ${fmtGbp(joinAmount)} to your group funding post`,
      });
    } catch (_) {}

    return res.status(200).json({ ok: true, room_id: room.id });
  }

  // ── FUNDING-ROOM-SET-TERMS ────────────────────────────────────────────────
  if (action === "funding-room-set-terms") {
    if (userRole !== "builder") return res.status(403).json({ error: "Builders only" });
    const { room_id, return_type, return_value } = req.body;
    if (!room_id) return res.status(400).json({ error: "room_id required" });

    const { data: room } = await supabase.from("funding_rooms").select("id, builder_id").eq("id", room_id).single().catch(() => ({ data: null }));
    if (!room || room.builder_id !== user.id) return res.status(403).json({ error: "Not authorised" });

    const { error: e } = await supabase.from("funding_rooms").update({
      return_type: sanitizeStr(return_type, 30) || null,
      return_value: return_value != null ? String(return_value) : null,
      terms_set_at: new Date().toISOString(),
    }).eq("id", room_id);
    if (e) return res.status(500).json({ error: e.message });

    // Notify all members
    const { data: members } = await supabase.from("funding_room_members").select("lender_id").eq("room_id", room_id);
    for (const m of members || []) {
      await supabase.from("notifications").insert({
        user_id: m.lender_id, type: "funding_room_terms",
        message: "Investment terms have been set for your funding room — please review and agree.",
      }).catch(() => {});
    }

    return res.status(200).json({ ok: true });
  }

  // ── FUNDING-ROOM-AGREE-TERMS ──────────────────────────────────────────────
  if (action === "funding-room-agree-terms") {
    if (userRole !== "lender") return res.status(403).json({ error: "Lenders only" });
    const { room_id } = req.body;
    if (!room_id) return res.status(400).json({ error: "room_id required" });

    const { error: e } = await supabase.from("funding_room_members")
      .update({ status: "terms_agreed", terms_agreed_at: new Date().toISOString() })
      .eq("room_id", room_id)
      .eq("lender_id", user.id);
    if (e) return res.status(500).json({ error: e.message });

    return res.status(200).json({ ok: true });
  }

  // ── FUNDING-ROOM-FINDER-FEE ───────────────────────────────────────────────
  if (action === "funding-room-finder-fee") {
    if (userRole !== "lender") return res.status(403).json({ error: "Lenders only" });
    const { room_id } = req.body;
    if (!room_id) return res.status(400).json({ error: "room_id required" });

    const { data: membership } = await supabase.from("funding_room_members")
      .select("*").eq("room_id", room_id).eq("lender_id", user.id).single().catch(() => ({ data: null }));
    if (!membership) return res.status(404).json({ error: "Not a member of this room" });
    if (membership.status === "fee_paid") return res.status(400).json({ error: "Finder fee already paid" });
    if (membership.status !== "terms_agreed") return res.status(400).json({ error: "Please agree to terms before paying the finder fee" });

    const feeAmount = Math.max(50, Math.round(Number(membership.amount) * 0.01 * 100)); // pence, min £0.50
    const Stripe = require("stripe");
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const { data: room } = await supabase.from("funding_rooms").select("listing_id").eq("id", room_id).single().catch(() => ({ data: null }));
    const description = `Finder's fee (1%) for funding room commitment of £${Number(membership.amount).toLocaleString("en-GB")}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "gbp",
          unit_amount: feeAmount,
          product_data: { name: "LenderBuild Finder's Fee", description },
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url: `${PLATFORM_URL}/?fee_paid=1&room_id=${room_id}`,
      cancel_url:  `${PLATFORM_URL}/?room_id=${room_id}`,
      metadata: { room_id, lender_id: user.id, type: "funding_room_finder_fee" },
    });

    await supabase.from("funding_room_members").update({
      stripe_session_id: session.id,
      fee_amount: Math.round(Number(membership.amount) * 0.01 * 100) / 100,
    }).eq("room_id", room_id).eq("lender_id", user.id).catch(() => {});

    return res.status(200).json({ ok: true, checkout_url: session.url });
  }

  // ── FUNDING-ROOM-FEE-CONFIRM ──────────────────────────────────────────────
  // Called on return from Stripe to mark the fee as paid
  if (action === "funding-room-fee-confirm") {
    const { room_id } = req.body;
    if (!room_id) return res.status(400).json({ error: "room_id required" });

    const { error: e } = await supabase.from("funding_room_members")
      .update({ status: "fee_paid", fee_paid_at: new Date().toISOString() })
      .eq("room_id", room_id)
      .eq("lender_id", user.id)
      .in("status", ["terms_agreed"]);
    if (e) return res.status(500).json({ error: e.message });

    // Notify builder
    const { data: room } = await supabase.from("funding_rooms").select("builder_id").eq("id", room_id).single().catch(() => ({ data: null }));
    if (room?.builder_id) {
      const lenderName = sanitizeStr(user.user_metadata?.name || user.email?.split("@")[0] || "Lender", 100);
      await supabase.from("notifications").insert({
        user_id: room.builder_id, type: "funding_room_fee_paid",
        message: `${lenderName} has paid their finder's fee and is fully confirmed in your funding room.`,
      }).catch(() => {});
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Unknown action" });
};
