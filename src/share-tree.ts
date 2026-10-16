import { defaultTreeAdapter, type DefaultTreeAdapterMap, type TreeAdapter } from "parse5";
import type { WorkBudget } from "@/share-budget";

type Parent = DefaultTreeAdapterMap["parentNode"];
type Child = DefaultTreeAdapterMap["childNode"];
type Links = { first?: Child; last?: Child; previous?: Child; next?: Child };

/** parse5's default sibling arrays use indexOf/splice during tree repair.
 * Linked siblings keep insertion/removal O(1), including foster parenting and
 * adoption-agency repair. Materialize ordinary arrays once, after parsing.
 */
export function shareTree(budget: WorkBudget): { adapter: TreeAdapter<DefaultTreeAdapterMap>; finish: () => void } {
  const links = new Map<Parent | Child, Links>();
  const link = (node: Parent | Child): Links => {
    budget.charge();
    let value = links.get(node);
    if (!value) { value = {}; links.set(node, value); }
    return value;
  };
  const insert = (parent: Parent, node: Child, before?: Child) => {
    const siblings = link(parent);
    const previous = before ? link(before).previous : siblings.last;
    const item = link(node);
    item.previous = previous;
    item.next = before;
    if (previous) link(previous).next = node;
    else siblings.first = node;
    if (before) link(before).previous = node;
    else siblings.last = node;
    node.parentNode = parent;
  };
  const insertText = (parent: Parent, text: string, before?: Child) => {
    budget.charge(text.length);
    const previous = before ? link(before).previous : link(parent).last;
    if (previous?.nodeName === "#text") (previous as DefaultTreeAdapterMap["textNode"]).value += text;
    else insert(parent, defaultTreeAdapter.createTextNode(text), before);
  };
  let doctype: DefaultTreeAdapterMap["documentType"] | undefined;
  return {
    adapter: {
      ...defaultTreeAdapter,
      appendChild: (parent, node) => insert(parent, node),
      insertBefore: insert,
      insertText,
      insertTextBefore: insertText,
      detachNode(node) {
        budget.charge();
        if (!node.parentNode) return;
        const siblings = link(node.parentNode);
        const item = link(node);
        if (item.previous) link(item.previous).next = item.next;
        else siblings.first = item.next;
        if (item.next) link(item.next).previous = item.previous;
        else siblings.last = item.previous;
        node.parentNode = null;
      },
      getFirstChild: node => link(node).first ?? null,
      setDocumentType(document, name, publicId, systemId) {
        budget.charge();
        if (doctype) Object.assign(doctype, { name, publicId, systemId });
        else {
          doctype = { nodeName: "#documentType", name, publicId, systemId, parentNode: null };
          insert(document, doctype);
        }
      },
      adoptAttributes(node, attrs) {
        budget.charge(node.attrs.length + attrs.length);
        // Repeated html/body tags must not accumulate an unbounded attribute map.
        if (node.attrs.length + attrs.length > 128) budget.fail();
        defaultTreeAdapter.adoptAttributes(node, attrs);
      },
      getTagName(node) {
        budget.charge(node.tagName.length + 1);
        return node.tagName;
      },
      getAttrList(node) {
        // Reserve parse5's formatting candidate comparisons/map construction,
        // including long attribute names/values, before it scans this list.
        budget.charge();
        for (const attr of node.attrs) budget.charge(attr.name.length + attr.value.length + 1);
        return node.attrs;
      },
      getNamespaceURI(node) {
        budget.charge();
        return node.namespaceURI;
      },
    },
    finish() {
      for (const [node, siblings] of links) {
        budget.charge();
        if (!("childNodes" in node)) continue;
        for (let child = siblings.first; child; child = link(child).next) {
          budget.charge();
          node.childNodes.push(child);
        }
      }
    },
  };
}
