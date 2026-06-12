const connectionEl = document.getElementById("connection");
const port = chrome.runtime.connect({ name: "popup" });

function render(state) {
  connectionEl.textContent = state.connected ? "connected" : "disconnected";
  connectionEl.dataset.connected = String(Boolean(state.connected));
}

port.onMessage.addListener((message) => {
  if (message?.type === "state") render(message.state);
});

port.postMessage({ type: "get_state" });
