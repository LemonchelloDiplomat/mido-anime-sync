import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const api = spawn(node, ["server/index.mjs"], { cwd: root, stdio: "inherit", env: process.env });
const vite = spawn(node, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"], { cwd: root, stdio: "inherit", env: process.env });

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  api.kill("SIGTERM");
  vite.kill("SIGTERM");
  setTimeout(() => process.exit(code), 150);
}
api.on("exit", (code) => {
  if (!stopping) {
    console.error("Локальный API-сервер остановился.");
    stop(code || 1);
  }
});
vite.on("exit", (code) => {
  if (!stopping) stop(code || 0);
});
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
