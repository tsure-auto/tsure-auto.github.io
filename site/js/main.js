document.addEventListener("DOMContentLoaded", () => {
  initTopbar();
  initThemeToggle();
  initHomepageBlog();
});

function initTopbar() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;

  const connectSection = document.querySelector(".connect-section");
  const setCompact = (on) => {
    topbar.classList.toggle("is-compact", on);
    if (connectSection) connectSection.classList.toggle("is-compact", on);
  };

  const onScroll = () => setCompact(window.scrollY > 80);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

let ALL_POSTS = [];
let ACTIVE_TAG = "all";

function normalizeTag(tag) {
  return String(tag || "").trim();
}

function getPostTags(post) {
  const raw = post?.tags ?? [];
  if (Array.isArray(raw)) return raw.map(normalizeTag).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map(normalizeTag).filter(Boolean);
  return [];
}

function getAllTags(posts) {
  const tags = new Set();
  for (const post of posts) {
    for (const tag of getPostTags(post)) tags.add(tag);
  }
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

function renderTagFilters(tags) {
  const host = document.getElementById("blogFilters");
  if (!host) return;

  host.replaceChildren();
  for (const tag of ["all", ...tags]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `blog-tag${tag === ACTIVE_TAG ? " is-active" : ""}`;
    button.textContent = tag === "all" ? "All" : tag;

    button.addEventListener("click", () => {
      ACTIVE_TAG = tag;
      renderTagFilters(tags);
      const filtered =
        tag === "all" ? ALL_POSTS : ALL_POSTS.filter((post) => getPostTags(post).includes(tag));
      renderBlogCards(filtered);
    });

    host.appendChild(button);
  }
}

function renderBlogCards(posts) {
  const grid = document.getElementById("blogGrid");
  const status = document.getElementById("blogStatus");
  if (!grid || !status) return;

  grid.replaceChildren();
  if (!posts.length) {
    status.textContent = "No posts yet.";
    return;
  }

  status.textContent = "";
  for (const post of posts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "blog-card";

    const title = document.createElement("div");
    title.className = "blog-card-title";
    title.textContent = post.title || post.post_id;

    const description = document.createElement("p");
    description.className = "blog-card-desc";
    description.textContent = post.excerpt || "Read this post.";

    const date = document.createElement("div");
    date.className = "blog-card-meta";
    date.textContent = post.published || "";

    button.append(title, description, date);

    const tags = getPostTags(post);
    if (tags.length) {
      const tagHost = document.createElement("div");
      tagHost.className = "blog-card-tags";
      for (const tag of tags) {
        const badge = document.createElement("span");
        badge.className = "blog-tag";
        badge.setAttribute("aria-hidden", "true");
        badge.textContent = tag;
        tagHost.appendChild(badge);
      }
      button.appendChild(tagHost);
    }

    button.addEventListener("click", async () => {
      setBlogDeepLink(post.post_id);
      await openPostInModal(post.post_id);
    });
    grid.appendChild(button);
  }
}

function getBlogDeepLink() {
  const hash = window.location.hash || "";
  if (!hash.startsWith("#blog")) return null;

  const queryIndex = hash.indexOf("?");
  const params = new URLSearchParams(queryIndex >= 0 ? hash.slice(queryIndex + 1) : "");
  return { id: params.get("id") || "" };
}

function setBlogDeepLink(postId) {
  history.pushState({ blogPostId: postId }, "", `/#blog?id=${encodeURIComponent(postId)}`);
}

function clearBlogDeepLink() {
  history.pushState({ blogPostId: "" }, "", "/#blog");
}

function openBlogModal() {
  const modal = document.getElementById("blogModal");
  if (!modal) return;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeBlogModal() {
  const modal = document.getElementById("blogModal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "");
}

async function openPostInModal(postId) {
  const body = document.getElementById("blogModalBody");
  const post = ALL_POSTS.find((item) => item.post_id === postId);
  if (!body || !post) return;

  document.getElementById("blog")?.scrollIntoView({ behavior: "smooth", block: "start" });
  body.innerHTML = '<div class="muted">Loading…</div>';
  openBlogModal();

  try {
    const response = await fetch(post.markdown_url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Unable to load ${post.title}`);
    if (!window.marked) throw new Error("Markdown renderer did not load");

    const markdown = stripFrontmatter(await response.text());
    body.replaceChildren();

    const title = document.createElement("h1");
    title.textContent = post.title;

    const meta = document.createElement("div");
    meta.className = "blog-post-meta";
    meta.textContent = `${post.post_id}${post.published ? ` · ${post.published}` : ""}`;

    const content = document.createElement("div");
    content.className = "blog-post-content";
    content.innerHTML = window.marked.parse(markdown);

    body.append(title, meta, content);
    if (window.Prism) Prism.highlightAllUnder(body);
    addCopyButtonsToCodeBlocks(body);
  } catch (error) {
    body.innerHTML = `<div class="muted">Failed to load post: ${error.message}</div>`;
  }
}

function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);

  return new Promise((resolve, reject) => {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}

function addCopyButtonsToCodeBlocks(container) {
  for (const pre of container.querySelectorAll("pre")) {
    if (pre.dataset.hasCopy === "1") continue;
    const code = pre.querySelector("code");
    if (!code) continue;

    pre.dataset.hasCopy = "1";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy-btn";
    button.textContent = "Copy";
    button.addEventListener("click", async () => {
      try {
        await copyTextToClipboard(code.textContent || "");
        button.textContent = "Copied!";
        button.classList.add("is-copied");
      } catch {
        button.textContent = "Failed";
      }
      setTimeout(() => {
        button.textContent = "Copy";
        button.classList.remove("is-copied");
      }, 1200);
    });
    pre.appendChild(button);
  }
}

async function initHomepageBlog() {
  const status = document.getElementById("blogStatus");
  if (!document.getElementById("blogGrid") || !status) return;

  try {
    const response = await fetch("/blog/posts.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Post index not found");

    const data = await response.json();
    ALL_POSTS = data.items || [];
    renderTagFilters(getAllTags(ALL_POSTS));
    renderBlogCards(ALL_POSTS);

    const deepLink = getBlogDeepLink();
    if (deepLink?.id) await openPostInModal(deepLink.id);
  } catch (error) {
    status.textContent = `Failed to load: ${error.message}`;
  }
}

document.addEventListener("click", (event) => {
  if (event.target?.matches?.("[data-close='true']")) {
    closeBlogModal();
    clearBlogDeepLink();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeBlogModal();
    clearBlogDeepLink();
  }
});

window.addEventListener("popstate", async () => {
  const deepLink = getBlogDeepLink();
  if (deepLink?.id) await openPostInModal(deepLink.id);
  else closeBlogModal();
});

function getPreferredTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const icon = document.getElementById("themeToggleIcon");
  const button = document.getElementById("themeToggle");
  if (icon) icon.textContent = theme === "light" ? "☀️" : "🌙";
  if (button) button.setAttribute("aria-label", `Switch to ${theme === "light" ? "dark" : "light"} mode`);
}

function initThemeToggle() {
  const button = document.getElementById("themeToggle");
  if (!button) return;
  applyTheme(getPreferredTheme());
  button.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem("theme", next);
    applyTheme(next);
  });
}
