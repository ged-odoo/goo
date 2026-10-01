// Bootstrap: hydrate from the server-side data file (if configured) so plugins
// read up-to-date localStorage, then mount the Owl app with all plugins.
import { mount } from "@odoo/owl";
import { App } from "./core/app.ts";
import { loadServerConfig } from "./core/config_plugin.ts";
import { PLUGINS } from "./plugins.ts";

async function boot() {
  // load the server-owned config before mount, so ConfigPlugin seeds from it
  await loadServerConfig();
  // static/index.html always has the #root mount point
  mount(App, document.getElementById("root")!, { plugins: PLUGINS, dev: true });
}

boot();
