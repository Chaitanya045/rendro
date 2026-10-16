import type { FunctionArgs } from "convex/server";
import type { TestConvex } from "convex-test";
import type schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import { cleanPublicationPath } from "../../shared/v2-paths";
import { signStorageValidation } from "../../shared/storage-attestation";

type Backend = TestConvex<typeof schema>;
type Commit = FunctionArgs<typeof internal.deployments.commitInternal>;
type Publication = FunctionArgs<typeof internal.publicationsV2.createInternal>;

// Fixture-only substitute for Worker storage verification. Security tests call
// the real HTTP/Worker routes and never use these helpers to admit requests.
export async function commitWithProof(backend: Backend, args: Commit) {
  const attestation = await commitProof(backend, args);
  return backend.mutation(internal.deployments.commitInternal, { ...args, attestation });
}
export async function commitProof(backend: Backend, args: Pick<Commit, "deploymentId">) {
  const deployment = await backend.run(ctx => ctx.db.get(ctx.db.normalizeId("deployments", args.deploymentId)!));
  return deployment ? signStorageValidation({ purpose: "deployment-commit", ...deployment, deploymentId: deployment._id }, process.env.CONVEX_INTERNAL_SECRET!) : undefined;
}
export async function publicationProof(backend: Backend, args: Omit<Publication, "actorId" | "slug">) {
  const project = await backend.run(ctx => ctx.db.get(ctx.db.normalizeId("projects", args.projectId)!));
  const deploymentId = args.trackingMode === "pinned" ? args.pinnedDeploymentId : project?.activeDeploymentId;
  const deployment = deploymentId ? await backend.run(ctx => ctx.db.get(ctx.db.normalizeId("deployments", deploymentId)!)) : null;
  return deployment ? signStorageValidation({
    purpose: "publication-entry", ...deployment, deploymentId: deployment._id,
    pathPrefix: cleanPublicationPath(args.pathPrefix, true)!, entryFile: cleanPublicationPath(args.entryFile, false)!, trackingMode: args.trackingMode,
  }, process.env.CONVEX_INTERNAL_SECRET!) : undefined;
}
export async function publishWithProof(backend: Backend, args: Publication) {
  return backend.mutation(internal.publicationsV2.createInternal, { ...args, attestation: await publicationProof(backend, args) });
}

type Share = FunctionArgs<typeof internal.shareGrants.createInternal>;
export async function shareProof(backend: Backend, args: Pick<Share, "projectId" | "documentPath" | "assetPaths">) {
  const project = await backend.run(ctx => ctx.db.get(ctx.db.normalizeId("projects", args.projectId)!));
  const deployment = project?.activeDeploymentId ? await backend.run(ctx => ctx.db.get(project.activeDeploymentId!)) : null;
  return deployment ? signStorageValidation({
    purpose: "share-assets", ...deployment, deploymentId: deployment._id,
    documentPath: args.documentPath, assetPaths: args.assetPaths ?? [],
  }, process.env.CONVEX_INTERNAL_SECRET!) : undefined;
}
export async function shareWithProof(backend: Backend, args: Share) {
  return backend.mutation(internal.shareGrants.createInternal, { ...args, assetPaths: args.assetPaths ?? [], attestation: await shareProof(backend, args) });
}
