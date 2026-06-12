const PAGE_SOURCE = "webcli-sdk-page";
const EXTENSION_SOURCE = "webcli-sdk-extension";
const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;

export type WebcliOptions = {
  bridgeTimeoutMs?: number;
  targetOrigin?: string;
};

export type ProviderCode = "codex" | "gemini" | "opencode" | "cursor" | "claude";

type CreateSessionInputWithProvider = {
  provider: ProviderCode;
  model?: string;
  skillsUrls?: string[];
};

type CreateSessionInputWithDefaults = {
  provider?: undefined;
  model?: never;
  skillsUrls?: string[];
};

export type CreateSessionInput = CreateSessionInputWithProvider | CreateSessionInputWithDefaults;

export type ProviderInfo = {
  name: string;
  code: ProviderCode;
  path: string | null;
  available: boolean;
  error: string | null;
};

export type WebCliSettings = {
  defaultProvider: ProviderCode | null;
  defaultModel: string | null;
};

export type WebcliError = {
  code: string;
  message: string;
  details?: unknown;
};

export type WebcliSessionStatus =
  | "idle"
  | "running"
  | "waiting_tool_result"
  | "ended"
  | "error";

type ResponseMessage = {
  channelId: string;
  type: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: WebcliError;
};

type SessionEvent =
  | {
      type: "chat_delta";
      channelId: string;
      sessionId: string;
      seq?: number;
      text: string;
    }
  | {
      type: "status_changed";
      channelId: string;
      sessionId: string;
      seq?: number;
      status: WebcliSessionStatus;
    }
  | {
      type: "tool_call";
      channelId: string;
      sessionId: string;
      seq?: number;
      toolRequestId: string;
      tool: string;
      args: unknown;
    }
  | {
      type: "done";
      channelId: string;
      sessionId: string;
      seq?: number;
    }
  | {
      type: "error";
      channelId?: string;
      sessionId?: string;
      seq?: number;
      error?: WebcliError;
    }
  | {
      type: "ended";
      channelId: string;
      sessionId: string;
      seq?: number;
    };

type PortMessage = ResponseMessage | SessionEvent;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: WebcliError) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type PendingSend = {
  resolve: () => void;
  reject: (error: WebcliError) => void;
};

type ChatHandler = (text: string) => void;
type ToolHandler = (tool: string, args: unknown) => unknown | Promise<unknown>;
type ErrorHandler = (error: WebcliError) => void;
type StatusHandler = (status: WebcliSessionStatus) => void;
type EndedHandler = () => void;

export class Webcli {
  private readonly pageWindow: Window | null;
  private readonly channelId: string;
  private readonly bridgeTimeoutMs: number;
  private readonly targetOrigin: string;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly sessions = new Map<string, WebcliSession>();
  private readonly lastSeqBySession = new Map<string, number>();
  private nextRequestNumber = 1;
  private disconnectedError: WebcliError | null = null;
  private readonly messageListener: (event: MessageEvent) => void;

  constructor(options: WebcliOptions = {}) {
    this.pageWindow = typeof window === "undefined" ? null : window;
    this.channelId = createChannelId();
    this.bridgeTimeoutMs = Math.max(1, options.bridgeTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS);
    this.targetOrigin = options.targetOrigin || "*";
    this.messageListener = (event) => this.handleWindowMessage(event);

    if (!this.pageWindow?.postMessage || !this.pageWindow?.addEventListener) {
      this.disconnectedError = makeError(
        "EXTENSION_UNAVAILABLE",
        "WebCLI SDK must run in a browser page context."
      );
      return;
    }

    this.pageWindow.addEventListener("message", this.messageListener);
  }

  async createSession(input: CreateSessionInput = {}): Promise<WebcliSession> {
    const resolvedOrPromise = this.resolveCreateSessionInput(input);
    const resolvedInput =
      resolvedOrPromise instanceof Promise ? await resolvedOrPromise : resolvedOrPromise;

    const result = await this.request<{ sessionId: string }>("create_session", {
      input: {
        provider: resolvedInput.provider,
        model: resolvedInput.model,
        skillsUrls: resolvedInput.skillsUrls,
      },
    });

    if (!result.sessionId) {
      throw makeError("SDK_PROTOCOL_ERROR", "create_session response did not include sessionId");
    }

    return this.registerSession(result.sessionId, resolvedInput.provider, resolvedInput.model);
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const result = await this.request<ProviderInfo[]>("list_providers");
    if (!Array.isArray(result)) {
      throw makeError("SDK_PROTOCOL_ERROR", "list_providers response was not an array");
    }
    return result;
  }

