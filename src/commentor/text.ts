export function appendPlainText(parent: ParentNode, value: string): void {
  parent.append(document.createTextNode(value));
}
