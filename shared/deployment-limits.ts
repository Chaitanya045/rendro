// Each reused file makes two external S3 calls (HEAD + COPY). Leave room
// below Workers' 50-subrequest free-tier limit for auth, manifests and retries.
export const MAX_REUSED_FILES_PER_REQUEST = 16;

export const MAX_DEPLOYMENT_FILES = 1_000;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_DEPLOYMENT_BYTES = 128 * 1024 * 1024;
export const MAX_DEPLOYMENT_PATH_LENGTH = 1024;
export const MAX_MIME_LENGTH = 128;
export const MAX_MANIFEST_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_HTTP_BODY_BYTES = 64 * 1024;
export const MAX_COMMIT_LIST_PAGES = 8;

export function validDeploymentCounts(files: number, bytes: number): boolean {
  return Number.isSafeInteger(files) && files >= 0 && files <= MAX_DEPLOYMENT_FILES
    && Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= MAX_DEPLOYMENT_BYTES;
}

export function deploymentFileLimitError(path: string, size: number, contentType: string): string | null {
  if (path.length > MAX_DEPLOYMENT_PATH_LENGTH) return `Deployment paths must be at most ${MAX_DEPLOYMENT_PATH_LENGTH} characters`;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) return "Deployment files must be safe integer sizes of at most 8 MiB";
  if (contentType.length > MAX_MIME_LENGTH) return `Deployment MIME types must be at most ${MAX_MIME_LENGTH} characters`;
  return null;
}
