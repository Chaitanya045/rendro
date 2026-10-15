/** Anonymous presentation metadata. Never add stored records to these DTOs. */
export type PublicPublication = {
  publication: { slug: string; entryFile: string; title: string };
};
export type PublicShare = {
  grant: { documentPath: string; expiresAt: number };
  project: { name: string };
};

/** Only returned over the signed Worker boundary; storage prefixes stay private. */
export type WorkerPublication = PublicPublication & {
  publication: PublicPublication["publication"] & { pathPrefix: string };
  deployment: { manifestKey: string };
};
export type WorkerShare = PublicShare & { deployment: { manifestKey: string } };

export function publicPublication(result: WorkerPublication): PublicPublication {
  return { publication: {
    slug: result.publication.slug,
    entryFile: result.publication.entryFile,
    title: result.publication.title,
  } };
}
export function publicShare(result: WorkerShare): PublicShare {
  return {
    grant: { documentPath: result.grant.documentPath, expiresAt: result.grant.expiresAt },
    project: { name: result.project.name },
  };
}
