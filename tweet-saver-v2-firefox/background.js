const api = typeof browser !== "undefined" ? browser : chrome;

const EAGLE_API = "http://localhost:41595";

// ── Convert data URL to Blob URL (Firefox can't download data: URLs) ──
function dataUrlToBlobUrl(dataUrl) {
  const parts = dataUrl.split(",");
  const mime = parts[0].match(/:(.*?);/)[1];
  const raw = atob(parts[1]);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  const blob = new Blob([arr], { type: mime });
  return URL.createObjectURL(blob);
}

// ── Start download and wait for completion, return absolute file path ──
function downloadAndGetPath(url, filename) {
  return new Promise((resolve, reject) => {
    api.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      if (api.runtime.lastError || !downloadId) {
        return reject(new Error(api.runtime.lastError?.message || "Download start failed"));
      }

      const timeout = setTimeout(() => {
        api.downloads.onChanged.removeListener(listener);
        reject(new Error("Download timeout"));
      }, 60000);

      function listener(delta) {
        if (delta.id !== downloadId) return;
        if (delta.state && delta.state.current === "complete") {
          clearTimeout(timeout);
          api.downloads.onChanged.removeListener(listener);
          api.downloads.search({ id: downloadId }, (results) => {
            if (results && results[0] && results[0].filename) {
              resolve(results[0].filename);
            } else {
              reject(new Error("Could not resolve download path"));
            }
          });
        }
        if (delta.state && delta.state.current === "interrupted") {
          clearTimeout(timeout);
          api.downloads.onChanged.removeListener(listener);
          reject(new Error("Download interrupted"));
        }
      }
      api.downloads.onChanged.addListener(listener);
    });
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

  // Step 1: Always download files first (collect absolute paths)
  const dlResult = await saveToDownloads(data);

  if (!dlResult.success) {
    return { success: false, error: "Download failed: " + dlResult.error };
  }

  const results = { download: dlResult, eagle: null };

  // Step 2: If Eagle mode, send downloaded files to Eagle via path
  if (mode === "eagle" || mode === "both") {
    results.eagle = await sendToEagle(data.tweet, dlResult.paths, settings.eagleFolderId);
  }

  const anySuccess =
    results.download.success || (results.eagle && results.eagle.success);

  if (!anySuccess) {
    const errors = [];
    if (!results.download.success) errors.push("DL: " + results.download.error);
    if (results.eagle && !results.eagle.success) errors.push("Eagle: " + results.eagle.error);
    return { success: false, error: errors.join("; ") };
  }

  return { success: true, mode, download: results.download, eagle: results.eagle };
}

// ── Download all files, return absolute paths ──
async function saveToDownloads(data) {
  const blobUrls = [];
  const paths = { archive: null, images: [], videos: [] };

  try {
    const { tweet, archivePngDataUrl, imageUrls, videoUrls } = data;
    const folder = `tweets/${tweet.username}_${tweet.id}`;

    // Archive PNG
    if (archivePngDataUrl) {
      const blobUrl = dataUrlToBlobUrl(archivePngDataUrl);
      blobUrls.push(blobUrl);
      try {
        paths.archive = await downloadAndGetPath(blobUrl, `${folder}/archive.png`);
      } catch (err) {
        console.warn("[Tweet Saver] Archive DL failed:", err);
      }
    }

    // Tweet JSON (no need to send to Eagle)
    const jsonStr = JSON.stringify(tweet, null, 2);
    const jsonDataUrl = "data:application/json;base64," + btoa(unescape(encodeURIComponent(jsonStr)));
    const jsonBlobUrl = dataUrlToBlobUrl(jsonDataUrl);
    blobUrls.push(jsonBlobUrl);
    try {
      await downloadAndGetPath(jsonBlobUrl, `${folder}/tweet.json`);
    } catch {}

    // Images
    for (let i = 0; i < (imageUrls || []).length; i++) {
      try {
        const ext = getExt(imageUrls[i]);
        const p = await downloadAndGetPath(imageUrls[i], `${folder}/image_${i + 1}.${ext}`);
        paths.images.push(p);
      } catch {}
    }

    // Videos
    for (let i = 0; i < (videoUrls || []).length; i++) {
      try {
        const p = await downloadAndGetPath(videoUrls[i], `${folder}/video_${i + 1}.mp4`);
        paths.videos.push(p);
      } catch {}
    }

    return { success: true, folder, paths };
  } catch (err) {
    return { success: false, error: err.message, paths };
  } finally {
    for (const u of blobUrls) URL.revokeObjectURL(u);
  }
}

// ── Send downloaded files to Eagle via addFromPaths ──
async function sendToEagle(tweet, filePaths, folderId) {
  const tags = ["tweet", `@${tweet.username}`];
  if (tweet.hasVideo) tags.push("video");

  const annotation = [
    tweet.text,
    "",
    `— ${tweet.displayName || tweet.username} (@${tweet.username})`,
    tweet.timestamp ? `  ${tweet.timestamp}` : "",
    `  ${tweet.url}`,
  ].filter(Boolean).join("\n");

  const items = [];

  if (filePaths.archive) {
    items.push({
      path: filePaths.archive,
      name: `@${tweet.username}_${tweet.id}_archive`,
      website: tweet.url,
      tags: [...tags, "archive"],
      annotation,
    });
  }

  for (let i = 0; i < filePaths.images.length; i++) {
    items.push({
      path: filePaths.images[i],
      name: `@${tweet.username}_${tweet.id}_img${i + 1}`,
      website: tweet.url,
      tags,
      annotation,
    });
  }

  for (let i = 0; i < filePaths.videos.length; i++) {
    items.push({
      path: filePaths.videos[i],
      name: `@${tweet.username}_${tweet.id}_video${i + 1}`,
      website: tweet.url,
      tags: [...tags, "video"],
      annotation,
    });
  }

  // Text-only tweet: bookmark fallback
  if (items.length === 0) {
    try {
      const r = await eagleFetch("/api/item/addBookmark", {
        url: tweet.url,
        name: `@${tweet.username}_${tweet.id}`,
        tags, annotation, folderId: folderId || undefined,
      });
      return r.status === "success"
        ? { success: true, itemCount: 1 }
        : { success: false, error: r.message || "Bookmark failed" };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // Send all at once
  try {
    const r = await eagleFetch("/api/item/addFromPaths", {
      items,
      folderId: folderId || undefined,
    });
    if (r.status === "success") {
      return { success: true, itemCount: items.length };
    }
    return { success: false, error: r.message || "addFromPaths failed" };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function eagleFetch(endpoint, body) {
  const resp = await fetch(EAGLE_API + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