  async getSettings(): Promise<WebCliSettings> {
    const result = await this.request<WebCliSettings>("get_settings");
    if (!isSettings(result)) {
      throw makeError("SDK_PROTOCOL_ERROR", "get_settings response had invalid shape");
    }
    return result;
  }

  async resumeSession(sessionId: string): Promise<WebcliSession> {
    if (!sessionId?.trim()) {
      throw makeError("INVALID_INPUT", "sessionId is required");
    }

    const result = await this.request<{ sessionId: string }>("resume_session", {
      sessionId,
    });

    if (!result.sessionId) {
      throw makeError("SDK_PROTOCOL_ERROR", "resume_session response did not include sessionId");
    }

    return this.registerSession(result.sessionId, "", undefined);
  }

  request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.disconnectedError) {
      return Promise.reject(this.disconnectedError);
    }

    if (!this.pageWindow) {
      return Promise.reject(makeError("EXTENSION_UNAVAILABLE", "WebCLI SDK must run in a browser page context."));
    }

    const requestId = `sdk_${Date.now()}_${this.nextRequestNumber++}`;
    const message = { source: PAGE_SOURCE, channelId: this.channelId, type, requestId, ...payload };

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          makeError("SDK_BRIDGE_TIMEOUT", "WebCLI extension bridge did not respond.", {
            requestId,
            type,
          })
        );
      }, this.bridgeTimeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeoutId,
      });

      try {
        this.pageWindow?.postMessage(message, this.targetOrigin);
      } catch (err) {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeoutId);
        reject(normalizeError(err, "EXTENSION_DISCONNECTED", "WebCLI extension disconnected."));
      }
    });
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.lastSeqBySession.delete(sessionId);
  }

  private resolveCreateSessionInput(input: CreateSessionInput):
    | {
        provider: ProviderCode;
        model?: string;
        skillsUrls: string[];
      }
    | Promise<{
    provider: ProviderCode;
    model?: string;
    skillsUrls: string[];
  }> {
    const raw = (input ?? {}) as {
      provider?: unknown;
      model?: unknown;
      skillsUrls?: unknown;
    };
    const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
    const hasProvider = provider.length > 0;
    const hasModel = raw.model !== undefined;

    if (!hasProvider && hasModel) {
      throw makeError("INVALID_INPUT", "model cannot be provided without provider");
    }

    const skillsUrls = Array.isArray(raw.skillsUrls) ? raw.skillsUrls : [];
    const userModel = typeof raw.model === "string" ? raw.model : undefined;

    if (!hasProvider) {
      return this.resolveDefaultCreateSessionInput(skillsUrls);
    }

    if (!isProviderCode(provider)) {
      throw makeError("INVALID_INPUT", "provider is not supported", { provider });
    }

    let model = userModel;
    if (model === undefined) {
      return this.resolveProviderOnlyCreateSessionInput(provider, skillsUrls);
    }

    return {
      provider: provider as ProviderCode,
      model,
      skillsUrls,
    };
  }

  private async resolveDefaultCreateSessionInput(skillsUrls: string[]): Promise<{
    provider: ProviderCode;
    model?: string;
    skillsUrls: string[];
  }> {
    const settings = await this.getSettings();
    if (!settings.defaultProvider) {
      throw makeError(
        "DEFAULT_PROVIDER_NOT_SET",
        "Default provider is not set. Open the WebCLI desktop app Settings page and choose a default provider."
      );
    }
    await this.assertDefaultProviderAvailable(settings.defaultProvider);
    return {
      provider: settings.defaultProvider,
      model: settings.defaultModel ?? undefined,
      skillsUrls,
    };
  }

  private async resolveProviderOnlyCreateSessionInput(
    provider: ProviderCode,
    skillsUrls: string[]
  ): Promise<{
    provider: ProviderCode;
    model?: string;
    skillsUrls: string[];
  }> {
    const settings = await this.getSettings();
    return {
      provider,
      model:
        settings.defaultProvider === provider && settings.defaultModel
          ? settings.defaultModel
          : undefined,
      skillsUrls,
    };
  }

  private async assertDefaultProviderAvailable(provider: ProviderCode): Promise<void> {
    const providers = await this.listProviders();
    const info = providers.find((candidate) => candidate.code === provider);
    if (!info?.available) {
      throw makeError(
        "DEFAULT_PROVIDER_UNAVAILABLE",
        "Default provider is not currently available. Open the WebCLI desktop app Settings page and choose an available provider.",
        { provider }
      );
    }
  }

  private registerSession(sessionId: string, provider: string, model: string | undefined): WebcliSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const session = new WebcliSession(this, sessionId, provider, model);
    this.sessions.set(sessionId, session);
    return session;
  }

  private handleWindowMessage(event: MessageEvent): void {
    if (event.source !== this.pageWindow) return;
    const raw = event.data;
    const message = raw as PortMessage;
    if (!message || typeof message !== "object") return;
    if ((message as { source?: unknown }).source !== EXTENSION_SOURCE) return;
    if (message.channelId && message.channelId !== this.channelId) return;

    if (message.type === "response") {
      this.handleResponse(message);
      return;
    }

    if (isSessionEvent(message) && this.isNewEvent(message)) {
      if (message.sessionId) {
        this.sessions.get(message.sessionId)?.handleEvent(message);
      } else if (message.type === "error") {
        this.broadcastError(normalizeError(message.error, "SDK_BRIDGE_ERROR", "WebCLI bridge error"));
      }
    }
  }

  private handleResponse(message: ResponseMessage): void {
    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) return;

    this.pendingRequests.delete(message.requestId);
    clearTimeout(pending.timeoutId);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(normalizeError(message.error, "SDK_BRIDGE_ERROR", "SDK bridge request failed"));
    }
  }

  private isNewEvent(event: SessionEvent): boolean {
    if (!event.sessionId || typeof event.seq !== "number") return true;

    const lastSeq = this.lastSeqBySession.get(event.sessionId);
    if (typeof lastSeq === "number" && event.seq <= lastSeq) {
      return false;
    }

    this.lastSeqBySession.set(event.sessionId, event.seq);
    return true;
  }

  private handleDisconnect(): void {
    const error = makeError("EXTENSION_DISCONNECTED", "WebCLI extension disconnected.");
    this.disconnectedError = error;

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.broadcastError(error);
  }

  private broadcastError(error: WebcliError): void {
    for (const session of this.sessions.values()) {
      session.handleEvent({ type: "error", sessionId: session.sessionId, error });
    }
  }
}

