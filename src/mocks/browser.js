import { setupWorker } from "msw/browser";

// Create MSW worker instance (safely guard against non-browser environments)
export const worker = typeof window !== "undefined" ? setupWorker() : null;

let isStarted = false;
const listeners = {
  statusChange: new Set(),
  requestIntercepted: new Set(),
  requestUnhandled: new Set(),
};

export function onStatusChange(callback) {
  listeners.statusChange.add(callback);
  return () => listeners.statusChange.delete(callback);
}

export function onRequestIntercepted(callback) {
  listeners.requestIntercepted.add(callback);
  return () => listeners.requestIntercepted.delete(callback);
}

export function onRequestUnhandled(callback) {
  listeners.requestUnhandled.add(callback);
  return () => listeners.requestUnhandled.delete(callback);
}

function notifyStatus(status, detail) {
  listeners.statusChange.forEach((cb) => cb({ status, detail, isStarted }));
}

// MSW Lifecycle events
if (worker?.events) {
  worker.events.on("request:match", ({ request }) => {
    listeners.requestIntercepted.forEach((cb) =>
      cb({
        url: request.url,
        method: request.method,
        matched: true,
      }),
    );
  });

  worker.events.on("request:unhandled", ({ request }) => {
    listeners.requestUnhandled.forEach((cb) =>
      cb({
        url: request.url,
        method: request.method,
      }),
    );
  });
}

export async function startWorker() {
  if (isStarted) return;
  notifyStatus("starting", "Registering Service Worker...");
  try {
    await worker.start({
      onUnhandledRequest: "warn",
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
    isStarted = true;
    notifyStatus("active", "MSW Service Worker Active");
  } catch (err) {
    isStarted = false;
    notifyStatus("error", err.message || "Failed to start Service Worker");
    throw err;
  }
}

export function stopWorker() {
  if (!isStarted) return;
  worker.stop();
  isStarted = false;
  notifyStatus("inactive", "MSW Service Worker Stopped");
}

export function isWorkerActive() {
  return isStarted;
}
