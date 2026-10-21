import { Hono } from "hono";
import type { User } from "better-auth/types";
import { refreshGitHubAccount, repoAccessBinding } from "@/github-hand-off";

const app = new Hono<{ Variables: { user?: User } }>();

/**
 * The GitHub App's setup URL (#338): GitHub sends the installer here after they installed the app, changed its
 * repositories, or asked an organization owner to approve it (`setup_action=request`). The `installation_id` GitHub
 * appends is never trusted: the reader's mirror is listed again from their own token on its next use, so it shows
 * exactly what the new installation lets them read. A signed-out installer signs in first and lands on the same home.
 */
app.get("/github/setup", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect(`/sign-in?returnTo=${encodeURIComponent("/home")}`);
  const binding = repoAccessBinding(c.env);
  if (binding) await refreshGitHubAccount(binding, user.id);
  return c.redirect(`/home?github=${c.req.query("setup_action") === "request" ? "requested" : "installed"}`);
});

export default app;
