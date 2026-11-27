import { parseRealtimeEvent, serializeRealtimeEvent } from "@repopulse/queue/events";

import { getCurrentUserOrThrow, UnauthorizedError } from "@/lib/auth";
import { isRealtimeConfigured, subscribeUserEvents } from "@/server/realtime";

/** Comment lines keep proxies (Traefik in Coolify) from closing an idle stream. */
const HEARTBEAT_MS = 25_000;
/** Reconnect delay suggested to EventSource after a dropped connection. */
const RETRY_MS = 5_000;

function noopCleanup(): void {}

/**
 * GET /api/events/stream: Server-Sent Events for the signed-in user. Relays the worker's
 * Redis Pub/Sub channel `user:{userId}:events` as `data:` frames (one JSON `RealtimeEvent` each).
 */
export async function GET(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = (await getCurrentUserOrThrow()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return new Response("Unauthorized", { status: 401 });
    throw error;
  }
  // EventSource retries non-200 responses only on network errors; a 503 stops it for good.
  if (!isRealtimeConfigured()) return new Response("Live updates are not configured", { status: 503 });

  const encoder = new TextEncoder();
  let cleanup: () => void = noopCleanup;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => Promise<void>) | undefined;

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        request.signal.removeEventListener("abort", cleanup);
        const unsub = unsubscribe;
        unsubscribe = undefined;
        if (unsub) void unsub();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      // The client navigated away, closed the tab or lost the connection.
      request.signal.addEventListener("abort", cleanup, { once: true });

      send(`retry: ${RETRY_MS}\n: connected\n\n`);
      void subscribeUserEvents(userId, (message) => {
        const event = parseRealtimeEvent(message);
        if (event) send(`data: ${serializeRealtimeEvent(event)}\n\n`);
      }).then(
        (unsub) => {
          if (closed) {
            void unsub();
          } else {
            unsubscribe = unsub;
          }
        },
        (err: unknown) => {
          console.error("[sse] could not subscribe", err);
          // Ending the stream makes EventSource reconnect after `retry`.
          cleanup();
        },
      );
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable response buffering in nginx-style proxies.
      "X-Accel-Buffering": "no",
    },
  });
}
