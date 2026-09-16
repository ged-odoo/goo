// Construct a Plugin subclass that has no usePlugin() dependencies without going
// through the full harness — e.g. StorePlugin, confirmed dependency-free by an
// earlier audit. Mirrors what PluginManager.startPlugin() does internally
// (new ctor(manager); plugin.setup()), with a minimal stand-in manager.
export function newPlugin(PluginClass, manager = {}) {
  const plugin = new PluginClass(manager);
  plugin.setup();
  return plugin;
}
