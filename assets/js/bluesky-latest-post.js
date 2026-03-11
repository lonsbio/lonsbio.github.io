class BlueskyLatestPost extends HTMLElement {
  static get observedAttributes() {
    return ["handle", "mode", "exclude-replies", "max-check"];
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
    const n = parseInt(this.getAttribute("max-check") || "10", 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 10;
  }

  renderLoading() {
    this.innerHTML = `
      <div class="bsky-latest-post__status">
        Loading latest Bluesky post…
      </div>
    `;
  }

  renderError(message) {
    const safe = this.escapeHtml(message);
    const profile = this.handle
      ? `<div class="bsky-latest-post__fallback">
           <a href="https://bsky.app/profile/${encodeURIComponent(this.handle)}" target="_blank" rel="noopener noreferrer">
             View @${this.escapeHtml(this.handle)} on Bluesky
           </a>
         </div>`
      : "";

    this.innerHTML = `
      <div class="bsky-latest-post__status">
        ${safe}
        ${profile}
      </div>
    `;
  }

  async fetchJson(url) {
    const res = await fetch(url, {
      method: "GET",
      mode: "cors",
      headers: {
        "Accept": "application/json"
      }
    });

    const text = await res.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // leave as null
    }

    if (!res.ok) {
      const msg =
        data?.message ||
        data?.error ||
        text ||
        `HTTP ${res.status}`;
      throw new Error(msg);
    }

    return data;
  }

  async resolveDid(handle) {
    // Resolve handle first; this is more reliable than passing raw handle around.
    const url =
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle` +
      `?handle=${encodeURIComponent(handle)}`;

    const data = await this.fetchJson(url);
    if (!data?.did) {
      throw new Error(`Could not resolve handle: ${handle}`);
    }
    return data.did;
  }

  async getLatestPost(did) {
    // Official author feed endpoint; public and unauthenticated.
    // Use feed filtering to avoid replies if requested.
    const filter = this.excludeReplies
      ? "posts_no_replies"
      : "posts_with_replies";

    const url =
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed` +
      `?actor=${encodeURIComponent(did)}` +
      `&filter=${encodeURIComponent(filter)}` +
      `&limit=${encodeURIComponent(this.maxCheck)}`;

    const data = await this.fetchJson(url);
    const items = Array.isArray(data?.feed) ? data.feed : [];

    const item = items.find((entry) => {
      // Skip repost wrappers
      if (entry?.reason) return false;
      return Boolean(entry?.post?.uri && entry?.post?.cid);
    });

    if (!item?.post?.uri || !item?.post?.cid) {
      throw new Error("No suitable recent post found.");
    }

    return item.post;
  }

  renderEmbed(post) {
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

    this.innerHTML = "";
    this.appendChild(blockquote);

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
      const post = await this.getLatestPost(did);
      this.renderEmbed(post);
    } catch (err) {
      console.error("Bluesky latest post widget error:", err);
      this.renderError(`Could not load latest post: ${err.message}`);
    }
  }
}

customElements.define("bluesky-latest-post", BlueskyLatestPost);
