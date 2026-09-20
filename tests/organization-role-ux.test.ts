/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import vm from "node:vm";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { adminAc, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { describe, expect, it, vi } from "vitest";
import organizationPages from "@/routes/organization-pages";

const user = {
  id: "current-user",
  email: "current@example.test",
  name: "Current User",
} as User;

async function rendered(path: string): Promise<string> {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (context, next) => {
    context.set("user", user);
    await next();
  });
  app.route("/", organizationPages);
  return (await app.request(path)).text();
}

function lastInlineScript(html: string): string {
  const marker = html.lastIndexOf("<script data-cp-page-script>");
  const start = marker + "<script data-cp-page-script>".length;
  return html.slice(start, html.indexOf("</script>", start));
}

function organizationState(html: string): Record<string, string> {
  return JSON.parse(html.match(/window\.__RENDRO_PAGE_STATE__=([^;]+);/)?.[1] ?? "{}");
}

function organizationRuntime(script: string, section: string, request: (path: string, options?: any) => Promise<any>) {
  const exposed = script.replace("  load();\n})();", "  window.__roleUx={baseData:baseData,renderPeople:renderPeople,statusEmpty:statusEmpty};\n})();");
  const document = {
    getElementById: () => ({}),
    querySelectorAll: () => [],
    createElement: () => ({}),
  };
  const context: any = {
    window: {
      __RENDRO_PAGE_STATE__: { organizationId: "org-a", section, userId: user.id },
      RendroUI: { request, toast() {}, busy() {}, openDialog() {} },
    },
    document,
    Promise,
    Error,
  };
  vm.runInNewContext(exposed, context);
  return context.window.__roleUx as { baseData: () => Promise<any>; renderPeople: (data: any) => Promise<void>; statusEmpty: (mark: string, title: string, copy: string, action: string) => string };
}

class ElementMock {
  className = "";
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  dataset: Record<string, string> = {};
  children: ElementMock[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event?: any) => unknown)[]>();
  private selectors = new Map<string, ElementMock>();
  private markup = "";

  constructor(public readonly tag = "div") {}
  set innerHTML(value: string) {
    this.markup = value;
    if (this.className === "invite-entry") this.selectors.set(".remove-invite", new ElementMock("button"));
  }
  get innerHTML() { return this.markup; }
  append(...nodes: ElementMock[]) { this.children.push(...nodes); }
  remove() {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(type: string, listener: (event?: any) => unknown) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  async dispatch(type: string) { for (const listener of this.listeners.get(type) ?? []) await listener({ preventDefault() {} }); }
  querySelector(selector: string) { return this.selectors.get(selector) ?? null; }
  querySelectorAll() { return []; }
}

