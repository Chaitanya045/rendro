/** Settles at once while the document is visible, otherwise when it next becomes visible. */
export function whenVisible(doc: Document = document): Promise<void> {
  if (doc.visibilityState !== "hidden") return Promise.resolve();
  return new Promise(resolve => {
    const onChange = () => {
      if (doc.visibilityState === "hidden") return;
      doc.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    doc.addEventListener("visibilitychange", onChange);
  });
}
