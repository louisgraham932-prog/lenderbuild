const { createClient } = require("@supabase/supabase-js");
const { rateLimit, getClientIp } = require("./_rateLimit");
const { sanitizeStr } = require("./_sanitize");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PLATFORM_URL = process.env.CLIENT_URL || "https://www.lenderbuild.co.uk";
const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>";

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) return;
  fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: FROM_EMAIL, to: Array.isArray(to) ? to : [to], subject, html }),
  }).catch(() => {});
}

/**
 * GET  /api/save-profile  — get saved searches for the current user
 * POST /api/save-profile  — save profile or manage saved searches
 * Auth: authenticated user JWT
 */
module.exports = async function handler(req, res) {
  // ── GET: list saved searches ───────────────────────────────────────────────
  if (req.method === "GET") {
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "Unauthorised" });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });
    const { data } = await supabase.from("saved_searches").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    return res.status(200).json({ searches: data || [] });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Rate limiting
  const ip = getClientIp(req);
  if (!rateLimit(`save-profile:ip:${ip}`, 30, 60_000).allowed) {
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }

  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Unauthorised" });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });

  if (!rateLimit(`api:${user.id}`, 100, 60_000).allowed) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }

  const role = user.user_metadata?.role;
  const raw = req.body || {};

  // ── Action routing ─────────────────────────────────────────────────────────
  const { action } = raw;

  if (action === "save-search") {
    const { name, role_type, filters, frequency } = raw;
    if (!name) return res.status(400).json({ error: "name required" });
    const { data, error: insErr } = await supabase.from("saved_searches").insert({
      user_id: user.id,
      name: sanitizeStr(name, 100),
      role_type: role_type || "builder",
      filters: filters || {},
      frequency: frequency || "instant",
    }).select().single();
    if (insErr) return res.status(500).json({ error: insErr.message });
    return res.status(200).json({ ok: true, search: data });
  }

  if (action === "delete-search") {
    const { search_id } = raw;
    if (!search_id) return res.status(400).json({ error: "search_id required" });
    const { error: delErr } = await supabase.from("saved_searches").delete().eq("id", search_id).eq("user_id", user.id);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.status(200).json({ ok: true });
  }
  // Sanitize free-text fields
  const {
    location = "",
    bio = "",
    // lender fields
    budget_max,
    return_type,
    interest_rate,
    builder_split,
    lender_split,
    equity_stake,
    preferred_projects,
    // builder fields
    specialization,
    projects_completed,
    total_value,
    completion_rate,
  } = raw;

  // Sanitized values
  const cleanLocation = sanitizeStr(location, 150);
  const cleanBio      = sanitizeStr(bio, 600);

  // Upsert into profiles table (bio + location)
  const { error: profileErr } = await supabase
    .from("profiles")
    .upsert(
      { id: user.id, full_name: sanitizeStr(user.user_metadata?.name || "", 100), location: cleanLocation, bio: cleanBio, role: role || "builder" },
      { onConflict: "id" }
    );

  if (profileErr) return res.status(500).json({ error: profileErr.message });

  // Role-specific profile upsert
  if (role === "lender") {
    const lenderData = {
      user_id:            user.id,
      budget_max:         budget_max ? Number(budget_max) : null,
      return_type:        return_type || null,
      interest_rate:      interest_rate || null,
      builder_split:      builder_split || null,
      lender_split:       lender_split || null,
      equity_stake:       equity_stake || null,
      preferred_projects: preferred_projects || [],
      is_active:          true,
    };

    const { data: existing } = await supabase
      .from("lender_profiles")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();

    const { error: lpErr } = existing
      ? await supabase.from("lender_profiles").update(lenderData).eq("user_id", user.id)
      : await supabase.from("lender_profiles").insert(lenderData);

    if (lpErr) return res.status(500).json({ error: lpErr.message });

  } else if (role === "builder") {
    const builderData = {
      user_id:           user.id,
      specialization:    specialization || null,
      projects_completed: projects_completed != null ? Number(projects_completed) : 0,
      total_value:       total_value != null ? Number(total_value) : 0,
      completion_rate:   completion_rate != null ? Number(completion_rate) : 100,
      is_active:         true,
    };

    const { data: existing } = await supabase
      .from("builder_profiles")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();

    const { error: bpErr } = existing
      ? await supabase.from("builder_profiles").update(builderData).eq("user_id", user.id)
      : await supabase.from("builder_profiles").insert(builderData);

    if (bpErr) return res.status(500).json({ error: bpErr.message });
  }

  // Mark profile as complete and persist avatar_url if provided
  const avatarUrlUpdate = raw.avatar_url !== undefined
    ? { avatar_url: raw.avatar_url }
    : {};
  await supabase.auth.admin.updateUserById(user.id, {
    user_metadata: { ...user.user_metadata, profile_complete: true, ...avatarUrlUpdate },
  });

  // Fire saved-search alert emails for matching searches (fire and forget)
  try {
    const profileRoleType = role === "lender" ? "lender" : "builder";
    const { data: matchingSearches } = await supabase
      .from("saved_searches")
      .select("*, user_id")
      .eq("role_type", profileRoleType)
      .eq("frequency", "instant")
      .neq("user_id", user.id);

    if (matchingSearches && matchingSearches.length > 0) {
      const profileName = user.user_metadata?.name || user.email;
      for (const search of matchingSearches) {
        const { data: searchOwner } = await supabase.auth.admin.getUserById(search.user_id);
        if (searchOwner?.user?.email) {
          sendEmail(
            searchOwner.user.email,
            `New ${profileRoleType} profile matches your saved search: ${search.name}`,
            `<p>Hi ${searchOwner.user.user_metadata?.name || ""},</p>
<p>A new ${profileRoleType} profile from <strong>${profileName}</strong> matches your saved search "<strong>${search.name}</strong>".</p>
<p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`
          );
        }
      }
    }
  } catch (_) { /* non-critical */ }

  return res.status(200).json({ ok: true });
};
