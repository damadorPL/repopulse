import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { isExpandedCombobox, rootLabel } from "@/lib/repo-paths";

import { WatchedPathsPicker } from "./watched-paths-picker";

vi.mock("@/server/actions/repositories", () => ({ listRepositoryPathsAction: vi.fn() }));

const noop = () => {};

describe("WatchedPathsPicker", () => {
  it("renders chips, an accessible combobox and the path counter", () => {
    const html = renderToStaticMarkup(
      <WatchedPathsPicker
        id="paths"
        repo={null}
        paths={["CHANGELOG.md", "packages/cli"]}
        onPathsChange={noop}
        draft=""
        onDraftChange={noop}
      />,
    );
    expect(html).toContain('aria-label="Stop watching CHANGELOG.md"');
    expect(html).toContain('aria-label="Stop watching packages/cli"');
    expect(html).toMatch(/<input[^>]*role="combobox"[^>]*id="paths"|<input[^>]*id="paths"[^>]*role="combobox"/);
    expect(html).toContain("2/10");
    expect(html).toContain("Enter the repository to browse its files.");
  });

  it("shows the loading state for a repository and a parent error", () => {
    const html = renderToStaticMarkup(
      <WatchedPathsPicker
        id="paths"
        repo="acme/widget"
        paths={[]}
        onPathsChange={noop}
        draft=""
        onDraftChange={noop}
        error="Enter at least one file or folder path."
      />,
    );
    expect(html).toContain("Loading files…");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Enter at least one file or folder path.");
  });
});

describe("isExpandedCombobox", () => {
  const element = (attributes: Record<string, string>) =>
    ({ getAttribute: (name: string) => attributes[name] ?? null }) as unknown as EventTarget;

  it("matches only an expanded combobox", () => {
    expect(isExpandedCombobox(element({ role: "combobox", "aria-expanded": "true" }))).toBe(true);
    expect(isExpandedCombobox(element({ role: "combobox", "aria-expanded": "false" }))).toBe(false);
    expect(isExpandedCombobox(element({ role: "button", "aria-expanded": "true" }))).toBe(false);
    expect(isExpandedCombobox(null)).toBe(false);
  });
});

describe("rootLabel", () => {
  it("extracts the repository name from slugs and GitHub URLs", () => {
    expect(rootLabel(null)).toBe("root");
    expect(rootLabel("acme/widget")).toBe("widget");
    expect(rootLabel("https://github.com/acme/widget")).toBe("widget");
    expect(rootLabel("https://www.github.com/acme/widget/releases")).toBe("widget");
    expect(rootLabel("github.com/acme/widget")).toBe("widget");
    expect(rootLabel("git@github.com:acme/widget")).toBe("widget");
  });
});
