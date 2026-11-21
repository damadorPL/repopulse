import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppVersionLink, appReleaseUrl } from "./app-version-link";

describe("appReleaseUrl", () => {
  it("links to the version tag when APP_VERSION is provided", () => {
    expect(appReleaseUrl("0.9.7.1")).toBe("https://github.com/damadorPL/repopulse/releases/tag/v0.9.7.1");
  });

  it("falls back to the releases index when version is empty", () => {
    expect(appReleaseUrl("")).toBe("https://github.com/damadorPL/repopulse/releases");
    expect(appReleaseUrl(undefined)).toBe("https://github.com/damadorPL/repopulse/releases");
  });
});

describe("AppVersionLink", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders a link to the GitHub release for APP_VERSION", () => {
    vi.stubEnv("APP_VERSION", "0.9.7.1");
    const html = renderToStaticMarkup(<AppVersionLink className="text-xs" title="RepoPulse version" />);
    expect(html).toContain('href="https://github.com/damadorPL/repopulse/releases/tag/v0.9.7.1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("RepoPulse v0.9.7.1");
  });
});
