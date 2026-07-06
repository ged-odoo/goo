import { Component, props, t, xml } from "@odoo/owl";

// ─────────────────────────── Panel (screen header) ───────────────────────────

// The fixed-height header every screen opens with: the screen <h1> plus up to four
// slotted regions —
//   top-middle   → filters, centered on the title row (adds `has-filters`)
//   top-right    → the "updated…" stamp + Refresh button cluster
//   bottom-left  → primary actions (buttons) on the actions row
//   bottom-right → trailing info (row counts, subtitles) on the actions row
// Alignment within the actions row is carried by the slotted content's own classes
// (e.g. `.row-count` / `.dash-subtitle` already use margin-auto), so Panel adds no
// layout CSS. The middle/right/actions regions are omitted when their slots are empty.

export class Panel extends Component {
  static template = xml`
    <div class="panel">
      <div class="panel-top" t-att-class="{'has-filters': this.hasSlot('top-middle')}">
        <h1 t-out="this.props.title"/>
        <div t-if="this.hasSlot('top-middle')" class="panel-filters"><t t-slot="top-middle"/></div>
        <div t-if="this.hasSlot('top-right')" class="panel-top-right"><t t-slot="top-right"/></div>
      </div>
      <div t-if="this.hasSlot('bottom-left') or this.hasSlot('bottom-right')" class="panel-actions">
        <t t-slot="bottom-left"/>
        <t t-slot="bottom-right"/>
      </div>
    </div>`;

  props = props({
    title: t.string(),
    slots: t
      .object({
        "top-middle": t.any().optional(),
        "top-right": t.any().optional(),
        "bottom-left": t.any().optional(),
        "bottom-right": t.any().optional(),
      })
      .optional(),
  });

  hasSlot(name) {
    return name in (this.props.slots || {});
  }
}
