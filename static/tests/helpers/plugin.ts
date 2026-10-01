// Construct a Plugin subclass that has no usePlugin() dependencies without going
// through the full harness — e.g. StorePlugin, confirmed dependency-free by an
// earlier audit. Mirrors what PluginManager.startPlugin() does internally
// (new ctor(manager); plugin.setup()), with a minimal stand-in manager.
import type { Plugin, PluginConstructor } from "@odoo/owl";

type PluginManager = ConstructorParameters<typeof Plugin>[0];

// a stand-in manager for a plugin constructed directly: one with no usePlugin()
// dependencies never reaches its manager, so an empty object is enough
export const NO_MANAGER = {} as PluginManager;

export function newPlugin<T extends PluginConstructor>(
  PluginClass: T,
  manager: PluginManager = NO_MANAGER,
): InstanceType<T> {
  const plugin = new PluginClass(manager) as InstanceType<T>; // `new T` is a T instance
  plugin.setup();
  return plugin;
}
