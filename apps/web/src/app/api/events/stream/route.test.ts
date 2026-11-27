import { beforeEach, describe, expect, it, vi } from "vitest";

class UnauthorizedError extends Error {}

const getCurrentUserOrThrow = vi.fn();
const isRealtimeConfigured = vi.fn();
const subscribeUserEvents = vi.fn();

vi.mock("@/lib/auth", () => ({ UnauthorizedError, getCurrentUserOrThrow }));
vi.mock("@/server/realtime", () => ({ isRealtimeConfigured, subscribeUserEvents }));

const { GET } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUserOrThrow.mockResolvedValue({ id: "u1" });
  isRealtimeConfigured.mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/events/stream", () => {
  it("returns 401 when unauthenticated and 503 when realtime is unconfigured", async () => {
    getCurrentUserOrThrow.mockRejectedValueOnce(new UnauthorizedError());
    const unauth = await GET(new Request("http://localhost/api/events/stream"));
    expect(unauth.status).toBe(401);

    isRealtimeConfigured.mockReturnValueOnce(false);
    const unconfigured = await GET(new Request("http://localhost/api/events/stream"));
    expect(unconfigured.status).toBe(503);
  });

  it("streams validated events over SSE and unsubscribes on abort", async () => {
    const unsubscribe = vi.fn(async () => undefined);
    let capturedListener: ((raw: string) => void) | undefined;
    subscribeUserEvents.mockImplementation(async (_userId: string, listener: (raw: string) => void) => {
      capturedListener = listener;
      return unsubscribe;
    });

    const controller = new AbortController();
    const response = await GET(new Request("http://localhost/api/events/stream", { signal: controller.signal }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const firstChunk = await reader.read();
    expect(decoder.decode(firstChunk.value)).toBe("retry: 5000\n: connected\n\n");

    expect(subscribeUserEvents).toHaveBeenCalledWith("u1", expect.any(Function));
    // Malformed event is ignored; valid event has unknown fields stripped.
    capturedListener!("not-json");
    capturedListener!(JSON.stringify({ type: "SYNC_STARTED", repositoryId: "r1", repositoryName: "a/b", leaked: 123 }));

    const eventChunk = await reader.read();
    expect(decoder.decode(eventChunk.value)).toBe(
      'data: {"type":"SYNC_STARTED","repositoryId":"r1","repositoryName":"a/b"}\n\n',
    );

    controller.abort();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
  });
});
