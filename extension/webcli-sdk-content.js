const PAGE_SOURCE = "webcli-sdk-page";
const EXTENSION_SOURCE = "webcli-sdk-extension";
const CONTENT_PORT_NAME = "webcli-sdk-content";

function createWebcliSdkContentBridge(runtimeChrome, pageWindow) {
  let port = null;

  function connect() {
    if (port) return port;

    port = runtimeChrome.runtime.connect({ name: CONTENT_PORT_NAME });
    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(handleDisconnect);
    return port;
  }

  function handlePageMessage(event) {
    if (event.source !== pageWindow) return;

    const message = event.data;
    if (!isPageMessage(message)) return;

    try {
      connect().postMessage(message);
    } catch (err) {
      postToPage({
        channelId: message.channelId,
        type: "error",
        error: normalizeError(err, "EXTENSION_DISCONNECTED", "WebCLI extension disconnected."),
      });
    }
  }

  function handlePortMessage(message) {
    if (!isBridgeMessage(message)) return;
    postToPage(message);
  }

  function handleDisconnect() {
    port = null;
    postToPage({
      type: "error",
      error: {
        code: "EXTENSION_DISCONNECTED",
        message: "WebCLI extension disconnected.",
      },
    });
  }

  function postToPage(message) {
    pageWindow.postMessage(
      {
        ...message,
        source: EXTENSION_SOURCE,
      },
      "*"
    );
  }

  function start() {
    connect();
    pageWindow.addEventListener("message", handlePageMessage);
  }

  return {
    start,
    connect,
    handlePageMessage,
    handlePortMessage,
    handleDisconnect,
  };
}

function isPageMessage(message) {
  return (
    message &&
    typeof message === "object" &&
    message.source === PAGE_SOURCE &&
    typeof message.channelId === "string" &&
    message.channelId.length > 0 &&
    typeof message.type === "string" &&
    message.type.length > 0
  );
}

function isBridgeMessage(message) {
  return (
    message &&
    typeof message === "object" &&
    typeof message.type === "string" &&
    (typeof message.channelId === "string" || message.type === "error")
  );
}

function normalizeError(err, fallbackCode, fallbackMessage) {
  if (!err) return { code: fallbackCode, message: fallbackMessage };
  if (typeof err === "string") return { code: fallbackCode, message: err };
  if (err.code && err.message) return err;
  return {
    code: fallbackCode,
    message: err.message || fallbackMessage,
    details: err.details,
  };
}

if (typeof chrome !== "undefined" && chrome.runtime && typeof window !== "undefined") {
  createWebcliSdkContentBridge(chrome, window).start();
}

if (typeof module !== "undefined") {
  module.exports = {
    createWebcliSdkContentBridge,
    PAGE_SOURCE,
    EXTENSION_SOURCE,
    CONTENT_PORT_NAME,
  };
}
