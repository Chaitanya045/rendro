import { ConvexError } from "convex/values";

export function validateClientOperationId(value: string | undefined): void {
  if (value !== undefined && (!value.trim() || value.length > 128)) {
    throw new ConvexError("Client operation ID must contain between 1 and 128 characters");
  }
}

export function validateCommentAuthor(expectedAuthorId: string | undefined, authorId: string): void {
  if (expectedAuthorId !== undefined && expectedAuthorId !== authorId) {
    throw new ConvexError("The comment session changed. Reload the document before submitting.");
  }
}
