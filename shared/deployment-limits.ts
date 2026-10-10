// Each reused file makes two external S3 calls (HEAD + COPY). Leave room
// below Workers' 50-subrequest free-tier limit for auth, manifests and retries.
export const MAX_REUSED_FILES_PER_REQUEST = 16;
