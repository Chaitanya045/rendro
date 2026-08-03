import {
  deleteObject,
  getObjectStream,
  headObject,
  listAllKeys,
  putObject,
} from "@/minio";
import { filterDeleted } from "@/soft-delete";
import { isValidSlug } from "@/orgs";

const PUBLICATION_RECORD_PREFIX = "__rendro/publications";

export interface Publication {
  orgSlug: string;
  slug: string;
  sourcePrefix: string;
  title: string;
  entryFile: string;
  createdAt: string;
  updatedAt: string;
}

export class PublicationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "PublicationError";
  }
}

function decodeRepeatedly(value: string): string | null {
  let decoded = value;
  try {
    for (let pass = 0; pass < 3; pass++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    }
    return decoded.includes("%") ? null : decoded;
  } catch {
    return null;
  }
}

function hasUnsafeSegments(value: string): boolean {
  if (!value || value.includes("\\")) return true;
  for (const character of value) {
    if (character.charCodeAt(0) < 32) return true;
  }
  const segments = value.split("/");
  return segments.some((segment) => !segment || segment === "." || segment === "..");
}

export function normalizeSourcePrefix(orgSlug: string, value: string): string | null {
  const decoded = decodeRepeatedly(value.trim());
  if (!decoded || !decoded.startsWith(`${orgSlug}/`) || !decoded.endsWith("/")) return null;
  const relative = decoded.slice(orgSlug.length + 1, -1);
  return hasUnsafeSegments(relative) ? null : `${orgSlug}/${relative}/`;
}

export function normalizeDocumentPath(value: string): string | null {
  const decoded = decodeRepeatedly(value.trim().replace(/^\/+/, ""));
  if (!decoded || decoded.endsWith("/") || hasUnsafeSegments(decoded)) return null;
  if (!decoded.toLowerCase().endsWith(".html")) return null;
  return decoded;
}

function recordKey(orgSlug: string, slug: string): string {
  return `${PUBLICATION_RECORD_PREFIX}/${orgSlug}/${slug}.json`;
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value) text += decoder.decode(result.value, { stream: true });
  }
  return text + decoder.decode();
}

function isPublication(value: unknown): value is Publication {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.orgSlug === "string" &&
    typeof row.slug === "string" &&
    typeof row.sourcePrefix === "string" &&
    typeof row.title === "string" &&
    typeof row.entryFile === "string" &&
    typeof row.createdAt === "string" &&
    typeof row.updatedAt === "string" &&
    isValidSlug(row.orgSlug) &&
    isValidSlug(row.slug) &&
    normalizeSourcePrefix(row.orgSlug, row.sourcePrefix) === row.sourcePrefix &&
    normalizeDocumentPath(row.entryFile) === row.entryFile
  );
}

export async function getPublication(orgSlug: string, slug: string): Promise<Publication | null> {
  if (!isValidSlug(orgSlug) || !isValidSlug(slug)) return null;
  const stream = await getObjectStream(recordKey(orgSlug, slug));
  if (!stream) return null;
  try {
    const parsed: unknown = JSON.parse(await readText(stream));
    return isPublication(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function listPublications(orgSlug: string): Promise<Publication[]> {
  if (!isValidSlug(orgSlug)) return [];
  const keys = await listAllKeys(`${PUBLICATION_RECORD_PREFIX}/${orgSlug}/`);
  const rows = await Promise.all(
    keys
      .filter((key) => key.endsWith(".json"))
      .map(async (key) => {
        const slug = key.slice(key.lastIndexOf("/") + 1, -".json".length);
        return getPublication(orgSlug, slug);
      }),
  );
  return rows
    .filter((row): row is Publication => row !== null)
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

export async function listPublishedDocumentPaths(publication: Publication): Promise<string[]> {
  const keys = (await listAllKeys(publication.sourcePrefix)).filter((key) => key.endsWith(".html"));
  const visible = await filterDeleted(keys);
  return visible
    .map((key) => key.slice(publication.sourcePrefix.length))
    .filter((path) => normalizeDocumentPath(path) === path)
    .sort((left, right) => left.localeCompare(right));
}

export async function savePublication(input: {
  orgSlug: string;
  slug: string;
  sourcePrefix: string;
  title?: string;
  entryFile: string;
}): Promise<{ publication: Publication; documentCount: number }> {
  const { orgSlug } = input;
  if (!isValidSlug(orgSlug)) throw new PublicationError("Invalid organization", 400);
  const slug = input.slug.trim().toLowerCase();
  if (!isValidSlug(slug)) throw new PublicationError("Invalid public slug", 400);
  const sourcePrefix = normalizeSourcePrefix(orgSlug, input.sourcePrefix);
  if (!sourcePrefix) throw new PublicationError("Folder must be inside your organization", 400);
  const entryFile = normalizeDocumentPath(input.entryFile);
  if (!entryFile) throw new PublicationError("Entry must be a relative .html file", 400);
  if (!(await headObject(`${sourcePrefix}${entryFile}`))) {
    throw new PublicationError("Entry document was not found in that folder", 404);
  }

  const publications = await listPublications(orgSlug);
  const overlap = publications.find(
    (publication) =>
      publication.slug !== slug &&
      (publication.sourcePrefix.startsWith(sourcePrefix) || sourcePrefix.startsWith(publication.sourcePrefix)),
  );
  if (overlap) throw new PublicationError(`Folder overlaps publication "${overlap.slug}"`, 409);

  const existing = publications.find((publication) => publication.slug === slug);
  const now = new Date().toISOString();
  const publication: Publication = {
    orgSlug,
    slug,
    sourcePrefix,
    title: input.title?.trim() || slug,
    entryFile,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const documentPaths = await listPublishedDocumentPaths(publication);
  if (!documentPaths.includes(entryFile)) {
    throw new PublicationError("Entry document is deleted", 404);
  }

  await putObject(recordKey(orgSlug, slug), JSON.stringify(publication), "application/json");
  return { publication, documentCount: documentPaths.length };
}

export async function removePublication(orgSlug: string, slug: string): Promise<boolean> {
  const publication = await getPublication(orgSlug, slug);
  if (!publication) return false;
  await deleteObject(recordKey(orgSlug, slug));
  return true;
}

export function resolvePublishedKey(publication: Publication, path: string): string | null {
  const normalized = normalizeDocumentPath(path);
  if (!normalized) return null;
  const key = `${publication.sourcePrefix}${normalized}`;
  return key.startsWith(publication.sourcePrefix) ? key : null;
}
