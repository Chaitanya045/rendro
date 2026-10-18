import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * E2E-only stand-in for the Worker's STORAGE binding: it forwards every call to the real (local) R2 bucket, after asking
 * the harness whether a spec has scheduled an outage for that key (`startFaults` in e2e/services.ts). An outage fails
 * the call with the error shape a real R2 outage has: "<operation>: <text> (10043)".
 * Results cross a service boundary, so R2 objects are flattened into plain data plus the body stream (a stream
 * can be passed once, which is why storage.ts reads text through the body rather than `text()`).
 */
const PROBE = "http://r2-faults.invalid/";

export default class StorageFaults extends WorkerEntrypoint {
  async #gate(operation, key) {
    const probe = await fetch(`${PROBE}${encodeURI(key)}?op=${operation}`);
    if (probe.status >= 500) throw new Error(`${operation}: Injected storage outage (10043)`);
  }

  static #flatten(object) {
    const { key, size, etag, uploaded, httpMetadata, customMetadata, range } = object;
    return { key, size, etag, uploaded, httpMetadata, customMetadata, range };
  }

  async get(key, options) {
    await this.#gate("get", key);
    const object = await this.env.BUCKET.get(key, options);
    if (!object) return null;
    return { ...StorageFaults.#flatten(object), body: object.body };
  }

  async head(key) {
    await this.#gate("head", key);
    const object = await this.env.BUCKET.head(key);
    return object ? StorageFaults.#flatten(object) : null;
  }

  async put(key, value, options) {
    await this.#gate("put", key);
    // R2 needs a known length; a stream that crossed the service boundary has none.
    const bytes = value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value;
    return StorageFaults.#flatten(await this.env.BUCKET.put(key, bytes, options));
  }

  async list(options = {}) {
    await this.#gate("list", options.prefix ?? "");
    const page = await this.env.BUCKET.list(options);
    return { ...page, objects: page.objects.map(StorageFaults.#flatten) };
  }

  async delete(keys) {
    for (const key of [keys].flat()) await this.#gate("delete", key);
    await this.env.BUCKET.delete(keys);
  }
}
