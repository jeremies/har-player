/**
 * Extracts and scores M3U8 playlists from HAR entries, copying the intelligent
 * master extraction strategy from har-inspector.
 */

/**
 * Decode response text safely handling base64 and utf-8 encodings.
 */
export function getResponseText(entry) {
  if (!entry || !entry.response || !entry.response.content) return "";
  const content = entry.response.content;
  if (!content.text) return "";
  if (content.encoding === "base64") {
    try {
      const cleanB64 = content.text
        .replace(/\s+/g, "")
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const binary = atob(cleanB64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder("utf-8").decode(bytes);
    } catch (e) {
      try {
        return atob(content.text);
      } catch (err) {
        return content.text;
      }
    }
  }
  return content.text;
}

/**
 * Evaluates and scores an entry or URL as an M3U8 playlist candidate.
 * Copied from har-inspector.
 */
export function evaluateEntry(
  url,
  responseText = "",
  mimeType = "",
  lineCount = null,
) {
  if (!url || typeof url !== "string") return null;
  const cleanUrl = url.trim();
  if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
    return null;
  }

  const isM3u8Url =
    /\.m3u8(\?.*)?$/i.test(cleanUrl) ||
    cleanUrl.toLowerCase().includes(".m3u8");
  const isMasterName = /master\.m3u8/i.test(cleanUrl);
  const hasExtM3u = responseText.includes("#EXTM3U");

  // HLS tags matching multivariant master playlist
  const streamInfMatches = (responseText.match(/#EXT-X-STREAM-INF/g) || [])
    .length;
  const mediaMatches = (responseText.match(/#EXT-X-MEDIA/g) || []).length;
  const audioMatches = (
    responseText.match(/#EXT-X-MEDIA:[^\r\n]*TYPE=AUDIO/gi) || []
  ).length;
  const subtitlesMatches = (
    responseText.match(/#EXT-X-MEDIA:[^\r\n]*TYPE=SUBTITLES/gi) || []
  ).length;
  const m3u8VariantMatches = (
    responseText.match(/[^\r\n#\s]+\.m3u8[^\s\r\n]*/gi) || []
  ).length;

  // Disqualifiers for master manifest (segment playlists contain chunks)
  const hasExtInf = /#EXTINF:/i.test(responseText);
  const hasTargetDuration = /#EXT-X-TARGETDURATION/i.test(responseText);
  const hasMediaSequence = /#EXT-X-MEDIA-SEQUENCE/i.test(responseText);
  const isSegmentPlaylist = hasExtInf || hasTargetDuration || hasMediaSequence;

  const hasResolution = /RESOLUTION=/i.test(responseText);
  const hasCodecs = /CODECS=/i.test(responseText);
  const hasVersion = /#EXT-X-VERSION/i.test(responseText);

  const bandwidths = Array.from(responseText.matchAll(/BANDWIDTH=(\d+)/gi)).map(
    (m) => parseInt(m[1], 10),
  );
  const maxBandwidth = bandwidths.length ? Math.max(...bandwidths) : 0;

  const resMatches = Array.from(
    responseText.matchAll(/RESOLUTION=(\d+x\d+)/gi),
  ).map((m) => m[1]);
  const uniqueResolutions = Array.from(new Set(resMatches));

  const computedLineCount =
    lineCount !== null
      ? lineCount
      : responseText
        ? (responseText.match(/\n/g) || []).length + 1
        : 0;
  const isUnder100Lines =
    responseText && computedLineCount > 0 && computedLineCount <= 100;

  // Real Master Manifest must have #EXTM3U, variant stream definitions, and NOT be a chunk playlist
  const isRealMasterManifest =
    hasExtM3u && streamInfMatches > 0 && !isSegmentPlaylist;

  let score = 0;
  if (isRealMasterManifest) {
    // Base score for verified multivariant playlist
    score += 10000;
    // High boost for meeting the <= 100 lines criteria
    if (isUnder100Lines) {
      score += 5000;
    }
    // Number of variant streams
    score += Math.min(streamInfMatches, 10) * 1500;
    // Number of variant m3u8 playlist URLs listed in manifest
    score += Math.min(m3u8VariantMatches, 10) * 500;
    // Audio renditions
    score += Math.min(audioMatches, 5) * 800;
    // Subtitles renditions
    score += Math.min(subtitlesMatches, 5) * 800;
    // Quality descriptors
    if (hasResolution) score += 600;
    if (hasCodecs) score += 400;
    if (hasVersion) score += 200;
    // Higher bandwidth preference (main content vs low-res ads)
    score += Math.min(Math.floor(maxBandwidth / 100000), 40) * 100;

    // Ad URL penalty
    const isAdUrl =
      /doubleclick\.net|googleads|googlesyndication|pubads|imasdk|smartclip|\/pagead\/|\/ad\/|\/ads\//i.test(
        cleanUrl,
      );
    if (isAdUrl) {
      score -= 5000;
    }
  } else if (hasExtM3u && mediaMatches > 0 && !isSegmentPlaylist) {
    // Audio or media manifest without stream-inf
    score += 4000 + mediaMatches * 400;
  } else if (hasExtM3u && !isSegmentPlaylist && isMasterName) {
    score += 2000;
  } else if (isMasterName && !isSegmentPlaylist) {
    score += 500;
  } else if (isM3u8Url && !isSegmentPlaylist) {
    score += 200;
  } else if (isSegmentPlaylist) {
    // Heavily deprioritize segment playlists
    score = 10;
  } else if (hasExtM3u) {
    score += 50;
  }

  if (score === 0) return null;

  return {
    url: cleanUrl,
    responseText: responseText,
    isRealMasterManifest: isRealMasterManifest,
    isMasterName: isMasterName,
    variantsCount: streamInfMatches,
    mediaCount: mediaMatches,
    audioCount: audioMatches,
    subtitlesCount: subtitlesMatches,
    maxBandwidth: maxBandwidth,
    uniqueResolutions: uniqueResolutions,
    isSegmentPlaylist: isSegmentPlaylist,
    lineCount: computedLineCount,
    score: score,
  };
}

/**
 * Extracts and ranks all M3U8 playlists from HAR entries, identifying the top master stream.
 */
export function extractMasterAndPlaylists(entries, rawHarText = "") {
  const urlMap = new Map();
  let foundMaster = null;

  if (Array.isArray(entries)) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const reqUrl =
        entry.request && entry.request.url ? entry.request.url.trim() : "";
      const redirectUrl =
        entry.response && entry.response.redirectURL
          ? entry.response.redirectURL.trim()
          : "";
      const mime =
        entry.response &&
        entry.response.content &&
        entry.response.content.mimeType
          ? entry.response.content.mimeType.toLowerCase()
          : "";

      // Fast pre-filter: Skip non-m3u8 assets immediately without decoding content
      const isCandidate =
        reqUrl.toLowerCase().includes(".m3u8") ||
        redirectUrl.toLowerCase().includes(".m3u8") ||
        mime.includes("mpegurl");

      if (!isCandidate) continue;

      const rawContentText =
        entry.response && entry.response.content && entry.response.content.text;

      let respText = "";
      let lineCount = 0;
      // Size guard: Skip decoding large files (> 35KB) during master search (100 lines manifest is < 10KB)
      if (!rawContentText || rawContentText.length <= 35000) {
        respText = getResponseText(entry);
        lineCount = respText ? (respText.match(/\n/g) || []).length + 1 : 0;
      }

      const evaluated = evaluateEntry(reqUrl, respText, mime, lineCount);
      if (evaluated) {
        evaluated.status = entry.response?.status || 200;
        evaluated.mimeType = evaluated.mimeType || mime;
        evaluated.size =
          entry.response?.content?.size ||
          (evaluated.responseText ? evaluated.responseText.length : 0);

        if (
          !urlMap.has(evaluated.url) ||
          urlMap.get(evaluated.url).score < evaluated.score
        ) {
          urlMap.set(evaluated.url, evaluated);
        }

        // Track the first entry that is a verified response of <= 100 lines
        if (
          !foundMaster &&
          evaluated.isRealMasterManifest &&
          lineCount > 0 &&
          lineCount <= 100
        ) {
          foundMaster = evaluated;
        }
      }

      // Also check redirect URLs
      if (redirectUrl) {
        const evalRedirect = evaluateEntry(
          redirectUrl,
          respText,
          mime,
          lineCount,
        );
        if (evalRedirect) {
          evalRedirect.status = entry.response?.status || 302;
          evalRedirect.mimeType = evalRedirect.mimeType || mime;
          evalRedirect.size = evaluated ? evaluated.size : 0;

          if (
            !urlMap.has(evalRedirect.url) ||
            urlMap.get(evalRedirect.url).score < evalRedirect.score
          ) {
            urlMap.set(evalRedirect.url, evalRedirect);
          }

          if (
            !foundMaster &&
            evalRedirect.isRealMasterManifest &&
            lineCount > 0 &&
            lineCount <= 100
          ) {
            foundMaster = evalRedirect;
          }
        }
      }
    }
  }

  // Regex fallback search if no candidates were found
  if (urlMap.size === 0 && rawHarText) {
    const text =
      typeof rawHarText === "string" ? rawHarText : JSON.stringify(rawHarText);
    const regex = /https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const matchedUrl = match[0].replace(/[\)\}\]>]+$/, "");
      const evalRegex = evaluateEntry(matchedUrl);
      if (evalRegex && !urlMap.has(evalRegex.url)) {
        urlMap.set(evalRegex.url, evalRegex);
      }
    }
  }

  const allCandidates = Array.from(urlMap.values());
  allCandidates.sort((a, b) => b.score - a.score);

  const topMaster = foundMaster || allCandidates[0] || null;

  // Ensure topMaster is placed at index 0 of allCandidates
  if (
    topMaster &&
    allCandidates.length > 0 &&
    allCandidates[0].url !== topMaster.url
  ) {
    const topIdx = allCandidates.findIndex((c) => c.url === topMaster.url);
    if (topIdx > -1) {
      allCandidates.splice(topIdx, 1);
      allCandidates.unshift(topMaster);
    }
  }

  return {
    topMaster,
    playlists: allCandidates,
  };
}
