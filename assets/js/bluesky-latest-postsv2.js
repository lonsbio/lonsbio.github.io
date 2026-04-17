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
      "gap",
      "uniform-height",
      "box-height",
      "expandable",
      "show-expand-only-when-needed"
    ];
  }

  static defaults = {
    source: "user",
    mode: "system",
    excludeReplies: true,
    maxCheck: 30,
    count: 3,
    layout: "stack",
    minWidth: 320,
    gap: "1rem",
    uniformHeight: false,
    boxHeight: 430,
    expandable: true,
    showExpandOnlyWhenNeeded: true
  };

  static _embedScriptPromise = null;
  static _didCache = new Map();
  static _instanceCounter = 0;

  constructor() {
    super();
    this._resizeObserver = null;
    this._reloadTimer = null;
    this._overflowTimers = [];
    this._loadVersion = 0;
    this._instanceId = `bsky-latest-posts-${++BlueskyLatestPosts._instanceCounter}`;
  }

  connectedCallback() {
    this.renderLoading();
    this.load();
  }

  disconnectedCallback() {
    this.cleanupObserversAndTimers();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;

    clearTimeout(this._reloadTimer);
    this._reloadTimer = setTimeout(() => {
      this.cleanupObserversAndTimers({ keepReloadTimer: true });
      this.renderLoading();
      this.load();
    }, 0);
  }

  cleanupObserversAndTimers(options = {}) {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    this._overflowTimers.forEach(clearTimeout);
    this._overflowTimers = [];

    if (!options.keepReloadTimer) {
      clearTimeout(this._reloadTimer);
      this._reloadTimer = null;
    }
  }

  getBoolAttr(name, defaultValue = false) {
    const value = this.getAttribute(name);
    if (value === null) return defaultValue;
    return value !== "false";
  }

  getIntAttr(name, defaultValue, { min = -Infinity, max = Infinity } = {}) {
    const raw = this.getAttribute(name);
    const n = parseInt(raw ?? String(defaultValue), 10);
    if (!Number.isFinite(n)) return defaultValue;
    return Math.min(max, Math.max(min, n));
  }

  get source() {
    const explicit = (this.getAttribute("source") || "").trim().toLowerCase();
    if (explicit === "user" || explicit === "feed") return explicit;
    if (this.feedUri || this.feedUrl) return "feed";
    return BlueskyLatestPosts.defaults.source;
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
    const mode = (this.getAttribute("mode") || BlueskyLatestPosts.defaults.mode).trim().toLowerCase();
    return ["light", "dark", "system"].includes(mode) ? mode : BlueskyLatestPosts.defaults.mode;
  }

  get excludeReplies() {
    return this.getBoolAttr("exclude-replies", BlueskyLatestPosts.defaults.excludeReplies);
  }

  get maxCheck() {
    return this.getIntAttr("max-check", BlueskyLatestPosts.defaults.maxCheck, { min: 1, max: 100 });
  }

  get count() {
    return this.getIntAttr("count", BlueskyLatestPosts.defaults.count, { min: 1, max: 20 });
  }

  get layout() {
    const value = (this.getAttribute("layout") || BlueskyLatestPosts.defaults.layout).trim().toLowerCase();
    return ["stack", "grid"].includes(value) ? value : BlueskyLatestPosts.defaults.layout;
  }

  get columns() {
    const raw = this.getAttribute("columns");
    if (raw == null || raw.trim() === "") return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 12) : null;
  }

  get minWidth() {
    return this.getIntAttr("min-width", BlueskyLatestPosts.defaults.minWidth, { min: 180 });
  }

  get gap() {
    const raw = (this.getAttribute("gap") || BlueskyLatestPosts.defaults.gap).trim();
    return raw || BlueskyLatestPosts.defaults.gap;
  }

  get uniformHeight() {
    return this.getBoolAttr("uniform-height", BlueskyLatestPosts.defaults.uniformHeight);
  }

  get boxHeight() {
    return this.getIntAttr("box-height", BlueskyLatestPosts.defaults.boxHeight, { min: 160 });
  }

  get expandable() {
    return this.getBoolAttr("expandable", BlueskyLatestPosts.defaults.expandable);
  }

  get showExpandOnlyWhenNeeded() {
    return this.getBoolAttr(
      "show-expand-only-when-needed",
      BlueskyLatestPosts.defaults.showExpandOnlyWhenNeeded
    );
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
    } catch {
      data = null;
    }

    if (!res.ok) {
      const msg = data?.message || data?.error || text || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    return data;
  }

  async resolveDid(handle) {
    const normalized = handle.trim().toLowerCase();

    if (BlueskyLatestPosts._didCache.has(normalized)) {
      return BlueskyLatestPosts._didCache.get(normalized);
    }

    const url =
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle` +
      `?handle=${encodeURIComponent(normalized)}`;

    const data = await this.fetchJson(url);
    if (!data?.did) {
      throw new Error(`Could not resolve handle: ${handle}`);
    }

    BlueskyLatestPosts._didCache.set(normalized, data.did);
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
    if (this.feedUri) return this.feedUri;

    if (!this.feedUrl) {
      throw new Error("Missing feed-uri or feed-url for feed source.");
    }

    const { actor, rkey } = this.parseFeedUrl(this.feedUrl);
    const did = actor.startsWith("did:") ? actor : await this.resolveDid(actor);
    return `at://${did}/app.bsky.feed.generator/${rkey}`;
  }

  isUsablePost(entry) {
    return Boolean(entry?.post?.uri && entry?.post?.cid);
  }

  async getPostsFromUser() {
    if (!this.handle) {
      throw new Error("Missing Bluesky handle.");
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
        return this.isUsablePost(entry);
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
        if (!this.isUsablePost(entry)) return false;
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

  async renderEmbeds(posts) {
    const layout = this.layout;
    const columns = this.columns;
    const minWidth = this.minWidth;
    const gap = this.gap;
    const uniformHeight = this.uniformHeight;
    const boxHeight = this.boxHeight;
    const expandable = this.expandable;
    const showExpandOnlyWhenNeeded = this.showExpandOnlyWhenNeeded;
    const mode = this.mode;

    const wrapper = document.createElement("div");
    wrapper.className = `bsky-latest-posts__list bsky-latest-posts__list--${layout}`;
    wrapper.style.gap = gap;

    if (layout === "grid") {
      wrapper.style.display = "grid";
      if (columns) {
        wrapper.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
      } else {
        wrapper.style.gridTemplateColumns = `repeat(auto-fit, minmax(${minWidth}px, 1fr))`;
      }
    } else {
      wrapper.style.display = "grid";
      wrapper.style.gridTemplateColumns = "minmax(0, 1fr)";
    }

    posts.forEach((post, index) => {
      const item = document.createElement("article");
      item.className = "bsky-latest-posts__item";

      if (uniformHeight) {
        item.classList.add("bsky-latest-posts__item--uniform");
        item.style.setProperty("--bsky-box-height", `${boxHeight}px`);
      }

      const cardLink = document.createElement("a");
      cardLink.className = "bsky-latest-posts__cardlink";
      cardLink.href = this.toBskyUrl(post.uri);
      cardLink.target = "_blank";
      cardLink.rel = "noopener noreferrer";
      cardLink.setAttribute(
        "aria-label",
        `Open Bluesky post${post?.author?.handle ? ` by @${post.author.handle}` : ""}`
      );

      const viewport = document.createElement("div");
      viewport.className = "bsky-latest-posts__viewport";
      viewport.id = `${this._instanceId}-post-${index}`;

      const blockquote = document.createElement("blockquote");
      blockquote.className = "bluesky-embed";
      blockquote.setAttribute("data-bluesky-uri", post.uri);
      blockquote.setAttribute("data-bluesky-cid", post.cid);
      blockquote.setAttribute("data-bluesky-embed-color-mode", mode);

      const fallbackText = (post.record && post.record.text) || "View on Bluesky";
      const fallbackP = document.createElement("p");
      fallbackP.textContent = fallbackText;

      blockquote.appendChild(fallbackP);
      viewport.appendChild(blockquote);
      cardLink.appendChild(viewport);
      item.appendChild(cardLink);

      if (uniformHeight && expandable) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "bsky-latest-posts__toggle";
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-controls", viewport.id);

        toggle.innerHTML = `
          <span class="bsky-latest-posts__toggle-icon" aria-hidden="true">▾</span>
          <span class="sr-only">Expand post</span>
        `;

        if (showExpandOnlyWhenNeeded) {
          toggle.hidden = true;
        }

        toggle.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();

          const expanded = item.classList.toggle("is-expanded");
          toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
          toggle.innerHTML = expanded
            ? `<span class="bsky-latest-posts__toggle-icon" aria-hidden="true">▴</span><span class="sr-only">Collapse post</span>`
            : `<span class="bsky-latest-posts__toggle-icon" aria-hidden="true">▾</span><span class="sr-only">Expand post</span>`;
        });

        item.appendChild(toggle);
      }

      wrapper.appendChild(item);
    });

    this.innerHTML = "";
    this.appendChild(wrapper);

    await this.ensureEmbedScript();
    this.scheduleOverflowCheck();
  }

  ensureEmbedScript() {
    if (window.blueskyEmbed?.init) {
      window.blueskyEmbed.init();
      return Promise.resolve();
    }

    if (BlueskyLatestPosts._embedScriptPromise) {
      return BlueskyLatestPosts._embedScriptPromise.then(() => {
        window.blueskyEmbed?.init?.();
      });
    }

    BlueskyLatestPosts._embedScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.async = true;
      script.src = "https://embed.bsky.app/static/embed.js";
      script.charset = "utf-8";

      script.onload = () => {
        window.blueskyEmbed?.init?.();
        resolve();
      };

      script.onerror = () => {
        reject(new Error("Failed to load Bluesky embed script."));
      };

      document.body.appendChild(script);
    });

    return BlueskyLatestPosts._embedScriptPromise;
  }

  scheduleOverflowCheck() {
    if (!this.uniformHeight || !this.expandable) return;

    const run = () => this.updateExpandButtonsIfNeeded();

    requestAnimationFrame(() => {
      run();

      [250, 750, 1500, 2500].forEach((delay) => {
        const timer = setTimeout(run, delay);
        this._overflowTimers.push(timer);
      });
    });

    if ("ResizeObserver" in window) {
      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
      }

      this._resizeObserver = new ResizeObserver(() => {
        this.updateExpandButtonsIfNeeded();
      });

      this.querySelectorAll(".bsky-latest-posts__viewport").forEach((el) => {
        this._resizeObserver.observe(el);
      });
    }
  }

  updateExpandButtonsIfNeeded() {
    const items = this.querySelectorAll(".bsky-latest-posts__item--uniform");

    items.forEach((item) => {
      const viewport = item.querySelector(".bsky-latest-posts__viewport");
      const toggle = item.querySelector(".bsky-latest-posts__toggle");
      if (!viewport || !toggle) return;

      const expanded = item.classList.contains("is-expanded");
      const maxHeight = this.boxHeight;
      const contentHeight = viewport.scrollHeight;
      const needsExpand = contentHeight > maxHeight + 6;

      item.classList.toggle("is-expandable", needsExpand);

      if (this.showExpandOnlyWhenNeeded) {
        toggle.hidden = !needsExpand;
      } else {
        toggle.hidden = false;
      }

      if (!needsExpand && expanded) {
        item.classList.remove("is-expanded");
        toggle.setAttribute("aria-expanded", "false");
        toggle.innerHTML = `
          <span class="bsky-latest-posts__toggle-icon" aria-hidden="true">▾</span>
          <span class="sr-only">Expand post</span>
        `;
      }
    });
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

  normalizeErrorMessage(err) {
    const message = err?.message || "Unknown error";

    if (/Failed to fetch/i.test(message)) {
      return "Network error while loading Bluesky posts.";
    }
    if (/Could not resolve handle/i.test(message)) {
      return message;
    }
    if (/Missing Bluesky handle/i.test(message)) {
      return message;
    }
    if (/Missing feed-uri or feed-url/i.test(message)) {
      return message;
    }
    if (/Invalid feed-url/i.test(message)) {
      return message;
    }
    if (/Failed to load Bluesky embed script/i.test(message)) {
      return "Posts loaded, but the Bluesky embed script could not be loaded.";
    }

    return message;
  }

  async load() {
    const version = ++this._loadVersion;

    try {
      const posts = this.source === "feed"
        ? await this.getPostsFromFeed()
        : await this.getPostsFromUser();

      if (version !== this._loadVersion) return;

      await this.renderEmbeds(posts);
    } catch (err) {
      if (version !== this._loadVersion) return;

      console.error("Bluesky posts widget error:", err);
      this.renderError(`Could not load Bluesky posts: ${this.normalizeErrorMessage(err)}`);
    }
  }
}

if (!customElements.get("bluesky-latest-posts")) {
  customElements.define("bluesky-latest-posts", BlueskyLatestPosts);
}