// The Claude tab's chat UI — the view half of claude_plugin.js (which owns the
// per-workspace transcript, model choice and send/stop wire).

import { Component, onMounted, usePlugin, useProps, signal, t, useEffect, xml } from "@odoo/owl";
import { ClaudePlugin } from "./claude_plugin.js";

export class ClaudeChat extends Component {
  static template = xml`
    <div class="cchat">
      <div class="cchat-msgs" t-ref="this.scroll">
        <div t-if="!this.items.length" class="cchat-hint dim">
          <t t-if="this.props.inMain">
            Send a task to Claude. <b>Caution:</b> it runs with full autonomy in your
            MAIN checkout — it edits the real working tree this workspace shares.
          </t>
          <t t-else="">
            Send a task to Claude. It runs in this worktree's checkout with full autonomy —
            it can edit files and run commands here without touching your main tree.
          </t>
        </div>
        <t t-foreach="this.items" t-as="m" t-key="m_index">
          <div t-if="m.role === 'user'" class="cmsg cmsg-user"><div class="cmsg-body" t-out="m.text"/></div>
          <div t-elif="m.role === 'assistant'" class="cmsg cmsg-asst"><div class="cmsg-body" t-out="m.text"/></div>
          <div t-elif="m.role === 'tool'" class="cmsg-tool">
            <span class="cmsg-tool-name" t-out="m.tool"/>
            <span t-if="m.text" class="cmsg-tool-text" t-out="m.text"/>
          </div>
          <div t-elif="m.role === 'error'" class="cmsg cmsg-error"><div class="cmsg-body" t-out="m.text"/></div>
        </t>
        <div t-if="this.running" class="cchat-working"><span class="spin"/>Claude is working…</div>
      </div>
      <div class="cchat-input">
        <div class="cchat-toolbar">
          <span class="cchat-model-label dim">Model</span>
          <select class="cchat-model" t-on-change="(ev) => this.claude.setModel(ev.target.value)">
            <option t-foreach="this.claude.models" t-as="opt" t-key="opt.value"
                    t-att-value="opt.value" t-att-selected="opt.value === this.claude.model()" t-out="opt.label"/>
          </select>
        </div>
        <div class="cchat-row">
          <textarea t-ref="this.ta" class="cchat-ta" rows="2"
                    placeholder="Describe a task —  Enter to send, Shift+Enter for a newline"
                    t-att-disabled="this.running" t-on-keydown="(ev) => this.onKey(ev)"/>
          <button t-if="!this.running" class="pbtn primary cchat-send" t-on-click="() => this.send()">Send</button>
          <button t-else="" class="pbtn stop cchat-send" t-on-click="() => this.stop()"><span class="ic square"/>Stop</button>
        </div>
      </div>
    </div>`;

  props = useProps({ target: t.any(), inMain: t.boolean().optional() });
  claude = usePlugin(ClaudePlugin);
  scroll = signal.ref(HTMLElement);
  ta = signal.ref(HTMLElement);

  setup() {
    onMounted(() => this.claude.prime(this.props.target.id));
    // follow the tail as items stream in (owl3's useEffect tracks the body itself —
    // the items/running reads below are what re-run it)
    useEffect(() => {
      (void this.items.length, this.running);
      const el = this.scroll();
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  get items() {
    return this.claude.items(this.props.target.id);
  }

  get running() {
    return this.claude.running(this.props.target.id);
  }

  onKey(ev) {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      this.send();
    }
  }

  send() {
    const el = this.ta();
    const text = el ? el.value : "";
    if (!text.trim() || this.running) return;
    this.claude.send(this.props.target, text);
    if (el) el.value = "";
  }

  stop() {
    this.claude.stop(this.props.target);
  }
}
