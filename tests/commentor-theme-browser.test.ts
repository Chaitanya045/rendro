import { beforeAll, describe, expect, it } from "vitest";
import { useCommentLab } from "./helpers/comment-lab";

const commentLab = useCommentLab();
beforeAll(() => commentLab.start());

describe("comment widget theme handshake", () => {
  it("asks the parent for its theme only once it can hear the answer", async () => {
    const lab = await commentLab.open({
      init: () => {
        if (window.parent === window) return;
        const parentWindow = window.parent;
        const original = parentWindow.postMessage.bind(parentWindow) as (message: unknown, target: string) => void;
        const asked: Array<{ type: string; heard: boolean }> = [];
        (window as unknown as { asked: typeof asked }).asked = asked;
        parentWindow.postMessage = ((message: { type?: string }, target: string) => {
          if (message?.type === "commentor-theme-ready") {
            // The parent's answer would arrive after this task; deliver one right now to see whether anything is listening.
            window.dispatchEvent(new MessageEvent("message", { data: { type: "rendro-theme", theme: "dark" }, source: parentWindow }));
            asked.push({ type: message.type, heard: document.getElementById("commentor-host")?.classList.contains("dark") === true });
          }
          original(message, target);
        }) as typeof parentWindow.postMessage;
      },
    });
    await lab.ready();
    expect(await lab.doc(() => (window as unknown as { asked: unknown[] }).asked)).toEqual([{ type: "commentor-theme-ready", heard: true }]);
  });
});
