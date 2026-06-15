// Bootstrap: hydrate from the server-side data file (if configured) so plugins
// read up-to-date localStorage, then mount the Owl app with all plugins.
import { App } from "./components.js";
import { PLUGINS, dataFilePath, loadDataFile } from "./plugins.js";

async function boot() {
  const path = dataFilePath();
  if (path) {
    try { await loadDataFile(path); }
    catch (e) { console.error(`[oo] data file load failed, using browser storage: ${e.message}`); }
  }
  owl.mount(App, document.getElementById("root"), { plugins: PLUGINS, dev: true });
}

boot();
