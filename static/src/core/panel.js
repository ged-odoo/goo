import { Component, props, t, xml } from "@odoo/owl";

// ─────────────────────────── Panel (screen header) ───────────────────────────

// The fixed-height header every screen opens with: the screen <h1> plus up to five
// slotted regions —
//   title-extra  → content inline with the <h1> (server's db/odoo info, the Tests
//                  status badge); when set, the title + extra share a `.panel-title`
//                  cluster, otherwise the <h1> is rendered bare
//   top-middle   → filters, centered on the title row (adds `has-filters`)
//   top-right    → the "updated…" stamp + Refresh button cluster
//   bottom-left  → primary actions (buttons) on the actions row
//   bottom-right → trailing info (row counts, subtitles) on the actions row
// Alignment within the actions row is carried by the slotted content's own classes
// (e.g. `.row-count` / `.dash-subtitle` already use margin-auto), so Panel adds no
// layout CSS there. The middle/right/actions regions are omitted when their slots are empty.

export class Panel extends Component {
  static template = xml`
    <div class="panel">
      <div class="panel-top" t-att-class="{'has-filters': this.hasSlot('top-middle')}">
        <div t-if="this.hasSlot('title-extra')" class="panel-title">
          <h1 t-out="this.props.title"/>
          <t t-call-slot="title-extra"/>
        </div>
        <h1 t-else="" t-out="this.props.title"/>
        <div t-if="this.hasSlot('top-middle')" class="panel-filters"><t t-call-slot="top-middle"/></div>
        <div t-if="this.hasSlot('top-right')" class="panel-top-right"><t t-call-slot="top-right"/></div>
      </div>
      <div t-if="this.hasSlot('bottom-left') or this.hasSlot('bottom-right')" class="panel-actions">
        <t t-call-slot="bottom-left"/>
        <t t-call-slot="bottom-right"/>
      </div>
    </div>`;

  props = props({
    title: t.string(),
    slots: t
      .object({
        "title-extra": t.any().optional(),
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
