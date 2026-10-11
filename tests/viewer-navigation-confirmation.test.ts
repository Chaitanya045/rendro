import { describe, expect, it } from "vitest";
import { createNavigationConfirmation } from "@/viewer/navigation-confirmation";

const first = { fullPath: "org/first.html", search: "?v=1", fragment: "#first" };
const second = { fullPath: "org/second.html", search: "?v=2", fragment: "#second" };

describe("parent-owned navigation confirmation", () => {
  it("freezes the visible destination through duplicate and different requests", () => {
    const confirmation = createNavigationConfirmation();
    expect(confirmation.request(first)).toEqual(first);
    for (let i = 0; i < 1000; i++) {
      expect(confirmation.request(first)).toBeNull();
      expect(confirmation.request(second)).toBeNull();
    }
    expect(confirmation.dismiss()).toBe(true);
    expect(confirmation.reopen()).toEqual(first);
  });

  it("retains only the latest dismissed request without reopening", () => {
    const confirmation = createNavigationConfirmation();
    confirmation.request(first);
    confirmation.dismiss();
    for (let i = 0; i < 1000; i++) {
      expect(confirmation.request({ ...second, search: `?v=${i}` })).toBeNull();
    }
    expect(confirmation.reopen()).toEqual({ ...second, search: "?v=999" });
    expect(confirmation.request(first)).toBeNull();
    confirmation.dismiss();
    expect(confirmation.reopen()).toEqual({ ...second, search: "?v=999" });
  });

  it("de-duplicates the same target while allowing explicit reopening", () => {
    const confirmation = createNavigationConfirmation();
    confirmation.request(first);
    confirmation.dismiss();
    for (let i = 0; i < 1000; i++) expect(confirmation.request({ ...first })).toBeNull();
    expect(confirmation.reopen()).toEqual(first);
  });

  it.each([
    { ...first, fullPath: second.fullPath },
    { ...first, search: second.search },
    { ...first, fragment: second.fragment },
  ])("keeps changes to each destination component: %j", target => {
    const confirmation = createNavigationConfirmation();
    confirmation.request(first);
    confirmation.dismiss();
    expect(confirmation.request(target)).toBeNull();
    expect(confirmation.reopen()).toEqual(target);
  });

  it("allows any number of reader-driven dismiss/reopen cycles with later links", () => {
    const confirmation = createNavigationConfirmation();
    confirmation.request(first);
    for (let i = 0; i < 20; i++) {
      expect(confirmation.dismiss()).toBe(true);
      const target = { ...second, fragment: `#later-${i}` };
      expect(confirmation.request(target)).toBeNull();
      expect(confirmation.reopen()).toEqual(target);
    }
  });

  it("clears stale destinations on parent navigation and ignores invalid transitions", () => {
    const confirmation = createNavigationConfirmation();
    expect(confirmation.dismiss()).toBe(false);
    expect(confirmation.reopen()).toBeNull();
    confirmation.request(first);
    expect(confirmation.reopen()).toBeNull();
    confirmation.dismiss();
    expect(confirmation.dismiss()).toBe(false);
    confirmation.reset();
    expect(confirmation.reopen()).toBeNull();
    expect(confirmation.request(second)).toEqual(second);
    confirmation.reset();
    expect(confirmation.request(first)).toEqual(first);
  });
});
