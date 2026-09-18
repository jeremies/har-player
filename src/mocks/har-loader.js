import { http, HttpResponse, passthrough } from "msw";
import { worker } from "./browser.js";
import { extractMasterAndPlaylists } from "./har-extractor.js";

/**
 * Converts a base64 string to a Uint8Array
 */
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Sanitize response headers from HAR.
 * Excludes content-encoding (as HAR bodies are usually pre-decoded)
 * and attaches CORS headers for seamless playback across origins.
 */
function buildResponseHeaders(rawHeaders, mimeType) {
  const headers = new Headers();

  if (Array.isArray(rawHeaders)) {
    for (const h of rawHeaders) {
      const name = h.name.toLowerCase();
      // Skip hop-by-hop and encoding headers that conflict with already-decoded bodies
      if (
        ["content-encoding", "transfer-encoding", "connection"].includes(name)
      ) {
        continue;
      }
      headers.set(h.name, h.value);
    }
  }

  if (mimeType && !headers.has("content-type")) {
    headers.set("content-type", mimeType);
  }

  // Permissive CORS for smooth local replaying of any captured domain
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
  headers.set("access-control-allow-headers", "*");
  headers.set("access-control-expose-headers", "*");

  return headers;
}

/**
 * State for currently loaded HAR
 */
let currentHarInfo = null;
let currentHarHandler = null;

export function getLoadedHarInfo() {
  return currentHarInfo;
}

/**
 * Clears loaded HAR and resets MSW handlers
 */
export function clearHar() {
  currentHarInfo = null;
  currentHarHandler = null;
  worker.resetHandlers();
}

/**
 * Parses a HAR JSON string, indexes responses, discovers M3U8 streams,
 * and attaches MSW interceptor.
 */
export function loadHarData(harJsonString, filename = "recording.har") {
  const har =
    typeof harJsonString === "string"
      ? JSON.parse(harJsonString)
      : harJsonString;
  const entries = har?.log?.entries || [];

  if (!entries.length) {
    throw new Error("No HTTP entries found in HAR file.");
  }

  const exactMap = new Map();
  const noQueryMap = new Map();
  const pathMap = new Map();
  let totalBinaryCount = 0;
  let totalTextCount = 0;

  entries.forEach((entry, idx) => {
    const req = entry.request;
    const res = entry.response;
    if (!req || !res) return;

    const urlStr = req.url;
    const method = (req.method || "GET").toUpperCase();
    const status = res.status || 200;
    const statusText = res.statusText || "OK";
    const content = res.content || {};
    const mimeType = content.mimeType || "";

    let bodyData;
    let isBinary = false;

    if (content.encoding === "base64" && content.text) {
      try {
        bodyData = base64ToUint8Array(content.text);
        isBinary = true;
        totalBinaryCount++;
      } catch (e) {
        console.warn(`[HAR Replayer] Failed base64 decoding for ${urlStr}:`, e);
        bodyData = content.text;
      }
    } else {
      bodyData = content.text !== undefined ? content.text : "";
      totalTextCount++;
    }

    const headers = buildResponseHeaders(res.headers, mimeType);

    const record = {
      index: idx,
      method,
      url: urlStr,
      status,
      statusText,
      headers,
      bodyData,
      isBinary,
      mimeType,
    };

    // Store in exact lookup
    const exactKey = `${method} ${urlStr}`;
    if (!exactMap.has(exactKey)) exactMap.set(exactKey, []);
    exactMap.get(exactKey).push(record);

    // Store in no-query lookup
    try {
      const parsedUrl = new URL(urlStr);
      const noQueryKey = `${method} ${parsedUrl.origin}${parsedUrl.pathname}`;
      if (!noQueryMap.has(noQueryKey)) noQueryMap.set(noQueryKey, []);
      noQueryMap.get(noQueryKey).push(record);

      const pathKey = `${method} ${parsedUrl.pathname}`;
      if (!pathMap.has(pathKey)) pathMap.set(pathKey, []);
      pathMap.get(pathKey).push(record);
    } catch {
      // Relative or custom URL
    }
  });

  // Extract and rank M3U8 stream playlists copying the har-inspector strategy
  const extraction = extractMasterAndPlaylists(entries, harJsonString);

  // Keep track of sequence invocation per key for sequential replay
  const sequenceCounters = new Map();

  function getNextResponse(records, key) {
    if (!records || records.length === 0) return null;
    const currentIdx = sequenceCounters.get(key) || 0;
    const record = records[currentIdx % records.length];
    sequenceCounters.set(key, currentIdx + 1);
    return record;
  }

  // Create an MSW catch-all HTTP handler that checks the loaded HAR entries
  currentHarHandler = http.all("*", ({ request }) => {
    const method = request.method.toUpperCase();
    const fullUrl = request.url;

    // 1. Try exact match
    const exactKey = `${method} ${fullUrl}`;
    let match = getNextResponse(exactMap.get(exactKey), exactKey);

    // 2. Try match without query params
    if (!match) {
      try {
        const parsed = new URL(fullUrl);
        const noQueryKey = `${method} ${parsed.origin}${parsed.pathname}`;
        match = getNextResponse(noQueryMap.get(noQueryKey), noQueryKey);

        // 3. Try pathname only
        if (!match) {
          const pathKey = `${method} ${parsed.pathname}`;
          match = getNextResponse(pathMap.get(pathKey), pathKey);
        }
      } catch {}
    }

    if (match) {
      // Re-create headers object so it can be safely reused across calls
      const respHeaders = new Headers();
      match.headers.forEach((val, key) => respHeaders.set(key, val));

      return new HttpResponse(match.bodyData, {
        status: match.status,
        statusText: match.statusText,
        headers: respHeaders,
      });
    }

    // Let unhandled requests pass through (MSW will warn if onUnhandledRequest='warn')
    return passthrough();
  });

  // Apply to worker if available
  if (worker) {
    worker.resetHandlers();
    worker.use(currentHarHandler);
  }

  currentHarInfo = {
    filename,
    totalEntries: entries.length,
    totalBinaryCount,
    totalTextCount,
    discoveredStreams: extraction.playlists,
    topMaster: extraction.topMaster,
    exactKeyCount: exactMap.size,
  };

  return currentHarInfo;
}
