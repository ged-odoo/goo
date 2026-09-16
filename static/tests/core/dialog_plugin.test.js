import { describe, it, expect } from "vitest";
import { DialogPlugin } from "../../src/core/dialog_plugin.js";

// bookkeeping only — the `Dialog`/`DialogContainer` xml components need a real
// DOM mount and are out of scope (see CLAUDE.md's Owl-3-early-release note).
function start() {
  const plugin = new DialogPlugin({});
  // Plugin's own setup() calls useApp(), which needs a real scope -- skip it here
  // since we're only exercising add()/openComponent()/open()/error()'s bookkeeping,
  // none of which touch this.root or the mount effect.
  return plugin;
}

describe("DialogPlugin bookkeeping", () => {
  it("add() appends a dialog entry with a unique id and a working close()", () => {
    const plugin = start();
    const FakeComponent = () => {};
    const handle = plugin.add(FakeComponent, { foo: 1 });
    expect(plugin.dialogs()).toEqual([
      { id: handle.id, Component: FakeComponent, props: { foo: 1 } },
    ]);
    handle.close();
    expect(plugin.dialogs()).toEqual([]);
  });

  it("add() assigns increasing ids across calls, stacking multiple open dialogs", () => {
    const plugin = start();
    const A = () => {};
    const B = () => {};
    const h1 = plugin.add(A);
    const h2 = plugin.add(B);
    expect(h2.id).toBeGreaterThan(h1.id);
    expect(plugin.dialogs().map((d) => d.id)).toEqual([h1.id, h2.id]);
    h1.close();
    expect(plugin.dialogs().map((d) => d.id)).toEqual([h2.id]);
  });

  it("openComponent() resolves the promise with the value passed to `done`, then closes", async () => {
    const plugin = start();
    const FakeComponent = () => {};
    const promise = plugin.openComponent(FakeComponent, { x: 1 });
    expect(plugin.dialogs().length).toBe(1);
    const { done } = plugin.dialogs()[0].props;
    done("the result");
    await expect(promise).resolves.toBe("the result");
    expect(plugin.dialogs()).toEqual([]);
  });

  it("open() builds a Dialog dialog from the spec and resolves however `done` is called", async () => {
    const plugin = start();
    const promise = plugin.open({ title: "Confirm?" });
    const dialogEntry = plugin.dialogs()[0];
    expect(dialogEntry.props.spec).toEqual({ title: "Confirm?" });
    dialogEntry.props.done(null); // discarded/escaped
    await expect(promise).resolves.toBeNull();
  });

  it("error() builds the standard error-modal spec (OK only, red header)", async () => {
    const plugin = start();
    const promise = plugin.error("Oops", "Something broke");
    const spec = plugin.dialogs()[0].props.spec;
    expect(spec).toEqual({
      title: "Oops",
      message: "Something broke",
      cls: "dialog-error",
      okLabel: "OK",
      cancelLabel: null,
    });
    plugin.dialogs()[0].props.done({});
    await promise;
  });
});
