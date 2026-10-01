// `PluginManager` itself isn't part of the curated @odoo/owl surface (app code
// never needs it directly) — but `App` is, and its constructor already builds a
// real `pluginManager` without mounting anything to a DOM. Using `App` here keeps
// this harness on owl's actual public API instead of reaching into an unexported
// internal class.
//
// Lets a test pre-seed fake sibling-plugin instances before starting the plugin
// under test, so its usePlugin(X) field initializers resolve without a full live
// Owl app. A plugin with no usePlugin() calls (e.g. StorePlugin) can be `new`'d
// directly — no harness needed.
export function createPluginHarness(overrides = []) {
  const app = new globalThis.owl.App({});
  const manager = app.pluginManager;
  for (const [PluginClass, fakeInstance] of overrides) {
    manager.plugins[PluginClass.id] = fakeInstance;
  }
  return {
    // manager.startPlugin() alone does NOT push the plugin-manager scope onto
    // owl's internal scope stack (only startPlugins()'s batching does) — a
    // plugin whose field initializers call usePlugin(X) would hit "No active
    // scope". Scope.run() (PluginManager extends Scope) pushes/pops around the
    // call, matching what startPlugins()'s own startBatch does internally.
    start(PluginClass) {
      return manager.run(() => manager.startPlugin(PluginClass));
    },
  };
}
