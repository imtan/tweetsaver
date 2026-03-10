// Tweet Saver v2.3 — Content Script
// Extracts tweet data + video URLs, renders archive image, saves to Downloads/Eagle.
// Shortcut key is configurable via the popup.
// Compatible with Chrome and Firefox.

(() => {
  "use strict";

  // Browser API compat: Firefox uses `browser`, Chrome uses `chrome`
  const api = typeof browser !== "undefined" ? browser : chrome;

  const SAVE_ICON = `<svg class="tweet-saver-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
  const CHECK_ICON = `<svg class="tweet-saver-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
  const SPIN_ICON = `<svg class="tweet-saver-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;

  const savedTweetIds = new Set();

  // ── Video URL map (populated by interceptor) ──
  const videoUrlMap = new Map(); // tweetId -> { mp4Url, bitrate, allVariants }

  // Listen for video data from the injected interceptor
  window.addEventListener("__tweetsaver_video", (e) => {
    const { tweetId, data } = e.detail;
    if (tweetId && data) {
      videoUrlMap.set(tweetId, data);
    }
  });

  window.addEventListener("__tweetsaver_video_response", (e) => {
    const { tweetId, data } = e.detail;
    if (tweetId && data) {
      videoUrlMap.set(tweetId, data);
    }
  });

  // Inject the interceptor script into the page context
  function injectInterceptor() {
    const script = document.createElement("script");
    script.src = api.runtime.getURL("interceptor.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }
  injectInterceptor();

  // ── Shortcut config ──
  let shortcut = { altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, key: "s" };

  function loadShortcut() {
    api.storage.local.get(["shortcut"], (data) => {
      if (data.shortcut) shortcut = data.shortcut;
      updateAllTooltips();
    });
  }

  // Listen for changes from popup
  api.storage.onChanged.addListener((changes) => {
    if (changes.shortcut) {
      shortcut = changes.shortcut.newValue;
      updateAllTooltips();
    }
  });

  function shortcutLabel() {
    const parts = [];
    if (shortcut.ctrlKey) parts.push("Ctrl");
    if (shortcut.altKey) parts.push("Alt");
    if (shortcut.shiftKey) parts.push("Shift");
    if (shortcut.metaKey) parts.push("Meta");
    let k = shortcut.key;
    if (k === " ") k = "Space";
    else if (k.length === 1) k = k.toUpperCase();
    parts.push(k);
    return parts.join("+");
  }

  function updateAllTooltips() {
    const label = shortcutLabel();
    document.querySelectorAll(".tweet-saver-btn").forEach((btn) => {
      if (btn.classList.contains("tweet-saver-saved")) {
        btn.setAttribute("data-tooltip", "Saved ✓");
      } else {
        btn.setAttribute("data-tooltip", `Save tweet (${label})`);
      }
    });
  }

  loadShortcut();

  // ── Toast ──
  function showToast(msg, isError = false) {
    document.querySelectorAll(".tweet-saver-toast").forEach((el) => el.remove());
    const t = document.createElement("div");
    t.className = "tweet-saver-toast" + (isError ? " tweet-saver-toast-error" : "");
    t.innerHTML = `<span>${isError ? "✕" : "✓"}</span><span>${msg}</span>`;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("tweet-saver-toast-visible"));
    setTimeout(() => {
      t.classList.remove("tweet-saver-toast-visible");
      setTimeout(() => t.remove(), 300);
    }, 3000);
  }

  function isDarkMode() {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/(\d+),\s*(\d+),\s*(\d+)/);
    if (m) return (parseInt(m[1]) + parseInt(m[2]) + parseInt(m[3])) / 3 < 128;
    return true;
  }

  // ── Extract ──
  function extractTweet(article) {
    const data = {
      id: null, username: "", displayName: "", text: "",
      timestamp: "", isoTime: "", url: "",
      imageUrls: [], hasVideo: false, videoUrls: [],
      avatarUrl: "", isVerified: false,
    };

    const timeEl = article.querySelector("time");
    if (timeEl) {
      const a = timeEl.closest("a");
      if (a) {
        data.url = a.href;
        const m = a.href.match(/status\/(\d+)/);
        if (m) data.id = m[1];
      }
      data.isoTime = timeEl.getAttribute("datetime") || "";
      data.timestamp = timeEl.textContent || "";
    }

    const avatarImg = article.querySelector('div[data-testid="Tweet-User-Avatar"] img');
    if (avatarImg) data.avatarUrl = avatarImg.src;

    const userNameEl = article.querySelector('div[data-testid="User-Name"]');
    if (userNameEl) {
      for (const span of userNameEl.querySelectorAll("span")) {
        const t = span.textContent.trim();
        if (t.startsWith("@") && !data.username) data.username = t.slice(1);
      }
      const firstLink = userNameEl.querySelector('a[role="link"]');
      if (firstLink) {
        for (const s of firstLink.querySelectorAll("span")) {
          const t = s.textContent.trim();
          if (t && !t.startsWith("@") && t !== "·") { data.displayName = t; break; }
        }
      }
      if (userNameEl.querySelector('svg[data-testid="icon-verified"]')) data.isVerified = true;
    }

    if (!data.username && data.url) {
      const m = data.url.match(/x\.com\/([^/]+)\/status/);
      if (m) data.username = m[1];
    }

    const textEl = article.querySelector('[data-testid="tweetText"]');
    if (textEl) data.text = textEl.innerText;

    for (const img of article.querySelectorAll('[data-testid="tweetPhoto"] img')) {
      if (img.src && img.src.includes("pbs.twimg.com")) {
        data.imageUrls.push(upgradeImageUrl(img.src));
      }
    }

    // Video detection + URL from interceptor
    if (article.querySelector("video")) {
      data.hasVideo = true;
      if (data.id && videoUrlMap.has(data.id)) {
        const vData = videoUrlMap.get(data.id);
        data.videoUrls.push(vData.mp4Url);
      } else if (data.id) {
        // Try querying the interceptor
        window.dispatchEvent(
          new CustomEvent("__tweetsaver_query_video", {
            detail: { tweetId: data.id },
          })
        );
        // Check again after a tick
        if (videoUrlMap.has(data.id)) {
          data.videoUrls.push(videoUrlMap.get(data.id).mp4Url);
        }
      }
    }

    return data;
  }

  function upgradeImageUrl(url) {
    try { const u = new URL(url); u.searchParams.set("name", "orig"); return u.toString(); }
    catch { return url; }
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Image load failed"));
      img.src = url;
    });
  }

  // ── Canvas Archive Renderer ──
  async function renderArchiveImage(tweet, tweetImages) {
    const dark = isDarkMode();
    const scale = 2;
    const theme = dark
      ? { bg:"#15202b", cardBg:"#192734", text:"#e7e9ea", textSec:"#8b98a5", border:"#38444d", accent:"#1d9bf0", wmBg:"rgba(255,255,255,0.04)", wmText:"rgba(255,255,255,0.15)" }
      : { bg:"#f0f2f5", cardBg:"#ffffff", text:"#0f1419", textSec:"#536471", border:"#e1e8ed", accent:"#1d9bf0", wmBg:"rgba(0,0,0,0.02)", wmText:"rgba(0,0,0,0.10)" };

    const W = 600, PAD = 32, CPAD = 24, AVATAR = 48, IMG_MAX_H = 340;
    const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';

    const tmp = document.createElement("canvas");
    tmp.width = W * scale;
    const tctx = tmp.getContext("2d");
    tctx.scale(scale, scale);
    const bodyFS = 17;
    tctx.font = `${bodyFS}px ${FONT}`;
    const bodyLines = wrapText(tctx, tweet.text, W - PAD * 2 - CPAD * 2);

    const imgCount = tweetImages.length;
    const imgGridH = imgCount > 0 ? IMG_MAX_H + 12 : 0;
    const headerH = AVATAR + 8;
    const bodyH = bodyLines.length * (bodyFS + 7);
    const metaH = 48;
    const cardH = CPAD + headerH + 12 + bodyH + (imgGridH > 0 ? 16 + imgGridH : 0) + 16 + metaH + CPAD;
    const totalH = PAD + cardH + 12 + 36 + PAD;

    const canvas = document.createElement("canvas");
    canvas.width = W * scale;
    canvas.height = totalH * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, W, totalH);

    ctx.save();
    ctx.fillStyle = theme.wmBg;
    for (let i = -totalH; i < W + totalH; i += 40) {
      ctx.save();
      ctx.translate(i, 0);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(0, 0, 1, totalH * 2);
      ctx.restore();
    }
    ctx.restore();

    const cX = PAD, cY = PAD, cW = W - PAD * 2;
    roundRect(ctx, cX, cY, cW, cardH, 16);
    ctx.fillStyle = theme.cardBg; ctx.fill();
    ctx.strokeStyle = theme.border; ctx.lineWidth = 1; ctx.stroke();

    let y = cY + CPAD;
    const cx = cX + CPAD, cw = cW - CPAD * 2;

    try {
      if (tweet.avatarUrl) {
        const av = await loadImage(tweet.avatarUrl);
        ctx.save();
        roundRect(ctx, cx, y, AVATAR, AVATAR, AVATAR / 2);
        ctx.clip();
        ctx.drawImage(av, cx, y, AVATAR, AVATAR);
        ctx.restore();
      }
    } catch {}

    const nx = cx + AVATAR + 12;
    ctx.fillStyle = theme.text;
    ctx.font = `bold 16px ${FONT}`;
    ctx.fillText(tweet.displayName || tweet.username, nx, y + 20);
    let nw = ctx.measureText(tweet.displayName || tweet.username).width;
    if (tweet.isVerified) drawBadge(ctx, nx + nw + 6, y + 9, theme.accent);

    ctx.fillStyle = theme.textSec;
    ctx.font = `14px ${FONT}`;
    ctx.fillText(`@${tweet.username}`, nx, y + 40);
    y += headerH + 12;

    ctx.fillStyle = theme.text;
    ctx.font = `${bodyFS}px ${FONT}`;
    for (const line of bodyLines) {
      ctx.fillText(line, cx, y + bodyFS);
      y += bodyFS + 7;
    }

    if (imgCount > 0) {
      y += 16;
      if (imgCount === 1 && tweetImages[0]) {
        const img = tweetImages[0];
        const asp = img.width / img.height;
        let dw = cw, dh = dw / asp;
        if (dh > IMG_MAX_H) { dh = IMG_MAX_H; dw = dh * asp; }
        ctx.save(); roundRect(ctx, cx, y, dw, dh, 12); ctx.clip();
        ctx.drawImage(img, cx, y, dw, dh); ctx.restore();
        roundRect(ctx, cx, y, dw, dh, 12); ctx.strokeStyle = theme.border; ctx.lineWidth = 1; ctx.stroke();
      } else if (imgCount >= 2) {
        const gap = 4, cols = Math.min(imgCount, 2);
        const cellW = (cw - gap * (cols - 1)) / cols;
        const rows = Math.ceil(imgCount / 2);
        const cellH = (IMG_MAX_H - gap * (rows - 1)) / rows;
        for (let i = 0; i < imgCount && i < 4; i++) {
          const col = i % 2, row = Math.floor(i / 2);
          const px = cx + col * (cellW + gap), py = y + row * (cellH + gap);
          if (tweetImages[i]) {
            ctx.save(); roundRect(ctx, px, py, cellW, cellH, 10); ctx.clip();
            drawCover(ctx, tweetImages[i], px, py, cellW, cellH); ctx.restore();
            roundRect(ctx, px, py, cellW, cellH, 10); ctx.strokeStyle = theme.border; ctx.lineWidth = 1; ctx.stroke();
          }
        }
      }
      y += imgGridH;
    }

    y += 16;
    ctx.fillStyle = theme.textSec; ctx.font = `13px ${FONT}`;
    ctx.fillText(fmtTime(tweet.isoTime), cx, y + 13);
    y += 28;
    ctx.strokeStyle = theme.border; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx + cw, y); ctx.stroke();
    y += 8;
    ctx.fillStyle = theme.accent; ctx.font = `12px ${FONT}`;
    ctx.fillText(tweet.url, cx, y + 12);

    const wmY = cY + cardH + 12;
    ctx.fillStyle = theme.wmText; ctx.font = `11px ${FONT}`; ctx.textAlign = "center";
    ctx.fillText(`Archived by Tweet Saver — ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`, W / 2, wmY + 14);
    ctx.textAlign = "left";

    return canvas.toDataURL("image/png");
  }

  // ── Canvas helpers ──
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
  }

  // CJK-aware text wrapping
  function wrapText(ctx, text, maxW) {
    if (!text) return [""];
    const paragraphs = text.split("\n");
    const lines = [];
    for (const para of paragraphs) {
      if (para.trim() === "") { lines.push(""); continue; }
      const tokens = tokenize(para);
      let line = "";
      for (const token of tokens) {
        const test = line + token;
        if (ctx.measureText(test).width > maxW && line) {
          lines.push(line);
          line = token.replace(/^\s+/, "");
        } else {
          line = test;
        }
        // If a single token exceeds maxW, break it character by character
        while (ctx.measureText(line).width > maxW && line.length > 1) {
          let i = line.length - 1;
          while (i > 1 && ctx.measureText(line.slice(0, i)).width > maxW) i--;
          lines.push(line.slice(0, i));
          line = line.slice(i);
        }
      }
      if (line) lines.push(line);
    }
    return lines.length > 0 ? lines : [""];
  }

  function tokenize(text) {
    const tokens = [];
    const cjkRe = /([\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{2FA1F}]|[^\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{2FA1F}]+)/gu;
    let m;
    while ((m = cjkRe.exec(text)) !== null) {
      const chunk = m[0];
      // Single CJK character — keep as-is
      if (chunk.length === 1) { tokens.push(chunk); continue; }
      // Non-CJK run — split into words at space boundaries
      const words = chunk.match(/\S+\s*|\s+/g);
      if (words) tokens.push(...words);
      else tokens.push(chunk);
    }
    return tokens;
  }

  function drawCover(ctx, img, x, y, w, h) {
    const ia = img.width / img.height, ba = w / h;
    let sx, sy, sw, sh;
    if (ia > ba) { sh = img.height; sw = sh * ba; sx = (img.width - sw) / 2; sy = 0; }
    else { sw = img.width; sh = sw / ba; sx = 0; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }

  function drawBadge(ctx, x, y, color) {
    ctx.save(); ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x + 8, y + 8, 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x + 4, y + 8); ctx.lineTo(x + 7, y + 11); ctx.lineTo(x + 12, y + 5); ctx.stroke();
    ctx.restore();
  }

  function fmtTime(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true,
        month: "short", day: "numeric", year: "numeric",
      });
    } catch { return iso; }
  }

  // ── Save ──
  async function saveTweet(article, btn) {
    const tweet = extractTweet(article);
    if (!tweet.id) { showToast("Could not identify tweet", true); return; }
    if (savedTweetIds.has(tweet.id)) { showToast("Already saved!"); return; }

    btn.classList.add("tweet-saver-saving");
    btn.innerHTML = SPIN_ICON;

    try {
      const tweetImages = [];
      for (const url of tweet.imageUrls) {
        try { tweetImages.push(await loadImage(url)); } catch { tweetImages.push(null); }
      }

      const archiveDataUrl = await renderArchiveImage(tweet, tweetImages);
      // Extract base64 from data URL (for Eagle)
      const archiveBase64 = archiveDataUrl.split(",")[1];

      // Send unified payload to background
      const resp = await api.runtime.sendMessage({
        type: "saveTweet",
        data: {
          tweet: {
            id: tweet.id, username: tweet.username, displayName: tweet.displayName,
            text: tweet.text, timestamp: tweet.isoTime, url: tweet.url,
            imageUrls: tweet.imageUrls, videoUrls: tweet.videoUrls,
            hasVideo: tweet.hasVideo,
            savedAt: new Date().toISOString(),
          },
          // For Downloads
          archivePngDataUrl: archiveDataUrl,
          imageUrls: tweet.imageUrls,
          videoUrls: tweet.videoUrls,
          // For Eagle
          archivePngBase64: archiveBase64,
        },
      });

      if (resp && resp.success) {
        savedTweetIds.add(tweet.id);
        btn.classList.remove("tweet-saver-saving");
        btn.classList.add("tweet-saver-saved");
        btn.innerHTML = CHECK_ICON;
        btn.setAttribute("data-tooltip", "Saved ✓");

        // Build toast message
        const parts = [];
        if (resp.download?.success) parts.push("📁");
        if (resp.eagle?.success) parts.push(`🦅(${resp.eagle.itemCount})`);
        showToast(`@${tweet.username} — ${parts.join(" + ") || "saved"}`);
      } else {
        throw new Error(resp?.error || "Save failed");
      }
    } catch (err) {
      btn.classList.remove("tweet-saver-saving");
      btn.innerHTML = SAVE_ICON;
      showToast(err.message, true);
      console.error("[Tweet Saver]", err);
    }
  }

  function getExt(url) {
    try {
      const m = url.match(/format=(\w+)/); if (m) return m[1];
      const p = new URL(url).pathname.match(/\.(\w+)$/); if (p) return p[1];
    } catch {} return "jpg";
  }

  // ── Inject buttons ──
  function injectButton(article) {
    if (article.querySelector(".tweet-saver-btn")) return;
    const bar = article.querySelector('[role="group"]');
    if (!bar) return;

    const btn = document.createElement("button");
    btn.className = "tweet-saver-btn";
    btn.innerHTML = SAVE_ICON;
    btn.setAttribute("data-tooltip", `Save tweet (${shortcutLabel()})`);

    const timeEl = article.querySelector("time");
    if (timeEl) {
      const a = timeEl.closest("a");
      if (a) {
        const m = a.href.match(/status\/(\d+)/);
        if (m && savedTweetIds.has(m[1])) {
          btn.classList.add("tweet-saver-saved");
          btn.innerHTML = CHECK_ICON;
          btn.setAttribute("data-tooltip", "Saved ✓");
        }
      }
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      saveTweet(article, btn);
    });
    bar.appendChild(btn);
  }

  function processAll() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach(injectButton);
  }

  // ── Keyboard shortcut (configurable) ──
  document.addEventListener("keydown", (e) => {
    // Match configured shortcut
    const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase();
    const modMatch =
      e.altKey === shortcut.altKey &&
      e.ctrlKey === shortcut.ctrlKey &&
      e.shiftKey === shortcut.shiftKey &&
      e.metaKey === shortcut.metaKey;

    if (keyMatch && modMatch) {
      e.preventDefault();
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      const cy = window.innerHeight / 2;
      let best = null, bestD = Infinity;
      for (const a of articles) {
        const r = a.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - cy);
        if (d < bestD) { bestD = d; best = a; }
      }
      if (best) {
        const btn = best.querySelector(".tweet-saver-btn");
        if (btn) saveTweet(best, btn);
      }
    }
  });

  // ── Observer ──
  const obs = new MutationObserver(() => requestAnimationFrame(processAll));
  obs.observe(document.body, { childList: true, subtree: true });
  processAll();
  console.log("[Tweet Saver v2.1] Loaded ✓");
})();
