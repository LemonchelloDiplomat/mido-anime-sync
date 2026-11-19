import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

const root = process.cwd();
const read = (path) => readFile(resolve(root, path), "utf8");

const manifest = JSON.parse(await read("browser-extension/manifest.json"));
assert.equal(manifest.manifest_version, 3, "Extension must use Manifest V3");
assert.equal(manifest.action?.default_popup, "popup.html");
assert.equal(manifest.background?.service_worker, "background.js");
assert.ok(manifest.permissions.includes("activeTab"));
assert.ok(manifest.permissions.includes("tabs"));
assert.ok(!manifest.permissions.includes("cookies"), "Extension must not request cookies access");
assert.ok(!manifest.host_permissions.some((host) => host.includes("<all_urls>")), "Extension must not request broad host access");

for (const file of ["content.js", "popup.js", "options.js", "background.js", "bridge.js"]) {
  const source = await read("browser-extension/" + file);
  new vm.Script(source, { filename: file });
}

for (const file of ["popup.html", "options.html"]) {
  await read("browser-extension/" + file);
}

const matches = manifest.content_scripts.flatMap((script) => script.matches);
for (const host of ["anime-go.org", "animego.online", "yummyani.me", "yummy-ani.me", "anixart-app.com", "anixartapp.com"]) {
  assert.ok(matches.some((pattern) => pattern.includes(host)), `Missing host match: ${host}`);
}

console.log("Browser extension manifest and scripts are valid.");
