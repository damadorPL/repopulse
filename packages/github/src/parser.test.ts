import { describe, expect, it } from "vitest";
import { classifySemver, InvalidRepositoryInputError, parseRepoInput } from "./parser.js";

describe("parseRepoInput", () => {
  const react = { owner: "facebook", name: "react" };

  it.each([
    "facebook/react",
    "  facebook/react  ",
    "facebook/react/",
    "facebook/react.git",
    "https://github.com/facebook/react",
    "https://github.com/facebook/react/",
    "https://github.com/facebook/react.git",
    "http://www.github.com/facebook/react",
    "github.com/facebook/react.git",
    "github.com/facebook/react///",
    "https://github.com/facebook/react/releases/tag/v19.0.0",
    "https://github.com/facebook/react?tab=readme#top",
    "git@github.com:facebook/react.git",
  ])("parses %j", (input) => {
    expect(parseRepoInput(input)).toEqual(react);
  });

  it("keeps dots, dashes and underscores in names", () => {
    expect(parseRepoInput("vercel/next.js")).toEqual({ owner: "vercel", name: "next.js" });
    expect(parseRepoInput("coollabsio/coolify")).toEqual({ owner: "coollabsio", name: "coolify" });
    expect(parseRepoInput("my_org/my-repo_v2")).toEqual({ owner: "my_org", name: "my-repo_v2" });
  });

  it.each([
    "",
    "   ",
    "react",
    "facebook/react/extra",
    "facebook/re act",
    "https://gitlab.com/facebook/react",
    "https://github.com/facebook",
    "https://github.com/",
    "../react",
    "facebook/..",
  ])("rejects %j", (input) => {
    expect(() => parseRepoInput(input)).toThrow(InvalidRepositoryInputError);
  });
});

describe("classifySemver", () => {
  it.each([
    ["v2.0.0", false, "MAJOR"],
    ["v2.1.0", false, "MINOR"],
    ["v2.1.3", false, "PATCH"],
    ["v2.0.0-rc.1", false, "PRERELEASE"],
    ["2.0.0", false, "MAJOR"],
    ["v4.0.0-beta.380", false, "PRERELEASE"],
    ["release-1.4.0", false, "MINOR"],
    ["coolify@4.2.7", false, "PATCH"],
    ["v3", false, "MAJOR"],
    ["v3.1", false, "MINOR"],
    ["nightly", false, "OTHER"],
    ["0.0.0", false, "OTHER"],
  ] as const)("%s (prerelease flag %s) -> %s", (tag, flag, expected) => {
    expect(classifySemver(tag, flag)).toBe(expected);
  });

  it("honors the GitHub prerelease flag over the tag", () => {
    expect(classifySemver("v2.0.0", true)).toBe("PRERELEASE");
    expect(classifySemver("nightly", true)).toBe("PRERELEASE");
  });
});
