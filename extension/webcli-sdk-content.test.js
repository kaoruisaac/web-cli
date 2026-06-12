const assert = require("node:assert/strict");
const test = require("node:test");
const { createWebcliSdkContentBridge } = require("./webcli-sdk-content.js");

class MockPort {
  constructor() {
    this.sent = [];
    this.messageListeners = [];
    this.disconnectListeners = [];
    this.onMessage = {
      addListener: (listener) => this.messageListeners.push(listener),
    };
    this.onDisconnect = {
      addListener: (listener) => this.disconnectListeners.push(listener),
    };
  }

  postMessage(message) {
    this.sent.push(message);
  }

  emit(message) {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  disconnect() {
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }
}

class MockWindow {
  constructor() {
    this.listeners = [];
    this.sent = [];
  }

  addEventListener(type, listener) {
    if (type === "message") {
      this.listeners.push(listener);
    }
  }

  postMessage(message, targetOrigin) {
    this.sent.push({ message, targetOrigin });
  }

  emitFromPage(message) {
    for (const listener of this.listeners) {
      listener({ source: this, data: message });
    }
  }

  emitFromOther(message) {
    for (const listener of this.listeners) {
      listener({ source: {}, data: message });
    }
  }
}

function createMocks() {
  const port = new MockPort();
  const calls = [];
  const chrome = {
    runtime: {
      connect: (connectInfo) => {
        calls.push(connectInfo);
        return port;
      },
    },
  };
  const pageWindow = new MockWindow();
  return { chrome, pageWindow, port, calls };
}

test("forwards page requests to the runtime port", () => {
  const { chrome, pageWindow, port, calls } = createMocks();
  const bridge = createWebcliSdkContentBridge(chrome, pageWindow);
  bridge.start();

  pageWindow.emitFromPage({
    source: "webcli-sdk-page",
    channelId: "channel_1",
    requestId: "request_1",
    type: "create_session",
    input: { provider: "codex" },
  });

  assert.deepEqual(calls, [{ name: "webcli-sdk-content" }]);
  assert.deepEqual(port.sent[0], {
    source: "webcli-sdk-page",
    channelId: "channel_1",
    requestId: "request_1",
    type: "create_session",
    input: { provider: "codex" },
  });
});

test("ignores unrelated window messages", () => {
  const { chrome, pageWindow, port } = createMocks();
  const bridge = createWebcliSdkContentBridge(chrome, pageWindow);
  bridge.start();

  pageWindow.emitFromOther({
    source: "webcli-sdk-page",
    channelId: "channel_1",
    type: "create_session",
  });
  pageWindow.emitFromPage({
    source: "other",
    channelId: "channel_1",
    type: "create_session",
  });

  assert.equal(port.sent.length, 0);
});

test("forwards background messages back to the page with extension source", () => {
  const { chrome, pageWindow, port } = createMocks();
  const bridge = createWebcliSdkContentBridge(chrome, pageWindow);
  bridge.start();

  port.emit({
    channelId: "channel_1",
    type: "response",
    requestId: "request_1",
    ok: true,
    result: { sessionId: "thread_1" },
  });

  assert.deepEqual(pageWindow.sent[0], {
    targetOrigin: "*",
    message: {
      source: "webcli-sdk-extension",
      channelId: "channel_1",
      type: "response",
      requestId: "request_1",
      ok: true,
      result: { sessionId: "thread_1" },
    },
  });
});

test("posts an extension disconnect error to the page", () => {
  const { chrome, pageWindow, port } = createMocks();
  const bridge = createWebcliSdkContentBridge(chrome, pageWindow);
  bridge.start();

  port.disconnect();

  assert.deepEqual(pageWindow.sent[0], {
    targetOrigin: "*",
    message: {
      source: "webcli-sdk-extension",
      type: "error",
      error: {
        code: "EXTENSION_DISCONNECTED",
        message: "WebCLI extension disconnected.",
      },
    },
  });
});
