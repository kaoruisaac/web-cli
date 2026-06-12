const assert = require("node:assert/strict");
const test = require("node:test");
const { createBackground } = require("./background.js");

class MockPort {
  constructor(name) {
    this.name = name;
    this.sent = [];
    this.disconnectCallCount = 0;
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
    this.disconnectCallCount += 1;
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }

  lastSent() {
    return this.sent.at(-1);
  }
}

function createChromeMock() {
  const nativePort = new MockPort("native");
  let connectNativeCallCount = 0;
  let onConnectListener = null;
  const chrome = {
    runtime: {
      lastError: null,
      onConnect: { addListener: (listener) => {
        onConnectListener = listener;
      } },
      connectNative: () => {
        connectNativeCallCount += 1;
        return nativePort;
      },
    },
  };
  return {
    chrome,
    nativePort,
    getConnectNativeCallCount: () => connectNativeCallCount,
    emitRuntimeConnect: (port) => onConnectListener?.(port),
  };
}

function respondNative(nativePort, request, result = {}) {
  nativePort.emit({
    type: "response",
    requestId: request.requestId,
    ok: true,
    result,
  });
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function createSdkSession(background, nativePort, sessionId = "thread_sdk") {
  const sdkPort = new MockPort("webcli-sdk-content");
  background.handleSdkConnect(sdkPort);
  sdkPort.emit({
    type: "create_session",
    channelId: "channel_1",
    requestId: "sdk_create",
    input: { provider: "codex", skillsUrls: [] },
  });
  assert.equal(nativePort.lastSent().type, "create_thread");
  respondNative(nativePort, nativePort.lastSent(), { threadId: sessionId });
  await tick();
  assert.equal(nativePort.lastSent().type, "subscribe_thread");
  respondNative(nativePort, nativePort.lastSent(), { subscribed: true });
  await tick();
  assert.deepEqual(sdkPort.lastSent(), {
    channelId: "channel_1",
    type: "response",
    requestId: "sdk_create",
    ok: true,
    result: { sessionId },
  });
  return sdkPort;
}

test("background start does not connect native host", () => {
  const { chrome, getConnectNativeCallCount } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });

  background.start();

  assert.equal(getConnectNativeCallCount(), 0);
  assert.equal(background.getState().connected, false);
  assert.equal(background.getState().error, null);
});

test("SDK port connect does not connect native host", () => {
  const { chrome, getConnectNativeCallCount } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });
  const sdkPort = new MockPort("webcli-sdk-content");

  background.handleSdkConnect(sdkPort);

  assert.equal(getConnectNativeCallCount(), 0);
  assert.equal(sdkPort.sent.length, 0);
});

test("popup connect and get_state do not connect native host", async () => {
  const { chrome, getConnectNativeCallCount } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });
  const popupPort = new MockPort("popup");

  background.handlePopupConnect(popupPort);
  popupPort.emit({ type: "get_state" });
  await tick();

  assert.equal(getConnectNativeCallCount(), 0);
  assert.equal(popupPort.sent.length, 2);
  assert.equal(popupPort.lastSent().state.connected, false);
});

test("SDK list_providers routes to native host", async () => {
  const { chrome, nativePort, getConnectNativeCallCount } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });
  const sdkPort = new MockPort("webcli-sdk-content");
  background.handleSdkConnect(sdkPort);
  assert.equal(getConnectNativeCallCount(), 0);

  sdkPort.emit({
    type: "list_providers",
    channelId: "channel_1",
    requestId: "sdk_providers",
  });
  assert.equal(getConnectNativeCallCount(), 1);
  assert.equal(nativePort.lastSent().type, "list_providers");
  respondNative(nativePort, nativePort.lastSent(), [
    { name: "OpenCode", code: "opencode", path: null, available: false, error: "program was not found in PATH" },
  ]);
  await tick();

  assert.deepEqual(sdkPort.lastSent(), {
    channelId: "channel_1",
    type: "response",
    requestId: "sdk_providers",
    ok: true,
    result: [
      { name: "OpenCode", code: "opencode", path: null, available: false, error: "program was not found in PATH" },
    ],
  });
  assert.equal(nativePort.disconnectCallCount, 1);
  assert.equal(background.getState().connected, false);
  assert.equal(background.getState().error, null);
});

