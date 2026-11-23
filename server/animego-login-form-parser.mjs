const SITE_ORIGIN = "https://animego.me";
const MAX_LOGIN_HTML_CHARS = 1024 * 1024;

function decodeHtmlAttribute(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function readAttribute(tag, name) {
  const match = String(tag).match(new RegExp(
    "\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
    "i",
  ));
  return match ? decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function parseFormInputs(formHtml) {
  const inputs = [];
  for (const match of String(formHtml).matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const name = readAttribute(tag, "name");
    if (!name) continue;
    inputs.push({
      name,
      type: (readAttribute(tag, "type") || "text").toLowerCase(),
      value: readAttribute(tag, "value"),
    });
  }
  return inputs;
}

/**
 * Extracts the first-party AnimeGO login form contract from a GET /login
 * HTML response. The returned csrfToken is secret material and must remain
 * server-side: never log it or return it to the browser.
 *
 * This parser performs no network requests and never handles credentials.
 */
export function parseAnimeGoLoginForm(html, options = {}) {
  const source = String(html ?? "");
  if (source.length > MAX_LOGIN_HTML_CHARS) {
    throw new Error("AnimeGO login page exceeds the 1 MB parser limit.");
  }

  let baseUrl;
  try {
    baseUrl = new URL(options.baseUrl || SITE_ORIGIN + "/login");
  } catch {
    throw new Error("AnimeGO login parser received an invalid base URL.");
  }
  if (baseUrl.origin !== SITE_ORIGIN) {
    throw new Error("AnimeGO login parser only accepts animego.me pages.");
  }

  for (const match of source.matchAll(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi)) {
    const openingTag = match[0].match(/^<form\b[^>]*>/i)?.[0] ?? "";
    const method = (readAttribute(openingTag, "method") || "GET").toUpperCase();
    if (method !== "POST") continue;

    const rawAction = readAttribute(openingTag, "action") || baseUrl.pathname;
    let action;
    try {
      action = new URL(rawAction, baseUrl);
    } catch {
      continue;
    }
    if (action.origin !== SITE_ORIGIN || action.pathname !== "/login") continue;

    const inputs = parseFormInputs(match[0]);
    const username = inputs.find((input) => input.name === "_username" && input.type === "text");
    const password = inputs.find((input) => input.name === "_password" && input.type === "password");
    const remember = inputs.find((input) => input.name === "_remember_me" && input.type === "checkbox");
    const csrf = inputs.find((input) => input.name === "_csrf_token" && input.type === "hidden");

    if (!username || !password || !csrf || !csrf.value) continue;

    return {
      action: action.pathname,
      method: "POST",
      usernameField: username.name,
      passwordField: password.name,
      rememberMeField: remember?.name ?? null,
      csrfField: csrf.name,
      csrfToken: csrf.value,
    };
  }

  throw new Error("AnimeGO login form was not found in the page response.");
}
