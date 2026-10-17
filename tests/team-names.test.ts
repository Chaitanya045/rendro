import { describe, expect, it } from "vitest";
import { beforeCreateTeam, beforeUpdateTeam, requireTeamName } from "../shared/team-names";

describe("team names", () => {
  it("trims a name and rejects one that is blank or not text", () => {
    expect(requireTeamName("  Docs  ")).toBe("Docs");
    for (const value of ["", "   ", "\t\n", undefined, null, 7]) {
      expect(() => requireTeamName(value)).toThrowError(expect.objectContaining({ status: "BAD_REQUEST", body: expect.objectContaining({ message: "Team name is required." }) }));
    }
  });

  it("normalizes names when a team is created and renamed", async () => {
    await expect(beforeCreateTeam({ team: { name: " Platform " } })).resolves.toEqual({ data: { name: "Platform" } });
    await expect(beforeCreateTeam({ team: { name: "  " } })).rejects.toMatchObject({ status: "BAD_REQUEST" });
    await expect(beforeUpdateTeam({ updates: { name: " Renamed " } })).resolves.toEqual({ data: { name: "Renamed" } });
    await expect(beforeUpdateTeam({ updates: { name: "" } })).rejects.toMatchObject({ status: "BAD_REQUEST" });
    await expect(beforeUpdateTeam({ updates: {} })).resolves.toBeUndefined();
  });
});
