import { Plugin, signal } from "@odoo/owl";

export class TerminalPlugin extends Plugin {
  open = signal(false);
  toggle() {
    this.open.set(!this.open());
  }
}
