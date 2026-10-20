// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { shellFrameNavigation, startShellNavigation } from "@/viewer/content-frame";

/*
 * Which document a shell frame shows (#296): the shell records each navigation it starts on the frame element, each
 * load settles it, and a load the shell did not start leaves the frame untrusted until the shell navigates it again.
 */
afterEach(() => { document.body.innerHTML = ""; });

function frame(html = "<iframe></iframe>"): HTMLIFrameElement {
  document.body.innerHTML = html;
  return document.querySelector("iframe")!;
}
const load = (target: EventTarget) => target.dispatchEvent(new Event("load"));

describe("shell frame navigations", () => {
  it("trusts the document the shell loaded, through each of its own navigations, and never one the frame loaded by itself", () => {
    const content = frame('<iframe src="about:blank"></iframe>');
    expect(shellFrameNavigation(content)).toBeNull();
    // The first navigation leaves the frame's empty document: that one runs nothing, so the frame may speak meanwhile.
    startShellNavigation(content);
    expect(shellFrameNavigation(content)).toBe("1");
    load(content);
    expect(content.dataset).toMatchObject({ navigation: "1", document: "1" });
    expect(content.dataset.loading).toBeUndefined();
    // Loading the next page: the page being left was the shell's, so it still is until the next load.
    startShellNavigation(content);
    expect(shellFrameNavigation(content)).toBe("2");
    load(content);
    expect(shellFrameNavigation(content)).toBe("2");
    // A load nobody asked for: the document is no longer the one `src` names.
    load(content);
    expect(shellFrameNavigation(content)).toBeNull();
    // A navigation started from there trusts nothing until it loads.
    startShellNavigation(content);
    expect(shellFrameNavigation(content)).toBeNull();
    load(content);
    expect(shellFrameNavigation(content)).toBe("3");
  });

  it("trusts nothing a frame showed before the shell first navigated it", () => {
    const named = frame('<iframe src="/r/acme/docs/files/guide.md"></iframe>');
    startShellNavigation(named);
    expect(shellFrameNavigation(named)).toBeNull();
    load(named);
    expect(shellFrameNavigation(named)).toBe("1");
  });

  it("starts with a frame created with no address, as a preload is", () => {
    const preload = document.createElement("iframe");
    document.body.append(preload);
    startShellNavigation(preload);
    expect(shellFrameNavigation(preload)).toBe("1");
  });

  it("settles only frames the shell navigates, once per load however many frames it navigates", () => {
    const other = document.createElement("iframe");
    startShellNavigation(other);
    const untracked = frame();
    load(untracked);
    expect({ ...untracked.dataset }).toEqual({});
    const content = frame();
    startShellNavigation(content);
    load(content);
    expect(shellFrameNavigation(content)).toBe("1");
    // Other elements' loads (an image, the window itself) change nothing.
    const image = document.createElement("img");
    content.after(image);
    load(image);
    window.dispatchEvent(new Event("load"));
    expect(shellFrameNavigation(content)).toBe("1");
  });
});
