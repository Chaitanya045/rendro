import { describe, expect, it } from "vitest";
import { sanitizeGitRemote, sanitizeProvenance, type Provenance } from "../shared/provenance";

describe("credential-free deployment provenance", () => {
  it.each([
    ["https://user:synthetic-token@git.example/repo.git?token=synthetic-query#synthetic-fragment", "https://git.example/repo.git"],
    ["https://synthetic-token@git.example/repo.git", "https://git.example/repo.git"],
    ["ssh://git:synthetic-token@git.example:2222/repo.git", "ssh://git.example:2222/repo.git"],
    ["git+https://user:token@git.example/repo.git", "git+https://git.example/repo.git"],
    [" git@git.example:team/repo.git?token=synthetic-query#fragment ", "git.example:team/repo.git"],
    ["user:synthetic-token@git.example:team/repo.git", "git.example:team/repo.git"],
    ["git@[::1]:team/repo.git", "[::1]:team/repo.git"],
    ["git.example:team/repo.git", "git.example:team/repo.git"],
    ["https://git.example/repo.git", "https://git.example/repo.git"],
    [undefined, undefined], ["", undefined], ["/local/repo", undefined],
    ["https://user:token@", undefined], ["ssh:///private", undefined],
    ["file://user:token@host/private", undefined], ["https://user:token@host/repo\nextra", undefined],
    ["https://user:token@host\\repo", undefined],
    ["https://host/" + "x".repeat(2048), undefined],
    ["remote-helper::secret", undefined],
  ])("sanitizes remote %j", (input, expected) => expect(sanitizeGitRemote(input)).toBe(expected));

  it("bounds every string, removes URL credentials in labels, and preserves useful metadata", () => {
    const long = "x".repeat(3000);
    const input: Provenance = {
      source: { kind: "git", repository: "https://user:token@host/repo?secret=value#fragment", commit: long, ref: long, dirty: true, localPathLabel: long },
      execution: { kind: "ci", provider: long, runId: long, workflow: long, job: long, actor: long },
      cliVersion: long, manifestSha256: long,
    };
    const result = sanitizeProvenance(input);
    expect(result).toEqual({
      source: { kind: "git", repository: "https://host/repo", commit: "x".repeat(128), ref: "x".repeat(256), dirty: true, localPathLabel: "x".repeat(512) },
      execution: { kind: "ci", provider: "x".repeat(256), runId: "x".repeat(256), workflow: "x".repeat(256), job: "x".repeat(256), actor: "x".repeat(256) },
      cliVersion: "x".repeat(64), manifestSha256: "x".repeat(128),
    });
    expect(sanitizeProvenance(result)).toEqual(result);
    expect(sanitizeProvenance({ source: { kind: "local" }, execution: { kind: "local", actor: "from https://user:secret@host/repo?secret=q and file://user:secret@host/private\u0000" }, cliVersion: "v1", manifestSha256: "sha" })).toEqual({
      source: { kind: "local" }, execution: { kind: "local", actor: "from https://host/repo and [redacted]" }, cliVersion: "v1", manifestSha256: "sha",
    });
  });
});
