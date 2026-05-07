const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * GET /api/get-profiles?type=lenders|builders
 * No auth required. Returns active lender or builder profiles enriched with
 * data from the profiles table. Uses explicit separate queries so it works
 * regardless of whether PostgREST foreign-key relationships are configured.
 */
module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { type } = req.query;

  if (type === "lenders") {
    const { data: lenders, error } = await supabase
      .from("lender_profiles")
      .select("*")
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    // Enrich with profiles data + avatar_url from user metadata
    if (lenders && lenders.length > 0) {
      const userIds = lenders.map(l => l.user_id).filter(Boolean);
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, full_name, location, bio, sequential_id, user_role")
        .in("id", userIds);
      const profileMap = {};
      (profiles || []).forEach(p => { profileMap[p.id] = p; });

      const { data: usersPage } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      const usersMap = {};
      (usersPage?.users || []).forEach(u => { usersMap[u.id] = u; });

      lenders.forEach(l => {
        l.profiles = profileMap[l.user_id] || null;
        l.avatar_url = usersMap[l.user_id]?.user_metadata?.avatar_url || null;
      });
    }

    return res.status(200).json({ lenders: lenders || [] });
  }

  if (type === "builders") {
    const { data: builders, error } = await supabase
      .from("builder_profiles")
      .select("*")
      .eq("is_active", true)
      .order("projects_completed", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    if (builders && builders.length > 0) {
      // Enrich with profiles data
      const userIds = builders.map(b => b.user_id).filter(Boolean);
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, full_name, location, bio, sequential_id, user_role")
        .in("id", userIds);
      const profileMap = {};
      (profiles || []).forEach(p => { profileMap[p.id] = p; });
      builders.forEach(b => { b.profiles = profileMap[b.user_id] || null; });

      // Enrich with approved verified_documents from document_submissions table
      const { data: usersPage } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      const usersMap = {};
      (usersPage?.users || []).forEach(u => { usersMap[u.id] = u; });

      const { data: approvedSubs } = await supabase
        .from("document_submissions")
        .select("user_id, document_type")
        .eq("status", "approved")
        .in("user_id", userIds);
      const approvedMap = {};
      (approvedSubs || []).forEach(s => {
        if (!approvedMap[s.user_id]) approvedMap[s.user_id] = [];
        approvedMap[s.user_id].push(s.document_type);
      });

      builders.forEach(b => {
        b.verified_documents = approvedMap[b.user_id] || [];
        b.avatar_url = usersMap[b.user_id]?.user_metadata?.avatar_url || null;
      });
    }

    return res.status(200).json({ builders: builders || [] });
  }

  // ── type=avatars: lightweight batch avatar URL lookup by user ID ──────────
  if (type === "avatars") {
    const rawIds = (req.query.ids || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 50);
    if (rawIds.length === 0) return res.status(200).json({ avatars: {} });

    const { data: usersPage } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const result = {};
    (usersPage?.users || []).forEach(u => {
      if (rawIds.includes(u.id)) result[u.id] = u.user_metadata?.avatar_url || null;
    });
    return res.status(200).json({ avatars: result });
  }

  // ── type=by-id: look up a user by their sequential ID number ─────────────
  if (type === "by-id") {
    const numId = parseInt(req.query.id, 10);
    if (!numId || numId < 1) return res.status(400).json({ error: "Invalid ID" });

    const { data: profile } = await supabase
      .from("profiles")
      .select("id, full_name, location, bio, role, sequential_id, user_role")
      .eq("sequential_id", numId)
      .maybeSingle();

    if (!profile) return res.status(404).json({ error: "User not found" });

    const { data: usersPage } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const authUser = (usersPage?.users || []).find(u => u.id === profile.id);
    return res.status(200).json({
      profile: {
        ...profile,
        avatar_url: authUser?.user_metadata?.avatar_url || null,
      },
    });
  }

  return res.status(400).json({ error: "type must be lenders, builders, avatars, or by-id" });
};
