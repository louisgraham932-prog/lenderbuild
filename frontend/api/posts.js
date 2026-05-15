const { createClient } = require("@supabase/supabase-js");
const { randomUUID } = require("crypto");
const { rateLimit, getClientIp } = require("./_rateLimit");
const { sanitizeStr } = require("./_sanitize");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * GET  /api/posts           — list all posts (public, optional auth to flag own posts)
 * POST /api/posts           — create / update / delete a post (requires auth)
 *   body.action = "create"  → { title, body, category }
 *   body.action = "update"  → { post_id, title, body, category }
 *   body.action = "delete"  → { post_id }
 */
module.exports = async function handler(req, res) {
  // IP rate limit for all methods
  const ip = getClientIp(req);
  if (!rateLimit(`posts:ip:${ip}`, 60, 60_000).allowed) {
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }

  // ── GET: list all posts ───────────────────────────────────────────────────
  if (req.method === "GET") {
    let viewerUserId = null;
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (token) {
      const { data: { user } } = await supabase.auth.getUser(token);
      viewerUserId = user?.id || null;
    }

    const posts = [];
    let page = 1;
    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return res.status(500).json({ error: error.message });
      for (const u of data.users) {
        for (const post of u.user_metadata?.posts || []) {
          posts.push({
            ...post,
            author_id:         u.id,
            author_name:       u.user_metadata?.name || u.email?.split("@")[0],
            author_role:       u.user_metadata?.role,
            author_verified:   !!(u.user_metadata?.verified_documents?.length),
            view_count:        post.view_count || 0,
            interest_count:    (post.interested_by || []).length,
            user_has_interest: viewerUserId ? (post.interested_by || []).includes(viewerUserId) : false,
            interested_by:     undefined,
          });
        }
      }
      if (data.users.length < 1000) break;
      page++;
    }
    posts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return res.status(200).json({ posts });
  }

  // ── POST: mutate a post ───────────────────────────────────────────────────
  if (req.method === "POST") {
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "Unauthorised" });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });

    if (!rateLimit(`api:${user.id}`, 100, 60_000).allowed) {
      return res.status(429).json({ error: "Too many requests. Please wait a moment." });
    }

    const { action, post_id } = req.body || {};
    // Sanitize text inputs
    const title    = sanitizeStr(req.body?.title, 200);
    const body     = sanitizeStr(req.body?.body, 5000);
    const category = sanitizeStr(req.body?.category, 50);

    if (action === "create") {
      if (!title || !body) return res.status(400).json({ error: "title and body are required" });
      const now = new Date().toISOString();
      const newPost = {
        id: randomUUID(), title, body,
        category: category || "general", created_at: now, updated_at: now, interested_by: [],
      };
      const existing = user.user_metadata?.posts || [];
      const { error: e } = await supabase.auth.admin.updateUserById(user.id, {
        user_metadata: { ...user.user_metadata, posts: [...existing, newPost] },
      });
      if (e) return res.status(500).json({ error: e.message });
      return res.status(200).json({ ok: true, post: newPost });
    }

    if (action === "update") {
      if (!post_id) return res.status(400).json({ error: "post_id required" });
      if (!title || !body) return res.status(400).json({ error: "title and body are required" });
      const existing = user.user_metadata?.posts || [];
      const idx = existing.findIndex(p => p.id === post_id);
      if (idx === -1) return res.status(404).json({ error: "Post not found" });
      const updated = [...existing];
      updated[idx] = { ...updated[idx], title, body, category: category || updated[idx].category, updated_at: new Date().toISOString() };
      const { error: e } = await supabase.auth.admin.updateUserById(user.id, {
        user_metadata: { ...user.user_metadata, posts: updated },
      });
      if (e) return res.status(500).json({ error: e.message });
      return res.status(200).json({ ok: true, post: updated[idx] });
    }

    if (action === "delete") {
      if (!post_id) return res.status(400).json({ error: "post_id required" });
      const existing = user.user_metadata?.posts || [];
      const filtered = existing.filter(p => p.id !== post_id);
      if (filtered.length === existing.length) return res.status(404).json({ error: "Post not found" });
      const { error: e } = await supabase.auth.admin.updateUserById(user.id, {
        user_metadata: { ...user.user_metadata, posts: filtered },
      });
      if (e) return res.status(500).json({ error: e.message });
      return res.status(200).json({ ok: true });
    }

    if (action === "view") {
      const { author_id } = req.body || {};
      if (!post_id || !author_id) return res.status(400).json({ error: "post_id and author_id required" });
      const { data: { user: author }, error: ae } = await supabase.auth.admin.getUserById(author_id);
      if (ae || !author) return res.status(404).json({ error: "Author not found" });
      const authorPosts = author.user_metadata?.posts || [];
      const idx = authorPosts.findIndex(p => p.id === post_id);
      if (idx >= 0) {
        authorPosts[idx] = { ...authorPosts[idx], view_count: (authorPosts[idx].view_count || 0) + 1 };
        await supabase.auth.admin.updateUserById(author_id, {
          user_metadata: { ...author.user_metadata, posts: authorPosts },
        });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === "interest") {
      const { author_id } = req.body || {};
      if (!post_id || !author_id) return res.status(400).json({ error: "post_id and author_id required" });
      const { data: { user: author }, error: ae } = await supabase.auth.admin.getUserById(author_id);
      if (ae || !author) return res.status(404).json({ error: "Author not found" });
      const authorPosts = author.user_metadata?.posts || [];
      const idx = authorPosts.findIndex(p => p.id === post_id);
      if (idx < 0) return res.status(404).json({ error: "Post not found" });
      const interestedBy = authorPosts[idx].interested_by || [];
      const hasInterest = interestedBy.includes(user.id);
      authorPosts[idx] = {
        ...authorPosts[idx],
        interested_by: hasInterest
          ? interestedBy.filter(id => id !== user.id)
          : [...interestedBy, user.id],
      };
      await supabase.auth.admin.updateUserById(author_id, {
        user_metadata: { ...author.user_metadata, posts: authorPosts },
      });
      return res.status(200).json({ ok: true, liked: !hasInterest });
    }

    return res.status(400).json({ error: "action must be create, update, delete, view, or interest" });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
