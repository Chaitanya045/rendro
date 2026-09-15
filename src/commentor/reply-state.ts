export function draftAfterSuccessfulReply(
  currentDraft: string | undefined,
  submittedDraft: string,
): string | undefined {
  return currentDraft === submittedDraft ? undefined : currentDraft;
}
