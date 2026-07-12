const api = typeof browser !== "undefined" ? browser : chrome;

const EAGLE_API = "http://localhost:41595";

// ── Convert data URL to Blob URL (Firefox can't download data: URLs) ──
function dataUrlToBlobUrl(dataUrl) {
  if (typeof URL.createObjectURL !== "function") return dataUrl;
  const parts = dataUrl.split(",");
  const mime = parts[0].match(/:(.*?);/)[1];
  const raw = atob(parts[1]);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  const blob = new Blob([arr], { type: mime });
  return URL.createObjectURL(blob);
}

// ── Start download and wait for completion ──
async function downloadAndWait(url, filename, timeoutMs = 60000) {
  const downloadId = await api.downloads.download({ url, filename, saveAs: false });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      api.downloads.onChanged.removeListener(listener);
      // Cancel, or the timed-out download keeps running while the next variant starts
      api.downloads.cancel(downloadId).catch(() => {});
      reject(new Error("Download timeout"));
    }, timeoutMs);

    function listener(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === "complete") {
        clearTimeout(timeout);
        api.downloads.onChanged.removeListener(listener);
        resolve();
      }
      if (delta.state && delta.state.current === "interrupted") {
        clearTimeout(timeout);
        api.downloads.onChanged.removeListener(listener);
        reject(new Error("Download interrupted"));
      }
    }
    api.downloads.onChanged.addListener(listener);
  });
}

async function downloadFirst(urls, filename, timeoutMs) {
  const errors = [];
  for (const url of urls.filter(Boolean)) {
    try {
      await downloadAndWait(url, filename, timeoutMs);
      return;
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(errors.join("; ") || "No URL");
}

// ── Message handler ──
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "saveTweet") {
    handleSave(message.data)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }
});

async function handleSave(data) {
  // Chrome MV3: the service worker is killed after 30s without extension-API activity,
  // and downloads.onChanged stays silent during a long transfer. Ping to stay alive.
  const keepAlive = setInterval(() => api.runtime.getPlatformInfo(), 20000);
  try {
    const settings = await api.storage.local.get(["saveMode", "eagleFolderId"]);
    const mode = settings.saveMode || "download";

    const results = { download: null, eagle: null };

    if (mode === "download" || mode === "both") {
      results.download = await saveToDownloads(data);
    }

    if (mode === "eagle" || mode === "both") {
      results.eagle = await sendToEagle(data, settings.eagleFolderId);
    }

    const anySuccess =
      (results.download && results.download.success) ||
      (results.eagle && results.eagle.success);

    if (!anySuccess) {
      const errors = [];
      if (results.download && !results.download.success) errors.push("DL: " + results.download.error);
      if (results.eagle && !results.eagle.success) errors.push("Eagle: " + results.eagle.error);
      return { success: false, error: errors.join("; ") };
    }

    return { success: true, mode, download: results.download, eagle: results.eagle };
  } finally {
    clearInterval(keepAlive);
  }
}

