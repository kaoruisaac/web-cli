const HOST_NAME = "com.example.webcli";
const DEMO_PROVIDER = "codex";
const DEMO_SKILLS_URLS = [
  "http://127.0.0.1:8765/tools.json",
  "http://127.0.0.1:8765/tools.md",
];
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const MAX_EVENTS = 80;
const SDK_PORT_NAME = "webcli-sdk-content";

function createBackground(runtimeChrome, options = {}) {
  let nativePort = null;
  let reconnectTimer = null;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let nextRequestNumber = 1;
  let pendingIntentionalDisconnects = 0;
  let nativeOperationDepth = 0;

  const popupPorts = new Set();
  const pendingRequests = new Map();
  const activeThreadIds = new Set();
  const sdkPorts = new Set();
  const sdkChannelsByPort = new Map();
  const sdkRoutesBySession = new Map();

  let state = {
    connected: false,
    threadId: null,
    threadStatus: "notCreated",
    counter: 0,
    error: null,
    events: [],
  };

  function nextRequestId() {
    return `ext_${Date.now()}_${nextRequestNumber++}`;
  }

  function normalizeError(err, fallbackCode = "SDK_BRIDGE_ERROR", fallbackMessage = "WebCLI bridge error") {
    if (!err) return { code: fallbackCode, message: fallbackMessage };
    if (typeof err === "string") return { code: fallbackCode, message: err };
    if (err.code && err.message) return err;
    return {
      code: fallbackCode,
      message: err.message || fallbackMessage,
      details: err.details,
    };
  }

  function setState(partial) {
    state = { ...state, ...partial };
    broadcastState();
  }

  function appendEvent(event) {
    state = {
      ...state,
      events: [event, ...state.events].slice(0, MAX_EVENTS),
    };
    broadcastState();
  }

  function broadcastState() {
    const message = { type: "state", state };
    for (const port of popupPorts) {
      try {
        port.postMessage(message);
      } catch (_err) {
        popupPorts.delete(port);
      }
    }
  }

  function scheduleReconnect() {
    if (options.disableReconnect || reconnectTimer || activeThreadIds.size === 0) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (activeThreadIds.size === 0) return;
      connectNative();
    }, reconnectDelayMs);

    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function isNativeIdle() {
    return activeThreadIds.size === 0 && pendingRequests.size === 0 && nativeOperationDepth === 0;
  }

  function maybeDisconnectNativeIfIdle() {
    if (!nativePort || !isNativeIdle()) return;

    const port = nativePort;
    nativePort = null;
    pendingIntentionalDisconnects += 1;
    clearReconnectTimer();
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    setState({
      connected: false,
      error: null,
    });
    try {
      port.disconnect();
    } catch (_err) {
      pendingIntentionalDisconnects = Math.max(0, pendingIntentionalDisconnects - 1);
    }
  }

  async function withNativeOperation(operation) {
    nativeOperationDepth += 1;
    try {
      return await operation();
    } finally {
      nativeOperationDepth -= 1;
      maybeDisconnectNativeIfIdle();
    }
  }

  function connectNative() {
    if (nativePort) return true;

    try {
      nativePort = runtimeChrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      nativePort = null;
      setState({
        connected: false,
        error: err.message,
      });
      notifyAllSdkPorts({
        type: "error",
        error: normalizeError(err, "NATIVE_HOST_UNAVAILABLE", "WebCLI native host is not connected."),
      });
      scheduleReconnect();
      return false;
    }

    nativePort.onMessage.addListener(handleNativeMessage);
    nativePort.onDisconnect.addListener(handleNativeDisconnect);
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    setState({
      connected: true,
      error: null,
    });
    return true;
  }

  function handleNativeDisconnect() {
    if (pendingIntentionalDisconnects > 0) {
      pendingIntentionalDisconnects -= 1;
      return;
    }

    const err = runtimeChrome.runtime.lastError;
    const error = normalizeError(err, "NATIVE_CONNECTION_CLOSED", "Native host disconnected.");
    nativePort = null;
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
    setState({
      connected: false,
      error: error.message,
    });
    notifyAllSdkPorts({ type: "error", error });
    scheduleReconnect();
  }

  function handleNativeMessage(message) {
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;

    if (message?.type === "response") {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) return;

      pendingRequests.delete(message.requestId);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(normalizeError(message.error, "IPC_UNAVAILABLE", "Native request failed"));
      }
      maybeDisconnectNativeIfIdle();
      return;
    }

    if (message?.type === "thread_event") {
      applyThreadEvent(message.event);
      dispatchSdkThreadEvent(message.event);
      if (message.event?.type === "ended") {
        removeActiveThread(message.event.threadId);
        removeSdkSessionRoutes(message.event.threadId);
        maybeDisconnectNativeIfIdle();
      }
      return;
    }

    const text = `Unexpected native message: ${JSON.stringify(message)}`;
    setState({ error: text });
    notifyAllSdkPorts({
      type: "error",
      error: { code: "SDK_PROTOCOL_ERROR", message: text },
    });
  }

  function sendNativeRequest(type, payload = {}) {
    if (!connectNative()) {
      return Promise.reject({
        code: "NATIVE_HOST_UNAVAILABLE",
        message: "WebCLI native host is not connected.",
      });
    }

    const requestId = nextRequestId();
    const message = { type, requestId, ...payload };

    return new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
      try {
        nativePort.postMessage(message);
      } catch (err) {
        pendingRequests.delete(requestId);
        const error = normalizeError(err, "NATIVE_CONNECTION_CLOSED", "Native host disconnected.");
        reject(error);
        nativePort = null;
        setState({
          connected: false,
          error: error.message,
        });
        notifyAllSdkPorts({ type: "error", error });
        scheduleReconnect();
        maybeDisconnectNativeIfIdle();
      }
    });
  }

  async function createThread() {
    return withNativeOperation(async () => {
      setState({
        error: null,
        events: [],
      });

      const result = await sendNativeRequest("create_thread", {
        provider: DEMO_PROVIDER,
        skillsUrls: DEMO_SKILLS_URLS,
      });
      const threadId = result?.threadId;
      if (!threadId) {
        throw new Error("create_thread response did not include threadId.");
      }

      try {
        await sendNativeRequest("subscribe_thread", { threadId });
      } catch (err) {
        await sendNativeRequest("end_thread", { threadId }).catch(() => {});
        throw err;
      }

      addActiveThread(threadId);
      setState({
        threadId,
        threadStatus: "idle",
      });
    });
  }

  async function sendText(message) {
    if (!state.threadId) {
      throw new Error("Create a thread first.");
    }
    await sendNativeRequest("send_text", {
      threadId: state.threadId,
      message,
    });
  }

  async function endThread() {
    if (!state.threadId) {
      throw new Error("No active thread.");
    }
    return withNativeOperation(async () => {
      const threadId = state.threadId;
      await sendNativeRequest("end_thread", { threadId });
      removeActiveThread(threadId);
      setState({
        threadStatus: "ended",
      });
    });
  }

  function applyThreadEvent(event) {
    if (!event) return;
    if (!state.threadId || event.threadId !== state.threadId) return;

    if (event.threadId) {
      state = { ...state, threadId: state.threadId || event.threadId };
    }

    if (event.type === "status_changed") {
      state = { ...state, threadStatus: event.status };
    } else if (event.type === "error") {
      state = {
        ...state,
        threadStatus: "error",
        error: formatError(event.error),
      };
    } else if (event.type === "ended") {
      state = { ...state, threadStatus: "ended" };
      removeActiveThread(event.threadId);
    } else if (event.type === "tool_call") {
      autoSubmitToolResult(event);
    }

    appendEvent(event);
  }

  function autoSubmitToolResult(event) {
    const result = runDemoTool(event);
    sendNativeRequest("submit_tool_result", {
      threadId: event.threadId,
      toolRequestId: event.requestId,
      result,
    }).catch((err) => {
      setState({ error: formatError(err) });
    });
  }

  function runDemoTool(event) {
    if (event.toolName === "get_app_state") {
      return {
        connected: state.connected,
        threadId: state.threadId,
        threadStatus: state.threadStatus,
        counter: state.counter,
        eventCount: state.events.length,
      };
    }

    if (event.toolName === "update_counter") {
      const delta = Number(event.args?.delta);
      const nextCounter = state.counter + delta;
      setState({ counter: nextCounter });
      return {
        counter: nextCounter,
        delta,
      };
    }

    return {
      error: {
        code: "TOOL_NOT_FOUND",
        message: `No demo handler for ${event.toolName}`,
      },
    };
  }

  function formatError(err) {
    if (!err) return "";
    if (typeof err === "string") return err;
    if (err.code && err.message) return `${err.code}: ${err.message}`;
    return err.message || JSON.stringify(err);
  }

  function postSdkResponse(port, channelId, requestId, ok, result, error) {
    const message = { channelId, type: "response", requestId, ok };
    if (ok) message.result = result ?? {};
    if (!ok) message.error = normalizeError(error, "SDK_BRIDGE_ERROR", "SDK bridge request failed");
    try {
      port.postMessage(message);
    } catch (_err) {
      disconnectSdkPort(port);
    }
  }

  function postSdkEvent(port, message) {
    try {
      port.postMessage(message);
    } catch (_err) {
      disconnectSdkPort(port);
    }
  }

  function notifyAllSdkPorts(message) {
    for (const port of sdkPorts) {
      postSdkEvent(port, message);
    }
  }

  function addActiveThread(threadId) {
    if (threadId) activeThreadIds.add(threadId);
  }

  function removeActiveThread(threadId) {
    if (threadId) activeThreadIds.delete(threadId);
    if (activeThreadIds.size === 0) clearReconnectTimer();
  }

  function addSdkSession(port, channelId, sessionId) {
    if (!channelId || !sessionId) return;
    if (!sdkChannelsByPort.has(port)) {
      sdkChannelsByPort.set(port, new Map());
    }
    const channels = sdkChannelsByPort.get(port);
    if (!channels.has(channelId)) {
      channels.set(channelId, new Set());
    }
    channels.get(channelId).add(sessionId);

    if (!sdkRoutesBySession.has(sessionId)) {
      sdkRoutesBySession.set(sessionId, new Map());
    }
    const routes = sdkRoutesBySession.get(sessionId);
    if (!routes.has(port)) {
      routes.set(port, new Set());
    }
    routes.get(port).add(channelId);
  }

  function removeSdkSession(port, channelId, sessionId) {
    const channels = sdkChannelsByPort.get(port);
    const sessions = channels?.get(channelId);
    sessions?.delete(sessionId);
    if (sessions?.size === 0) {
      channels.delete(channelId);
    }
    if (channels?.size === 0) {
      sdkChannelsByPort.delete(port);
    }

    const routes = sdkRoutesBySession.get(sessionId);
    const routeChannels = routes?.get(port);
    routeChannels?.delete(channelId);
    if (routeChannels?.size === 0) {
      routes.delete(port);
    }
    if (routes?.size === 0) {
      sdkRoutesBySession.delete(sessionId);
    }
  }

  function removeSdkSessionRoutes(sessionId) {
    const routes = sdkRoutesBySession.get(sessionId);
    if (!routes) return;
    for (const [port, channelIds] of Array.from(routes.entries())) {
      for (const channelId of Array.from(channelIds)) {
        removeSdkSession(port, channelId, sessionId);
      }
    }
  }

  function disconnectSdkPort(port) {
    sdkPorts.delete(port);
    const channels = sdkChannelsByPort.get(port);
    if (channels) {
      for (const [channelId, sessions] of Array.from(channels.entries())) {
        for (const sessionId of Array.from(sessions)) {
          removeSdkSession(port, channelId, sessionId);
        }
      }
    }
    sdkChannelsByPort.delete(port);
  }

  function sdkEventFromThreadEvent(event) {
    if (!event?.threadId) return null;
    const base = { sessionId: event.threadId, seq: event.seq };
    if (event.type === "assistant_message") {
      return { ...base, type: "chat_delta", text: event.text || "" };
    }
    if (event.type === "status_changed") {
      return { ...base, type: "status_changed", status: sdkStatusFromCoreStatus(event.status) };
    }
    if (event.type === "tool_call") {
      return {
        ...base,
        type: "tool_call",
        toolRequestId: event.requestId,
        tool: event.toolName,
        args: event.args,
      };
    }
    if (event.type === "done") {
      return { ...base, type: "done" };
    }
    if (event.type === "error") {
      return { ...base, type: "error", error: normalizeError(event.error) };
    }
    if (event.type === "ended") {
      return { ...base, type: "ended" };
    }
    return null;
  }

  function sdkStatusFromCoreStatus(status) {
    if (status === "waitingToolResult") return "waiting_tool_result";
    if (status === "starting" || status === "stopping") return "running";
    return status;
  }

  function dispatchSdkThreadEvent(event) {
    const message = sdkEventFromThreadEvent(event);
    if (!message) return;
    const routes = sdkRoutesBySession.get(message.sessionId);
    if (!routes) return;
    for (const [port, channelIds] of routes) {
      for (const channelId of channelIds) {
        postSdkEvent(port, { ...message, channelId });
      }
    }
  }

  async function handleSdkMessage(port, message) {
    const requestId = message?.requestId || "";
    const channelId = message?.channelId || "";
    try {
      if (!requestId) {
        throw { code: "SDK_PROTOCOL_ERROR", message: "requestId is required" };
      }
      if (!channelId) {
        throw { code: "SDK_PROTOCOL_ERROR", message: "channelId is required" };
      }

      if (message.type === "create_session") {
        await withNativeOperation(async () => {
          const input = message.input || {};
          const result = await sendNativeRequest("create_thread", {
            provider: input.provider,
            model: input.model,
            skillsUrls: input.skillsUrls || [],
          });
          const sessionId = result?.threadId;
          if (!sessionId) {
            throw { code: "SDK_PROTOCOL_ERROR", message: "create_thread response did not include threadId." };
          }

          try {
            await sendNativeRequest("subscribe_thread", { threadId: sessionId });
          } catch (err) {
            await sendNativeRequest("end_thread", { threadId: sessionId }).catch(() => {});
            throw err;
          }

          addActiveThread(sessionId);
          addSdkSession(port, channelId, sessionId);
          postSdkResponse(port, channelId, requestId, true, { sessionId });
        });
        return;
      }

      if (message.type === "list_providers") {
        const result = await withNativeOperation(() => sendNativeRequest("list_providers"));
        postSdkResponse(port, channelId, requestId, true, result || []);
        return;
      }

      if (message.type === "get_settings") {
        const result = await withNativeOperation(() => sendNativeRequest("get_settings"));
        postSdkResponse(port, channelId, requestId, true, result || {});
        return;
      }

      if (message.type === "resume_session") {
        const sessionId = message.sessionId;
        if (!sessionId) {
          throw { code: "SDK_PROTOCOL_ERROR", message: "sessionId is required" };
        }
        await withNativeOperation(async () => {
          await sendNativeRequest("subscribe_thread", { threadId: sessionId });
          addActiveThread(sessionId);
          addSdkSession(port, channelId, sessionId);
          postSdkResponse(port, channelId, requestId, true, { sessionId });
        });
        return;
      }

      if (message.type === "send_text") {
        await sendNativeRequest("send_text", {
          threadId: message.sessionId,
          message: message.text || "",
        });
        postSdkResponse(port, channelId, requestId, true, {});
        return;
      }

      if (message.type === "submit_tool_result") {
        await sendNativeRequest("submit_tool_result", {
          threadId: message.sessionId,
          toolRequestId: message.toolRequestId,
          result: message.result,
        });
        postSdkResponse(port, channelId, requestId, true, {});
        return;
      }

      if (message.type === "end_session") {
        await withNativeOperation(async () => {
          await sendNativeRequest("end_thread", { threadId: message.sessionId });
          removeSdkSession(port, channelId, message.sessionId);
          removeActiveThread(message.sessionId);
        });
        postSdkResponse(port, channelId, requestId, true, {});
        return;
      }

      throw {
        code: "SDK_PROTOCOL_ERROR",
        message: "unknown SDK request type",
        details: { type: message.type },
      };
    } catch (err) {
      postSdkResponse(port, channelId, requestId, false, null, err);
    }
  }

  function handlePopupConnect(port) {
    if (port.name !== "popup") return;

    popupPorts.add(port);
    port.postMessage({ type: "state", state });

    port.onMessage.addListener(async (message) => {
      try {
        if (message?.type === "create_thread") {
          await createThread();
        } else if (message?.type === "send_text") {
          await sendText(message.message || "");
        } else if (message?.type === "end_thread") {
          await endThread();
        } else if (message?.type === "get_state") {
          port.postMessage({ type: "state", state });
        }
      } catch (err) {
        setState({ error: formatError(err) });
      }
    });

    port.onDisconnect.addListener(() => {
      popupPorts.delete(port);
    });
  }

  function handleSdkConnect(port) {
    if (port.name !== SDK_PORT_NAME) return;

    sdkPorts.add(port);
    sdkChannelsByPort.set(port, new Map());

    port.onMessage.addListener((message) => {
      handleSdkMessage(port, message);
    });

    port.onDisconnect.addListener(() => {
      disconnectSdkPort(port);
    });
  }

  function start() {
    runtimeChrome.runtime.onConnect.addListener((port) => {
      handlePopupConnect(port);
      handleSdkConnect(port);
    });
  }

  return {
    start,
    handleNativeMessage,
    handleNativeDisconnect,
    handlePopupConnect,
    handleSdkConnect,
    handleSdkMessage,
    dispatchSdkThreadEvent,
    sdkEventFromThreadEvent,
    getState: () => state,
    getSdkRouteCount: () => sdkRoutesBySession.size,
    getNativeRequestCount: () => pendingRequests.size,
    getActiveThreadCount: () => activeThreadIds.size,
    hasReconnectTimer: () => Boolean(reconnectTimer),
  };
}

if (typeof chrome !== "undefined" && chrome.runtime) {
  createBackground(chrome).start();
}

if (typeof module !== "undefined") {
  module.exports = { createBackground };
}
