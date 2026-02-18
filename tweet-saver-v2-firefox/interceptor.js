// This script is injected into the PAGE context (not content script context)
// to intercept fetch() responses from Twitter's internal API and extract video URLs.

(() => {
  const videoMap = {}; // tweetId -> { mp4Url, bitrate, contentType }

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

  console.log("[Tweet Saver] Video interceptor injected ✓");
})();
