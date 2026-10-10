import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, components } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("../convex/**/*.ts");
const betterAuthModules = import.meta.glob("../convex/betterAuth/**/*.ts");

describe("document membership authorization at roster scale", () => {
  it("authorizes a member beyond the full-organization roster's first 100", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const now = Date.now();
    const seeded = await backend.run(async (ctx) => {
      const organization = await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "organization",
          data: { name: "Scale organization", slug: "scale-organization", createdAt: now },
        },
      });
      const members: Array<{ membershipId: string; userId: string; email: string }> = [];
      for (let index = 0; index < 121; index += 1) {
        const email = `member-${index}@example.test`;
        const user = await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: "user",
            data: {
              name: `Member ${index}`,
              email,
              emailVerified: true,
              createdAt: now + index,
              updatedAt: now + index,
            },
          },
        });
        const membership = await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: "member",
            data: {
              organizationId: organization._id,
              userId: user._id,
              role: "member",
              createdAt: now + index,
            },
          },
        });
        members.push({ membershipId: membership._id, userId: user._id, email });
      }

      const firstRosterPage = await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "member",
        where: [{ field: "organizationId", value: organization._id }],
        paginationOpts: { cursor: null, numItems: 100 },
      }) as { page: Array<{ _id: string }>; isDone: boolean };
      if (firstRosterPage.isDone || firstRosterPage.page.length !== 100) {
        throw new Error("Expected the 121-member roster to require a second page");
      }
      const firstPageIds = new Set(firstRosterPage.page.map((member) => member._id));
      const lateMember = members.find((member) => !firstPageIds.has(member.membershipId));
      if (!lateMember) throw new Error("Expected a member beyond the first roster page");

      const session = await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "session",
          data: {
            token: "late-roster-member-session",
            userId: lateMember.userId,
            createdAt: now,
            updatedAt: now,
            expiresAt: now + 60_000,
          },
        },
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId: organization._id,
        name: "Scale docs",
        slug: "scale-docs",
        createdBy: lateMember.userId,
        createdAt: now,
      });
      return {
        organizationId: organization._id,
        projectId,
        sessionId: session._id,
        ...lateMember,
      };
    });

    const member = backend.withIdentity({
      subject: seeded.userId,
      sessionId: seeded.sessionId,
      email: seeded.email,
      name: "Late roster member",
    });
    const threadId = await member.mutation(api.documentThreads.create, {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      documentPath: "guide/index.html",
      body: "This member still has document access",
      anchor: { kind: "element", path: ["main"] },
    });

    await expect(member.query(api.documentThreads.list, {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      documentPath: "guide/index.html",
      paginationOpts: { numItems: 20, cursor: null },
    })).resolves.toMatchObject({ page: [{ _id: threadId, authorId: seeded.userId }] });
  });
});
