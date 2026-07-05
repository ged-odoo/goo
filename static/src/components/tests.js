import { Component, plugin, signal, xml } from "@odoo/owl";
import { ConfigPlugin } from "../plugins/config_plugin.js";
import { ServerPlugin } from "../plugins/server_plugin.js";
import { TestsPlugin } from "../plugins/tests_plugin.js";
import { ICONS, LogConsole, m } from "./common.js";

export class TestsScreen extends Component {
  static components = { LogConsole };
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top"><div class="test-title"><h1>Tests</h1><span t-if="this.badge" class="test-badge" t-att-class="this.badge.cls" t-out="this.badge.label"/></div></div>
        <div class="panel-actions">
          <form class="test-form" t-on-submit.prevent="() => this.run()">
            <select class="preset-select" t-on-change="(ev) => this.onPreset(ev)" title="presets and recent test tags">
              <option value="" selected="selected" hidden="hidden">Presets</option>
              <optgroup t-if="this.presets.length" label="Presets">
                <option t-foreach="this.presets" t-as="p" t-key="p_index" t-att-value="p.tags" t-out="p.tags"/>
              </optgroup>
              <optgroup t-if="this.tests.history().length" label="Recent">
                <option t-foreach="this.tests.history()" t-as="h" t-key="h_index" t-att-value="h" t-out="h"/>
              </optgroup>
            </select>
            <input type="text" t-att-value="this.tags()" t-on-input="ev => this.tags.set(ev.target.value)" autocomplete="off"
                   placeholder="--test-tags, e.g. my_module, :TestClass, /module_tour"/>
            <button type="button" class="tool-btn" t-att-disabled="!this.tags().trim()"
                    title="Copy a 'goo --test-tags …' command for these tags — run it on this machine (e.g. hand it to an agent) to run the test from the CLI"
                    t-on-click="() => this.copyCommand()"><t t-out="this.copyIcon"/></button>
            <button type="submit" t-att-disabled="!this.tests.target or this.tests.runActive() or !this.tags().trim()"><span class="play"/>Run</button>
            <button type="button" class="stop" t-att-disabled="!this.tests.running" t-on-click="() => this.server.stop()"><span class="ic square"/>Stop</button>
            <div class="log-controls">
              <label class="toggle" t-att-class="{on: this.tests.output.autoScroll()}" t-on-click="() => this.toggleAuto()"><span class="switch"/>Autoscroll</label>
              <button type="button" class="tool-btn" t-on-click="() => this.tests.output.clear()"><t t-out="this.clearIcon"/>Clear</button>
            </div>
          </form>
        </div>
      </div>
      <div class="content flush tests-content">
        <div t-if="!this.tests.output.count() and !this.tests.runActive()" class="tests-empty">
          <p class="tests-empty-title">No test output yet</p>
          <p class="tests-empty-hint">Pick a preset or type <code>--test-tags</code> above, then hit <strong>Run</strong> to launch a test on the active target.</p>
        </div>
        <LogConsole title="'Test output'" buffer="this.tests.output" bare="true"/>
      </div>
    </section>`;

  tests = plugin(TestsPlugin);
  server = plugin(ServerPlugin);
  config = plugin(ConfigPlugin);
  clearIcon = m(ICONS.clear);
  copyIcon = m(ICONS.copy);
  tags = signal("");

  // configured test-tag presets (Configuration tab), non-empty only
  get presets() {
    return (this.config.config.test_presets || []).filter((p) => (p.tags || "").trim());
  }

  // copy a `goo --test-tags …` command for the current tags (single-quoted so the
  // shell doesn't mangle globs); an agent can run it to run this test from the CLI
  copyCommand() {
    const tags = this.tags().trim();
    if (!tags) return;
    navigator.clipboard?.writeText(`goo --test-tags '${tags.replace(/'/g, "'\\''")}'`);
  }

  // a compact result chip shown next to the title, replacing the old status text
  get badge() {
    const s = this.tests.status();
    if (s === "passed") return { label: "success", cls: "ok" };
    if (s.startsWith("failed")) return { label: "fail", cls: "fail" };
    if (s === "running…" || s === "starting…") return { label: "running", cls: "run" };
    return null;
  }

  run() {
    this.tests.run(this.tags());
  }

  // fill the input from the preset/recent menu, then reset it back to "Presets"
  onPreset(ev) {
    const v = ev.target.value;
    ev.target.value = "";
    if (v) this.tags.set(v);
  }

  toggleAuto() {
    const b = this.tests.output;
    b.autoScroll.set(!b.autoScroll());
    if (b.autoScroll()) b.toBottom();
  }
}

// ─────────────────────────── Assets screen ───────────────────────────

// One node of the bundle-analysis tree: a path segment (folder) or a leaf file,
// with its aggregated minified size. Recursive — expands to its children, which
// are sorted largest-first by the screen. Top-level (depth 0) nodes open by default.
