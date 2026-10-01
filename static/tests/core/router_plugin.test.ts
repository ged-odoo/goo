import { describe, expect, it } from "vitest";
import { RouterPlugin } from "../../src/core/router_plugin.ts";
import { NO_MANAGER } from "../helpers/plugin.ts";

// RouterPlugin has no usePlugin() dependencies, so it can be constructed
// directly without the plugin harness — its field initializer reads
// location.hash synchronously via _fromHash().
describe("RouterPlugin's hash -> section resolution (_fromHash)", () => {
  it("maps a retired section id through ALIASES to its successor", () => {
    location.hash = "#prs";
    expect(new RouterPlugin(NO_MANAGER).section()).toBe("branches");
    location.hash = "#reviews";
    expect(new RouterPlugin(NO_MANAGER).section()).toBe("branches");
    location.hash = "#dashboard";
    expect(new RouterPlugin(NO_MANAGER).section()).toBe("workspaces");
    location.hash = "#targets";
    expect(new RouterPlugin(NO_MANAGER).section()).toBe("config");
  });

  it("passes through a valid, non-aliased section id unchanged", () => {
    location.hash = "#databases";
    expect(new RouterPlugin(NO_MANAGER).section()).toBe("databases");
  });

  it("falls back to workspaces for an unknown or empty hash", () => {
    location.hash = "#not-a-real-section";
    expect(new RouterPlugin(NO_MANAGER).section()).toBe("workspaces");
    location.hash = "";
    expect(new RouterPlugin(NO_MANAGER).section()).toBe("workspaces");
  });
});
