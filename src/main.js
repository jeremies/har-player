import Hls from "hls.js";
import {
  startWorker,
  stopWorker,
  isWorkerActive,
  onStatusChange,
  onRequestIntercepted,
  onRequestUnhandled,
} from "./mocks/browser.js";
import { loadHarData, clearHar, getLoadedHarInfo } from "./mocks/har-loader.js";

// DOM Elements
const streamUrlInput = document.getElementById("streamUrl");
const minHeightInput = document.getElementById("minHeight");
const maxHeightInput = document.getElementById("maxHeight");
const presetSelect = document.getElementById("presetSelect");
const playBtn = document.getElementById("playBtn");
const stopBtn = document.getElementById("stopBtn");
const reloadBtn = document.getElementById("reloadBtn");
const videoPlayer = document.getElementById("videoPlayer");

const statState = document.getElementById("statState");
const statMode = document.getElementById("statMode");
const statResolution = document.getElementById("statResolution");
const statBitrate = document.getElementById("statBitrate");
const statLevelIndex = document.getElementById("statLevelIndex");
const statBuffer = document.getElementById("statBuffer");
const statMinH = document.getElementById("statMinH");
const statMaxH = document.getElementById("statMaxH");
const variantCount = document.getElementById("variantCount");
const variantsTableBody = document.getElementById("variantsTableBody");
const logBox = document.getElementById("logBox");

// MSW UI Elements
const mswToggleBtn = document.getElementById("mswToggleBtn");
const mswStatusBadge = document.getElementById("mswStatusBadge");
const harFileInput = document.getElementById("harFileInput");
const harDropZone = document.getElementById("harDropZone");
const loadSampleHarBtn = document.getElementById("loadSampleHarBtn");
const clearHarBtn = document.getElementById("clearHarBtn");
const harInfoBox = document.getElementById("harInfoBox");
const harDiscoveredStreamsSelect = document.getElementById(
  "harDiscoveredStreamsSelect",
);

// State
let hls = null;
let availableLevels = [];
let allowedLevelIndices = [];
let minAllowedIndex = -1;
let maxAllowedIndex = -1;

function log(msg, type = "info") {
  const time = new Date().toLocaleTimeString();
  const div = document.createElement("div");
  div.className = `log-entry ${type}`;
  div.textContent = `[${time}] ${msg}`;
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

function formatBitrate(bits) {
  if (!bits) return "N/A";
  if (bits >= 1000000) {
    return (bits / 1000000).toFixed(2) + " Mbps";
  }
  return (bits / 1000).toFixed(0) + " kbps";
}

function updateBufferInfo() {
  if (!videoPlayer) return;
  const buffered = videoPlayer.buffered;
  const currentTime = videoPlayer.currentTime;
  let bufLen = 0;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
      bufLen = buffered.end(i) - currentTime;
      break;
    }
  }
  statBuffer.textContent = bufLen.toFixed(1) + "s";
}
setInterval(updateBufferInfo, 1000);

// MSW Event listeners
onStatusChange(({ status, detail }) => {
  if (status === "active") {
    mswStatusBadge.className = "badge badge-success";
    mswStatusBadge.textContent = "Active";
    mswToggleBtn.textContent = "⏹ Stop Mock Worker";
    mswToggleBtn.classList.remove("btn-secondary");
    mswToggleBtn.classList.add("btn-danger-outline");
    log(
      "MSW Mock Service Worker is ACTIVE and intercepting network calls.",
      "info",
    );
  } else if (status === "starting") {
    mswStatusBadge.className = "badge badge-warning";
    mswStatusBadge.textContent = "Starting...";
  } else {
    mswStatusBadge.className = "badge badge-secondary";
    mswStatusBadge.textContent = "Inactive";
    mswToggleBtn.textContent = "▶ Enable Mock Worker";
    mswToggleBtn.classList.remove("btn-danger-outline");
    mswToggleBtn.classList.add("btn-secondary");
    log("MSW Mock Service Worker is INACTIVE.", "warn");
  }
});

onRequestIntercepted(({ url, method }) => {
  log(`⚡ [MSW Mocked] ${method} ${url}`, "info");
});

onRequestUnhandled(({ url, method }) => {
  log(`⚠️ [MSW Unhandled Warning] ${method} ${url}`, "warn");
});

