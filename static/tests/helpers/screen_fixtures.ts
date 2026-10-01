// DOM helpers for the screen tests that drive the mounted app (see app.ts): find
// buttons by their text, type into inputs, answer the open dialog, and wait on a
// condition with a deadline (for the debounced config save).
import { vi } from "vitest";
import type { BackendCall, MountedApp } from "./app.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/core/config.ts";

// the first element matching `selector` whose text contains `text`
export function byText<T extends HTMLElement = HTMLButtonElement>(
  root: ParentNode,
  text: string,
  selector = "button",
): T {
  const el = [...root.querySelectorAll<T>(selector)].find((b) => b.textContent?.includes(text));
  if (!el) throw new Error(`no ${selector} with text "${text}"`);
  return el;
}

// set an input/textarea's value as the user typing would, firing input (+ change)
export function type(el: HTMLInputElement | HTMLTextAreaElement, value: string, change = true) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  if (change) el.dispatchEvent(new Event("change", { bubbles: true }));
}

// tick/untick a checkbox (or pick a radio) as a click would
export function check(el: HTMLInputElement, checked = true) {
  el.checked = checked;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// the open dialog (the topmost one), or null
export function dialog(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(".dialog");
  return all.length ? all[all.length - 1] : null;
}

// click the open dialog's primary (OK) or secondary (Discard/Cancel) button
export async function answer(app: MountedApp, ok: boolean): Promise<void> {
  const d = dialog();
  if (!d) throw new Error("no dialog open");
  const btn = d.querySelector<HTMLButtonElement>(
    ok ? ".dialog-foot .pbtn.primary" : ".dialog-foot .pbtn:not(.primary)",
  )!;
  btn.click();
  await app.settle();
}

// wait (bounded by `ms`) until `cond()` holds — for timers like the 250ms
// debounced config save, which settle() alone doesn't outlast
export async function until(app: MountedApp, cond: () => unknown, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until(): condition not met before the deadline");
    await new Promise((r) => setTimeout(r, 10));
    await app.settle();
  }
}

// dispatch a left-button pointer event at (x, y) — on `target`, or on window (where
// the shared row drag listens for move/up)
export function pointer(
  type: "pointerdown" | "pointermove" | "pointerup",
  x: number,
  y: number,
  target: EventTarget = window,
): void {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }),
  );
}

// give an element a layout box (jsdom lays nothing out: every rect is all zeros)
export function setRect(
  el: Element,
  { left = 0, top = 0, width = 100, height = 20 }: Partial<DOMRect>,
): void {
  const r = {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
  };
  el.getBoundingClientRect = () => ({ ...r, toJSON: () => r }) as DOMRect;
}

// a config POST as the server receives it
export interface ConfigSave {
  rev: number;
  config?: Config;
  state?: Record<string, unknown>;
}

// a fake /api/config that behaves like the real one: GET serves {rev, config, state},
// a POST with the current rev is stored (rev + 1), a stale rev answers 409
export function configBackend(config: Partial<Config> = {}, state: Record<string, unknown> = {}) {
  let rev = 1;
  const saves: ConfigSave[] = [];
  const route = (body: unknown, call: BackendCall): unknown => {
    if (call.method !== "POST")
      return { ok: true, rev, config: { ...DEFAULT_CONFIG, ...config }, state };
    const save = body as ConfigSave;
    if (save.rev !== rev)
      return new Response(JSON.stringify({ ok: false, rev, error: "stale" }), { status: 409 });
    saves.push(save);
    rev += 1;
    return { ok: true, rev };
  };
  return {
    route,
    saves,
    rev: (): number => rev,
    // the last config the server stored
    last: (): ConfigSave => saves[saves.length - 1],
  };
}

// run a synchronous user action with the clock faked, then fire every timer it
// scheduled (e.g. the 250ms debounced config save) at once — returns how many
// config saves that sent, so a test can prove an edit saved nothing without waiting
export function savesFrom(app: MountedApp, act: () => void): number {
  const posts = () => app.callsTo("/api/config").filter((c) => c.method === "POST").length;
  const before = posts();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    act();
    vi.advanceTimersByTime(5000);
  } finally {
    vi.useRealTimers();
  }
  return posts() - before;
}
