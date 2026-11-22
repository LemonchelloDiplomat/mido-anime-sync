import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("Installing native platform tooling...");
run("npm", ["install", "@capacitor/android@^8"]);
run("npm", ["install", "--save-dev", "@capacitor/cli@^8", "@tauri-apps/cli@^2"]);

if (!existsSync("android")) {
  console.log("Generating the native Android project...");
  run("npx", ["cap", "add", "android"]);
} else {
  console.log("Android project already exists; leaving it intact.");
}

console.log("Platform tooling is installed. Build the web assets, then run 'npx cap sync android'.");
