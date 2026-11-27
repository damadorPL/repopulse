import { describe, expect, it, vi } from "vitest";
import { createUserReleaseStatesInBatches, USER_RELEASE_STATE_BATCH_SIZE } from "./batch-db.js";

describe("createUserReleaseStatesInBatches", () => {
  it("skips createMany when there are no rows", async () => {
    const createMany = vi.fn(async () => ({ count: 0 }));
    await createUserReleaseStatesInBatches({ userReleaseState: { createMany } } as never, []);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("chunks rows into batches of USER_RELEASE_STATE_BATCH_SIZE (2,000)", async () => {
    const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
    const rows = Array.from({ length: USER_RELEASE_STATE_BATCH_SIZE * 2 + 500 }, (_, i) => ({
      userId: `u-${i}`,
      releaseId: "r-1",
      isRead: false,
    }));

    await createUserReleaseStatesInBatches({ userReleaseState: { createMany } } as never, rows);

    expect(createMany).toHaveBeenCalledTimes(3);
    expect(createMany.mock.calls[0]![0]).toMatchObject({ skipDuplicates: true });
    expect(createMany.mock.calls[0]![0].data).toHaveLength(USER_RELEASE_STATE_BATCH_SIZE);
    expect(createMany.mock.calls[1]![0].data).toHaveLength(USER_RELEASE_STATE_BATCH_SIZE);
    expect(createMany.mock.calls[2]![0].data).toHaveLength(500);
  });
});
