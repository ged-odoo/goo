import { describe, expect, it } from "vitest";
import { ORM } from "../../../vendor/owl-orm/index.ts";
import {
  RepoStatus,
  WorktreeRepoStatus,
  PrRepo,
  MergebotStatus,
  RunbotStatus,
} from "../../src/core/observed_models.js";
import { OdooServer, Run } from "../../src/core/runtime_models.js";

describe("observed_models field defaults + read/write", () => {
  it("RepoStatus: defaults + getter/setter round trip", () => {
    const orm = new ORM();
    const rec = orm.create(RepoStatus, { id: "community" });
    expect(rec.current()).toBe("");
    expect(rec.dirty()).toBe(false);
    expect(rec.error()).toBeNull();
    expect(rec.ahead()).toBe(0);

    rec.current.set("master");
    rec.dirty.set(true);
    rec.branches.set([{ name: "a" }]);
    expect(rec.current()).toBe("master");
    expect(rec.dirty()).toBe(true);
    expect(rec.branches()).toEqual([{ name: "a" }]);
    expect(orm.records(RepoStatus).map((r) => r.id)).toEqual(["community"]);
  });

  it("WorktreeRepoStatus is a separate table from RepoStatus (composite ids never collide)", () => {
    const orm = new ORM();
    orm.create(RepoStatus, { id: "community" });
    orm.create(WorktreeRepoStatus, { id: "w1:community" });
    expect(orm.records(RepoStatus)).toHaveLength(1);
    expect(orm.records(WorktreeRepoStatus)).toHaveLength(1);
    expect(orm.records(WorktreeRepoStatus)[0].id).toBe("w1:community");
  });

  it("PrRepo carries a json prs array", () => {
    const orm = new ORM();
    const rec = orm.create(PrRepo, { id: "community", github: "odoo/odoo" });
    expect(rec.prs()).toBeNull();
    rec.prs.set([{ number: 1, state: "open" }]);
    expect(rec.prs()).toEqual([{ number: 1, state: "open" }]);
  });

  it("MergebotStatus keyed by 'github#number'", () => {
    const orm = new ORM();
    const rec = orm.create(MergebotStatus, { id: "odoo/odoo#1", state: "merged" });
    expect(rec.state()).toBe("merged");
    expect(rec.detail()).toBeNull();
  });

  it("RunbotStatus keyed by branch name", () => {
    const orm = new ORM();
    const rec = orm.create(RunbotStatus, { id: "master-x", status: "success" });
    expect(rec.status()).toBe("success");
  });
});

describe("runtime_models", () => {
  it("OdooServer/Run carry an opaque json data field, orm.delete() removes from records()", () => {
    const orm = new ORM();
    const server = orm.create(OdooServer, { id: "main", data: { state: "running" } });
    expect(server.data()).toEqual({ state: "running" });

    const run = orm.create(Run, { id: "r1", data: { state: "running" } });
    expect(orm.records(Run)).toHaveLength(1);
    orm.delete(run);
    expect(orm.records(Run)).toHaveLength(0);
    // getById still finds the dead record (see store_plugin.js's `_live` comment on
    // exactly this: delete() leaves table.datapoints[id] in place, so getById is
    // unsafe for "is this still active" checks — records()/activeRecords is not)
    expect(orm.getById(Run, "r1")).not.toBeNull();
  });
});
