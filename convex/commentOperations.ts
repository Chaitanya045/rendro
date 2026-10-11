import { publicError } from "./publicErrors";

export function validateClientOperationId(value: string | undefined): void {
  if (value !== undefined && (!value.trim() || value.length > 128)) {
    publicError("invalid_input");
  }
}

export function validateCommentAuthor(expectedAuthorId: string | undefined, authorId: string): void {
  if (expectedAuthorId !== undefined && expectedAuthorId !== authorId) {
    publicError("forbidden");
  }
}
