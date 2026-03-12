class BlueskyLatestPosts extends HTMLElement {
  static get observedAttributes() {
    return [
      "source",
      "handle",
      "feed-uri",
      "feed-url",
      "mode",
      "exclude-replies",
      "max-check",
      "count",
      "layout",
      "columns",
      "min-width",
      "uniform-height",
      "box-height",
      "expandable"
    ];
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

  get source() {
    const value = (this.getAttribute("source") || "user").trim().toLowerCase();
    return ["user", "feed"].includes(value) ? value : "user";
  }

  get handle() {
    return (this.getAttribute("handle") || "").replace(/^@/, "").trim();
  }

  get feedUri() {
    return (this.getAttribute("feed-uri") || "").trim();
  }

  get feedUrl() {
    return (this.getAttribute("feed-url") || "").trim();
  }

  get mode() {
    const mode = (this.getAttribute("mode") || "system").trim().toLowerCase();
    return ["light", "dark", "system"].includes(mode) ? mode : "system";
  }

  get excludeReplies() {
    return this.getAttribute("exclude-replies") !== "false";
  }

  get maxCheck() {
    const n = parseInt(this.getAttribute("max-check") || "30", 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 30;
  }

  get count() {
    const n = parseInt(this.getAttribute("count") || "3", 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 3;
  }

  get layout() {
    const value = (this.getAttribute("layout") || "stack").trim().toLowerCase();
    return ["stack", "grid"].includes(value) ? value : "stack";
  }

  get columns() {
    const n = parseInt(this.getAttribute("columns") || "", 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 6) : null;
  }

  get minWidth() {
    const n = parseInt(this.getAttribute("min-width") || "320", 10);
    return Number.isFinite(n) && n >= 180 ? n : 320;
  }

  get uniformHeight() {
    return this.getAttribute("uniform-height") === "true";
  }

  get boxHeight() {
    const n = parseInt(this.getAttribute("box-height") || "430", 10);
    return Number.isFinite(n) && n >= 160 ? n : 430;
  }

  get expandable() {
    return this.getAttribute("expandable") !== "false";
  }

  renderLoading() {
    this.innerHTML = `
      <div class="bsky-latest-posts__status">
        Loading Bluesky posts…
      </div>
    `;
  }

  renderError(message) {
    let fallback = "";

    if (this.source === "user" && this.handle) {
      fallback = `
        <div class="bsky-latest-posts__fallback">
          <a href="https://bsky.app/profile/${encodeURIComponent(this.handle)}" target="_blank" rel="noopener noreferrer">
            View @${this.escapeHtml(this.handle)} on Bluesky
          </a>
        </div>
      `;
    } else if (this.source === "feed" && this.feedUrl) {
      fallback = `
        <div class="bsky-latest-posts__fallback">
          <a href="${this.escapeAttribute(this.feedUrl)}" target="_blank" rel="noopener noreferrer">
            View feed on Bluesky
          </a>
        </div>
      `;
    }

    this.innerHTML = `
      <div class="bsky-latest-posts__status">
        ${this.escapeHtml(message)}
        ${fallback}
      </div>
    `;
  }

  async fetchJson(url) {
    const res = await fetch(url, {
      method: "GET",
      mode: "cors",
      headers: { Accept: "application/json" }
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

  parseFeedUrl(urlString) {
    try {
      const url = new URL(urlString);
      const hostOk = /(^|\.)bsky\.app$/i.test(url.hostname);
      if (!hostOk) {
        throw new Error("Feed URL must be on bsky.app.");
      }

      const parts = url.pathname.split("/").filter(Boolean);
      // Expected: /profile/{handle-or-did}/feed/{rkey}
      if (parts.length < 4 || parts[0] !== "profile" || parts[2] !== "feed") {
        throw new Error("Feed URL must look like /profile/{actor}/feed/{rkey}.");
      }

      const actor = decodeURIComponent(parts[1]);
      const rkey = decodeURIComponent(parts[3]);

      return { actor, rkey };
    } catch (err) {
      throw new Error(`Invalid feed-url: ${err.message}`);
    }
  }

  async resolveFeedUri() {
    if (this.feedUri) {
      return this.feedUri;
    }

    if (!this.feedUrl) {
      throw new Error("Missing feed-uri or feed-url for source='feed'.");
    }

    const { actor, rkey } = this.parseFeedUrl(this.feedUrl);
    const did = actor.startsWith("did:") ? actor : await this.resolveDid(actor);
    return `at://${did}/app.bsky.feed.generator/${rkey}`;
  }

  async getPostsFromUser() {
    if (!this.handle) {
      throw new Error("Missing handle for source='user'.");
    }

    const did = await this.resolveDid(this.handle);
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
        if (this.excludeReplies && entry?.reply) return false;
        return Boolean(entry?.post?.uri && entry?.post?.cid);
      })
      .map((entry) => entry.post)
      .slice(0, this.count);

    if (!posts.length) {
      throw new Error("No suitable recent posts found.");
    }

    return posts;
  }

  async getPostsFromFeed() {
    const feedUri = await this.resolveFeedUri();

    const url =
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed` +
      `?feed=${encodeURIComponent(feedUri)}` +
      `&limit=${encodeURIComponent(this.maxCheck)}`;

    const data = await this.fetchJson(url);
    const items = Array.isArray(data?.feed) ? data.feed : [];

    const posts = items
      .filter((entry) => {
        if (!entry?.post?.uri || !entry?.post?.cid) return false;
        if (this.excludeReplies && entry?.reply) return false;
        return true;
      })
      .map((entry) => entry.post)
      .slice(0, this.count);

    if (!posts.length) {
      throw new Error("No suitable recent posts found in feed.");
    }

    return posts;
  }

  renderEmbeds(posts) {
    const wrapper = document.createElement("div");
    wrapper.className = `bsky-latest-posts__list bsky-latest-posts__list--${this.layout}`;

    if (this.layout === "grid") {
      wrapper.style.setProperty("--bsky-min-width", `${this.minWidth}px`);
      if (this.columns) {
        wrapper.style.setProperty("--bsky-columns", String(this.columns));
      }
    }

    posts.forEach((post, index) => {
      const item = document.createElement("div");
      item.className = "bsky-latest-posts__item";

      if (this.uniformHeight) {
        item.classList.add("bsky-latest-posts__item--uniform");
        item.style.setProperty("--bsky-box-height", `${this.boxHeight}px`);
      }

      const viewport = document.createElement("div");
      viewport.className = "bsky-latest-posts__viewport";

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

      viewport.appendChild(blockquote);
      item.appendChild(viewport);

      if (this.uniformHeight && this.expandable) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "bsky-latest-posts__toggle";
        toggle.textContent = "Expand";
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-controls", `bsky-post-${index}`);

        viewport.id = `bsky-post-${index}`;

        toggle.addEventListener("click", () => {
          const expanded = item.classList.toggle("is-expanded");
          toggle.textContent = expanded ? "Collapse" : "Expand";
          toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
        });

        item.appendChild(toggle);
      }

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
      if (this.source === "user" && this.handle) {
        return `https://bsky.app/profile/${encodeURIComponent(this.handle)}`;
      }
      return "https://bsky.app";
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

  escapeAttribute(str) {
    return this.escapeHtml(str).replace(/`/g, "&#96;");
  }

  async load() {
    try {
      let posts;

      if (this.source === "feed") {
        posts = await this.getPostsFromFeed();
      } else {
        posts = await this.getPostsFromUser();
      }

      this.renderEmbeds(posts);
    } catch (err) {
      console.error("Bluesky posts widget error:", err);
      this.renderError(`Could not load Bluesky posts: ${err.message}`);
    }
  }
}

customElements.define("bluesky-latest-posts", BlueskyLatestPosts);
