export type Provenance = {
  source: { kind: "local" | "git"; repository?: string; commit?: string; ref?: string; dirty?: boolean; localPathLabel?: string };
  execution: { kind: "local" | "ci"; provider?: string; runId?: string; workflow?: string; job?: string; actor?: string };
  cliVersion: string;
  manifestSha256: string;
};

/** Keep only known network remote formats; never fall back to a raw malformed URL. */
export function sanitizeGitRemote(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const remote = value.trim().split(/[?#]/, 1)[0];
  // eslint-disable-next-line no-control-regex -- Reject control bytes in remote addresses.
  if (/[\s\\\u0000-\u001f\u007f]/.test(remote)) return undefined;
  let safe: string;
  if (remote.includes("://")) {
    try {
      const url = new URL(remote);
      if (!["http:", "https:", "ssh:", "git:", "git+ssh:", "git+https:"].includes(url.protocol) || !url.hostname) return undefined;
      url.username = "";
      url.password = "";
      safe = url.href;
    } catch { return undefined; }
  } else {
    // scp-style [user@]host:path; strip the entire userinfo, not just a password.
    const match = /^(?:[^/@]+@)?(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):([^:@][^@]*)$/.exec(remote);
    if (!match) return undefined;
    safe = `${match[1]}:${match[2]}`;
  }
  return safe.length <= 2048 ? safe : undefined;
}

function text(value: string, limit: number): string {
  // Other labels may contain URLs too. Sanitize before capping so truncation
  // cannot preserve a fragment of userinfo from a long URL.
  return value.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+/g, url => sanitizeGitRemote(url) ?? "[redacted]")
    // eslint-disable-next-line no-control-regex -- Remove control bytes from display labels.
    .replace(/[\u0000-\u001f\u007f]/g, "").slice(0, limit);
}
function optional(value: string | undefined, limit = 256): string | undefined {
  return value === undefined ? undefined : text(value, limit);
}

/** Convex validators establish the input shape; this bounds and sanitizes every string. */
export function sanitizeProvenance(value: Provenance): Provenance {
  return {
    source: {
      kind: value.source.kind,
      repository: sanitizeGitRemote(value.source.repository),
      commit: optional(value.source.commit, 128),
      ref: optional(value.source.ref),
      dirty: value.source.dirty,
      localPathLabel: optional(value.source.localPathLabel, 512),
    },
    execution: {
      kind: value.execution.kind,
      provider: optional(value.execution.provider),
      runId: optional(value.execution.runId),
      workflow: optional(value.execution.workflow),
      job: optional(value.execution.job),
      actor: optional(value.execution.actor),
    },
    cliVersion: text(value.cliVersion, 64),
    manifestSha256: text(value.manifestSha256, 128),
  };
}