// MSW Toggle
mswToggleBtn.addEventListener("click", async () => {
  if (isWorkerActive()) {
    stopWorker();
  } else {
    try {
      await startWorker();
    } catch (e) {
      log(`Failed to start worker: ${e.message}`, "error");
    }
  }
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// HAR File Handling
function updateHarUI(harInfo) {
  if (!harInfo) {
    harInfoBox.style.display = "none";
    harDiscoveredStreamsSelect.innerHTML =
      '<option value="">Upload a HAR file to detect playlists...</option>';
    harDiscoveredStreamsSelect.disabled = true;
    return;
  }

  const topMaster =
    harInfo.topMaster ||
    (harInfo.discoveredStreams && harInfo.discoveredStreams[0]) ||
    null;

  let masterDetailsHtml = "";
  if (topMaster) {
    if (topMaster.isRealMasterManifest) {
      const parts = [];
      if (topMaster.variantsCount) {
        parts.push(`<strong>${topMaster.variantsCount}</strong> variants`);
      }
      if (
        topMaster.uniqueResolutions &&
        topMaster.uniqueResolutions.length > 0
      ) {
        parts.push(
          `Resolutions: <strong>${escapeHtml(topMaster.uniqueResolutions.join(", "))}</strong>`,
        );
      }
      if (topMaster.maxBandwidth) {
        parts.push(
          `Peak: <strong>${(topMaster.maxBandwidth / 1000000).toFixed(2)} Mbps</strong>`,
        );
      }
      if (topMaster.audioCount) {
        parts.push(`<strong>${topMaster.audioCount}</strong> audio`);
      }
      if (topMaster.subtitlesCount) {
        parts.push(`<strong>${topMaster.subtitlesCount}</strong> subs`);
      }
      if (topMaster.lineCount) {
        parts.push(`<strong>${topMaster.lineCount}</strong> lines`);
      }

      masterDetailsHtml = `
        <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-color);">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span class="badge badge-success">✓ Verified Master Manifest</span>
            <code style="word-break: break-all;">${escapeHtml(topMaster.url)}</code>
          </div>
          ${parts.length ? `<div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px;">${parts.join(" • ")}</div>` : ""}
        </div>
      `;
    } else {
      masterDetailsHtml = `
        <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-color); display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span class="badge badge-info">✓ Master M3U8 Stream URL</span>
          <code style="word-break: break-all;">${escapeHtml(topMaster.url)}</code>
        </div>
      `;
    }
  }

  harInfoBox.style.display = "block";
  harInfoBox.innerHTML = `
    <div>
      <strong>Loaded HAR:</strong> <code>${escapeHtml(harInfo.filename)}</code> | 
      <strong>Entries:</strong> ${harInfo.totalEntries} (${harInfo.totalBinaryCount} binary segments decoded, ${harInfo.totalTextCount} text) |
      <strong>Indexed Targets:</strong> ${harInfo.exactKeyCount}
    </div>
    ${masterDetailsHtml}
  `;

  if (harInfo.discoveredStreams && harInfo.discoveredStreams.length > 0) {
    harDiscoveredStreamsSelect.disabled = false;
    harDiscoveredStreamsSelect.innerHTML = harInfo.discoveredStreams
      .map((s) => {
        const fileName = s.url.split("/").pop()?.split("?")[0] || s.url;
        let prefix = "";
        if (s.isRealMasterManifest) {
          const resText = s.uniqueResolutions?.length
            ? ` (${s.uniqueResolutions.join(", ")})`
            : "";
          prefix = `⭐ [Master Manifest - ${s.variantsCount} var${resText}] `;
        } else if (s.isMasterName) {
          prefix = `⭐ [Master by name] `;
        } else if (s.isSegmentPlaylist) {
          prefix = `[Segment Playlist] `;
        } else {
          prefix = `[Playlist] `;
        }
        return `<option value="${escapeHtml(s.url)}">${prefix}${escapeHtml(fileName)} (${escapeHtml(s.url)})</option>`;
      })
      .join("");

    // Prepopulate stream URL with unique extracted master m3u8 stream URL
    if (topMaster && topMaster.url) {
      streamUrlInput.value = topMaster.url;
      harDiscoveredStreamsSelect.value = topMaster.url;

      const matchingPreset = Array.from(presetSelect.options).find(
        (opt) => opt.value === topMaster.url,
      );
      presetSelect.value = matchingPreset ? matchingPreset.value : "custom";

      log(
        topMaster.isRealMasterManifest
          ? `✓ Auto-selected verified Master Manifest (${topMaster.variantsCount} variants): ${topMaster.url}`
          : `✓ Auto-selected Master M3U8 from HAR: ${topMaster.url}`,
        "info",
      );
    }
  } else {
    harDiscoveredStreamsSelect.disabled = true;
    harDiscoveredStreamsSelect.innerHTML =
      '<option value="">No .m3u8 playlists found in HAR</option>';
  }
}

async function processHarFile(file) {
  log(
    `Reading HAR file: ${file.name} (${(file.size / 1024).toFixed(1)} KB)...`,
    "info",
  );
  try {
    const text = await file.text();
    const info = loadHarData(text, file.name);
    log(
      `HAR loaded successfully: ${info.totalEntries} entries mapped, ${info.discoveredStreams.length} M3U8 playlists discovered.`,
      "info",
    );

    // Ensure worker is running
    if (!isWorkerActive()) {
      log("Starting Mock Service Worker to replay HAR requests...", "info");
      await startWorker();
    }

    updateHarUI(info);
  } catch (err) {
    log(`Error loading HAR: ${err.message}`, "error");
    alert(`Failed to load HAR file: ${err.message}`);
  }
}

harFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) processHarFile(file);
});

// Drag and drop handlers
["dragenter", "dragover"].forEach((eventName) => {
  harDropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    harDropZone.classList.add("drag-over");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  harDropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    harDropZone.classList.remove("drag-over");
  });
});

harDropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) {
    if (!file.name.endsWith(".har") && !file.type.includes("json")) {
      alert("Please upload a .har or JSON archive file");
      return;
    }
    processHarFile(file);
  }
});

harDiscoveredStreamsSelect.addEventListener("change", (e) => {
  if (e.target.value) {
    streamUrlInput.value = e.target.value;
    const matchingPreset = Array.from(presetSelect.options).find(
      (opt) => opt.value === e.target.value,
    );
    presetSelect.value = matchingPreset ? matchingPreset.value : "custom";
    log(`Selected M3U8 from HAR playlists: ${e.target.value}`, "info");
  }
});

loadSampleHarBtn.addEventListener("click", async () => {
  log("Fetching sample HLS HAR fixture...", "info");
  try {
    const resp = await fetch("/fixtures/sample-stream.har");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const info = loadHarData(json, "sample-stream.har");
    log("Sample HAR fixture loaded into MSW handlers!", "info");

    if (!isWorkerActive()) {
      await startWorker();
    }
    updateHarUI(info);
  } catch (err) {
    log(`Failed to load sample fixture: ${err.message}`, "error");
  }
});

clearHarBtn.addEventListener("click", () => {
  clearHar();
  updateHarUI(null);
  log("Cleared HAR replay handlers from MSW.", "info");
});

// Preset selector handler
presetSelect.addEventListener("change", (e) => {
  if (e.target.value !== "custom") {
    streamUrlInput.value = e.target.value;
  }
});

// Filter calculation logic
function computeAllowedLevels(levels, minH, maxH) {
  const allowed = [];
  levels.forEach((lvl, idx) => {
    const height = lvl.height || 0;
    const matchesMin = isNaN(minH) || minH <= 0 || height >= minH;
    const matchesMax = isNaN(maxH) || maxH <= 0 || height <= maxH;

    if (matchesMin && matchesMax) {
      allowed.push(idx);
    }
  });
  return allowed;
}

function applyLevelFilters() {
  if (!hls || !availableLevels.length) return;

  const minH = parseInt(minHeightInput.value, 10);
  const maxH = parseInt(maxHeightInput.value, 10);

  statMinH.textContent = isNaN(minH) || minH <= 0 ? "None" : `${minH} px`;
  statMaxH.textContent = isNaN(maxH) || maxH <= 0 ? "None" : `${maxH} px`;

  allowedLevelIndices = computeAllowedLevels(availableLevels, minH, maxH);

  log(
    `Filtering levels for height range [${minH || "min"}, ${maxH || "max"}] px...`,
    "info",
  );
  log(
    `Total levels: ${availableLevels.length}, Allowed levels: ${allowedLevelIndices.length}`,
    "info",
  );

  if (allowedLevelIndices.length === 0) {
    log(
      `⚠️ Warning: No levels match specified bounds [${minH}, ${maxH}]. Defaulting to all levels.`,
      "warn",
    );
    allowedLevelIndices = availableLevels.map((_, idx) => idx);
  }

  minAllowedIndex = Math.min(...allowedLevelIndices);
  maxAllowedIndex = Math.max(...allowedLevelIndices);

  hls.autoLevelCapping = maxAllowedIndex;

  if (hls.startLevel < minAllowedIndex || hls.startLevel > maxAllowedIndex) {
    hls.startLevel = maxAllowedIndex;
  }

  renderVariantsTable();
}

function playStream() {
  const url = streamUrlInput.value.trim();

  if (!url) {
    alert("Please enter a valid M3U8 URL");
    return;
  }

  logBox.innerHTML = "";
  log(`Initializing playback: ${url}`);

  if (hls) {
    hls.destroy();
    hls = null;
  }

  statState.innerHTML = '<span class="badge badge-warning">Loading</span>';

  if (Hls.isSupported()) {
    hls = new Hls({
      debug: false,
      enableWorker: true,
      capLevelToPlayerSize: false,
    });

    hls.loadSource(url);
    hls.attachMedia(videoPlayer);

    hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      log(
        `Manifest parsed successfully. ${data.levels.length} variants found.`,
        "info",
      );
      availableLevels = data.levels;
      variantCount.textContent = availableLevels.length;

      applyLevelFilters();

      videoPlayer
        .play()
        .then(() => {
          statState.innerHTML =
            '<span class="badge badge-success">Playing</span>';
        })
        .catch((err) => {
          log(`Autoplay failed or blocked: ${err.message}`, "warn");
          statState.innerHTML =
            '<span class="badge badge-warning">Paused</span>';
        });
    });

    hls.on(Hls.Events.LEVEL_SWITCHING, (event, data) => {
      log(`Level switching requested to index: ${data.level}`, "info");

      if (hls.autoLevelEnabled) {
        if (
          allowedLevelIndices.length > 0 &&
          !allowedLevelIndices.includes(data.level)
        ) {
          let targetLevel = data.level;
          if (data.level < minAllowedIndex) targetLevel = minAllowedIndex;
          if (data.level > maxAllowedIndex) targetLevel = maxAllowedIndex;

          log(
            `Enforcing variant height bounds: redirecting auto level from ${data.level} to ${targetLevel}`,
            "warn",
          );
          hls.nextAutoLevel = targetLevel;
        }
      }
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
      const levelIdx = data.level;
      const level = hls.levels[levelIdx];
      if (level) {
        log(
          `Level switched to #${levelIdx} (${level.width}x${level.height} @ ${formatBitrate(level.bitrate)})`,
          "info",
        );
        updateTelemetry(levelIdx, level);
        renderVariantsTable();
      }
    });

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        log(`Fatal error: ${data.type} - ${data.details}`, "error");
        statState.innerHTML = '<span class="badge badge-danger">Error</span>';
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            log("Attempting network error recovery...", "warn");
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            log("Attempting media error recovery...", "warn");
            hls.recoverMediaError();
            break;
          default:
            hls.destroy();
            break;
        }
      } else {
        log(`Non-fatal warning: ${data.details}`, "warn");
      }
    });
  } else if (videoPlayer.canPlayType("application/vnd.apple.mpegurl")) {
    log("HLS.js not supported. Using native Apple Safari HLS player.", "warn");
    videoPlayer.src = url;
    videoPlayer.addEventListener("loadedmetadata", () => {
      videoPlayer.play();
      statState.innerHTML =
        '<span class="badge badge-success">Playing (Native)</span>';
    });
  } else {
    log("HLS is not supported in this browser.", "error");
    alert("HLS is not supported in your browser.");
  }
}

