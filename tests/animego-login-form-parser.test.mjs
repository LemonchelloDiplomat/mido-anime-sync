import { describe, expect, it } from "vitest";
import { parseAnimeGoLoginForm } from "../server/animego-login-form-parser.mjs";

const LOGIN_HTML = `
  <form action="/logout" method="post">
    <input type="hidden" name="_csrf_token" value="logout-token">
  </form>
  <form action="/login" method="post">
    <input type="text" name="_username" autocomplete="username">
    <input type="password" name="_password" autocomplete="current-password">
    <input type="checkbox" name="_remember_me" value="1">
    <input type="hidden" name="_csrf_token" value="login-token&amp;part">
  </form>
  <form action="/search/all" method="get">
    <input type="text" name="q">
  </form>
`;

describe("AnimeGO login form parser", () => {
  it("selects the login form rather than logout/search forms", () => {
    expect(parseAnimeGoLoginForm(LOGIN_HTML)).toEqual({
      action: "/login",
      method: "POST",
      usernameField: "_username",
      passwordField: "_password",
      rememberMeField: "_remember_me",
      csrfField: "_csrf_token",
      csrfToken: "login-token&part",
    });
  });

  it("accepts a same-origin absolute login action", () => {
    const html = LOGIN_HTML.replace('action="/login"', 'action="https://animego.me/login"');
    expect(parseAnimeGoLoginForm(html).action).toBe("/login");
  });

  it("does not accept an off-origin login form", () => {
    const html = LOGIN_HTML.replace('action="/login"', 'action="https://evil.example/login"');
    expect(() => parseAnimeGoLoginForm(html)).toThrow("AnimeGO login form was not found");
  });

  it("requires the observed username, password and CSRF fields", () => {
    const html = LOGIN_HTML.replace(
      '<input type="hidden" name="_csrf_token" value="login-token&amp;part">',
      "",
    );
    expect(() => parseAnimeGoLoginForm(html)).toThrow("AnimeGO login form was not found");
  });

  it("rejects an untrusted base URL", () => {
    expect(() => parseAnimeGoLoginForm(LOGIN_HTML, {
      baseUrl: "https://example.com/login",
    })).toThrow("only accepts animego.me");
  });

  it("rejects oversized HTML", () => {
    expect(() => parseAnimeGoLoginForm("x".repeat(1024 * 1024 + 1)))
      .toThrow("exceeds the 1 MB parser limit");
  });
});
