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

/**
 * One authorization per observed activation, owned by the shell, never the frame.
 * There is no side-effect-free web API to consume browser activation. Polling
 * observes its end without assuming any browser's transient-activation duration.
 * If a rapid second click hides that transition, request parent confirmation.
 */
export function createDocumentNavigationGate(host: Window = window) {
  let consumed = false;
  let parentInput = false;
  let hasNavigation = false;
  let lastNavigation = -Infinity;
  const observe = () => {
    if (host.navigator.userActivation?.isActive === false) {
      consumed = false;
      parentInput = false;
      hasNavigation = false;
    }
  };
  const consume = (): "push" | "replace" => {
    observe();
    // Without the API, only explicit parent UI can navigate; group rapid
    // confirmations conservatively without ever using elapsed time as authority.
    const inBurst = hasNavigation && (host.navigator.userActivation
      ? consumed : host.performance.now() - lastNavigation < 5000);
    consumed = true;
    hasNavigation = true;
    lastNavigation = host.performance.now();
    return inBurst ? "replace" : "push";
  };
  return {
    observe,
    // Reserve parent gestures without recording navigation or changing its burst.
    // Only observing inactivity can distinguish a later document activation.
    reserveParentInput() {
      observe();
      parentInput = true;
    },
    request(target: string, current: string): "push" | "confirm" | null {
      observe();
      if (target === current) return null;
      if (host.navigator.userActivation?.isActive !== true || consumed || parentInput) return "confirm";
      consume();
      return "push";
    },
    // Call only from trusted parent controls, never from message data.
    confirm: consume,
    // Back/Forward must not let the restored frame reuse the browser gesture.
    suspend() {
      consumed = true;
      // Traversal ends the history burst without granting frame authorization.
      // A later parent-confirmed link must preserve the restored entry for Back.
      hasNavigation = false;
    },
  };
}
