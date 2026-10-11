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
  return JSON.stringify([method, method === "thread.create" ? null : args.threadId ?? null, method === "reply.remove" ? args.replyId ?? null : null]);
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
      if ((method === "thread.create" || method === "reply.add") && args.body !== existing.args.body) {
        throw new CommentOperationConflictError();
      }
      return existing;
    }
    const operation = { method, args, clientOperationId: typeof args.clientOperationId === "string" ? args.clientOperationId : crypto.randomUUID() };
    this.value.operations[key] = operation;
    if (method === "thread.create") this.value.drafts.create = args;
    if (method === "reply.add") this.value.drafts[String(args.threadId)] = args;
    this.save();
    return operation;
  }
  complete(key: string, clientOperationId: string): void {
    const op = this.value.operations[key];
    if (!op || op.clientOperationId !== clientOperationId) return;
    const draftKey = op.method === "thread.create" ? "create" : op.method === "reply.add" ? String(op.args.threadId) : null;
    if (draftKey && this.value.drafts[draftKey]?.body === op.args.body) delete this.value.drafts[draftKey];
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