export class WebcliSession {
  readonly sessionId: string;
  readonly provider: string;
  readonly model?: string;

  private status: WebcliSessionStatus = "idle";
  private pendingSend: PendingSend | null = null;
  private toolHandler: ToolHandler | null = null;
  private readonly chatHandlers = new Set<ChatHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly endedHandlers = new Set<EndedHandler>();

  constructor(
    private readonly client: Webcli,
    sessionId: string,
    provider: string,
    model?: string
  ) {
    this.sessionId = sessionId;
    this.provider = provider;
    this.model = model;
  }

  sendText(text: string): Promise<void> {
    if (this.status === "ended") {
      return Promise.reject(makeError("SESSION_ENDED", "session has ended", { sessionId: this.sessionId }));
    }

    if (this.pendingSend) {
      return Promise.reject(makeError("SESSION_BUSY", "session is already running", { sessionId: this.sessionId }));
    }

    this.setStatus("running");

    const donePromise = new Promise<void>((resolve, reject) => {
      this.pendingSend = { resolve, reject };
    });

    const requestPromise = this.client
      .request("send_text", {
        sessionId: this.sessionId,
        text,
      })
      .catch((err) => {
        const error = normalizeError(err, "SEND_TEXT_FAILED", "sendText failed");
        this.clearPendingSend();
        this.emitError(error);
        throw error;
      });

    return Promise.all([requestPromise, donePromise]).then(() => undefined);
  }

  onChat(handler: ChatHandler): () => void {
    this.chatHandlers.add(handler);
    return () => this.chatHandlers.delete(handler);
  }