describe("organization role UX", () => {
  it("matches the installed Better Auth default mutation ACL", () => {
    for (const statements of [ownerAc.statements, adminAc.statements]) {
      expect(statements.organization).toContain("update");
      expect(statements.member).toContain("update");
      expect(statements.invitation).toEqual(expect.arrayContaining(["create", "cancel"]));
      expect(statements.team).toEqual(expect.arrayContaining(["create", "update", "delete"]));
    }
    expect(memberAc.statements.organization).toEqual([]);
    expect(memberAc.statements.member).toEqual([]);
    expect(memberAc.statements.invitation).toEqual([]);
    expect(memberAc.statements.team).toEqual([]);
  });

  it("injects the authenticated user id and keeps mutation actions hidden until role resolution", async () => {
    for (const path of ["/organizations/org-a", "/organizations/org-a/people", "/organizations/org-a/teams"]) {
      const html = await rendered(path);
      expect(organizationState(html).userId, path).toBe(user.id);
      expect(html, path).toMatch(/id="organization-page-action"[^>]*hidden/);
    }
    const onboarding = await rendered("/organizations/org-a/onboarding");
    expect(organizationState(onboarding).userId).toBe(user.id);
  });

  it("loads member overview and People data without requesting forbidden invitations", async () => {
    for (const section of ["overview", "people"]) {
      const html = await rendered(`/organizations/org-a${section === "overview" ? "" : "/people"}`);
      const calls: string[] = [];
      const runtime = organizationRuntime(lastInlineScript(html), section, async (path) => {
        calls.push(path);
        if (path.includes("get-full-organization")) return {
          id: "org-a", name: "Acme", slug: "acme", teams: [],
          members: [{ id: "member-a", userId: user.id, role: "member", user: { id: user.id } }],
        };
        if (path.includes("/api/rendro/projects")) return { projects: [] };
        return {};
      });
      const data = await runtime.baseData();
      expect(data.currentRole).toBe("member");
      expect(data.canManage).toBe(false);
      expect(calls.some((path) => path.includes("list-invitations"))).toBe(false);
      expect(calls.some((path) => path.includes("get-active-member"))).toBe(false);
    }
  });

  it("escapes request failures before rendering retry markup", async () => {
    const html = await rendered("/organizations/org-a/settings");
    const runtime = organizationRuntime(lastInlineScript(html), "settings", async () => ({}));
    const markup = runtime.statusEmpty(
      "error",
      "Unable to load this organization",
      '<img src=x onerror="window.compromised=true">',
      '<button id="retry">Try again</button>',
    );
    expect(markup).toContain("&lt;img src=x onerror=&quot;window.compromised=true&quot;&gt;");
    expect(markup).not.toContain("<img");
    expect(markup).toContain('<button id="retry">Try again</button>');
  });

  it("lets admins update non-owner members but never offers them the owner role", async () => {
    const html = await rendered("/organizations/org-a/people");
    expect(html).toContain('data.isOwner?["member","admin","owner"]:["member","admin"]');
    expect(html).toContain("data.isAdmin&&!targetIsOwner");
    expect(html).toContain("targetIsOwner&&ownerCount<=1&&role!==\"owner\"");
  });

  it("refreshes owner constraints and management actions after confirmed role changes", async () => {
    const html = await rendered("/organizations/org-a/people");
    const selects: ElementMock[] = [];
    const action = new ElementMock("button"); action.hidden = true; action.disabled = true;
    const elements = new Map<string, ElementMock>([
      ["organization-content", new ElementMock()], ["member-list", new ElementMock()],
      ["invitation-list", new ElementMock()], ["invite-rows", new ElementMock()],
      ["add-invite-row", new ElementMock("button")], ["invite-form", new ElementMock("form")],
      ["invite-error", new ElementMock()], ["invite-dialog", new ElementMock("dialog")],
      ["organization-page-action", action],
    ]);
    const document = {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: () => [],
      createElement: (tag: string) => {
        const element = new ElementMock(tag);
        if (tag === "select") selects.push(element);
        return element;
      },
    };
    const exposed = lastInlineScript(html).replace("  load();\n})();", "  window.__roleUx={renderPeople:renderPeople};\n})();");
    const context: any = {
      window: {
        __RENDRO_PAGE_STATE__: { organizationId: "org-a", section: "people", userId: user.id },
        RendroUI: {
          request: async (_path: string, options: { body: string }) => ({ role: JSON.parse(options.body).role }),
          toast() {}, busy() {}, openDialog() {},
        },
      },
      document,
      location: { reload: vi.fn() },
      MutationObserver: class { observe() {} },
      Promise,
      Error,
    };
    vm.runInNewContext(exposed, context);
    const data = {
      organization: {
        members: [
          { id: "owner", userId: user.id, role: "owner", user: { id: user.id, email: user.email } },
          { id: "target", userId: "target-user", role: "admin", user: { id: "target-user", email: "target@example.test" } },
        ],
      },
      invitations: [], invitationRequest: Promise.resolve({ data: [] }), canManage: true, currentRole: "owner", isOwner: true, isAdmin: false,
    };
    await context.window.__roleUx.renderPeople(data, 0);
    expect(selects[0].children.find((option) => option.value === "member")?.disabled).toBe(true);
    const inviteRows = elements.get("invite-rows")!;
    const draftRow = inviteRows.children[0];
    expect(elements.get("invite-form")!.listeners.get("submit")).toHaveLength(1);

    selects[1].value = "owner";
    await selects[1].dispatch("change");
    const refreshedOwner = selects[2];
    expect(refreshedOwner.children.find((option) => option.value === "member")?.disabled).toBe(false);
    expect(inviteRows.children[0]).toBe(draftRow);
    expect(elements.get("invite-form")!.listeners.get("submit")).toHaveLength(1);

    refreshedOwner.value = "member";
    await refreshedOwner.dispatch("change");
    expect(data.canManage).toBe(false);
    expect(action.hidden).toBe(true);
    expect(action.disabled).toBe(true);
  });

  it("reverts a failed role selection to the last server-confirmed value without reloading", async () => {
    const html = await rendered("/organizations/org-a/people");
    const script = lastInlineScript(html);
    const selects: ElementMock[] = [];
    const elements = new Map<string, ElementMock>([
      ["organization-content", new ElementMock()],
      ["member-list", new ElementMock()],
      ["invitation-list", new ElementMock()],
      ["invite-rows", new ElementMock()],
      ["add-invite-row", new ElementMock("button")],
      ["invite-form", new ElementMock("form")],
      ["invite-error", new ElementMock()],
      ["invite-dialog", new ElementMock("dialog")],
    ]);
    const document = {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: () => [],
      createElement: (tag: string) => {
        const element = new ElementMock(tag);
        if (tag === "select") selects.push(element);
        return element;
      },
    };
    const reload = vi.fn();
    const toasts: Array<[string, string | undefined]> = [];
    const exposed = script.replace("  load();\n})();", "  window.__roleUx={renderPeople:renderPeople};\n})();");
    const context: any = {
      window: {
        __RENDRO_PAGE_STATE__: { organizationId: "org-a", section: "people", userId: user.id },
        RendroUI: {
          request: async (path: string) => {
            if (path.includes("update-member-role")) throw new Error("Role update rejected");
            return {};
          },
          toast: (message: string, type?: string) => toasts.push([message, type]),
          busy() {}, openDialog() {},
        },
      },
      document,
      location: { reload },
      Promise,
      Error,
    };
    vm.runInNewContext(exposed, context);
    await context.window.__roleUx.renderPeople({
      organization: {
        members: [
          { id: "owner", userId: user.id, role: "owner", user: { id: user.id, email: user.email } },
          { id: "target", userId: "target-user", role: "admin", user: { id: "target-user", email: "target@example.test" } },
        ],
      },
      invitations: [], invitationRequest: Promise.resolve({ data: [] }), canManage: true, isOwner: true, isAdmin: false,
    }, 0);
    const targetSelect = selects[1];
    expect(targetSelect.value).toBe("admin");
    targetSelect.value = "member";
    await targetSelect.dispatch("change");
    expect(targetSelect.value).toBe("admin");
    expect(targetSelect.disabled).toBe(false);
    expect(toasts).toContainEqual(["Role update rejected", "error"]);
    expect(reload).not.toHaveBeenCalled();
  });

  it("replaces onboarding mutation forms with a member-safe access state", async () => {
    const html = await rendered("/organizations/org-a/onboarding");
    const script = lastInlineScript(html);
    const mount = new ElementMock();
    const context: any = {
      window: {
        __RENDRO_PAGE_STATE__: { organizationId: "org-a", projectId: "", userId: user.id },
        RendroUI: {
          request: async () => ({ name: "Acme", members: [{ userId: user.id, role: "member" }] }),
          busy() {}, toast() {},
        },
        addEventListener() {},
      },
      document: {
        getElementById: () => mount,
        querySelectorAll: () => [],
      },
      location: {},
      setTimeout,
      Promise,
      Error,
    };
    vm.runInNewContext(script, context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mount.innerHTML).toContain("Setup is managed by organization admins");
    expect(mount.innerHTML).not.toContain("project-form");
    expect(mount.innerHTML).not.toContain("key-form");
  });
});