test("SDK get_settings routes to native host", async () => {
  const { chrome, nativePort, getConnectNativeCallCount } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });
  const sdkPort = new MockPort("webcli-sdk-content");
  background.handleSdkConnect(sdkPort);
  assert.equal(getConnectNativeCallCount(), 0);

  sdkPort.emit({
    type: "get_settings",
    channelId: "channel_1",
    requestId: "sdk_settings",
  });
  assert.equal(getConnectNativeCallCount(), 1);
  assert.equal(nativePort.lastSent().type, "get_settings");
  respondNative(nativePort, nativePort.lastSent(), {
    defaultProvider: "codex",
    defaultModel: "gpt-5",
  });
  await tick();

  assert.deepEqual(sdkPort.lastSent(), {
    channelId: "channel_1",
    type: "response",
    requestId: "sdk_settings",
    ok: true,
    result: {
      defaultProvider: "codex",
      defaultModel: "gpt-5",
    },
  });
  assert.equal(nativePort.disconnectCallCount, 1);
});

test("SDK create_session forwards opencode provider", async () => {
  const { chrome, nativePort } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });
  const sdkPort = new MockPort("webcli-sdk-content");
  background.handleSdkConnect(sdkPort);

  sdkPort.emit({
    type: "create_session",
    channelId: "channel_1",
    requestId: "sdk_create",
    input: { provider: "opencode", model: "ollama/qwen2.5-coder:14b", skillsUrls: [] },
  });
  assert.equal(nativePort.lastSent().type, "create_thread");
  assert.equal(nativePort.lastSent().provider, "opencode");
  assert.equal(nativePort.lastSent().model, "ollama/qwen2.5-coder:14b");
});

test("SDK create_session forwards cursor provider", async () => {
  const { chrome, nativePort } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });
  const sdkPort = new MockPort("webcli-sdk-content");
  background.handleSdkConnect(sdkPort);

  sdkPort.emit({
    type: "create_session",
    channelId: "channel_1",
    requestId: "sdk_create",
    input: { provider: "cursor", model: "gpt-5", skillsUrls: [] },
  });
  assert.equal(nativePort.lastSent().type, "create_thread");
  assert.equal(nativePort.lastSent().provider, "cursor");
  assert.equal(nativePort.lastSent().model, "gpt-5");
});

test("SDK create_session forwards claude provider", async () => {
  const { chrome, nativePort } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });
  const sdkPort = new MockPort("webcli-sdk-content");
  background.handleSdkConnect(sdkPort);

  sdkPort.emit({
    type: "create_session",
    channelId: "channel_1",
    requestId: "sdk_create",
    input: { provider: "claude", model: "sonnet", skillsUrls: [] },
  });
  assert.equal(nativePort.lastSent().type, "create_thread");
  assert.equal(nativePort.lastSent().provider, "claude");
  assert.equal(nativePort.lastSent().model, "sonnet");
});

test("routes SDK thread events without mutating popup state", async () => {
  const { chrome, nativePort } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });
  const sdkPort = await createSdkSession(background, nativePort);

  background.handleNativeMessage({
    type: "thread_event",
    event: {
      type: "assistant_message",
      seq: 1,
      threadId: "thread_sdk",
      text: "hello",
    },
  });

  assert.deepEqual(sdkPort.lastSent(), {
    channelId: "channel_1",
    type: "chat_delta",
    sessionId: "thread_sdk",
    seq: 1,
    text: "hello",
  });
  assert.equal(background.getState().threadId, null);
  assert.equal(background.getState().events.length, 0);
});

test("SDK create_session lazy connects and keeps native host while active", async () => {
  const { chrome, nativePort, getConnectNativeCallCount } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });

  await createSdkSession(background, nativePort);

  assert.equal(getConnectNativeCallCount(), 1);
  assert.equal(background.getActiveThreadCount(), 1);
  assert.equal(background.getState().connected, true);
  assert.equal(nativePort.disconnectCallCount, 0);
});

