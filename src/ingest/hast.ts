import type { Element, ElementContent, Nodes, Root } from "hast";

export function isElement(node: unknown, tagName?: string): node is Element {
  return (node as Nodes | undefined)?.type === "element" && (tagName === undefined || (node as Element).tagName === tagName);
}

/** Pre-order (document order) without recursion. A visitor returning "skip" does not descend into that element. */
export function walkElements(tree: Root | Element, visit: (element: Element, parent: Root | Element, index: number) => "skip" | void): void {
  const stack: Array<{ parent: Root | Element; index: number }> = [{ parent: tree, index: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.parent.children.length) {
      stack.pop();
      continue;
    }
    const index = frame.index++;
    const child = frame.parent.children[index];
    if (isElement(child) && visit(child, frame.parent, index) !== "skip") stack.push({ parent: child, index: 0 });
  }
}

/** Text content, like hast-util-to-string, but without recursion. */
export function textOf(node: Nodes): string {
  let text = "";
  const stack: Nodes[] = [node];
  while (stack.length) {
    const current = stack.pop() as Nodes;
    if (current.type === "text") text += current.value;
    else if ("children" in current) for (let i = current.children.length - 1; i >= 0; i--) stack.push(current.children[i]);
  }
  return text;
}

export function classList(element: Element): string[] {
  const value = element.properties.className;
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * The <head> children and <body> children of a parsed document. The tree
 * builder always creates <html> and <head>; a frameset document has no <body>.
 */
export function documentParts(document: Root): { head: ElementContent[]; body: ElementContent[] } {
  const html = document.children.find((child) => isElement(child, "html")) as Element;
  const part = (name: string) => (html.children.find((child) => isElement(child, name)))?.children ?? [];
  return { head: part("head"), body: part("body") };
}

export function element(tagName: string, properties: Element["properties"], children: ElementContent[]): Element {
  return { type: "element", tagName, properties, children };
}
