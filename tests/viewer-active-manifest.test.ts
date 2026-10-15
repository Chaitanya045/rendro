import { commitWithProof } from "./helpers/storage-proof";
import { describe, expect, it } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import { publicErrorMessages } from "../src/shared/public-errors";
import { fixture } from "./helpers/comment-fixture";

async function deployedFixture() {
  const f = await fixture();
  const args = { organizationId: f.data.organizationId, projectId: f.data.projectId };
  const publish = async () => {
    const deployment = await f.backend.mutation(internal.deployments.startInternal, {
      ...args, actorId: f.data.users[0].userId, manifestSha256: "hash", fileCount: 1, byteCount: 1,
      provenance: { source: { kind: "local" }, execution: { kind: "local" }, cliVersion: "test", manifestSha256: "hash" },
    });
    await commitWithProof(f.backend, {
      ...args, deploymentId: deployment.deploymentId, actorId: f.data.users[0].userId,
    });
    return deployment.deploymentId;
  };
  return { ...f, args, publish };
}

describe("authorized viewer active deployment", () => {
  it("returns only the opaque deployment ID for a member and follows activation", async () => {
    const { viewers, args, publish } = await deployedFixture();
    expect(await viewers.member.query(api.projects.activeDeployment, args)).toBeNull();
    const first = await publish();
    expect(await viewers.member.query(api.projects.activeDeployment, args)).toBe(first);
    expect(first).not.toContain("/");
    const second = await publish();
    expect(second).not.toBe(first);
    expect(await viewers.member.query(api.projects.activeDeployment, args)).toBe(second);
  });

  it("denies non-members, removed members and cross-org projects identically before and after activation", async () => {
    const { backend, data, viewers, args, publish } = await deployedFixture();
    await backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: "member", where: [{ field: "_id", value: data.users.find(u => u.name === "member")!.memberId }] },
    }));
    const otherProject = await backend.run(ctx => ctx.db.insert("projects", {
      organizationId: data.otherOrgId, name: "Other", slug: "other", createdBy: data.users[0].userId, createdAt: Date.now(),
    }));
    for (const activated of [false, true]) {
      if (activated) await publish();
      const errors = await Promise.all([
        backend.query(api.projects.activeDeployment, args),
        viewers.outsider.query(api.projects.activeDeployment, args),
        viewers.member.query(api.projects.activeDeployment, args),
        viewers.author.query(api.projects.activeDeployment, { ...args, projectId: otherProject }),
      ].map(promise => promise.then(() => { throw new Error("Unexpected access"); }, (error: unknown) => error)));
      for (const error of errors) expect(error).toMatchObject({ data: { code: "not_found", message: publicErrorMessages.not_found } });
      expect(errors.map(error => (error as Error).message)).toEqual(Array(4).fill((errors[0] as Error).message));
    }
  });

  it("requires a live session before looking up the project", async () => {
    const { backend, data, viewers, args, publish } = await deployedFixture();
    await publish();
    await expect(backend.query(api.projects.activeDeployment, args)).rejects.toMatchObject({ data: { code: "not_found", message: publicErrorMessages.not_found } });
    await backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: "session", where: [{ field: "_id", value: data.users.find(u => u.name === "member")!.sessionId }] },
    }));
    await expect(viewers.member.query(api.projects.activeDeployment, args)).rejects.toMatchObject({ data: { code: "not_found", message: publicErrorMessages.not_found } });
  });
});
