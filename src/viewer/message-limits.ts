/** Limits live in the trusted parent and survive iframe reloads. */
export function createMessageRateLimit(interval: number, now = () => performance.now()): () => boolean {
  let last = -Infinity;
  return () => {
    const time = now();
    if (time - last < interval) return false;
    last = time;
    return true;
  };
}

/** One leading update and one trailing latest value per interval, with bounded memory. */
export function coalesceMessage<T>(apply: (value: T) => void, host: Window = window, interval = 100): ((value: T) => void) & { cancel: () => void } {
  let last = -Infinity;
  let timer: number | undefined;
  let latest: T;
  const update = (value: T) => {
    latest = value;
    if (timer !== undefined) return;
    const delay = interval - (host.performance.now() - last);
    const flush = () => {
      timer = undefined;
      last = host.performance.now();
      apply(latest);
    };
    if (delay <= 0) flush();
    else timer = host.setTimeout(flush, delay);
  };
  update.cancel = () => {
    if (timer !== undefined) host.clearTimeout(timer);
    timer = undefined;
  };
  return update;
}

/** Activation is browser-owned; publisher-provided gesture claims are never used. */
export function createDocumentNavigationGate(host: Window = window): (target: string, current: string) => "push" | "replace" | null {
  let last = -Infinity;
  return (target, current) => {
    const time = host.performance.now();
    if (host.navigator.userActivation?.isActive === false || target === current
      || time - last < 1000) return null;
    // Drop bursts rather than queueing reloads. Without activation support,
    // never let script navigation accumulate parent history entries.
    const action = host.navigator.userActivation ? "push" : "replace";
    last = time;
    return action;
  };
}
