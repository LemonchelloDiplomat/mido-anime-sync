import App from "./App";
import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { createStreamingRuntimeFromHost } from "./services/platform/runtime-bootstrap.js";

/** Native runtime is initialized before UI startup; web builds remain local-only. */
export const streamingRuntime = createStreamingRuntimeFromHost();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
