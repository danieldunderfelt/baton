import { expect, test } from "bun:test";
import { beginGithubLogin, safeNext } from "./auth.ts";

test("OAuth return paths follow browser URL parsing", () => {
  for (const path of [
    "//evil.test",
    "/\\evil.test",
    "/\t/evil.test",
    "/\n/evil.test",
    "https://evil.test",
  ]) {
    expect(safeNext(path)).toBe("/account");
  }
  expect(safeNext("/device?code=TEST#confirm")).toBe("/device?code=TEST#confirm");
});

test("the OAuth redirect accepts the state cookie Astro appends", () => {
  const cookies: string[] = [];
  const response = beginGithubLogin(
    { GITHUB_CLIENT_ID: "test" },
    new Request("https://baton.test/api/auth/github"),
    {
      set(name, value) {
        cookies.push(name + "=" + value);
      },
    },
    "https://baton.test",
    "/account",
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain("https://github.com/login/oauth/authorize?");
  expect(cookies).toHaveLength(1);
  expect(() => response.headers.append("set-cookie", cookies[0]!)).not.toThrow();
});