// ── Download all files ──
async function saveToDownloads(data) {
  const blobUrls = [];

  try {
    const { tweet, archivePngDataUrl, articlePngDataUrl, imageUrls, videoUrls, quoteImageUrls, cardImageUrl, articleImageUrls, articleMarkdown } = data;
    const folder = `tweets/${tweet.username}_${tweet.id}`;
    let failed = 0;

    // Archive PNG
    if (archivePngDataUrl) {
      const blobUrl = dataUrlToBlobUrl(archivePngDataUrl);
      if (blobUrl !== archivePngDataUrl) blobUrls.push(blobUrl);
      try {
        await downloadAndWait(blobUrl, `${folder}/archive.png`);
      } catch (err) {
        failed++;
        console.warn("[Tweet Saver] Archive DL failed:", err);
      }
    }

    if (articlePngDataUrl) {
      const blobUrl = dataUrlToBlobUrl(articlePngDataUrl);
      if (blobUrl !== articlePngDataUrl) blobUrls.push(blobUrl);
      try {
        await downloadAndWait(blobUrl, `${folder}/article.png`);
      } catch (err) {
        failed++;
        console.warn("[Tweet Saver] Article PNG DL failed:", err);
      }
    }

    // Tweet JSON
    const jsonStr = JSON.stringify(tweet, null, 2);
    const jsonDataUrl = "data:application/json;base64," + btoa(unescape(encodeURIComponent(jsonStr)));
    const jsonBlobUrl = dataUrlToBlobUrl(jsonDataUrl);
    if (jsonBlobUrl !== jsonDataUrl) blobUrls.push(jsonBlobUrl);
    try {
      await downloadAndWait(jsonBlobUrl, `${folder}/tweet.json`);
    } catch { failed++; }

    // Images
    for (let i = 0; i < (imageUrls || []).length; i++) {
      try {
        const ext = getExt(imageUrls[i]);
        await downloadAndWait(imageUrls[i], `${folder}/image_${i + 1}.${ext}`);
      } catch { failed++; }
    }

    // Videos: try all MP4 variants, but save only one successful file.
    // 10min per variant — large videos regularly exceed 60s.
    // Failure is counted, not fatal: hasVideo can be true with no captured URL
    // (quoted-tweet video, interceptor miss), and the rest of the save is already on disk.
    if (tweet.hasVideo) {
      try {
        await downloadFirst(videoUrls || [], `${folder}/video_1.mp4`, 600000);
      } catch (err) {
        failed++;
        console.warn("[Tweet Saver] Video DL failed:", err);
      }
    }

    // Quoted tweet images (引用リツイートの画像)
    for (let i = 0; i < (quoteImageUrls || []).length; i++) {
      try {
        const ext = getExt(quoteImageUrls[i]);
        await downloadAndWait(quoteImageUrls[i], `${folder}/quote_image_${i + 1}.${ext}`);
      } catch { failed++; }
    }

    // Link card / article thumbnail (記事のサムネイル)
    if (cardImageUrl) {
      try {
        const ext = getExt(cardImageUrl);
        await downloadAndWait(cardImageUrl, `${folder}/card_image.${ext}`);
      } catch { failed++; }
    }

    if (articleMarkdown) {
      const mdDataUrl = "data:text/markdown;base64," + btoa(unescape(encodeURIComponent(articleMarkdown)));
      const mdBlobUrl = dataUrlToBlobUrl(mdDataUrl);
      if (mdBlobUrl !== mdDataUrl) blobUrls.push(mdBlobUrl);
      try {
        await downloadAndWait(mdBlobUrl, `${folder}/article.md`);
      } catch { failed++; }
    }

    const seenImages = new Set([...(imageUrls || []), ...(quoteImageUrls || []), cardImageUrl].filter(Boolean));
    let articleImageIndex = 1;
    for (let i = 0; i < (articleImageUrls || []).length; i++) {
      if (seenImages.has(articleImageUrls[i])) continue;
      seenImages.add(articleImageUrls[i]);
      try {
        const ext = getExt(articleImageUrls[i]);
        await downloadAndWait(articleImageUrls[i], `${folder}/article_image_${articleImageIndex++}.${ext}`);
      } catch { failed++; }
    }

    return { success: true, folder, failed };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    for (const u of blobUrls) URL.revokeObjectURL(u);
  }
}

