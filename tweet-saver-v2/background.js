const api = typeof browser !== "undefined" ? browser : chrome;
// Background service worker
// Handles Downloads + Eagle API saving

const EAGLE_API = "http://localhost:41595";

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "saveTweet") {
    handleSave(message.data)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }
});

async function handleSave(data) {
  // Load settings
  const settings = await api.storage.local.get(["saveMode", "eagleFolderId"]);
  const mode = settings.saveMode || "download";

  const results = { download: null, eagle: null };

  // Download mode
  if (mode === "download" || mode === "both") {
    results.download = await saveToDownloads(data);
  }

  // Eagle mode
  if (mode === "eagle" || mode === "both") {
    results.eagle = await saveToEagle(data, settings.eagleFolderId);
  }

  // Determine overall success
  const anySuccess =
    (results.download && results.download.success) ||
    (results.eagle && results.eagle.success);

  if (!anySuccess) {
    const errors = [];
    if (results.download && !results.download.success) errors.push("DL: " + results.download.error);
    if (results.eagle && !results.eagle.success) errors.push("Eagle: " + results.eagle.error);
    return { success: false, error: errors.join("; ") };
  }

  return {
    success: true,
    mode,
    download: results.download,
    eagle: results.eagle,
  };
}

// ── Download to filesystem ──
async function saveToDownloads(data) {
  try {
    const { tweet, archivePngDataUrl, imageUrls, videoUrls } = data;
    const folder = `tweets/${tweet.username}_${tweet.id}`;

    // Archive PNG
    await api.downloads.download({
      url: archivePngDataUrl,
      filename: `${folder}/archive.png`,
      saveAs: false,
    });

    // Tweet JSON
    const jsonStr = JSON.stringify(tweet, null, 2);
    const jsonUrl = "data:application/json;base64," + btoa(unescape(encodeURIComponent(jsonStr)));
    await api.downloads.download({
      url: jsonUrl,
      filename: `${folder}/tweet.json`,
      saveAs: false,
    });

    // Individual images
    for (let i = 0; i < imageUrls.length; i++) {
      const ext = getExt(imageUrls[i]);
      try {
        await api.downloads.download({
          url: imageUrls[i],
          filename: `${folder}/image_${i + 1}.${ext}`,
          saveAs: false,
        });
      } catch {}
    }

    // Videos
    if (videoUrls && videoUrls.length > 0) {
      for (let i = 0; i < videoUrls.length; i++) {
        try {
          await api.downloads.download({
            url: videoUrls[i],
            filename: `${folder}/video_${i + 1}.mp4`,
            saveAs: false,
          });
        } catch {}
      }
    }

    return { success: true, folder };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Save to Eagle ──
async function saveToEagle(data, folderId) {
  try {
    const { tweet, archivePngBase64 } = data;

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
        const archiveResp = await fetch(`${EAGLE_API}/api/item/addFromURL`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: `data:image/png;base64,${archivePngBase64}`,
            name: `@${tweet.username}_${tweet.id}_archive`,
            website: tweet.url,
            tags: [...tags, "archive"],
            annotation,
            folderId: folderId || undefined,
          }),
        });
        const archiveJson = await archiveResp.json();
        if (archiveJson.status === "success") savedCount++;
        else console.warn("[Tweet Saver] Eagle archive save response:", archiveJson);
      } catch (err) {
        console.warn("[Tweet Saver] Eagle archive save failed:", err);
      }
    }

    // 2. Each tweet image via addFromURL (direct URL — Eagle downloads them)
    for (let i = 0; i < (tweet.imageUrls || []).length; i++) {
      try {
        const imgResp = await fetch(`${EAGLE_API}/api/item/addFromURL`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: tweet.imageUrls[i],
            name: `@${tweet.username}_${tweet.id}_img${i + 1}`,
            website: tweet.url,
            tags,
            annotation,
            folderId: folderId || undefined,
          }),
        });
        const imgJson = await imgResp.json();
        if (imgJson.status === "success") savedCount++;
      } catch (err) {
        console.warn(`[Tweet Saver] Eagle image ${i + 1} save failed:`, err);
      }
    }

    // 3. Videos via addFromURL (mp4 direct URL)
    for (let i = 0; i < (tweet.videoUrls || []).length; i++) {
      try {
        const vidResp = await fetch(`${EAGLE_API}/api/item/addFromURL`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: tweet.videoUrls[i],
            name: `@${tweet.username}_${tweet.id}_video${i + 1}`,
            website: tweet.url,
            tags: [...tags, "video"],
            annotation,
            folderId: folderId || undefined,
          }),
        });
        const vidJson = await vidResp.json();
        if (vidJson.status === "success") savedCount++;
      } catch (err) {
        console.warn(`[Tweet Saver] Eagle video ${i + 1} save failed:`, err);
      }
    }

    // 4. If text-only tweet (no images, no video, no archive), save as bookmark
    if (savedCount === 0) {
      try {
        const bmResp = await fetch(`${EAGLE_API}/api/item/addBookmark`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: tweet.url,
            name: `@${tweet.username}_${tweet.id}`,
            tags,
            annotation,
            folderId: folderId || undefined,
          }),
        });
        const bmJson = await bmResp.json();
        if (bmJson.status === "success") savedCount++;
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

function getExt(url) {
  try {
    const m = url.match(/format=(\w+)/);
    if (m) return m[1];
    const p = new URL(url).pathname.match(/\.(\w+)$/);
    if (p) return p[1];
  } catch {}
  return "jpg";
}
