/** Directory-page cursors are page numbers inside one immutable deployment.
 * Absent means the first page; anything but a plain decimal is rejected. */
export function treePageCursor(value: string | undefined): number | null {
  if (value === undefined) return 0;
  return /^(0|[1-9][0-9]{0,8})$/.test(value) ? Number(value) : null;
}
