import { describe, expect, it } from "vitest";
import { sanitizeUserCss } from "./userCss";

describe("sanitizeUserCss", () => {
  it("strips @import rules entirely", () => {
    expect(sanitizeUserCss('@import url("https://evil.com/x.css"); body{}')).toBe(" body{}");
  });

  it("keeps data/asset/blob/relative urls", () => {
    const css = [
      "a{background:url(data:image/png;base64,AAA)}",
      "b{background:url(asset://localhost/x.png)}",
      "c{background:url(http://asset.localhost/y.png)}",
      "d{background:url(blob:https://x/y)}",
      "e{background:url(img/local.png)}",
      "f{background:url(#grad)}",
    ].join("");
    expect(sanitizeUserCss(css)).toBe(css);
  });

  it("replaces external http(s) urls with none (exfil/pixel tracking)", () => {
    const out = sanitizeUserCss(
      'a{background:url("https://evil.com/pixel.png")} b{background:url(http://127.0.0.1:9/x)}',
    );
    expect(out).not.toContain("evil.com");
    expect(out).not.toContain("127.0.0.1");
    expect(out).toContain("none");
  });

  it("blocks protocol-relative urls that start with a slash", () => {
    const out = sanitizeUserCss('a{background:url(//evil.com/x.png)}');
    expect(out).not.toContain("evil.com");
    expect(out).toContain("none");
  });

  it("leaves non-url css untouched", () => {
    const css = ".card{position:fixed;inset:0;animation:x 1s infinite linear;filter:blur(4px)}";
    expect(sanitizeUserCss(css)).toBe(css);
  });
});
