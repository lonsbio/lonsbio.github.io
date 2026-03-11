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
    const attr = this.getAttribute("exclude-replies");
    return attr !== "false";
  }

  get maxCheck() {
    const n = parseInt(this.getAttribute("max-check") || "10", 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 30) : 10;
  }

  renderLoading() {
    this.innerHTML = `
      <div class="bsky-latest-post__status">
        Loading latest Bluesky post…
      </div>
    `;
  }

  renderError(message) {
    const safeHandle = this.escapeHtml(this.handle || "profile");
    this.innerHTML = `
      <div class="bsky-latest-post__status">
        ${this.escapeHtml(message)}
        ${
          this.handle
            ? `<div class="bsky-latest-post__fallback">
                 <a href="https://bsky.app/profile/${encodeURIComponent(this.handle)}" target="_blank" rel="noopener noreferrer">
                   View @${safeHandle} on Bluesky
                 </a>
               </div>`
            : ""
        }
      </div>
    `;
  }

  async load() {
    if (!this.handle) {
      this.renderError("Missing Bluesky handle.");
      return;
    }

    try {
      const url =
        `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed` +
        `?actor=${encodeURIComponent(this.handle)}` +
        `&limit=${encodeURIComponent(this.maxCheck)}`;

      const res = await fetch(url, {
        headers: { Accept: "application/json" }
      });

      if (!res.ok) {
        throw new Error(`Bluesky API returned ${res.status}`);
      }

      const data = await res.json();
      const items = Array.isArray(data.feed) ? data.feed : [];

      const postItem = items.find((item) => {
        // Skip reposts
        if (item?.reason) return false;

        // Skip replies if requested
        if (this.excludeReplies && item?.reply) return false;

        // Must have a usable post payload
        return Boolean(item?.post?.uri && item?.post?.cid);
      });

      if (!postItem) {
        this.renderError("No suitable recent post found.");
        return;
      }

      this.renderEmbed(postItem.post);
    } catch (err) {
      console.error(err);
      this.renderError("Could not load the latest Bluesky post.");
    }
  }

  renderEmbed(post) {
    const wrapper = document.createElement("div");
    wrapper.className = "bsky-latest-post__embed";

    const blockquote = document.createElement("blockquote");
    blockquote.className = "bluesky-embed";
    blockquote.setAttribute("data-bluesky-uri", post.uri);
    blockquote.setAttribute("data-bluesky-cid", post.cid);
    blockquote.setAttribute("data-bluesky-embed-color-mode", this.mode);

    // Lightweight fallback content before Bluesky's script upgrades it
    const fallbackText =
      post.record?.text ||
      "View this post on Bluesky";

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

    wrapper.appendChild(blockquote);
    this.innerHTML = "";
    this.appendChild(wrapper);

    this.injectEmbedScript();
  }

  injectEmbedScript() {
    // Re-add the official script so newly inserted blockquotes get upgraded
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://embed.bsky.app/static/embed.js";
    script.charset = "utf-8";
    this.appendChild(script);
  }

  toBskyUrl(atUri) {
    // at://did:plc:.../app.bsky.feed.post/3xyz
    const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(atUri);
    if (!match) {
      return `https://bsky.app/profile/${encodeURIComponent(this.handle)}`;
    }
    const did = match[1];
    const rkey = match[2];
    return `https://bsky.app/profile/${did}/post/${rkey}`;
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
}

customElements.define("bluesky-latest-post", BlueskyLatestPost);
