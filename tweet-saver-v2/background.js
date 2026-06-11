const api = typeof browser !== "undefined" ? browser : chrome;

const EAGLE_API = "http://localhost:41595";

// Chrome MV3 service workers have no URL.createObjectURL but can download data: URLs.
// Firefox event pages have createObjectURL but can't download data: URLs.
const canUseBlobUrl = typeof URL.createObjectURL === "function";

function dataUrlToBlobUrl(dataUrl, blobUrls) {
  const parts = dataUrl.split(",");
  const mime = parts[0].match(/:(.*?);/)[1];
  const raw = atob(parts[1]);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: mime }));
  blobUrls.push(url);
  return url;
}

function archiveDownloadUrl(dataUrl, blobUrls) {
  return canUseBlobUrl ? dataUrlToBlobUrl(dataUrl, blobUrls) : dataUrl;
}

function jsonDownloadUrl(jsonStr, blobUrls) {
  if (canUseBlobUrl) {
    const url = URL.createObjectURL(new Blob([jsonStr], { type: "application/json" }));
    blobUrls.push(url);
    return url;
  }
  return "data:application/json;base64," + btoa(unescape(encodeURIComponent(jsonStr)));
}

function sanitizePathPart(s) {
  return String(s ?? "").replace(/[^\w.-]+/g, "_") || "_";
}

// ── Start download and wait for completion ──
async function downloadAndWait(url, filename) {
  const downloadId = await api.downloads.download({ url, filename, saveAs: false });
  if (downloadId === undefined || downloadId === null) {
    throw new Error("Download start failed");
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      api.downloads.onChanged.removeListener(listener);
      reject(new Error("Download timeout"));
    }, 60000);

    function settle(fn, arg) {
      clearTimeout(timeout);
      api.downloads.onChanged.removeListener(listener);
      fn(arg);
    }

    function listener(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === "complete") {
        settle(resolve);
      } else if (delta.state && delta.state.current === "interrupted") {
        settle(reject, new Error(delta.error?.current || "Download interrupted"));
      }
    }
    api.downloads.onChanged.addListener(listener);

    // The download may already have finished before the listener was attached
    Promise.resolve(api.downloads.search({ id: downloadId }))
      .then((items) => {
        const item = items && items[0];
        if (!item) return;
        if (item.state === "complete") {
          settle(resolve);
        } else if (item.state === "interrupted") {
          settle(reject, new Error(item.error || "Download interrupted"));
        }
      })
      .catch(() => {});
  });
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
    return { success: false, error: errors.join("; ") || "Nothing saved" };
  }

  return { success: true, mode, download: results.download, eagle: results.eagle };
}

// ── Download all files ──
async function saveToDownloads(data) {
  const blobUrls = [];

  try {
    const { tweet, archivePngDataUrl, imageUrls, videoUrls } = data;
    const folder = `tweets/${sanitizePathPart(tweet.username)}_${sanitizePathPart(tweet.id)}`;
    let saved = 0;
    const errors = [];

    // Archive PNG
    if (archivePngDataUrl) {
      try {
        await downloadAndWait(archiveDownloadUrl(archivePngDataUrl, blobUrls), `${folder}/archive.png`);
        saved++;
      } catch (err) {
        errors.push("archive: " + err.message);
        console.warn("[Tweet Saver] Archive DL failed:", err);
      }
    }

    // Tweet JSON
    try {
      const jsonStr = JSON.stringify(tweet, null, 2);
      await downloadAndWait(jsonDownloadUrl(jsonStr, blobUrls), `${folder}/tweet.json`);
      saved++;
    } catch (err) {
      errors.push("json: " + err.message);
      console.warn("[Tweet Saver] JSON DL failed:", err);
    }

    // Images
    for (let i = 0; i < (imageUrls || []).length; i++) {
      try {
        const ext = getExt(imageUrls[i]);
        await downloadAndWait(imageUrls[i], `${folder}/image_${i + 1}.${ext}`);
        saved++;
      } catch (err) {
        errors.push(`image_${i + 1}: ` + err.message);
        console.warn(`[Tweet Saver] Image ${i + 1} DL failed:`, err);
      }
    }

    // Videos
    for (let i = 0; i < (videoUrls || []).length; i++) {
      try {
        await downloadAndWait(videoUrls[i], `${folder}/video_${i + 1}.mp4`);
        saved++;
      } catch (err) {
        errors.push(`video_${i + 1}: ` + err.message);
        console.warn(`[Tweet Saver] Video ${i + 1} DL failed:`, err);
      }
    }

    if (saved === 0) {
      return { success: false, error: errors.join("; ") || "No files saved" };
    }
    return { success: true, folder, fileCount: saved, errors };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    for (const u of blobUrls) URL.revokeObjectURL(u);
  }
}

// ── Send to Eagle via addFromURL ──
async function sendToEagle(data, folderId) {
  try {
    const { tweet, archivePngDataUrl, imageUrls, videoUrls } = data;
    const archivePngBase64 = archivePngDataUrl ? archivePngDataUrl.split(",")[1] : null;

    const tags = ["tweet", `@${tweet.username}`];
    if (tweet.hasVideo) tags.push("video");

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
    for (let i = 0; i < (videoUrls || []).length; i++) {
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
