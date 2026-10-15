export type Provenance = {
  source: { kind: "local" | "git"; repository?: string; commit?: string; ref?: string; dirty?: boolean; localPathLabel?: string };
  execution: { kind: "local" | "ci"; provider?: string; runId?: string; workflow?: string; job?: string; actor?: string };
  cliVersion: string;
  manifestSha256: string;
};

/** Decode Git's authority before removing userinfo; omit ambiguous encodings. */
function remoteHost(authority: string): string | undefined {
  // Encoded delimiters can move credentials into a different URL component.
  // Reject encoded percent too, so a second decode cannot reveal delimiters.
  if (/%(?:40|3a|2f|5c|25|23|3f)/i.test(authority)) return undefined;
  const decoded = decodeURIComponent(authority);
  const match = /^(?:[^@/?#]+@)?((?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::[0-9]+)?)$/.exec(decoded);
  if (!match) return undefined;
  // Validate IPv6 and port ranges using a special-scheme parser: WHATWG's
  // opaque SSH/Git host parser alone does not enforce these constraints.
  new URL(`https://${match[1]}`);
  return match[1];
}

/** Keep known network remotes; local paths and unparseable forms are omitted. */
export function sanitizeGitRemote(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Check literal controls before trimming or removing query/fragment.
  // eslint-disable-next-line no-control-regex -- Reject control bytes in remote addresses.
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const remote = value.trim();
  try {
    // eslint-disable-next-line no-control-regex -- Reject decoded control bytes too.
    if (/[\s\\\u0000-\u001f\u007f]/.test(decodeURIComponent(remote))) return undefined;
    let safe: string;
    if (remote.includes("://")) {
      const match = /^(https?|ssh|git|git\+ssh|git\+https):\/\/([^/]+)(\/.*)?$/i.exec(remote);
      if (!match) return undefined;
      const host = remoteHost(match[2]);
      if (!host) return undefined;
      // Parse authority before dropping query/fragment: a delimiter inside
      // malformed userinfo must never turn a credential into the hostname.
      const path = (match[3] ?? "").split(/[?#]/, 1)[0];
      safe = new URL(`${match[1]}://${host}${path}`).href;
    } else {
      // scp-style [user@]host:path (including bracketed IPv6). A slash
      // before the host/path separator identifies a local path, not a remote.
      const match = /^((?:[^/@]+@)?(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.%+-]+)):([^:@][^@]*)$/.exec(remote);
      if (!match) return undefined;
      const host = remoteHost(match[1]);
      if (!host) return undefined;
      safe = `${host}:${match[2].split(/[?#]/, 1)[0]}`;
    }
    return safe.length <= 2048 ? safe : undefined;
  } catch { return undefined; }
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
