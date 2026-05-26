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
            comments:          post.comments || [],
            comments_count:    (post.comments || []).length,
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

      // Group funding extra fields
      if (category === "group-funding") {
        newPost.funding_needed = req.body.funding_needed ? Number(req.body.funding_needed) : null;
        newPost.location       = sanitizeStr(req.body.location, 80) || null;
        newPost.return_type    = sanitizeStr(req.body.return_type, 30) || null;
        newPost.return_value   = req.body.return_value != null ? Number(req.body.return_value) : null;
        newPost.timeline       = sanitizeStr(req.body.timeline, 80) || null;
      }

      const existing = user.user_metadata?.posts || [];
      const { error: e } = await supabase.auth.admin.updateUserById(user.id, {
        user_metadata: { ...user.user_metadata, posts: [...existing, newPost] },
      });
      if (e) return res.status(500).json({ error: e.message });

      // Auto-create funding room for group-funding posts
      let fundingRoomId = null;
      if (category === "group-funding") {
        try {
          const { data: room } = await supabase.from("funding_rooms").insert({
            listing_id:      newPost.id,
            builder_id:      user.id,
            target_amount:   newPost.funding_needed || 0,
            committed_amount: 0,
            status:          "open",
            return_type:     newPost.return_type || null,
            return_value:    newPost.return_value != null ? String(newPost.return_value) : null,
          }).select().single();
          fundingRoomId = room?.id || null;
          if (fundingRoomId) {
            // Store room ID back on post
            const freshPosts = user.user_metadata?.posts ? [...user.user_metadata.posts] : [];
            const idx2 = freshPosts.findIndex(p => p.id === newPost.id);
            if (idx2 !== -1) {
              freshPosts[idx2] = { ...freshPosts[idx2], funding_room_id: fundingRoomId };
              await supabase.auth.admin.updateUserById(user.id, {
                user_metadata: { ...user.user_metadata, posts: freshPosts },
              }).catch(() => {});
            }
          }
        } catch (_) {}
      }

      return res.status(200).json({ ok: true, post: newPost, funding_room_id: fundingRoomId });
    }

    if (action === "update") {
      if (!post_id) return res.status(400).json({ error: "post_id required" });
      if (!title || !body) return res.status(400).json({ error: "title and body are required" });
      const existing = user.user_metadata?.posts || [];
      const idx = existing.findIndex(p => p.id === post_id);
      if (idx === -1) return res.status(404).json({ error: "Post not found" });
      const updated = [...existing];
      const updatedPost = {
        ...updated[idx], title, body,
        category: category || updated[idx].category,
        updated_at: new Date().toISOString(),
      };
      if ((category || updated[idx].category) === "group-funding") {
        updatedPost.funding_needed = req.body.funding_needed != null ? Number(req.body.funding_needed) : updated[idx].funding_needed;
        updatedPost.location       = req.body.location !== undefined ? sanitizeStr(req.body.location, 80) : updated[idx].location;
        updatedPost.return_type    = req.body.return_type !== undefined ? sanitizeStr(req.body.return_type, 30) : updated[idx].return_type;
        updatedPost.return_value   = req.body.return_value != null ? Number(req.body.return_value) : updated[idx].return_value;
        updatedPost.timeline       = req.body.timeline !== undefined ? sanitizeStr(req.body.timeline, 80) : updated[idx].timeline;
      }
      updated[idx] = updatedPost;
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

    if (action === "comment") {
      const { author_id } = req.body || {};
      const text = sanitizeStr(req.body?.text, 1000);
      if (!post_id || !author_id || !text) return res.status(400).json({ error: "post_id, author_id, and text required" });
      const { data: { user: author }, error: ae } = await supabase.auth.admin.getUserById(author_id);
      if (ae || !author) return res.status(404).json({ error: "Author not found" });
      const authorPosts = author.user_metadata?.posts || [];
      const idx = authorPosts.findIndex(p => p.id === post_id);
      if (idx < 0) return res.status(404).json({ error: "Post not found" });
      const comment = {
        id: randomUUID(),
        author_id: user.id,
        author_name: user.user_metadata?.name || user.email?.split("@")[0],
        author_role: user.user_metadata?.role || "",
        text,
        created_at: new Date().toISOString(),
      };
      authorPosts[idx] = { ...authorPosts[idx], comments: [...(authorPosts[idx].comments || []), comment] };
      await supabase.auth.admin.updateUserById(author_id, {
        user_metadata: { ...author.user_metadata, posts: authorPosts },
      });
      return res.status(200).json({ ok: true, comment });
    }

    return res.status(400).json({ error: "action must be create, update, delete, view, interest, or comment" });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