  onTool(handler: ToolHandler): () => void {
    this.toolHandler = handler;
    return () => {
      if (this.toolHandler === handler) {
        this.toolHandler = null;
      }
    };
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  onEnded(handler: EndedHandler): () => void {
    this.endedHandlers.add(handler);
    return () => this.endedHandlers.delete(handler);
  }

  getStatus(): WebcliSessionStatus {
    return this.status;
  }

  async end(): Promise<void> {
    if (this.status === "ended") return;

    try {
      await this.client.request("end_session", {
        sessionId: this.sessionId,
      });
    } catch (err) {
      const error = normalizeError(err, "END_SESSION_FAILED", "end failed");
      this.emitError(error);
      throw error;
    }

    this.markEnded();
    this.client.unregisterSession(this.sessionId);
  }

  handleEvent(event: SessionEvent): void {
    if (event.type === "chat_delta") {
      for (const handler of this.chatHandlers) {
        handler(event.text);
      }
      return;
    }

    if (event.type === "status_changed") {
      this.setStatus(event.status);
      if (event.status === "idle") {
        this.resolvePendingSend();
      } else if (event.status === "ended") {
        this.markEnded();
      } else if (event.status === "error") {
        const error = makeError("SESSION_ERROR", "session entered error status", { sessionId: this.sessionId });
        this.rejectPendingSend(error);
        this.emitError(error);
      }
      return;
    }

    if (event.type === "tool_call") {
      this.setStatus("waiting_tool_result");
      this.handleToolCall(event);
      return;
    }

    if (event.type === "done") {
      this.setStatus("idle");
      this.resolvePendingSend();
      return;
    }

    if (event.type === "error") {
      this.setStatus("error");
      const error = normalizeError(event.error, "SESSION_ERROR", "session error");
      this.rejectPendingSend(error);
      this.emitError(error);
      return;
    }

    if (event.type === "ended") {
      this.markEnded();
    }
  }

  private async handleToolCall(event: Extract<SessionEvent, { type: "tool_call" }>): Promise<void> {
    let result: unknown;
    if (!this.toolHandler) {
      result = {
        error: makeError("TOOL_HANDLER_NOT_FOUND", `No tool handler registered for ${event.tool}`, {
          tool: event.tool,
        }),
      };
    } else {
      try {
        result = await this.toolHandler(event.tool, event.args);
      } catch (err) {
        result = {
          error: normalizeError(err, "TOOL_HANDLER_ERROR", "Tool handler failed"),
        };
      }
    }

    try {
      await this.client.request("submit_tool_result", {
        sessionId: this.sessionId,
        toolRequestId: event.toolRequestId,
        result,
      });
    } catch (err) {
      this.emitError(normalizeError(err, "SUBMIT_TOOL_RESULT_FAILED", "submit_tool_result failed"));
    }
  }

  private resolvePendingSend(): void {
    const pending = this.pendingSend;
    this.pendingSend = null;
    pending?.resolve();
  }

  private rejectPendingSend(error: WebcliError): void {
    const pending = this.pendingSend;
    this.pendingSend = null;
    pending?.reject(error);
  }

  private clearPendingSend(): void {
    this.pendingSend = null;
  }

  private markEnded(): void {
    const wasEnded = this.status === "ended";
    this.setStatus("ended");
    this.rejectPendingSend(makeError("SESSION_ENDED", "session has ended", { sessionId: this.sessionId }));
    if (!wasEnded) {
      for (const handler of this.endedHandlers) {
        handler();
      }
    }
  }

  private emitError(error: WebcliError): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  private setStatus(status: WebcliSessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }
}

function isSessionEvent(message: PortMessage): message is SessionEvent {
  return (
    message.type === "chat_delta" ||
    message.type === "status_changed" ||
    message.type === "tool_call" ||
    message.type === "done" ||
    message.type === "error" ||
    message.type === "ended"
  );
}

function isSettings(value: unknown): value is WebCliSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Partial<WebCliSettings>;
  return (
    (settings.defaultProvider === null ||
      settings.defaultProvider === "codex" ||
      settings.defaultProvider === "gemini" ||
      settings.defaultProvider === "opencode" ||
      settings.defaultProvider === "cursor" ||
      settings.defaultProvider === "claude") &&
    (settings.defaultModel === null || typeof settings.defaultModel === "string")
  );
}

function isProviderCode(value: string): value is ProviderCode {
  return (
    value === "codex" ||
    value === "gemini" ||
    value === "opencode" ||
    value === "cursor" ||
    value === "claude"
  );
}

function makeError(code: string, message: string, details?: unknown): WebcliError {
  return details === undefined ? { code, message } : { code, message, details };
}

function createChannelId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `webcli_${Date.now()}_${random}`;
}

function normalizeError(err: unknown, fallbackCode: string, fallbackMessage: string): WebcliError {
  if (!err) return makeError(fallbackCode, fallbackMessage);
  if (typeof err === "string") return makeError(fallbackCode, err);
  if (err instanceof Error) return makeError(fallbackCode, err.message || fallbackMessage);

  const value = err as Partial<WebcliError>;
  if (typeof value.code === "string" && typeof value.message === "string") {
    return {
      code: value.code,
      message: value.message,
      details: value.details,
    };
  }

  return makeError(fallbackCode, fallbackMessage, err);
}
