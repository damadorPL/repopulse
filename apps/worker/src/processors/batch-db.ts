import type { Prisma } from "@repopulse/db";

export const USER_RELEASE_STATE_BATCH_SIZE = 2_000;

type UserReleaseStateClient = Pick<Prisma.TransactionClient, "userReleaseState">;

export interface UserReleaseStateRow {
  userId: string;
  releaseId: string;
  isRead: boolean;
}

/**
 * Inserts `UserReleaseState` rows in bounded chunks so large subscriber fan-outs stay well below
 * PostgreSQL's bind-parameter limit and avoid oversized single-statement transactions.
 */
export async function createUserReleaseStatesInBatches(
  tx: UserReleaseStateClient,
  rows: readonly UserReleaseStateRow[],
  batchSize = USER_RELEASE_STATE_BATCH_SIZE,
): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += batchSize) {
    await tx.userReleaseState.createMany({
      data: rows.slice(i, i + batchSize),
      skipDuplicates: true,
    });
  }
}
