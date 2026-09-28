---
name: odoo-bootstrap-leak-audit
description: 'Use when auditing Odoo JS/Owl code (community, enterprise, or any addon) for memory leaks caused by Bootstrap 5 component instances (Carousel, Modal, Tooltip, Dropdown, etc.) never being disposed.'
---

# Bootstrap 5 component leak audit (static, grep-and-read)

A specific, recurring memory-leak anti-pattern in Odoo's JS/Owl frontend,
found and fixed multiple times already in community — worth checking any
time new frontend code (an addon, a PR, an enterprise module) is being
reviewed for memory leaks.

## The mechanism (verified against the vendored source)

Odoo vendors Bootstrap 5 at `addons/web/static/lib/bootstrap/js/dist/`.
Every component instance — `Carousel`, `Tooltip`, `Popover`, `Modal`,
`Dropdown`, `Collapse`, `ScrollSpy`, `Tab`, `Offcanvas`, `Toast`, `Alert`,
`Button` — is tracked in one page-global, **non-weak** `Map` (`dom/data.js`):

```js
const elementMap = new Map();  // keyed by the DOM element the instance is attached to
```

The **only** way an entry is ever removed is calling `.dispose()` on the
instance — internally (`base-component.js`):

```js
dispose() {
  Data.remove(this._element, this.constructor.DATA_KEY);
  ...
}
```

So `new Carousel(el)`, `Modal.getOrCreateInstance(el)`, etc. — any of these —
permanently retains `el` (and everything `el` references) in memory unless
something later calls `.dispose()` on that instance. If the creation site is
inside an Owl component's mount lifecycle, or a JS "Interaction" (Odoo's
public-page interaction framework) that runs repeatedly (every mount, every
modal/popup open, every list item added), each repetition leaks one more
element — a compounding leak, not a one-off.

Already found and fixed this way in community (context/precedent — always
re-verify against the actual checkout being audited, since fixes land on
separate branches/PRs and a given local worktree may or may not have them
all yet): `addons/pos_self_order/static/src/app/utils/carousel_hook.js`
(biggest impact — ~85% memory reduction in its own test suite),
`addons/website/static/src/snippets/s_searchbar/search_bar.js`,
`addons/website/static/src/interactions/image_popup.js` +
`addons/website/static/src/snippets/s_image_gallery/gallery.js`.

## How to audit

1. Search for direct instantiation and the factory method, across whatever
   scope you're auditing (one addon, all of enterprise, everything):

   ```bash
   grep -rnE "new (Carousel|Tooltip|Popover|Modal|Dropdown|Collapse|ScrollSpy|Tab|Offcanvas|Toast|Alert|Button)\(" <path>/static/src
   grep -rnE "\.getOrCreateInstance\(" <path>/static/src
   ```

2. For **each** hit, read the *whole file* (not just the instantiation line)
   and the enclosing Owl component / Interaction / hook:
   - Which class, and what element — a persistent one-time element (created
     once, e.g. at module scope or a top-level ref) vs. one created/destroyed
     repeatedly (every mount, every modal open, every row added/removed)?
     Repeatable creation is what turns this into a real, compounding leak; a
     genuinely one-time element still leaks, but only once.
   - Search the same file for `.dispose()`, `onWillUnmount`, `onWillDestroy`,
     `destroy()`, `registerCleanup` — is the instance actually disposed when
     its owning component/interaction tears down, or when its element is
     removed? Note: an Interaction's `this.insert(el, ...)` /
     `registerCleanup(() => el.remove())` only removes `el` from the DOM — it
     does **not** call `.dispose()` on any Bootstrap instance attached to it,
     so relying on that alone is NOT a fix.
   - Verdict: genuine leak (repeatable creation, no matching dispose) vs.
     safe (disposed correctly, or a verified one-time element).

3. Report format, ranked by confidence: file:line, class + element
   description, dispose found (y/n, where), verdict. Only report sites
   you've actually read the surrounding code for — don't guess from the
   instantiation line alone.

## Fix shape (from the community precedent)

```js
let carousel;
onMounted(() => {
  carousel = new Carousel(el);
});
onWillUnmount(() => {
  carousel?.dispose();
});
```

Same idea for a repeatedly-opened Modal/Popover/etc.: dispose it on whatever
event signals it's done (`hidden.bs.modal`, the interaction's own teardown,
`onWillDestroy`), not just remove its element from the DOM.

## Going from static to empirical

A static hit here is a *candidate*, not proof — confirm and quantify it with
the `odoo-memory-perf` skill: find or write a tour/test that exercises the
exact mount/open/close cycle around the suspected site, then run it through
goo's Tests tab "Memory check" checkbox (or that skill's own `run_check.sh`)
to diff real heap snapshots. The retained element (and the Bootstrap
instance holding it) should show up directly in memlab's retainer trace if
the leak is real.
