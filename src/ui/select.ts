/** Progressive enhancement for Rendro's single-value selects. Native controls
 * retain form values, validation and change handlers; one shared popup owns UX. */
export function installSelects(doc: Document) {
  const view = doc.defaultView;
  if (!view) throw new Error("Select enhancement requires a browser document.");
  const win = view;
  const instances = new Map<HTMLSelectElement, ReturnType<typeof enhance>>();
  let serial = 0;
  let opened: ReturnType<typeof enhance> | undefined;

  function enhance(select: HTMLSelectElement) {
    const id = `rd-select-${++serial}`;
    const trigger = doc.createElement("button");
    trigger.type = "button";
    trigger.className = `${select.className} rd-select-trigger`;
    trigger.id = `${id}-trigger`;
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", `${id}-list`);
    const value = doc.createElement("span"); value.className = "rd-select-value";
    const caret = doc.createElement("span"); caret.className = "rd-select-caret"; caret.setAttribute("aria-hidden", "true");
    trigger.append(value, caret);
    const popup = doc.createElement("div");
    popup.className = "rd-select-popup"; popup.id = `${id}-list`;
    popup.setAttribute("role", "listbox"); popup.setAttribute("popover", "manual"); popup.hidden = true;
    // A popup in a modal must remain a descendant of that dialog's active tree.
    (select.closest("dialog") || doc.body).append(popup);
    const nativeTabIndex = select.getAttribute("tabindex"), nativeAriaHidden = select.getAttribute("aria-hidden");
    select.dataset.rdSelect = "true"; select.classList.add("rd-select-native"); select.tabIndex = -1; select.setAttribute("aria-hidden", "true");
    select.after(trigger);
    const validation = doc.createElement("span"); validation.id = `${id}-error`; validation.className = "rd-select-validation"; validation.hidden = true; validation.setAttribute("role", "alert"); trigger.after(validation);
    let active = -1, open = false, typeBuffer = "", lastType = 0;
    let items: HTMLElement[] = [];
    const isDisabled = (option: HTMLOptionElement) => option.disabled || Boolean(option.closest("optgroup")?.disabled);
    const optionLabel = (option: HTMLOptionElement) => option.label || option.textContent?.trim() || "";
    function label() {
      const named = select.getAttribute("aria-label");
      if (named) return named;
      const labelled = select.getAttribute("aria-labelledby");
      if (labelled) return labelled.split(/\s+/).map((part) => doc.getElementById(part)?.textContent || "").join(" ").trim();
      return Array.from(select.labels || []).map((node) => Array.from(node.childNodes).filter((child) => child !== select && child !== trigger && child !== validation && !(child.nodeType === 1 && (child as Element).tagName === "SMALL")).map((child) => child.textContent).join(" ")).join(" ").trim() || select.name || "Choose an option";
    }
    function highlight(index: number) {
      active = index;
      items.forEach((item, itemIndex) => { item.dataset.active = String(itemIndex === index); });
      if (open && items[index]) {
        trigger.setAttribute("aria-activedescendant", items[index].id);
        const item = items[index];
        // Scroll only this list, never the document or an ancestor dialog.
        if (item.offsetTop < popup.scrollTop) popup.scrollTop = item.offsetTop;
        else if (item.offsetTop + item.offsetHeight > popup.scrollTop + popup.clientHeight) popup.scrollTop = item.offsetTop + item.offsetHeight - popup.clientHeight;
      } else trigger.removeAttribute("aria-activedescendant");
    }
    function position() {
      if (!open) return;
      const rect = trigger.getBoundingClientRect(), viewport = win.visualViewport;
      const leftEdge = (viewport?.offsetLeft || 0) + 8, topEdge = (viewport?.offsetTop || 0) + 8;
      const rightEdge = leftEdge + (viewport?.width || win.innerWidth) - 16;
      const bottomEdge = topEdge + (viewport?.height || win.innerHeight) - 16;
      const below = bottomEdge - rect.bottom - 4, above = rect.top - topEdge - 4;
      const upward = below < Math.min(240, popup.scrollHeight) && above > below;
      popup.style.width = `${Math.min(Math.max(rect.width, 160), rightEdge - leftEdge)}px`;
      popup.style.maxHeight = `${Math.max(0, Math.min(288, upward ? above : below))}px`;
      popup.style.left = `${Math.max(leftEdge, Math.min(rect.left, rightEdge - Math.min(Math.max(rect.width, 160), rightEdge - leftEdge)))}px`;
      popup.style.top = `${upward ? Math.max(topEdge, rect.top - 4 - Math.min(popup.scrollHeight, above, 288)) : Math.max(topEdge, rect.bottom + 4)}px`;
      popup.dataset.side = upward ? "top" : "bottom";
    }
    function close(restoreFocus = false) {
      open = false; if (opened === api) opened = undefined;
      if (typeof popup.hidePopover === "function" && popup.matches(":popover-open")) popup.hidePopover();
      popup.hidden = true; trigger.setAttribute("aria-expanded", "false"); trigger.removeAttribute("aria-activedescendant");
      if (restoreFocus && trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
    }
    function sync() {
      const selected = select.options[select.selectedIndex];
      const text = selected ? optionLabel(selected) : "Choose an option";
      if (value.textContent !== text) value.textContent = text;
      trigger.title = text;
      trigger.disabled = select.matches(":disabled");
      trigger.setAttribute("aria-label", label());
      popup.setAttribute("aria-label", label());
      for (const name of ["aria-describedby", "aria-invalid", "aria-required"]) {
        const attr = select.getAttribute(name);
        if (attr) trigger.setAttribute(name, attr); else trigger.removeAttribute(name);
      }
      if (select.required) trigger.setAttribute("aria-required", "true");
      if (select.validity.valid) { validation.hidden = true; validation.textContent = ""; }
      if (!validation.hidden) { trigger.setAttribute("aria-invalid", "true"); trigger.setAttribute("aria-describedby", [select.getAttribute("aria-describedby"), validation.id].filter(Boolean).join(" ")); }
      if (trigger.disabled) close();
      popup.replaceChildren(); items = [];
      let group: HTMLOptGroupElement | null = null;
      Array.from(select.options).forEach((option, index) => {
        const nextGroup = option.closest("optgroup");
        if (nextGroup && nextGroup !== group) { const heading = doc.createElement("div"); heading.className = "rd-select-group"; heading.textContent = nextGroup.label; heading.setAttribute("role", "presentation"); popup.append(heading); }
        group = nextGroup;
        const item = doc.createElement("div"); item.id = `${id}-option-${index}`; item.className = "rd-select-option";
        item.setAttribute("role", "option"); item.setAttribute("aria-selected", String(option.selected)); item.setAttribute("aria-disabled", String(isDisabled(option)));
        const mark = doc.createElement("span"); mark.className = "rd-select-check"; mark.setAttribute("aria-hidden", "true");
        const text = doc.createElement("span"); text.textContent = optionLabel(option);
        item.append(mark, text); item.hidden = option.hidden;
        item.addEventListener("pointermove", () => { if (!isDisabled(option) && active !== index) highlight(index); });
        item.addEventListener("pointerdown", (event) => event.preventDefault());
        item.addEventListener("click", (event) => { event.stopPropagation(); choose(index); });
        items.push(item); popup.append(item);
      });
      if (open) { highlight(active >= 0 && active < items.length ? active : select.selectedIndex); position(); }
    }
    function show() {
      if (select.matches(":disabled") || !select.options.length) return;
      opened?.close(); sync(); open = true; opened = api; popup.hidden = false;
      if (typeof popup.showPopover === "function") popup.showPopover();
      trigger.setAttribute("aria-expanded", "true"); position();
      highlight(select.selectedIndex >= 0 && !isDisabled(select.options[select.selectedIndex]) ? select.selectedIndex : enabled()[0] ?? -1);
    }
    function enabled() { return Array.from(select.options).flatMap((option, index) => !isDisabled(option) && !option.hidden ? [index] : []); }
    function choose(index: number, restoreFocus = true) {
      const option = select.options[index];
      if (!option || isDisabled(option) || select.matches(":disabled")) return;
      const changed = select.selectedIndex !== index;
      select.selectedIndex = index; close(restoreFocus); sync();
      if (changed) { select.dispatchEvent(new win.Event("input", { bubbles: true })); select.dispatchEvent(new win.Event("change", { bubbles: true })); }
    }
    function keydown(event: KeyboardEvent) {
      if (trigger.disabled || event.ctrlKey || event.metaKey) return;
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key === "Tab") { if (open) { choose(active, false); close(); } return; }
      if (["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const wasOpen = open;
        if (!open) show();
        if (["Enter", " "].includes(event.key)) { if (wasOpen) choose(active); return; }
        if (event.altKey) { if (event.key === "ArrowUp" && wasOpen) choose(active); return; }
        const choices = enabled(), at = choices.indexOf(active);
        if (!choices.length) return;
        if (event.key === "Home") highlight(choices[0]);
        else if (event.key === "End") highlight(choices[choices.length - 1]);
        else if (wasOpen) { const delta = event.key === "ArrowUp" ? -1 : event.key === "PageUp" ? -10 : event.key === "PageDown" ? 10 : 1; highlight(choices[Math.max(0, Math.min(choices.length - 1, at + delta))]); }
        return;
      }
      if (event.key.length === 1 && !event.altKey) {
        event.preventDefault(); if (!open) show();
        const now = Date.now(); typeBuffer = now - lastType < 700 ? typeBuffer + event.key.toLowerCase() : event.key.toLowerCase(); lastType = now;
        const repeat = Array.from(typeBuffer).every((char) => char === typeBuffer[0]);
        const search = repeat ? typeBuffer[0] : typeBuffer;
        const choices = enabled(), start = repeat ? choices.indexOf(active) + 1 : 0;
        const match = choices.slice(start).concat(choices.slice(0, start)).find((index) => optionLabel(select.options[index]).toLowerCase().startsWith(search));
        if (match !== undefined) highlight(match);
      }
    }
    trigger.addEventListener("click", () => open ? close() : show());
    trigger.addEventListener("keydown", keydown);
    trigger.addEventListener("blur", () => close());
    const focus = () => trigger.focus({ preventScroll: true });
    const invalid = (event: Event) => { event.preventDefault(); validation.hidden = false; validation.textContent = select.validationMessage || "Choose an option."; trigger.setAttribute("aria-invalid", "true"); trigger.setAttribute("aria-describedby", [select.getAttribute("aria-describedby"), validation.id].filter(Boolean).join(" ")); focus(); };
    select.addEventListener("focus", focus); select.addEventListener("invalid", invalid); select.addEventListener("change", sync);
    const form = select.form, reset = () => { validation.hidden = true; queueMicrotask(sync); }; form?.addEventListener("reset", reset);
    // Existing controllers set these native properties directly after async
    // confirmation/rejection. Mirror them without patching global prototypes.
    const patched: string[] = [];
    for (const name of ["value", "selectedIndex", "disabled"]) {
      let proto = Object.getPrototypeOf(select) as object | null, descriptor: PropertyDescriptor | undefined;
      while (proto && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(proto, name); proto = Object.getPrototypeOf(proto) as object | null; }
      if (descriptor?.get && descriptor.set && !Object.hasOwn(select, name)) {
        const get = descriptor.get.bind(select) as () => unknown;
        const set = descriptor.set.bind(select) as (value: unknown) => void;
        Object.defineProperty(select, name, { configurable: true, get() { return get(); }, set(next: unknown) { const previous = get(); set(next); if (!Object.is(previous, get())) sync(); } }); patched.push(name);
      }
    }
    const observer = new win.MutationObserver(sync);
    observer.observe(select, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["disabled", "selected", "label", "hidden", "required", "aria-label", "aria-labelledby", "aria-describedby", "aria-invalid"] });
    const api = { close, position, sync, trigger, popup, destroy() {
      close(); observer.disconnect(); select.removeEventListener("focus", focus); select.removeEventListener("invalid", invalid); select.removeEventListener("change", sync); form?.removeEventListener("reset", reset);
      patched.forEach((name) => { Reflect.deleteProperty(select, name); }); trigger.remove(); popup.remove(); validation.remove(); select.classList.remove("rd-select-native"); delete select.dataset.rdSelect;
      if (nativeTabIndex === null) select.removeAttribute("tabindex"); else select.setAttribute("tabindex", nativeTabIndex);
      if (nativeAriaHidden === null) select.removeAttribute("aria-hidden"); else select.setAttribute("aria-hidden", nativeAriaHidden);
    } };
    sync(); return api;
  }
  function scan() {
    instances.forEach((instance, select) => { if (!select.isConnected) { instance.destroy(); instances.delete(select); } });
    doc.querySelectorAll<HTMLSelectElement>("select.select:not([data-rd-select]):not([multiple])").forEach((select) => { if (Number(select.getAttribute("size") || 0) <= 1) instances.set(select, enhance(select)); });
  }
  const outside = (event: PointerEvent) => { if (opened && !opened.trigger.contains(event.target as Node) && !opened.popup.contains(event.target as Node)) opened.close(); };
  const scroll = (event: Event) => { if (opened && !opened.popup.contains(event.target as Node)) opened.close(); };
  const resize = () => opened?.position();
  const transition = (event: Event) => { if (opened && (event.target as Node)?.contains(opened.trigger)) opened.position(); };
  const close = () => opened?.close();
  doc.addEventListener("pointerdown", outside, true); doc.addEventListener("scroll", scroll, true); win.addEventListener("resize", resize);
  doc.addEventListener("rendro:before-route-leave", close); doc.addEventListener("close", close, true);
  doc.addEventListener("transitionend", transition);
  win.visualViewport?.addEventListener("resize", resize); win.visualViewport?.addEventListener("scroll", resize);
  const observer = new win.MutationObserver(scan); observer.observe(doc.body, { childList: true, subtree: true }); scan();
  return { scan, destroy() { observer.disconnect(); instances.forEach((instance) => instance.destroy()); instances.clear(); doc.removeEventListener("pointerdown", outside, true); doc.removeEventListener("scroll", scroll, true); win.removeEventListener("resize", resize); doc.removeEventListener("rendro:before-route-leave", close); doc.removeEventListener("close", close, true); doc.removeEventListener("transitionend", transition); win.visualViewport?.removeEventListener("resize", resize); win.visualViewport?.removeEventListener("scroll", resize); } };
}
