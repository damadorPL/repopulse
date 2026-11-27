import { describe, expect, it } from "vitest";
import { enableGitHubAppWebhooksInput } from "./github-app-schema";

describe("enableGitHubAppWebhooksInput", () => {
  it("defaults rotateSecret to false and rejects unknown fields", () => {
    expect(enableGitHubAppWebhooksInput.parse({})).toEqual({ rotateSecret: false });
    expect(enableGitHubAppWebhooksInput.safeParse({ secret: "x" }).success).toBe(false);
  });
});
