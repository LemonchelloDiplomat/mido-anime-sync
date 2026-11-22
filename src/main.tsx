import App from "./App";
import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { initializeStreamingRuntimeFromHost } from "./services/platform/runtime-bootstrap.js";
import type { StreamingRuntime } from "./services/platform/streaming-runtime.js";

/** Initialize native adapters before React renders; web builds remain local-only. */
let streamingRuntime: StreamingRuntime | null = null;
try {
  streamingRuntime = await initializeStreamingRuntimeFromHost();
} catch (error) {
  // Keep the local library usable if native plugin installation is incomplete.
  console.error("Native streaming runtime initialization failed:", error);
}
export { streamingRuntime };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App streamingRuntime={streamingRuntime} />
  </React.StrictMode>,
);
