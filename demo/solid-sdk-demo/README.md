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

By default the SDK connects to extension id:

```txt
oafgamkcidgbmlcocfnmjajpegchbpgh
```

To use a different unpacked extension id:

```bash
VITE_WEBCLI_EXTENSION_ID=your_extension_id npm run dev
```

## Demo Tools

The page registers these frontend tools:

- `get_current_page`: returns the current page title and URL
- `get_selected_text`: returns the user's current text selection
- `ask_user`: opens an in-page prompt and returns the submitted text
- `throw_error`: intentionally throws to demonstrate tool handler errors

Unknown tools return a structured `TOOL_HANDLER_NOT_FOUND` result.

## Common Errors

- `Chrome runtime unavailable`: open the demo in Chrome and ensure extension APIs are available.
- `Extension unavailable`: load the WebCLI extension and confirm the extension id matches the SDK setting.
- `Session busy`: wait for the active session to finish before sending another message.
- `Session ended`: create or resume another session before sending text.
