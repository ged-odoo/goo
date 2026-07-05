// Bootstrap: hydrate from the server-side data file (if configured) so plugins
// read up-to-date localStorage, then mount the Owl app with all plugins.
import { mount } from "@odoo/owl";
import { App } from "./components.js";
import { TerminalPlugin } from "./plugins/terminal_plugin.js";
import { ConfigPlugin, loadServerConfig } from "./plugins/config_plugin.js";
import { StorePlugin } from "./plugins/store_plugin.js";
import { RouterPlugin } from "./plugins/router_plugin.js";
import { EventLogPlugin } from "./plugins/event_log_plugin.js";
import { ServerPlugin } from "./plugins/server_plugin.js";
import { DatabasePlugin } from "./plugins/database_plugin.js";
import { CodePlugin } from "./plugins/code_plugin.js";
import { TestsPlugin } from "./plugins/tests_plugin.js";
import { AddonsPlugin } from "./plugins/addons_plugin.js";
import { AssetsPlugin } from "./plugins/assets_plugin.js";
import { ReviewPlugin } from "./plugins/review_plugin.js";
import { DialogPlugin } from "./plugins/dialog_plugin.js";
import { UpdatePlugin } from "./plugins/update_plugin.js";
import { WorktreePlugin } from "./plugins/worktree_plugin.js";
import { ClaudePlugin } from "./plugins/claude_plugin.js";
import { NightlyPlugin } from "./plugins/nightly_plugin.js";
import { MemoryPlugin } from "./plugins/memory_plugin.js";

const PLUGINS = [
  StorePlugin,
  ConfigPlugin,
  RouterPlugin,
  EventLogPlugin,
  ServerPlugin,
  DatabasePlugin,
  CodePlugin,
  TestsPlugin,
  AddonsPlugin,
  AssetsPlugin,
  ReviewPlugin,
  TerminalPlugin,
  DialogPlugin,
  UpdatePlugin,
  WorktreePlugin,
  ClaudePlugin,
  NightlyPlugin,
  MemoryPlugin,
];

async function boot() {
  // load the server-owned config before mount, so ConfigPlugin seeds from it
  await loadServerConfig();
  mount(App, document.getElementById("root"), { plugins: PLUGINS, dev: true });
}

boot();
