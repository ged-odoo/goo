// Bootstrap: hydrate from the server-side data file (if configured) so plugins
// read up-to-date localStorage, then mount the Owl app with all plugins.
import { mount } from "@odoo/owl";
import { App } from "./core/app.js";
import { TerminalPlugin } from "./core/terminal_plugin.js";
import { ConfigPlugin, loadServerConfig } from "./core/config_plugin.js";
import { StorePlugin } from "./core/store_plugin.js";
import { RouterPlugin } from "./core/router_plugin.js";
import { EventLogPlugin } from "./core/event_log_plugin.js";
import { ServerPlugin } from "./core/server_plugin.js";
import { DatabasePlugin } from "./core/database_plugin.js";
import { CodePlugin } from "./core/code_plugin.js";
import { TestsPlugin } from "./core/tests_plugin.js";
import { AddonsPlugin } from "./addons/addons_plugin.js";
import { AssetsPlugin } from "./assets/assets_plugin.js";
import { ReviewPlugin } from "./core/review_plugin.js";
import { DialogPlugin } from "./core/dialog_plugin.js";
import { UpdatePlugin } from "./core/update_plugin.js";
import { WorktreePlugin } from "./core/worktree_plugin.js";
import { ClaudePlugin } from "./worktree/claude_plugin.js";
import { NightlyPlugin } from "./nightly/nightly_plugin.js";
import { MemoryPlugin } from "./memory/memory_plugin.js";

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
