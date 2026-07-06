import { Component, plugin, useEffect, xml } from "@odoo/owl";
import { AddonsPlugin } from "./addons_plugin.js";
import { ICONS, LogConsole, SearchBox, m } from "../core/common.js";

export class AddonsScreen extends Component {
  static components = { LogConsole, SearchBox };
  static template = xml`
    <section>
      <div class="panel">
        <div class="panel-top has-filters">
          <h1>Addons</h1>
          <div class="panel-filters">
            <SearchBox value="this.addons.filter"/>
            <button class="pbtn" t-att-class="{active: this.addons.stateFilter() === 'installed'}" t-on-click="() => this.toggleState('installed')">Installed</button>
            <button class="pbtn" t-att-class="{active: this.addons.stateFilter() === 'uninstalled'}" t-on-click="() => this.toggleState('uninstalled')">Uninstalled</button>
            <button class="pbtn" t-att-class="{active: this.addons.appOnly()}" t-on-click="() => this.addons.appOnly.set(!this.addons.appOnly())">Apps</button>
          </div>
          <div class="panel-top-right">
            <span class="meta" t-out="this.addons.status()"/>
            <button class="pbtn" t-att-disabled="!this.addons.targetDb()" t-on-click="() => this.addons.load()"><t t-out="this.refreshIcon"/>Refresh</button>
          </div>
        </div>
        <div class="panel-actions">
          <span t-if="this.addons.targetName()" class="addons-target" t-out="this.targetLabel"/>
          <span t-if="this.addons.targetDb()" class="row-count" t-out="this.count"/>
        </div>
      </div>
      <div class="content addons-content">
        <div t-if="!this.addons.targetDb()" class="dim addons-empty">No active target — start a server to browse its addons.</div>
        <t t-else="">
          <div class="addons-grid-wrap">
            <div t-if="this.addons.loading()" class="dim addons-msg">Loading…</div>
            <div t-elif="this.addons.error()" class="dim addons-msg" t-out="'Failed to load: ' + this.addons.error()"/>
            <div t-elif="!this.view.total" class="dim addons-msg">No modules match.</div>
            <t t-else="">
              <div class="brg-table">
                <table class="br-table brg-flat">
                  <thead>
                    <tr><th>Module</th><th>Summary</th><th>Repository</th><th>State</th><th/></tr>
                  </thead>
                  <tbody>
                    <tr t-foreach="this.view.shown" t-as="mod" t-key="mod.name">
                      <td class="addon-name" t-att-title="mod.summary" t-out="mod.name"/>
                      <td class="dim"><div class="br-ellip" t-att-title="mod.summary" t-out="mod.summary || '—'"/></td>
                      <td class="dim" t-out="mod.repo"/>
                      <td><span class="addon-state" t-att-class="this.stateClass(mod)" t-out="mod.state || 'not installed'"/></td>
                      <td>
                        <div class="br-act">
                          <button class="addon-btn" t-att-disabled="this.addons.runActive() or mod.installable === false"
                                  t-on-click="() => this.addons.run(mod.state === 'installed' ? 'upgrade' : 'install', mod.name)"
                                  t-out="mod.state === 'installed' ? 'Upgrade' : 'Install'"/>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div t-if="this.view.total > this.view.shown.length" class="dim addons-more"
                   t-out="'Showing ' + this.view.shown.length + ' of ' + this.view.total + ' — refine the filter to see more.'"/>
            </t>
          </div>
          <LogConsole t-if="this.addons.runActive() or this.addons.running" title="'Install / upgrade output'" buffer="this.addons.output" extraClass="'addons-console'"/>
        </t>
      </div>
    </section>`;

  addons = plugin(AddonsPlugin);
  refreshIcon = m(ICONS.refresh);

  setup() {
    // load (and reload when the active target's db changes) while mounted
    useEffect(() => {
      const db = this.addons.targetDb();
      if (
        db &&
        db !== this.addons.loadedDb() &&
        db !== this.addons.erroredDb() &&
        !this.addons.loading()
      )
        this.addons.load();
    });
  }

  get view() {
    return this.addons.filtered();
  }

  get count() {
    const n = this.view.total;
    return `${n} module${n === 1 ? "" : "s"}`;
  }

  get targetLabel() {
    return `${this.addons.targetName()} · ${this.addons.targetDb()}`;
  }

  toggleState(value) {
    this.addons.stateFilter.set(this.addons.stateFilter() === value ? "" : value);
  }

  stateClass(mod) {
    return (mod.state || "none").replace(/\s+/g, "-");
  }
}

// ─────────────────────────── Config screen ───────────────────────────
