import { Hono } from "hono";
import type { User } from "better-auth/types";
import { signInMethods } from "@/config";
import { renderLandingPage } from "@/routes/landing";

const app = new Hono<{ Variables: { user?: User } }>();

/** The public root is the product landing page; a signed-in reader goes to their home (#286). */
app.get("/", (c) => {
  const user = c.get("user");
  if (!user) {
    return c.html(renderLandingPage({ github: signInMethods().github }));
  }

  return c.redirect("/home");
});

// ----- HTML renderers -----

/** Comments on repository docs (#254): the trusted shell's repository, where it asks for access, and Convex. */
export interface RepoCommentConfig {
  repoId: number;
  accessUrl: string;
  convexUrl: string;
  /** The document the shell opens with: its first comments come with the first access answer (#284). */
  documentPath?: string;
}

/** The repository docs shell (`/r/{owner}/{repo}`): sidebar tree and search, the sandboxed document frame, comments. */
export interface ScopedDocumentShellOptions {
  namespace: string;
  title: string;
  /** The URL readers share and the tree's links name (a branch view keeps its branch). */
  basePath: string;
  /** Frames and tree pages load from here (a branch view pins its commit). */
  frameBase: string;
  selectedPath: string;
  repoCommentConfig: RepoCommentConfig;
  /** A private repository's frames load images through tickets only the shell may renew: the parent viewer, at the frames' base (#293). */
  privateViewerBase?: string;
  /** Real-user monitoring (#282), on the shell the read path serves. */
  monitoring?: boolean;
}

export { renderScopedDocumentShell } from "./shell";

export default app;
