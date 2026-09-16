import { describe, expect, it } from "vitest";
import { RouterPlugin } from "../../src/core/router_plugin.js";

// RouterPlugin has no usePlugin() dependencies, so it can be constructed
// directly without the plugin harness — its field initializer reads
// location.hash synchronously via _fromHash().
describe("RouterPlugin's hash -> section resolution (_fromHash)", () => {
  it("maps a retired section id through ALIASES to its successor", () => {
    location.hash = "#prs";
    expect(new RouterPlugin({}).section()).toBe("branches");
    location.hash = "#reviews";
    expect(new RouterPlugin({}).section()).toBe("branches");
    location.hash = "#dashboard";
    expect(new RouterPlugin({}).section()).toBe("workspaces");
    location.hash = "#targets";
    expect(new RouterPlugin({}).section()).toBe("config");
  });

  it("passes through a valid, non-aliased section id unchanged", () => {
    location.hash = "#databases";
    expect(new RouterPlugin({}).section()).toBe("databases");
  });

  it("falls back to workspaces for an unknown or empty hash", () => {
    location.hash = "#not-a-real-section";
    expect(new RouterPlugin({}).section()).toBe("workspaces");
    location.hash = "";
    expect(new RouterPlugin({}).section()).toBe("workspaces");
  });
});
