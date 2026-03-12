class BlueskyLatestPosts extends HTMLElement {
  static get observedAttributes() {
    return ["handle", "mode", "exclude-replies", "max-check", "count", "layout"];
  }

  connectedCallback() {
    this.renderLoading();
    this.load();
  }

  attributeChangedCallback() {
    if (this.isConnected) {
      this.renderLoading();
      this.load();
    }
  }

  get handle() {
    return (this.getAttribute("handle") || "").replace(/^@/, "").trim();
  }

  get mode() {
    const mode = (this.getAttribute("mode") || "system").trim();
    return ["light", "dark", "system"].includes(mode) ? mode : "system";
  }

  get excludeReplies() {
    return this.getAttribute("exclude-replies") !== "false";
  }

  get maxCheck() {
    const n = parseInt(this.getAttribute("max-check") || "20", 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20;
  }

  get count() {
    const n = parseInt(this.getAttribute("count") || "3", 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 3;
  }

  get layout() {
    const value = (this.getAttribute("layout") || "stack").trim().toLowerCase();
    return ["stack", "grid"].includes(value) ? value : "stack";
  }

  renderLoading() {
    this.innerHTML = `
      <div class="bsky-latest-posts__status">
        Loading latest Bluesky posts…
      </div>
    `;
  }

  renderError(message) {
    const profile = this.handle
      ? `<div class="bsky-latest-posts__fallback">
           <a href="https://bsky.app/profile/${encodeURIComponent(this.handle)}" target="_blank" rel="noopener noreferrer">
             View @${this.escapeHtml(this.handle)} on Bluesky
           </a>
         </div>`
      : "";

    this.innerHTML = `
      <div class="bsky-latest-posts__status">
        ${this.escapeHtml(message)}
        ${profile}
      </div>
    `;
  }

  async fetchJson(url) {
    const res = await fetch(url, {
      method: "GET",
      mode: "cors",
      headers: {
        Accept: "application/json"
      }
    });

    const text = await res.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }

    if (!res.ok) {
      const msg = data?.message || data?.error || text || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    return data;
  }

  async resolveDid(handle) {
    const url =
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle` +
      `?handle=${encodeURIComponent(handle)}`;

    const data = await this.fetchJson(url);
    if (!data?.did) {
      throw new Error(`Could not resolve handle: ${handle}`);
    }
    return data.did;
  }

  async getLatestPosts(did) {
    const filter = this.excludeReplies ? "posts_no_replies" : "posts_with_replies";

    const url =
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed` +
      `?actor=${encodeURIComponent(did)}` +
      `&filter=${encodeURIComponent(filter)}` +
      `&limit=${encodeURIComponent(this.maxCheck)}`;

    const data = await this.fetchJson(url);
    const items = Array.isArray(data?.feed) ? data.feed : [];

    const posts = items
      .filter((entry) => {
        if (entry?.reason) return false;
        return Boolean(entry?.post?.uri && entry?.post?.cid);
      })
      .map((entry) => entry.post)
      .slice(0, this.count);

    if (!posts.length) {
      throw new Error("No suitable recent posts found.");
    }

    return posts;
  }

  renderEmbeds(posts) {
    const wrapper = document.createElement("div");
    wrapper.className = `bsky-latest-posts__list bsky-latest-posts__list--${this.layout}`;

    posts.forEach((post) => {
      const item = document.createElement("div");
      item.className = "bsky-latest-posts__item";

      const blockquote = document.createElement("blockquote");
      blockquote.className = "bluesky-embed";
      blockquote.setAttribute("data-bluesky-uri", post.uri);
      blockquote.setAttribute("data-bluesky-cid", post.cid);
      blockquote.setAttribute("data-bluesky-embed-color-mode", this.mode);

      const fallbackText = (post.record && post.record.text) || "View on Bluesky";
      const fallbackLink = document.createElement("a");
      fallbackLink.href = this.toBskyUrl(post.uri);
      fallbackLink.target = "_blank";
      fallbackLink.rel = "noopener noreferrer";
      fallbackLink.textContent = "View on Bluesky";

      const p = document.createElement("p");
      p.textContent = fallbackText;

      blockquote.appendChild(p);
      blockquote.appendChild(document.createTextNode("— "));
      blockquote.appendChild(fallbackLink);

      item.appendChild(blockquote);
      wrapper.appendChild(item);
    });

    this.innerHTML = "";
    this.appendChild(wrapper);
    this.ensureEmbedScript();
  }

  ensureEmbedScript() {
    const existing = document.querySelector('script[src="https://embed.bsky.app/static/embed.js"]');

    if (existing) {
      const replacement = document.createElement("script");
      replacement.async = true;
      replacement.src = "https://embed.bsky.app/static/embed.js";
      replacement.charset = "utf-8";
      existing.replaceWith(replacement);
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.src = "https://embed.bsky.app/static/embed.js";
    script.charset = "utf-8";
    document.body.appendChild(script);
  }

  toBskyUrl(atUri) {
    const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(atUri);
    if (!match) {
      return `https://bsky.app/profile/${encodeURIComponent(this.handle)}`;
    }
    const actor = match[1];
    const rkey = match[2];
    return `https://bsky.app/profile/${actor}/post/${rkey}`;
  }

  escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));
  }

  async load() {
    if (!this.handle) {
      this.renderError("Missing Bluesky handle.");
      return;
    }

    try {
      const did = await this.resolveDid(this.handle);
      const posts = await this.getLatestPosts(did);
      this.renderEmbeds(posts);
    } catch (err) {
      console.error("Bluesky latest posts widget error:", err);
      this.renderError(`Could not load latest posts: ${err.message}`);
    }
  }
}

customElements.define("bluesky-latest-posts", BlueskyLatestPosts);
