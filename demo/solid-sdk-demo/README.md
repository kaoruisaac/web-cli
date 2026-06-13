# WebCLI SDK Solid Demo

This demo is a small SolidJS playground for validating the browser `webcli` SDK through the WebCLI Chrome extension.

It demonstrates:

- SDK initialization and extension diagnostics
- `createSession` and `resumeSession`
- multiple independent sessions
- `sendText`, streaming chat deltas, session errors, and ended sessions
- frontend tool handlers and tool result/error display
- per-session transcript, tool call log, error log, and debug event log

## Install

Build the local SDK first, then install demo dependencies:

```bash
cd ../../sdk
npm install
npm run build

cd ../demo/solid-sdk-demo
npm install
```

## Run

```bash
npm run dev
```

Open the Vite URL in Chrome. The WebCLI extension must be loaded and the desktop/native host must be running.

Production builds use this extension id:

```txt
ogccgaminlphbkeghldidiiimajfdpag
```

During `npm run dev`, the demo first reads `WEBCLI_DEV_CHROME_EXTENSION_ID` from the repo-root `.env.local` and falls back to the production id when the value is missing or invalid:

```txt
WEBCLI_DEV_CHROME_EXTENSION_ID=mifjcaefhmigmhmejhficbnhgnecfibk
```

## Demo Tools

The page registers these frontend tools:

- `get_current_page`: returns the current page title and URL
- `get_selected_text`: returns the user's current text selection
- `ask_user`: opens an in-page prompt and returns the submitted text
- `throw_error`: intentionally throws to demonstrate tool handler errors

Unknown tools return a structured `TOOL_HANDLER_NOT_FOUND` result.

## Common Errors

- `Extension unavailable`: load the WebCLI extension and confirm the extension id matches the SDK.
- `Approval rejected`: approve this origin from the WebCLI extension popup before creating or resuming a session.
- `Session busy`: wait for the active session to finish before sending another message.
- `Session ended`: create or resume another session before sending text.