function stopStream() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  statState.innerHTML = '<span class="badge badge-danger">Stopped</span>';
  statResolution.textContent = "--";
  statBitrate.textContent = "--";
  statLevelIndex.textContent = "--";
  variantsTableBody.innerHTML =
    '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Stream stopped.</td></tr>';
  log("Playback stopped.", "info");
}

function updateTelemetry(levelIdx, level) {
  statLevelIndex.textContent = `#${levelIdx}`;
  statResolution.textContent =
    level.width && level.height
      ? `${level.width} x ${level.height}`
      : `Height: ${level.height || "N/A"}`;
  statBitrate.textContent = formatBitrate(level.bitrate);
  statMode.textContent = hls.autoLevelEnabled
    ? "Auto (Filtered)"
    : `Manual (Level #${hls.manualLevel})`;
}

export function setManualLevel(idx) {
  if (!hls) return;
  if (idx === -1) {
    hls.currentLevel = -1;
    statMode.textContent = "Auto (Filtered)";
    log("Switched to Filtered Auto Mode", "info");
  } else {
    hls.currentLevel = idx;
    statMode.textContent = `Manual (Level #${idx})`;
    log(`Locked playback manually to level ${idx}`, "info");
  }
  renderVariantsTable();
}

function renderVariantsTable() {
  if (!availableLevels.length) return;

  const currentIdx = hls ? hls.currentLevel : -1;
  const activeIdx = hls
    ? hls.loadLevel >= 0
      ? hls.loadLevel
      : hls.currentLevel
    : -1;

  let html = "";

  const isAutoActive = hls && hls.autoLevelEnabled;
  html += `
    <tr class="${isAutoActive ? "active-variant" : ""}">
      <td><strong>Auto</strong></td>
      <td>Adaptive (ABR)</td>
      <td>Bounded [${minHeightInput.value || 0}px - ${maxHeightInput.value || "∞"}px]</td>
      <td>Dynamic</td>
      <td><span class="badge badge-info">${isAutoActive ? "ACTIVE AUTO" : "Available"}</span></td>
      <td>
        <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 0.8rem;" data-level="-1">
          ${isAutoActive ? "✓ Active" : "Select Auto"}
        </button>
      </td>
    </tr>
  `;

  availableLevels.forEach((lvl, idx) => {
    const isAllowed = allowedLevelIndices.includes(idx);
    const isActive =
      (hls && hls.currentLevel === idx) || (isAutoActive && activeIdx === idx);

    let trClass = isAllowed ? "allowed-variant" : "filtered-variant";
    if (isActive) trClass += " active-variant";

    let statusBadge = "";
    if (isActive) {
      statusBadge = '<span class="badge badge-success">PLAYING NOW</span>';
    } else if (isAllowed) {
      statusBadge = '<span class="badge badge-info">ALLOWED</span>';
    } else {
      statusBadge = '<span class="badge badge-danger">FILTERED OUT</span>';
    }

    html += `
      <tr class="${trClass}">
        <td><strong>#${idx}</strong></td>
        <td>${lvl.width || "?"} x ${lvl.height || "?"}</td>
        <td>${lvl.height || "N/A"} px</td>
        <td>${formatBitrate(lvl.bitrate)}</td>
        <td>${statusBadge}</td>
        <td>
          <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 0.8rem;" data-level="${idx}">
            ${isActive ? "✓ Selected" : "Force Level"}
          </button>
        </td>
      </tr>
    `;
  });

  variantsTableBody.innerHTML = html;

  variantsTableBody.querySelectorAll("button[data-level]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lvl = parseInt(btn.getAttribute("data-level"), 10);
      setManualLevel(lvl);
    });
  });
}

// Video events
videoPlayer.addEventListener("play", () => {
  statState.innerHTML = '<span class="badge badge-success">Playing</span>';
});
videoPlayer.addEventListener("pause", () => {
  statState.innerHTML = '<span class="badge badge-warning">Paused</span>';
});

// Control buttons
playBtn.addEventListener("click", playStream);
stopBtn.addEventListener("click", stopStream);
reloadBtn.addEventListener("click", () => {
  if (hls && availableLevels.length) {
    applyLevelFilters();
  } else {
    playStream();
  }
});

// Window globals for inline onclick fallbacks if needed
window.setManualLevel = setManualLevel;

// Initialize MSW (worker can start on page boot or on user request)
// Start active by default so user can immediately replay or intercept
startWorker().catch((err) => {
  console.warn("MSW initial start deferred:", err);
});
