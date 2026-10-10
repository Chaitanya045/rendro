export type PendingDeletePhase = "waiting" | "committing";
export type UndoDeleteResult = "undone" | "committing" | "missing";

interface PendingDelete {
  timer: ReturnType<typeof setTimeout>;
  phase: PendingDeletePhase;
}

export class PendingDeletionCoordinator<Key> {
  private readonly pending = new Map<Key, PendingDelete>();

  begin(key: Key, delay: number, commit: () => Promise<unknown>, onFailure: (error: unknown) => void): boolean {
    if (this.pending.has(key)) return false;
    const deletion = { timer: undefined as unknown as ReturnType<typeof setTimeout>, phase: "waiting" as PendingDeletePhase };
    deletion.timer = setTimeout(async () => {
      if (this.pending.get(key) !== deletion || deletion.phase !== "waiting") return;
      deletion.phase = "committing";
      try {
        await commit();
      } catch (error) {
        if (this.pending.get(key) === deletion) this.pending.delete(key);
        onFailure(error);
      }
    }, delay);
    this.pending.set(key, deletion);
    return true;
  }

  undo(key: Key): UndoDeleteResult {
    const deletion = this.pending.get(key);
    if (!deletion) return "missing";
    if (deletion.phase === "committing") return "committing";
    clearTimeout(deletion.timer);
    this.pending.delete(key);
    return "undone";
  }

  acknowledge(key: Key): void {
    const deletion = this.pending.get(key);
    if (!deletion) return;
    clearTimeout(deletion.timer);
    this.pending.delete(key);
  }

  has(key: Key): boolean { return this.pending.has(key); }
  keys(): IterableIterator<Key> { return this.pending.keys(); }
}
