import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectPullRequestButton } from "./project-pull-request-button";
import type { PlannedPullRequest } from "@/server/queries/dependencies";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/server/actions/dependencies", () => ({
  createDependencyPullRequestAction: vi.fn(),
  createProjectDependencyPullRequestsAction: vi.fn(),
}));

function makePlan(overrides: Partial<PlannedPullRequest> = {}): PlannedPullRequest {
  return {
    groupKey: "all",
    isMajor: false,
    updates: [{ name: "react", manifestPath: "package.json", from: "18.0.0", to: "18.3.0", level: "MINOR" }],
    lockfiles: ["pnpm-lock.yaml"],
    pullRequest: null,
    disabledReason: null,
    ...overrides,
  };
}

describe("ProjectPullRequestButton", () => {
  it("renders nothing for NOTIFY mode or when there are no plans", () => {
    expect(
      renderToStaticMarkup(
        <ProjectPullRequestButton projectId="p1" fullName="acme/web" updateMode="NOTIFY" plans={[makePlan()]} />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <ProjectPullRequestButton projectId="p1" fullName="acme/web" updateMode="MANUAL_PR" plans={[]} />,
      ),
    ).toBe("");
  });

  it("renders Create PR or Update PR for a single planned group", () => {
    const createHtml = renderToStaticMarkup(
      <ProjectPullRequestButton projectId="p1" fullName="acme/web" updateMode="MANUAL_PR" plans={[makePlan()]} />,
    );
    expect(createHtml).toContain("Create PR");
    expect(createHtml).toContain('aria-label="Create pull request for acme/web"');
    expect(createHtml).not.toContain('disabled=""');

    const updateHtml = renderToStaticMarkup(
      <ProjectPullRequestButton
        projectId="p1"
        fullName="acme/web"
        updateMode="AUTO_PR"
        plans={[makePlan({ pullRequest: { number: 12, htmlUrl: "https://github.com/acme/web/pull/12", state: "OPEN" } })]}
      />,
    );
    expect(updateHtml).toContain("Update PR");
    expect(updateHtml).toContain('aria-label="Update pull request for acme/web"');
  });

  it("renders a disabled button wrapped with title tooltip when disabledReason is set", () => {
    const reason = "Needs a regenerated lockfile (pnpm-lock.yaml), which is not available yet";
    const html = renderToStaticMarkup(
      <ProjectPullRequestButton
        projectId="p1"
        fullName="acme/web"
        updateMode="MANUAL_PR"
        plans={[makePlan({ disabledReason: reason })]}
      />,
    );
    expect(html).toContain("Create PR");
    expect(html).toContain('disabled=""');
    expect(html).toContain(`title="${reason}"`);
  });

  it("renders Create PRs (N) and Update PRs (N) for multiple planned groups", () => {
    const createMultiHtml = renderToStaticMarkup(
      <ProjectPullRequestButton
        projectId="p1"
        fullName="acme/web"
        updateMode="MANUAL_PR"
        plans={[makePlan({ groupKey: "all" }), makePlan({ groupKey: "major-vite", isMajor: true })]}
      />,
    );
    expect(createMultiHtml).toContain("Create PRs (2)");
    expect(createMultiHtml).toContain('aria-label="Pull requests for acme/web"');

    const updateMultiHtml = renderToStaticMarkup(
      <ProjectPullRequestButton
        projectId="p1"
        fullName="acme/web"
        updateMode="MANUAL_PR"
        plans={[
          makePlan({ groupKey: "all", pullRequest: { number: 12, htmlUrl: "https://github.com/acme/web/pull/12", state: "OPEN" } }),
          makePlan({
            groupKey: "major-vite",
            isMajor: true,
            pullRequest: { number: 13, htmlUrl: "https://github.com/acme/web/pull/13", state: "OPEN" },
          }),
        ]}
      />,
    );
    expect(updateMultiHtml).toContain("Update PRs (2)");

    const allDisabledHtml = renderToStaticMarkup(
      <ProjectPullRequestButton
        projectId="p1"
        fullName="acme/web"
        updateMode="MANUAL_PR"
        plans={[
          makePlan({ groupKey: "all", disabledReason: "Sandbox offline" }),
          makePlan({ groupKey: "major-vite", isMajor: true, disabledReason: "Sandbox offline" }),
        ]}
      />,
    );
    expect(allDisabledHtml).toContain("Create PRs");
    expect(allDisabledHtml).toContain('disabled=""');
    expect(allDisabledHtml).toContain('title="Sandbox offline"');
  });
});
