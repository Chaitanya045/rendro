export interface LinkActivation {
  button: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function shouldUseNativeLinkNavigation(event: LinkActivation): boolean {
  return event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

export function emptyTreeAction(documentBase: string): {
  message: string;
  href?: string;
  label?: string;
} {
  const projectDocs = /^(\/organizations\/[^/]+\/projects\/[^/]+)\/docs\/?$/i.exec(documentBase);
  if (projectDocs) return { message: "No documents deployed yet.", href: projectDocs[1], label: "Return to project" };
  if (documentBase) return { message: "No documents available." };
  return { message: "No documents yet." };
}
