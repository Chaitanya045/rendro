import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { managementUiRuntime } from "@/ui/management-ui";

const windows: Window[] = [];
afterEach(() => { for (const win of windows.splice(0)) void win.happyDOM.close(); });

function page(markup: string) {
  const win = new Window({ url: "https://rendro.test/", settings: { enableJavaScriptEvaluation: true } });
  windows.push(win);
  win.document.write(markup);
  Object.assign(win, { RendroUI: {} });
  win.eval(managementUiRuntime);
  const ui = (win as unknown as { RendroUI: { setOrganizationChrome(name: string, mark: string): void } }).RendroUI;
  return { win, document: win.document, set: (name: string, mark = name.charAt(0).toUpperCase()) => ui.setOrganizationChrome(name, mark) };
}
const records = (win: Window, root: Node) => {
  const observer = new win.MutationObserver(() => {});
  observer.observe(root as never, { childList: true, characterData: true, subtree: true });
  return () => observer.takeRecords();
};

describe("organization chrome label updates", () => {
  // WebKit drops a click whose pressed text node is removed before the button is released.
  it("rewrites a changed label in place, keeping the node a reader may be pressing", () => {
    const { document, set } = page('<button id="s"><span data-org-mark>R</span><span data-org-name>Organization</span></button><a><span data-org-name>Organization</span></a>');
    const [name] = Array.from(document.querySelectorAll("[data-org-name]"));
    const text = name.firstChild, markText = document.querySelector("[data-org-mark]")!.firstChild;
    set("Alpha");
    expect(Array.from(document.querySelectorAll("[data-org-name]"), node => node.textContent)).toEqual(["Alpha", "Alpha"]);
    expect(document.querySelector("[data-org-mark]")!.textContent).toBe("A");
    expect(name.firstChild).toBe(text);
    expect(document.querySelector("[data-org-mark]")!.firstChild).toBe(markText);
  });

  it("leaves a label that already shows the name untouched", () => {
    const { win, document, set } = page('<span data-org-name>Alpha</span><span data-org-mark>A</span>');
    const take = records(win, document.body);
    set("Alpha");
    expect(take()).toHaveLength(0);
  });

  it("still fills a label that is empty or holds more than one text node", () => {
    const { document, set } = page('<span data-org-name></span><span data-org-name><b>x</b></span><span data-org-name><b>Alpha</b></span><span data-org-mark><i>R</i></span>');
    set("Alpha");
    expect(Array.from(document.querySelectorAll("[data-org-name]"), node => node.textContent)).toEqual(["Alpha", "Alpha", "Alpha"]);
    expect(document.querySelector("[data-org-mark]")!.textContent).toBe("A");
    // An element child is replaced by the name only when the content differs.
    expect(document.querySelectorAll("[data-org-name]")[2].querySelector("b")).not.toBeNull();
  });
});