test("maps Core statuses to SDK statuses", () => {
  const { chrome } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });

  assert.deepEqual(
    background.sdkEventFromThreadEvent({
      type: "status_changed",
      seq: 3,
      threadId: "thread_sdk",
      status: "waitingToolResult",
    }),
    {
      type: "status_changed",
      sessionId: "thread_sdk",
      seq: 3,
      status: "waiting_tool_result",
    }
  );
});

test("SDK port disconnect removes routing without ending the Core thread", async () => {
  const { chrome, nativePort } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });
  const sdkPort = await createSdkSession(background, nativePort);
  const sentBeforeDisconnect = nativePort.sent.length;

  sdkPort.disconnect();

  assert.equal(background.getSdkRouteCount(), 0);
  assert.equal(nativePort.sent.length, sentBeforeDisconnect);
  assert.equal(nativePort.sent.some((message) => message.type === "end_thread"), false);
});

test("end_session calls end_thread", async () => {
  const { chrome, nativePort } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });
  const sdkPort = await createSdkSession(background, nativePort);

  sdkPort.emit({
    type: "end_session",
    channelId: "channel_1",
    requestId: "sdk_end",
    sessionId: "thread_sdk",
  });
  await tick();
  assert.equal(nativePort.lastSent().type, "end_thread");
  assert.equal(nativePort.lastSent().threadId, "thread_sdk");
  respondNative(nativePort, nativePort.lastSent(), {});
  await tick();

  assert.deepEqual(sdkPort.lastSent(), {
    channelId: "channel_1",
    type: "response",
    requestId: "sdk_end",
    ok: true,
    result: {},
  });
  assert.equal(background.getActiveThreadCount(), 0);
  assert.equal(nativePort.disconnectCallCount, 1);
  assert.equal(background.getState().connected, false);
});

test("create_session after idle disconnect opens a fresh native port before old disconnect event", async () => {
  const nativePorts = [];
  const chrome = {
    runtime: {
      lastError: null,
      onConnect: { addListener: () => {} },
      connectNative: () => {
        const port = new MockPort("native");
        port.disconnect = function disconnectWithoutEvent() {
          this.disconnectCallCount += 1;
        };
        nativePorts.push(port);
        return port;
      },
    },
  };
  const background = createBackground(chrome, { disableReconnect: true });
  const sdkPort = new MockPort("webcli-sdk-content");
  background.handleSdkConnect(sdkPort);

  sdkPort.emit({
    type: "create_session",
    channelId: "channel_1",
    requestId: "sdk_create_1",
    input: { provider: "codex", skillsUrls: [] },
  });
  assert.equal(nativePorts.length, 1);
  respondNative(nativePorts[0], nativePorts[0].lastSent(), { threadId: "thread_1" });
  await tick();
  respondNative(nativePorts[0], nativePorts[0].lastSent(), { subscribed: true });
  await tick();

  sdkPort.emit({
    type: "end_session",
    channelId: "channel_1",
    requestId: "sdk_end_1",
    sessionId: "thread_1",
  });
  await tick();
  respondNative(nativePorts[0], nativePorts[0].lastSent(), {});
  await tick();

  assert.equal(nativePorts[0].disconnectCallCount, 1);
  assert.equal(background.getState().connected, false);

  sdkPort.emit({
    type: "create_session",
    channelId: "channel_2",
    requestId: "sdk_create_2",
    input: { provider: "codex", skillsUrls: [] },
  });

  assert.equal(nativePorts.length, 2);
  assert.equal(nativePorts[1].lastSent().type, "create_thread");
  assert.equal(sdkPort.lastSent().type, "response");
  assert.equal(sdkPort.lastSent().requestId, "sdk_end_1");
  respondNative(nativePorts[1], nativePorts[1].lastSent(), { threadId: "thread_2" });
  await tick();
  respondNative(nativePorts[1], nativePorts[1].lastSent(), { subscribed: true });
  await tick();

  assert.deepEqual(sdkPort.lastSent(), {
    channelId: "channel_2",
    type: "response",
    requestId: "sdk_create_2",
    ok: true,
    result: { sessionId: "thread_2" },
  });
  assert.equal(background.getActiveThreadCount(), 1);
  assert.equal(background.getState().connected, true);
});

