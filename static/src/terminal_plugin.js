const { Plugin, signal } = owl;

export class TerminalPlugin extends Plugin {
  open = signal(false);
  toggle() {
    this.open.set(!this.open());
  }
}
