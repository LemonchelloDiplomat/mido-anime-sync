import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("Installing Tauri and Capacitor platform dependencies...");
run("npm", ["install", "@capacitor/core@^8", "@capacitor/android@^8", "@capnative/capacitor-secure-storage@^8"]);
run("npm", ["install", "--save-dev", "@capacitor/cli@^8", "@tauri-apps/cli@^2"]);

if (!existsSync("android")) {
  console.log("Generating the native Android project...");
  run("npx", ["cap", "add", "android"]);
} else {
  console.log("Android project already exists; leaving it intact.");
}

console.log("Platform dependencies are installed. Run 'npx cap sync android' before opening Android Studio.");