test("multiple SDK sessions keep native host until final session ends", async () => {
  const { chrome, nativePort } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });
  const sdkPort = new MockPort("webcli-sdk-content");
  background.handleSdkConnect(sdkPort);

  sdkPort.emit({
    type: "create_session",
    channelId: "channel_1",
    requestId: "sdk_create_a",
    input: { provider: "codex", skillsUrls: [] },
  });
  respondNative(nativePort, nativePort.lastSent(), { threadId: "thread_a" });
  await tick();
  respondNative(nativePort, nativePort.lastSent(), { subscribed: true });
  await tick();

  sdkPort.emit({
    type: "create_session",
    channelId: "channel_2",
    requestId: "sdk_create_b",
    input: { provider: "codex", skillsUrls: [] },
  });
  respondNative(nativePort, nativePort.lastSent(), { threadId: "thread_b" });
  await tick();
  respondNative(nativePort, nativePort.lastSent(), { subscribed: true });
  await tick();

  assert.equal(background.getActiveThreadCount(), 2);

  sdkPort.emit({
    type: "end_session",
    channelId: "channel_1",
    requestId: "sdk_end_a",
    sessionId: "thread_a",
  });
  await tick();
  respondNative(nativePort, nativePort.lastSent(), {});
  await tick();

  assert.equal(background.getActiveThreadCount(), 1);
  assert.equal(nativePort.disconnectCallCount, 0);

  sdkPort.emit({
    type: "end_session",
    channelId: "channel_2",
    requestId: "sdk_end_b",
    sessionId: "thread_b",
  });
  await tick();
  respondNative(nativePort, nativePort.lastSent(), {});
  await tick();

  assert.equal(background.getActiveThreadCount(), 0);
  assert.equal(nativePort.disconnectCallCount, 1);
});

test("thread ended event removes SDK route and disconnects when idle", async () => {
  const { chrome, nativePort } = createChromeMock();
  const background = createBackground(chrome, { disableReconnect: true });
  const sdkPort = await createSdkSession(background, nativePort);

  background.handleNativeMessage({
    type: "thread_event",
    event: {
      type: "ended",
      seq: 2,
      threadId: "thread_sdk",
    },
  });

  assert.deepEqual(sdkPort.lastSent(), {
    channelId: "channel_1",
    type: "ended",
    sessionId: "thread_sdk",
    seq: 2,
  });
  assert.equal(background.getSdkRouteCount(), 0);
  assert.equal(background.getActiveThreadCount(), 0);
  assert.equal(nativePort.disconnectCallCount, 1);
  assert.equal(background.getState().connected, false);
  assert.equal(background.getState().error, null);
});

test("intentional idle disconnect does not notify SDK error or schedule reconnect", async () => {
  const { chrome, nativePort } = createChromeMock();
  const background = createBackground(chrome);
  const sdkPort = new MockPort("webcli-sdk-content");
  background.handleSdkConnect(sdkPort);

  sdkPort.emit({
    type: "list_providers",
    channelId: "channel_1",
    requestId: "sdk_providers",
  });
  respondNative(nativePort, nativePort.lastSent(), []);
  await tick();

  assert.equal(nativePort.disconnectCallCount, 1);
  assert.equal(background.hasReconnectTimer(), false);
  assert.equal(sdkPort.sent.some((message) => message.type === "error"), false);
  assert.equal(background.getState().error, null);
});

test("unexpected disconnect reconnects only while active sessions remain", async () => {
  const { chrome, nativePort } = createChromeMock();
  const background = createBackground(chrome);
  await createSdkSession(background, nativePort);

  chrome.runtime.lastError = { message: "crashed" };
  background.handleNativeDisconnect();

  assert.equal(background.hasReconnectTimer(), true);
  assert.equal(background.getState().connected, false);
  assert.equal(background.getState().error, "crashed");

  background.handleNativeMessage({
    type: "thread_event",
    event: {
      type: "ended",
      seq: 3,
      threadId: "thread_sdk",
    },
  });

  assert.equal(background.getActiveThreadCount(), 0);
  assert.equal(background.hasReconnectTimer(), false);
});

test("unexpected disconnect without active sessions does not reconnect", () => {
  const { chrome } = createChromeMock();
  const background = createBackground(chrome);

  chrome.runtime.lastError = { message: "closed" };
  background.handleNativeDisconnect();

  assert.equal(background.hasReconnectTimer(), false);
});
