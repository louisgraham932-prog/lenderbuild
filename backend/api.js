/**
 * Money Has Been Given Out — Full Express API
 *
 * SETUP:
 *   npm install express stripe cors dotenv @supabase/supabase-js
 *
 * .env file (same folder as this file):
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY=service_role_key_here   ← NOT the anon key
 *   STRIPE_SECRET_KEY=sk_test_...
 *   STRIPE_WEBHOOK_SECRET=whsec_...
 *   CLIENT_URL=http://localhost:3000
 *   PORT=4000
 *
 * RUN:
 *   node api.js
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { createClient } = require("@supabase/supabase-js");

const app = express();

// Supabase admin client (uses service key — server only, never expose to browser)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(cors({ origin: process.env.CLIENT_URL }));
app.use(express.json());

// Auth middleware — checks the user's Supabase JWT token
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }
  const token = authHeader.split(" ")[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  req.user = user;
  next();
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Money Has Been Given Out API running" }));


// ═════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /auth/signup
 * Register a new user as a builder or lender.
 * Body: { email, password, full_name, role: "builder"|"lender" }
 */
app.post("/auth/signup", async (req, res) => {
  const { email, password, full_name, role } = req.body;
  if (!email || !password || !full_name || !role) {
    return res.status(400).json({ error: "email, password, full_name, and role are required" });
  }
  if (!["builder", "lender"].includes(role)) {
    return res.status(400).json({ error: "role must be 'builder' or 'lender'" });
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, role },
  });

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ message: "Account created successfully", userId: data.user.id });
});

/**
 * POST /auth/login
 * Body: { email, password }
 * Returns: { access_token, user }
 * The frontend stores access_token and sends it as: Authorization: Bearer <token>
 */
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ access_token: data.session.access_token, user: data.user });
});


// ═════════════════════════════════════════════════════════════════════════════
// PROFILE ROUTES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /profile/me
 * Get the logged-in user's full profile.
 */
app.get("/profile/me", requireAuth, async (req, res) => {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*, lender_profiles(*), builder_profiles(*)")
    .eq("id", req.user.id)
    .single();

  if (error) return res.status(404).json({ error: "Profile not found" });
  res.json(profile);
});

/**
 * GET /profile/:id
 * Get any user's public profile.
 */
app.get("/profile/:id", async (req, res) => {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*, lender_profiles(*), builder_profiles(*)")
    .eq("id", req.params.id)
    .single();

  if (error) return res.status(404).json({ error: "Profile not found" });
  res.json(profile);
});

/**
 * PUT /profile/me
 * Update the logged-in user's profile.
 * Body: { full_name?, location?, bio?, avatar_url? }
 */
