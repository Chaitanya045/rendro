import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { readExactBody } from "./bounded-body";

function conflict(message: string): HTTPException {
  return new HTTPException(409, { message, res: Response.json({ error: message }, { status: 409 }) });
}

/** Storage writes must start within the authorized lease and finish promptly.
 * Retention additionally drains expired staging leases for 24 hours. */
export function deploymentWriteSignal(expiresAt: number): AbortSignal {
  const remaining = expiresAt - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw conflict("Staging lease expired. Run rendro push again to start a new deployment.");
  return AbortSignal.timeout(Math.min(remaining, 5 * 60 * 1000));
}

/** Renew only while receiving a body, at most once per ten minutes, for at most
 * two hours. A failed renewal cancels the reader and preserves the HTTP denial.
 * A fresh authorization is still required immediately before storage dispatch. */
export async function readDeploymentBody(
  body: ReadableStream<Uint8Array> | null,
  size: number,
  renew: () => Promise<unknown>,
): Promise<Uint8Array | null> {
  const controller = new AbortController();
  let finished = false;
  let timer: ReturnType<typeof setTimeout>;
  const renewLease = async () => {
    try {
      const result = await renew();
      if (result instanceof Response) throw new HTTPException(result.status as ContentfulStatusCode, { res: result });
    } catch (error) {
      controller.abort(error);
    } finally {
      if (!finished && !controller.signal.aborted) timer = setTimeout(() => { void renewLease(); }, 10 * 60 * 1000);
    }
  };
  timer = setTimeout(() => { void renewLease(); }, 10 * 60 * 1000);
  const deadline = setTimeout(() => controller.abort(conflict("Upload exceeded the two-hour transfer limit. Run rendro push again to start a new deployment.")), 2 * 60 * 60 * 1000);
  try {
    return await readExactBody(body, size, controller.signal);
  } finally {
    finished = true;
    clearTimeout(timer);
    clearTimeout(deadline);
  }
}
