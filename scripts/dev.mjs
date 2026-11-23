import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const api = spawn(node, ["server/index.mjs"], { cwd: root, stdio: "inherit", env: process.env });
let vite;
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  api.kill("SIGTERM");
  vite?.kill("SIGTERM");
  setTimeout(() => process.exit(code), 150);
}

api.on("exit", (code) => {
  if (!stopping) {
    console.error("Локальный API-сервер остановился.");
    stop(code || 1);
  }
});

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function waitForApi({ attempts = 40, delayMs = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (stopping || api.exitCode !== null) return false;

    try {
      const response = await fetch("http://127.0.0.1:3001/api/health", {
        signal: AbortSignal.timeout(1000),
        cache: "no-store",
      });
      if (response.ok) {
        const health = await response.json();
        if (health?.ok === true && health?.mode === "local") return true;
      }
    } catch {
      // The API process can need a moment to bind its local port.
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

const apiReady = await waitForApi();
if (!apiReady) {
  console.error("Локальный API не запустился за 10 секунд. Vite не будет запущен.");
  stop(1);
} else if (!stopping) {
  console.log("Локальный API готов. Запускаю Vite.");
  vite = spawn(node, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  vite.on("exit", (code) => {
    if (!stopping) stop(code || 0);
  });
}
