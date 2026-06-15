// Bootstrap: hydrate from the server-side data file (if configured) so plugins
// read up-to-date localStorage, then mount the Owl app with all plugins.
import { App } from "./components.js";
import { ConfigPlugin, dataFilePath, loadDataFile } from "./config_plugin.js";
import { RouterPlugin } from "./router_plugin.js";
import { ServerPlugin } from "./server_plugin.js";
import { DatabasePlugin } from "./database_plugin.js";
import { CodePlugin } from "./code_plugin.js";
import { TestsPlugin } from "./tests_plugin.js";
import { AddonsPlugin } from "./addons_plugin.js";

const PLUGINS = [
  ConfigPlugin,
  RouterPlugin,
  ServerPlugin,
  DatabasePlugin,
  CodePlugin,
  TestsPlugin,
  AddonsPlugin,
];

async function boot() {
  const path = dataFilePath();
  if (path) {
    try {
      await loadDataFile(path);
    } catch (e) {
      console.error(`[goo] data file load failed, using browser storage: ${e.message}`);
    }
  }
  owl.mount(App, document.getElementById("root"), { plugins: PLUGINS, dev: true });
}

boot();
