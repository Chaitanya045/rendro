import { expect, it } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import { fixture } from "./helpers/comment-fixture";

it("keeps comments readable with an unnamed or deleted author", async () => {
  const { backend, viewers, scope, threadId, replyId, data } = await fixture();
  const authorId = data.users[0].userId;
  await backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.updateOne, {
    input: { model: "user", where: [{ field: "_id", value: authorId }], update: { name: "  " } },
  }));
  const paginationOpts = { cursor: null, numItems: 20 };
  for (const deleted of [false, true]) {
    if (deleted) await backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: "user", where: [{ field: "_id", value: authorId }] },
    }));
    const display = deleted ? { authorName: "Former member", authorEmail: "" } : { authorName: "author@example.test", authorEmail: "author@example.test" };
    const threads = await viewers.member.query(api.documentThreads.list, { ...scope, paginationOpts });
    expect(threads.page[0]).toMatchObject(display);
    expect(threads.page[0].replies.find(reply => reply._id === replyId)).toMatchObject(display);
    const replies = await viewers.member.query(api.documentReplies.list, { ...scope, threadId, paginationOpts });
    expect(replies.page.find(reply => reply._id === replyId)).toMatchObject(display);
  }
});

it("rejects missing reply/thread/project records before changing comments", async () => {
  const { backend, viewers, scope, threadId, replyId } = await fixture();
  const viewer = viewers.admin;
  await backend.run(ctx => ctx.db.delete(replyId));
  await expect(viewer.mutation(api.documentReplies.remove, { ...scope, threadId, replyId })).rejects.toThrow("Comment not found");
  await backend.run(ctx => ctx.db.delete(threadId));
  await expect(viewer.mutation(api.documentThreads.remove, { ...scope, threadId })).rejects.toThrow("Comment not found");
  expect(await backend.mutation(internal.documentThreads.cleanupDeletedThread, { threadId })).toBeNull();
  await backend.run(ctx => ctx.db.delete(scope.projectId));
  await expect(viewer.mutation(api.documentThreads.remove, { ...scope, threadId })).rejects.toThrow("Comment not found");
  await expect(viewer.mutation(api.documentReplies.remove, { ...scope, threadId, replyId })).rejects.toThrow("Comment not found");
  expect(await backend.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
});

it("rejects invalid pagination and document paths before writes or unbounded reads", async () => {
  const { viewers, scope, threadId, backend } = await fixture();
  for (const numItems of [-1, 0, 0.5, 21, Number.MAX_SAFE_INTEGER + 1]) {
    const paginationOpts = { cursor: null, numItems };
    await expect(viewers.author.query(api.documentThreads.list, { ...scope, paginationOpts })).rejects.toThrow("Invalid input");
    await expect(viewers.author.query(api.documentReplies.list, { ...scope, threadId, paginationOpts })).rejects.toThrow("Invalid input");
  }
  for (const documentPath of ["", "./index.html", "a\\b.html", "a/../b.html"]) {
    await expect(viewers.author.mutation(api.documentThreads.create, {
      ...scope, documentPath, body: "Thread", anchor: { kind: "element", path: ["main"] },
    })).rejects.toThrow("Invalid input");
  }
  expect(await backend.run(ctx => ctx.db.query("documentThreads").collect())).toHaveLength(1);
});
