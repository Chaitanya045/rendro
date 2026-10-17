import { APIError } from "better-auth/api";

// Team names are display labels. A name that is empty after trimming renders as a blank heading, so reject it
// with the same fixed BAD_REQUEST shape as the organization lifecycle hook and store the trimmed value.
export function requireTeamName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new APIError("BAD_REQUEST", { message: "Team name is required." });
  return trimmed;
}

// Better Auth awaits these hooks, so a refusal must surface as a rejection.
export function beforeCreateTeam({ team }: { team: { name: string } }) {
  return Promise.resolve().then(() => ({ data: { name: requireTeamName(team.name) } }));
}

export function beforeUpdateTeam({ updates }: { updates: { name?: string } }): Promise<{ data: { name: string } } | void> {
  // A rename always carries a name; other updates leave it untouched.
  return Promise.resolve().then(() => updates.name === undefined ? undefined : { data: { ...updates, name: requireTeamName(updates.name) } });
}
