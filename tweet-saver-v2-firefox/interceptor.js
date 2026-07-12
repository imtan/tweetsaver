// This script is injected into the PAGE context (not content script context)
// to intercept fetch() responses from Twitter's internal API and extract video URLs.

(() => {
  const videoMap = {}; // tweetId -> { mp4Url, bitrate, contentType }
  const articleMap = {}; // tweetId/articleId -> normalized X Article data

  // Extract video info from Twitter API response data recursively
  function extractVideos(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 20) return;

    // Look for tweet-like objects with video_info
    if (obj.video_info && obj.video_info.variants) {
      // Find the parent tweet's id_str
      let tweetId = obj.id_str;

      // video_info.variants contains different qualities
      const mp4Variants = obj.video_info.variants
        .filter((v) => v.content_type === "video/mp4" && v.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (mp4Variants.length > 0 && tweetId) {
        videoMap[tweetId] = {
          mp4Url: mp4Variants[0].url, // highest bitrate
          bitrate: mp4Variants[0].bitrate,
          allVariants: mp4Variants.map((v) => ({ url: v.url, bitrate: v.bitrate })),
        };
        // Notify content script
        window.dispatchEvent(
          new CustomEvent("__tweetsaver_video", {
            detail: { tweetId, data: videoMap[tweetId] },
          })
        );
      }
    }

    // Also check for the newer GraphQL response format
    // where video info is nested inside media entities
    if (obj.media_key && obj.video_info) {
      // handled above
    }

    // Check for legacy tweet format (inside result.legacy)
    if (obj.rest_id && obj.legacy && obj.legacy.extended_entities) {
      const restId = obj.rest_id;
      const entities = obj.legacy.extended_entities;
      if (entities.media) {
        for (const media of entities.media) {
          if (media.video_info && media.video_info.variants) {
            const mp4s = media.video_info.variants
              .filter((v) => v.content_type === "video/mp4" && v.url)
              .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

            if (mp4s.length > 0) {
              videoMap[restId] = {
                mp4Url: mp4s[0].url,
                bitrate: mp4s[0].bitrate,
                allVariants: mp4s.map((v) => ({ url: v.url, bitrate: v.bitrate })),
              };
              window.dispatchEvent(
                new CustomEvent("__tweetsaver_video", {
                  detail: { tweetId: restId, data: videoMap[restId] },
                })
              );
            }
          }
        }
      }
    }

    // Recurse
    if (Array.isArray(obj)) {
      for (const item of obj) extractVideos(item, depth + 1);
    } else {
      for (const key of Object.keys(obj)) {
        try {
          extractVideos(obj[key], depth + 1);
        } catch {}
      }
    }
  }

  function deepGet(obj, ...keys) {
    let cur = obj;
    for (const key of keys) {
      if (!cur || typeof cur !== "object") return undefined;
      cur = cur[key];
    }
    return cur;
  }

  function normalizeEntityMap(entityMap) {
    if (!entityMap || typeof entityMap !== "object") return {};
    if (!Array.isArray(entityMap)) return entityMap;
    const out = {};
    for (const item of entityMap) {
      if (item && item.key != null && item.value) out[String(item.key)] = item.value;
    }
    return out;
  }

  function findImageUrls(value, out = []) {
    if (!value) return out;
    if (typeof value === "string") {
      if (/^https:\/\/pbs\.twimg\.com\//.test(value) && !/profile_images|emoji/i.test(value)) out.push(value);
      return out;
    }
    if (Array.isArray(value)) {
      for (const item of value) findImageUrls(item, out);
      return out;
    }
    if (typeof value !== "object") return out;
    for (const key of ["original_img_url", "originalImgUrl", "media_url_https", "mediaUrlHttps", "media_url", "mediaUrl", "url", "src", "uri"]) {
      findImageUrls(value[key], out);
    }
    for (const nested of Object.values(value)) findImageUrls(nested, out);
    return [...new Set(out)];
  }

  function articleMediaUrlMap(article) {
    const out = {};
    for (const media of [article.cover_media, ...(article.media_entities || [])]) {
      if (!media || typeof media !== "object") continue;
      const url = findImageUrls(media.media_info || media)[0];
      if (!url) continue;
      for (const key of ["media_id", "media_key", "id"]) {
        if (media[key]) out[String(media[key])] = url;
      }
    }
    return out;
  }

  function articleEntityImageUrls(block, entityMap, mediaUrls) {
    const out = [];
    for (const range of block.entityRanges || []) {
      const entity = entityMap[String(range.key)];
      if (!entity) continue;
      const direct = findImageUrls(entity);
      out.push(...direct);
      const items = deepGet(entity, "data", "mediaItems") || [];
      for (const item of items) {
        const mediaId = item && item.mediaId;
        if (mediaId && mediaUrls[mediaId]) out.push(mediaUrls[mediaId]);
      }
    }
    return [...new Set(out)];
  }

  function normalizeArticle(article, tweetId) {
    if (!article || typeof article !== "object") return null;
    let contentState = article.content_state || {};
    if (typeof contentState === "string") {
      try { contentState = JSON.parse(contentState); } catch { contentState = {}; }
    }
    const blocks = contentState.blocks || article.contents || [];
    const entityMap = normalizeEntityMap(contentState.entityMap || contentState.entity_map);
    const mediaUrls = articleMediaUrlMap(article);
    const parts = [];
    const images = findImageUrls([article.cover_media, article.media_entities]);
    let ordered = 0;

    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const type = block.type || "unstyled";
      if (type === "atomic" || type === "image") {
        images.push(...articleEntityImageUrls(block, entityMap, mediaUrls));
        continue;
      }

      const text = (block.text || block.value || "").trim();
      if (!text) continue;
      if (type !== "ordered-list-item") ordered = 0;
      if (type === "header-one") parts.push(`# ${text}`);
      else if (type === "header-two") parts.push(`## ${text}`);
      else if (type === "header-three") parts.push(`### ${text}`);
      else if (type === "blockquote") parts.push(`> ${text}`);
      else if (type === "unordered-list-item") parts.push(`- ${text}`);
      else if (type === "ordered-list-item") parts.push(`${++ordered}. ${text}`);
      else if (type === "code-block") parts.push("```\n" + text + "\n```");
      else parts.push(text);
    }

    const imageUrls = [...new Set(images)];
    return {
      restId: article.rest_id || article.id || "",
      tweetId,
      title: article.title || "",
      previewText: article.preview_text || article.previewText || "",
      text: article.full_text || article.plain_text || parts.join("\n\n"),
      url: article.url || "",
      coverImageUrl: imageUrls[0] || "",
      imageUrls,
      publishedAt: article.published_at || article.publishedAt || "",
    };
  }

  function storeArticle(tweetId, article) {
    if (!article || (!tweetId && !article.restId)) return;
    const keys = [tweetId, article.restId].filter(Boolean);
    for (const key of keys) articleMap[key] = article;
    for (const key of keys) {
      window.dispatchEvent(new CustomEvent("__tweetsaver_article", {
        detail: { tweetId: key, data: article },
      }));
    }
  }

  function extractArticles(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 20) return;

    const articleResult =
      deepGet(obj, "article", "article_results", "result") ||
      deepGet(obj, "article_results", "result") ||
      (obj.content_state && obj.title ? obj : null);
    if (articleResult) {
      try { storeArticle(obj.rest_id || obj.id_str || "", normalizeArticle(articleResult, obj.rest_id || obj.id_str || "")); } catch {}
    }

    if (Array.isArray(obj)) {
      for (const item of obj) extractArticles(item, depth + 1);
    } else {
      for (const key of Object.keys(obj)) {
        try { extractArticles(obj[key], depth + 1); } catch {}
      }
    }
  }

  // Hook fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

      // Only intercept Twitter API endpoints that contain tweet data
      if (
        url.includes("/graphql/") ||
        url.includes("/2/timeline/") ||
        url.includes("/TweetDetail") ||
        url.includes("/HomeTimeline") ||
        url.includes("/UserTweets") ||
        url.includes("/SearchTimeline") ||
        url.includes("/ListLatestTweets")
      ) {
        // Clone to avoid consuming the body
        const clone = response.clone();
        clone.json().then((json) => {
          try {
            extractVideos(json);
            extractArticles(json);
          } catch {}
        }).catch(() => {});
      }
    } catch {}

    return response;
  };

  // Hook XHR as fallback
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__tsUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = this.__tsUrl || "";
        if (
          url.includes("/graphql/") ||
          url.includes("/2/timeline/") ||
          url.includes("/TweetDetail")
        ) {
          const json = JSON.parse(this.responseText);
          extractVideos(json);
          extractArticles(json);
        }
      } catch {}
    });
    return origSend.apply(this, args);
  };

  // Allow content script to query the map
  window.addEventListener("__tweetsaver_query_video", (e) => {
    const tweetId = e.detail?.tweetId;
    if (tweetId && videoMap[tweetId]) {
      window.dispatchEvent(
        new CustomEvent("__tweetsaver_video_response", {
          detail: { tweetId, data: videoMap[tweetId] },
        })
      );
    }
  });

  window.addEventListener("__tweetsaver_query_article", (e) => {
    const tweetId = e.detail?.tweetId;
    if (tweetId && articleMap[tweetId]) {
      window.dispatchEvent(
        new CustomEvent("__tweetsaver_article_response", {
          detail: { tweetId, data: articleMap[tweetId] },
        })
      );
    }
  });

  console.log("[Tweet Saver] Video interceptor injected ✓");
})();
