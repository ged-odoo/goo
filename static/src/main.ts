// Bootstrap: hydrate from the server-side data file (if configured) so plugins
// read up-to-date localStorage, then mount the Owl app with all plugins.
import { mount } from "@odoo/owl";
import { App } from "./core/app.ts";
import { TerminalPlugin } from "./core/terminal_plugin.ts";
import { ConfigPlugin, loadServerConfig } from "./core/config_plugin.ts";
import { StorePlugin } from "./core/store_plugin.ts";
import { RouterPlugin } from "./core/router_plugin.ts";
import { EventLogPlugin } from "./core/event_log_plugin.ts";
import { ServerPlugin } from "./core/server_plugin.ts";
import { DatabasePlugin } from "./core/database_plugin.ts";
import { CodePlugin } from "./core/code_plugin.ts";
import { TestsPlugin } from "./core/tests_plugin.ts";
import { AddonsPlugin } from "./addons_screen/addons_plugin.ts";
import { AssetsPlugin } from "./assets_screen/assets_plugin.ts";
import { DialogPlugin } from "./core/dialog_plugin.ts";
import { UpdatePlugin } from "./core/update_plugin.ts";
import { WorkspacePlugin } from "./core/workspace_plugin.ts";
import { ClaudePlugin } from "./workspaces_screen/claude_plugin.ts";
import { NightlyPlugin } from "./nightly_screen/nightly_plugin.ts";
import { MemoryPlugin } from "./memory_screen/memory_plugin.ts";
import { CiPlugin } from "./ci_screen/ci_plugin.ts";
import { ReviewsPlugin } from "./reviews_screen/reviews_plugin.ts";

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
  TerminalPlugin,
  DialogPlugin,
  UpdatePlugin,
  WorkspacePlugin,
  ClaudePlugin,
  NightlyPlugin,
  MemoryPlugin,
  CiPlugin,
  ReviewsPlugin,
];

async function boot() {
  // load the server-owned config before mount, so ConfigPlugin seeds from it
  await loadServerConfig();
  mount(App, document.getElementById("root"), { plugins: PLUGINS, dev: true });
}

boot();