// ── Send to Eagle via addFromURL (same approach as Chrome version) ──
async function sendToEagle(data, folderId) {
  try {
    const { tweet, imageUrls, videoUrls } = data;
    const archivePngBase64 = data.archivePngDataUrl.split(",")[1];
    const articlePngBase64 = data.articlePngDataUrl.split(",")[1];

    const tags = ["tweet", `@${tweet.username}`];
    if (tweet.hasVideo) tags.push("video");
    if (tweet.article) tags.push("article");

    const annotation = [
      tweet.text,
      "",
      `— ${tweet.displayName || tweet.username} (@${tweet.username})`,
      tweet.timestamp ? `  ${tweet.timestamp}` : "",
      `  ${tweet.url}`,
    ].filter(Boolean).join("\n");

    let savedCount = 0;

    // 1. Archive image via addFromURL with base64 data URI
    if (archivePngBase64) {
      try {
        const r = await eagleFetch("/api/item/addFromURL", {
          url: `data:image/png;base64,${archivePngBase64}`,
          name: `@${tweet.username}_${tweet.id}_archive`,
          website: tweet.url,
          tags: [...tags, "archive"],
          annotation,
          folderId: folderId || undefined,
        });
        if (r.status === "success") savedCount++;
        else console.warn("[Tweet Saver] Eagle archive save response:", r);
      } catch (err) {
        console.warn("[Tweet Saver] Eagle archive save failed:", err);
      }
    }

    if (articlePngBase64) {
      try {
        const r = await eagleFetch("/api/item/addFromURL", {
          url: `data:image/png;base64,${articlePngBase64}`,
          name: `@${tweet.username}_${tweet.id}_article`,
          website: tweet.url,
          tags: [...tags, "article"],
          annotation,
          folderId: folderId || undefined,
        });
        if (r.status === "success") savedCount++;
      } catch (err) {
        console.warn("[Tweet Saver] Eagle article PNG save failed:", err);
      }
    }

    // 2. Each tweet image via addFromURL
    for (let i = 0; i < (imageUrls || []).length; i++) {
      try {
        const r = await eagleFetch("/api/item/addFromURL", {
          url: imageUrls[i],
          name: `@${tweet.username}_${tweet.id}_img${i + 1}`,
          website: tweet.url,
          tags,
          annotation,
          folderId: folderId || undefined,
        });
        if (r.status === "success") savedCount++;
      } catch (err) {
        console.warn(`[Tweet Saver] Eagle image ${i + 1} save failed:`, err);
      }
    }

    // 3. Videos via addFromURL
    for (let i = 0; i < Math.min((videoUrls || []).length, 1); i++) {
      try {
        const r = await eagleFetch("/api/item/addFromURL", {
          url: videoUrls[i],
          name: `@${tweet.username}_${tweet.id}_video${i + 1}`,
          website: tweet.url,
          tags: [...tags, "video"],
          annotation,
          folderId: folderId || undefined,
        });
        if (r.status === "success") savedCount++;
      } catch (err) {
        console.warn(`[Tweet Saver] Eagle video ${i + 1} save failed:`, err);
      }
    }

    // 3b. Quoted tweet images (引用リツイートの画像)
    for (let i = 0; i < ((tweet.quote && tweet.quote.imageUrls) || []).length; i++) {
      try {
        const r = await eagleFetch("/api/item/addFromURL", {
          url: tweet.quote.imageUrls[i],
          name: `@${tweet.username}_${tweet.id}_quote_img${i + 1}`,
          website: tweet.url,
          tags: [...tags, "quote"],
          annotation,
          folderId: folderId || undefined,
        });
        if (r.status === "success") savedCount++;
      } catch (err) {
        console.warn(`[Tweet Saver] Eagle quote image ${i + 1} save failed:`, err);
      }
    }

    // 3c. Link card / article (記事): thumbnail + bookmark
    if (tweet.card) {
      const cardAnno = [tweet.card.title, tweet.card.description, tweet.card.url].filter(Boolean).join("\n") || annotation;
      if (tweet.card.imageUrl) {
        try {
          const r = await eagleFetch("/api/item/addFromURL", {
            url: tweet.card.imageUrl,
            name: `@${tweet.username}_${tweet.id}_card`,
            website: tweet.card.url || tweet.url,
            tags: [...tags, "article"],
            annotation: cardAnno,
            folderId: folderId || undefined,
          });
          if (r.status === "success") savedCount++;
        } catch (err) {
          console.warn("[Tweet Saver] Eagle card image save failed:", err);
        }
      }
      if (tweet.card.url) {
        try {
          const r = await eagleFetch("/api/item/addBookmark", {
            url: tweet.card.url,
            name: tweet.card.title || `@${tweet.username}_${tweet.id}_article`,
            tags: [...tags, "article"],
            annotation: cardAnno,
            folderId: folderId || undefined,
          });
          if (r.status === "success") savedCount++;
        } catch (err) {
          console.warn("[Tweet Saver] Eagle article bookmark save failed:", err);
        }
      }
    }

    // 4. Text-only tweet: bookmark fallback
    if (savedCount === 0) {
      try {
        const r = await eagleFetch("/api/item/addBookmark", {
          url: tweet.url,
          name: `@${tweet.username}_${tweet.id}`,
          tags,
          annotation,
          folderId: folderId || undefined,
        });
        if (r.status === "success") savedCount++;
      } catch (err) {
        console.warn("[Tweet Saver] Eagle bookmark save failed:", err);
      }
    }

    if (savedCount > 0) {
      return { success: true, itemCount: savedCount };
    }
    return { success: false, error: "Eagle API: 全アイテムの保存に失敗" };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function eagleFetch(endpoint, body) {
  const resp = await fetch(EAGLE_API + endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

function getExt(url) {
  try {
    const m = url.match(/format=(\w+)/);
    if (m) return m[1];
    const p = new URL(url).pathname.match(/\.(\w+)$/);
    if (p) return p[1];
  } catch {}
  return "jpg";
}
