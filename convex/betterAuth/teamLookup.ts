import { v } from "convex/values";
import { query } from "./_generated/server";

// Component IDs must be normalized inside the component's database context.
export const get = query({
  args: { teamId: v.string() },
  handler: async (ctx, { teamId }) => {
    const id = ctx.db.normalizeId("team", teamId);
    if (!id) return null;
    const team = await ctx.db.get(id);
    return team ? { organizationId: team.organizationId } : null;
  },
});