app.put("/profile/me", requireAuth, async (req, res) => {
  const { full_name, location, bio, avatar_url } = req.body;
  const { data, error } = await supabase
    .from("profiles")
    .update({ full_name, location, bio, avatar_url })
    .eq("id", req.user.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});


// ═════════════════════════════════════════════════════════════════════════════
// LENDER ROUTES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /lenders
 * Search and filter lenders.
 * Query params: budget_min, budget_max, return_type, project_type
 */
app.get("/lenders", async (req, res) => {
  const { budget_min, budget_max, return_type, project_type } = req.query;

  let query = supabase
    .from("lender_profiles")
    .select("*, profiles(id, full_name, location, avatar_url)")
    .eq("is_active", true);

  if (budget_min) query = query.gte("budget_max", Number(budget_min));
  if (budget_max) query = query.lte("budget_min", Number(budget_max));
  if (return_type && return_type !== "any") query = query.eq("return_type", return_type);
  if (project_type && project_type !== "any") query = query.contains("preferred_projects", [project_type]);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * POST /lenders/profile
 * Create or update a lender profile (logged-in lenders only).
 * Body: { budget_min, budget_max, return_type, interest_rate?, builder_split?, lender_split?, preferred_projects?, ... }
 */
app.post("/lenders/profile", requireAuth, async (req, res) => {
  const profileData = { ...req.body, user_id: req.user.id };

  const { data: existing } = await supabase
    .from("lender_profiles")
    .select("id")
    .eq("user_id", req.user.id)
    .single();

  let result;
  if (existing) {
    result = await supabase
      .from("lender_profiles")
      .update(profileData)
      .eq("user_id", req.user.id)
      .select()
      .single();
  } else {
    result = await supabase
      .from("lender_profiles")
      .insert(profileData)
      .select()
      .single();
  }

  if (result.error) return res.status(400).json({ error: result.error.message });
  res.json(result.data);
});


// ═════════════════════════════════════════════════════════════════════════════
// BUILDER ROUTES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /builders
 * List all active builders.
 */
app.get("/builders", async (req, res) => {
  const { data, error } = await supabase
    .from("builder_profiles")
    .select("*, profiles(id, full_name, location, avatar_url)")
    .eq("is_active", true)
    .order("projects_completed", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * POST /builders/profile
 * Create or update a builder profile.
 */
app.post("/builders/profile", requireAuth, async (req, res) => {
  const profileData = { ...req.body, user_id: req.user.id };

  const { data: existing } = await supabase
    .from("builder_profiles")
    .select("id")
    .eq("user_id", req.user.id)
    .single();

  let result;
  if (existing) {
    result = await supabase
      .from("builder_profiles")
      .update(profileData)
      .eq("user_id", req.user.id)
      .select()
      .single();
  } else {
    result = await supabase
      .from("builder_profiles")
      .insert(profileData)
      .select()
      .single();
  }

  if (result.error) return res.status(400).json({ error: result.error.message });
  res.json(result.data);
});


// ═════════════════════════════════════════════════════════════════════════════
// PROJECT ROUTES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /projects
 * List all open projects.
 * Query params: project_type, location, funding_min, funding_max
 */
app.get("/projects", async (req, res) => {
  const { project_type, funding_min, funding_max } = req.query;

  let query = supabase
    .from("projects")
    .select("*, profiles(id, full_name, avatar_url)")
    .eq("status", "open")
    .order("created_at", { ascending: false });

  if (project_type && project_type !== "any") query = query.eq("project_type", project_type);
  if (funding_min) query = query.gte("funding_needed", Number(funding_min));
  if (funding_max) query = query.lte("funding_needed", Number(funding_max));

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * POST /projects
 * Create a new project (builders only).
 * Body: { title, description, location, project_type, funding_needed, estimated_value, timeline_months }
 */
app.post("/projects", requireAuth, async (req, res) => {
  const { title, description, location, project_type, funding_needed, estimated_value, timeline_months } = req.body;
  if (!title || !location || !project_type || !funding_needed) {
    return res.status(400).json({ error: "title, location, project_type, and funding_needed are required" });
  }

  const { data, error } = await supabase
    .from("projects")
    .insert({ title, description, location, project_type, funding_needed, estimated_value, timeline_months, builder_id: req.user.id })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});


// ═════════════════════════════════════════════════════════════════════════════
// MATCH ROUTES (connection requests)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /matches
 * Builder sends a connect request to a lender.
 * Body: { project_id, lender_id, message? }
 */
app.post("/matches", requireAuth, async (req, res) => {
  const { project_id, lender_id, message } = req.body;
  if (!project_id || !lender_id) {
    return res.status(400).json({ error: "project_id and lender_id are required" });
  }

  const { data, error } = await supabase
    .from("matches")
    .insert({ project_id, lender_id, builder_id: req.user.id, message })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

/**
 * GET /matches/me
 * Get all matches for the logged-in user (as builder or lender).
 */
app.get("/matches/me", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("matches")
    .select("*, projects(*), builder:builder_id(id, full_name, avatar_url), lender:lender_id(id, full_name, avatar_url)")
    .or(`builder_id.eq.${req.user.id},lender_id.eq.${req.user.id}`)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * PUT /matches/:id
 * Lender accepts or declines a match request.
 * Body: { status: "accepted" | "declined" }
 */
app.put("/matches/:id", requireAuth, async (req, res) => {
  const { status } = req.body;
  if (!["accepted", "declined"].includes(status)) {
    return res.status(400).json({ error: "status must be 'accepted' or 'declined'" });
  }

  const { data, error } = await supabase
    .from("matches")
    .update({ status })
    .eq("id", req.params.id)
    .eq("lender_id", req.user.id)   // only the lender can accept/decline
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});


// ═════════════════════════════════════════════════════════════════════════════
// STRIPE — FINDER'S FEE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /create-checkout-session
 * Body: { match_id, deal_amount, return_type, return_details?, project_title }
 */
app.post("/create-checkout-session", requireAuth, async (req, res) => {
  const { match_id, deal_amount, return_type, return_details, project_title } = req.body;
  if (!match_id || !deal_amount) {
    return res.status(400).json({ error: "match_id and deal_amount are required" });
  }

  // Fetch match to get builder/lender names
  const { data: match, error: matchError } = await supabase
    .from("matches")
    .select("*, builder:builder_id(full_name), lender:lender_id(full_name)")
    .eq("id", match_id)
    .single();

  if (matchError || !match) return res.status(404).json({ error: "Match not found" });

  const feeAmountPounds = Math.round(deal_amount * 0.01);
  const feeAmountPence = feeAmountPounds * 100;

  // Create a deal record in pending state
  const { data: deal, error: dealError } = await supabase
    .from("deals")
    .insert({
      match_id,
      project_id: match.project_id,
      builder_id: match.builder_id,
      lender_id: match.lender_id,
      deal_amount,
      return_type,
      return_details,
      fee_amount: feeAmountPounds,
      fee_status: "pending",
      status: "active",
    })
    .select()
    .single();

  if (dealError) return res.status(400).json({ error: dealError.message });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "gbp",
          product_data: {
            name: "Money Has Been Given Out — Finder's Fee",
            description: `1% fee: ${match.builder.full_name} + ${match.lender.full_name} — "${project_title}"`,
          },
          unit_amount: feeAmountPence,
        },
        quantity: 1,
      }],
      metadata: {
        deal_id: deal.id,
        match_id,
        builder_name: match.builder.full_name,
        lender_name: match.lender.full_name,
        deal_amount: deal_amount.toString(),
        fee_amount: feeAmountPounds.toString(),
        project_title: project_title || "",
      },
      success_url: `${process.env.CLIENT_URL}/deal-success?session_id={CHECKOUT_SESSION_ID}&deal_id=${deal.id}`,
      cancel_url: `${process.env.CLIENT_URL}/deal-cancelled?deal_id=${deal.id}`,
    });

    // Save the Stripe session ID against the deal
    await supabase.from("deals").update({ stripe_session_id: session.id }).eq("id", deal.id);

    res.json({ sessionId: session.id, checkoutUrl: session.url, dealId: deal.id, feeAmountPounds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /session-status?session_id=...
 */
app.get("/session-status", async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: "Missing session_id" });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    res.json({
      status: session.payment_status,
      dealId: session.metadata.deal_id,
      dealAmount: session.metadata.deal_amount,
      feeAmount: session.metadata.fee_amount,
      builderName: session.metadata.builder_name,
      lenderName: session.metadata.lender_name,
      projectTitle: session.metadata.project_title,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.payment_status === "paid") {
      const { deal_id, match_id } = session.metadata;

      // Mark fee as paid
      await supabase
        .from("deals")
        .update({ fee_status: "paid", fee_paid_at: new Date().toISOString() })
        .eq("id", deal_id);

      // Mark match as completed
      await supabase
        .from("matches")
        .update({ status: "completed" })
        .eq("id", match_id);

      console.log(`✅ Fee paid for deal ${deal_id}`);
    }
  }

  res.json({ received: true });
});


// ═════════════════════════════════════════════════════════════════════════════
// LEADERBOARD ROUTES
// ═════════════════════════════════════════════════════════════════════════════

/** GET /leaderboard/lenders */
app.get("/leaderboard/lenders", async (req, res) => {
  const { data, error } = await supabase
    .from("lender_leaderboard")
    .select("*")
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** GET /leaderboard/builders */
app.get("/leaderboard/builders", async (req, res) => {
  const { data, error } = await supabase
    .from("builder_leaderboard")
    .select("*")
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** GET /leaderboard/pairs */
app.get("/leaderboard/pairs", async (req, res) => {
  const { data, error } = await supabase
    .from("pair_leaderboard")
    .select("*")
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});


// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
