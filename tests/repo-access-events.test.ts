import { describe, expect, it } from "vitest";
import { planEvent } from "../src/repo-access/events";

/** Webhook payloads → access plans (#243): restrictive changes apply directly, permissive ones are confirmed with GitHub. */

const installation = { id: 71, account: { login: "octo" } };
const repository = { id: 802, name: "closed-docs", full_name: "octo/closed-docs", private: true, owner: { login: "octo" } };
const user = { id: 5001, login: "reader" };
const hint = { id: 802, owner: "octo", name: "closed-docs", private: true };

describe("planEvent", () => {
  it("ignores events and actions that change no access", () => {
    expect(planEvent("push", { installation })).toBe("ignored");
    expect(planEvent(null, {})).toBe("ignored");
    expect(planEvent("member", null)).toBe("ignored");
    expect(planEvent("member", "text")).toBe("ignored");
    for (const [event, action] of [["member", "invited"], ["membership", "edited"], ["organization", "member_invited"], ["team", "renamed"],
      ["installation", "unknown"], ["installation_repositories", "changed"], ["github_app_authorization", "granted"]]) {
      expect(planEvent(event, { action, installation }), `${event}.${action}`).toBe("ignored");
    }
    expect(planEvent("member", { installation })).toBe("ignored");
  });

  it("refreshes or revokes the people a membership event names", () => {
    expect(planEvent("member", { action: "added", member: user, repository })).toEqual({ users: [5001], revoke: false });
    expect(planEvent("member", { action: "edited", member: user })).toEqual({ users: [5001], revoke: true });
    expect(planEvent("member", { action: "removed", member: user })).toEqual({ users: [5001], revoke: true });
    expect(planEvent("membership", { action: "added", member: user })).toEqual({ users: [5001], revoke: false });
    expect(planEvent("membership", { action: "removed", member: user })).toEqual({ users: [5001], revoke: true });
    expect(planEvent("organization", { action: "member_added", membership: { user } })).toEqual({ users: [5001], revoke: false });
    expect(planEvent("organization", { action: "member_removed", membership: { user } })).toEqual({ users: [5001], revoke: true });
    expect(planEvent("github_app_authorization", { action: "revoked", sender: user })).toEqual({ unauthorize: 5001, revoke: true });
    for (const [event, payload] of [["member", { action: "removed", member: { id: "5001" } }], ["membership", { action: "removed" }],
      ["organization", { action: "member_removed", membership: {} }], ["github_app_authorization", { action: "revoked", sender: { id: -1 } }]] as const) {
      expect(planEvent(event, payload), event).toBe("malformed");
    }
  });

  it("reaches holders or the whole installation for team changes", () => {
    expect(planEvent("team", { action: "removed_from_repository", repository, installation })).toEqual({ holders: [802], revoke: true });
    expect(planEvent("team", { action: "edited", repository, installation })).toEqual({ holders: [802], revoke: true });
    expect(planEvent("team", { action: "edited", installation })).toEqual({ installationUsers: 71, revoke: true });
    expect(planEvent("team", { action: "deleted", installation })).toEqual({ installationUsers: 71, revoke: true });
    expect(planEvent("team", { action: "added_to_repository", repository, installation })).toEqual({ installationUsers: 71, revoke: false });
    expect(planEvent("team", { action: "created", installation })).toEqual({ installationUsers: 71, revoke: false });
    expect(planEvent("team", { action: "deleted" })).toBe("malformed");
    expect(planEvent("team", { action: "edited", repository: { id: 1 }, installation })).toBe("malformed");
  });

  it("applies repository changes: removals and privatization directly, everything else after a check", () => {
    expect(planEvent("repository", { action: "deleted", repository, installation })).toEqual({ repos: { change: "remove", hints: [hint], installation: 71 }, holders: [802], revoke: true });
    expect(planEvent("repository", { action: "privatized", repository, installation })).toEqual({ repos: { change: "privatize", hints: [hint], installation: 71 }, revoke: false });
    expect(planEvent("repository", { action: "transferred", repository, installation })).toEqual({ repos: { change: "confirm", hints: [hint], installation: 71 }, holders: [802], revoke: true });
    expect(planEvent("repository", { action: "publicized", repository: { ...repository, private: false } })).toEqual({ repos: { change: "confirm", hints: [{ ...hint, private: false }], installation: null }, revoke: false });
    expect(planEvent("repository", { action: "renamed", repository: { id: 802, name: "docs", owner: { login: "octo" } }, installation })).toMatchObject({ repos: { hints: [{ id: 802, owner: "octo", name: "docs", private: null }] } });
    for (const bad of [undefined, { id: 0, name: "x", owner: { login: "octo" } }, { id: 1, name: "../x", owner: { login: "octo" } }, { id: 1, name: "x", owner: {} },
      { id: 1, full_name: "octo/a/b" }, { id: 1, name: "b", full_name: "octo/a" }]) {
      expect(planEvent("repository", { action: "edited", repository: bad }), JSON.stringify(bad)).toBe("malformed");
    }
  });

  it("follows installations and their repository selection", () => {
    const listed = [{ id: 802, name: "closed-docs", full_name: "octo/closed-docs", private: true }];
    expect(planEvent("installation", { action: "deleted", installation })).toEqual({ installation: { id: 71, account: "octo", state: "deleted" }, installationUsers: 71, revoke: true });
    expect(planEvent("installation", { action: "suspend", installation: { id: 71 } })).toEqual({ installation: { id: 71, account: null, state: "suspended" }, installationUsers: 71, revoke: true });
    expect(planEvent("installation", { action: "created", installation, repositories: listed })).toEqual({
      installation: { id: 71, account: "octo", state: "active" }, installationUsers: 71, revoke: false, repos: { change: "confirm", hints: [hint], installation: 71 },
    });
    expect(planEvent("installation", { action: "unsuspend", installation })).toEqual({ installation: { id: 71, account: "octo", state: "active" }, installationUsers: 71, revoke: false });
    expect(planEvent("installation", { action: "new_permissions_accepted", installation, repositories: [] })).toEqual({ installation: { id: 71, account: "octo", state: "active" }, installationUsers: 71, revoke: false });
    expect(planEvent("installation", { action: "created", installation, repositories: "all" })).toBe("malformed");
    expect(planEvent("installation", { action: "created", installation, repositories: [{ id: 1 }] })).toBe("malformed");
    expect(planEvent("installation", { action: "deleted" })).toBe("malformed");

    expect(planEvent("installation_repositories", { action: "added", installation, repositories_added: listed })).toEqual({ repos: { change: "confirm", hints: [hint], installation: 71 }, installationUsers: 71, revoke: false });
    expect(planEvent("installation_repositories", { action: "removed", installation, repositories_removed: listed })).toEqual({ repos: { change: "remove", hints: [hint], installation: 71 }, holders: [802], revoke: true });
    expect(planEvent("installation_repositories", { action: "removed", installation })).toBe("malformed");
    expect(planEvent("installation_repositories", { action: "added", repositories_added: listed })).toBe("malformed");
  });

  it("renames owners and closes deleted organizations", () => {
    expect(planEvent("organization", { action: "renamed", organization: { login: "octo-labs" }, changes: { login: { from: "octo" } } })).toEqual({ renameOwner: { from: "octo", to: "octo-labs" }, revoke: false });
    expect(planEvent("organization", { action: "renamed", organization: { login: "octo-labs" } })).toBe("malformed");
    expect(planEvent("organization", { action: "deleted", installation })).toEqual({ installation: { id: 71, account: null, state: "deleted" }, installationUsers: 71, revoke: true });
    expect(planEvent("organization", { action: "deleted" })).toBe("malformed");
  });
});
