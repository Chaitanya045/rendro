import type { CommentorParentMutationMethod } from "./parent-protocol";

export class CommentOperationConflictError extends Error {
  constructor() {
    super("Your previous comment is still unconfirmed. Resubmit the original draft before editing it.");
  }
}

type Args = Record<string, unknown>;
export type CommentOperation = { method: CommentorParentMutationMethod; args: Args; clientOperationId: string };
export type CommentRecoveryState = { operations: Record<string, CommentOperation>; drafts: Record<string, Args> };

export function mutationKey(method: CommentorParentMutationMethod, args: Args = {}): string {
  const reply = method === "reply.remove" || method === "reply.edit";
  return JSON.stringify([method, method === "thread.create" ? null : args.threadId ?? null, reply ? args.replyId ?? null : null]);
}

/** Where an edit's unsaved text is kept (#287): one draft per thread or reply, apart from the reply box's. */
export function editDraftKey(threadId: string, replyId?: string): string {
  return replyId === undefined ? `edit:${threadId}` : `edit:${threadId}:${replyId}`;
}

/** The draft a write was typed in, if it carries text: the composer's, a reply box's or an edit's. */
function draftKey(method: CommentorParentMutationMethod, args: Args): string | null {
  if (method === "thread.create") return "create";
  if (method === "reply.add") return String(args.threadId);
  if (method === "thread.edit") return editDraftKey(String(args.threadId));
  if (method === "reply.edit") return editDraftKey(String(args.threadId), String(args.replyId));
  return null;
}

// The parent owns durable storage: document frames have an opaque origin.
// Persist before dispatch; storage failure must prevent the backend write.
export class CommentOperationState {
  value: CommentRecoveryState = { operations: {}, drafts: {} };
  constructor(private readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">, private readonly key = "", private readonly userId?: string) {
    if (storage) {
      const saved = storage.getItem(key);
      if (saved) {
        try {
          const value = JSON.parse(saved);
          if (value.userId !== userId || !value.operations || !value.drafts
            || typeof value.operations !== "object" || Array.isArray(value.operations)
            || typeof value.drafts !== "object" || Array.isArray(value.drafts)) throw new Error("Invalid recovery owner/state");
          this.value = { operations: value.operations, drafts: value.drafts };
        } catch { storage.removeItem(key); }
      }
    }
  }
  save(): void { this.storage?.setItem(this.key, JSON.stringify({ ...this.value, userId: this.userId })); }
  prepare(method: CommentorParentMutationMethod, args: Args): CommentOperation {
    const key = mutationKey(method, args);
    const existing = this.value.operations[key];
    if (existing) {
      // Keep the submitted payload as well as its ID across uncertain outcomes.
      if (draftKey(method, args) !== null && args.body !== existing.args.body) {
        throw new CommentOperationConflictError();
      }
      return existing;
    }
    const operation = { method, args, clientOperationId: typeof args.clientOperationId === "string" ? args.clientOperationId : crypto.randomUUID() };
    this.value.operations[key] = operation;
    const draft = draftKey(method, args);
    if (draft !== null) this.value.drafts[draft] = args;
    this.save();
    return operation;
  }
  complete(key: string, clientOperationId: string): void {
    const op = this.value.operations[key];
    if (!op || op.clientOperationId !== clientOperationId) return;
    const draft = draftKey(op.method, op.args);
    if (draft !== null && this.value.drafts[draft]?.body === op.args.body) delete this.value.drafts[draft];
    delete this.value.operations[key];
    this.save();
  }
  reject(key: string, clientOperationId: string): void {
    if (this.value.operations[key]?.clientOperationId !== clientOperationId) return;
    delete this.value.operations[key];
    this.save(); // Keep the editable draft on definitive rejection.
  }
  draft(key: string, args: Args): void {
    if (args.body) this.value.drafts[key] = args;
    else delete this.value.drafts[key];
    this.save();
  }
}
