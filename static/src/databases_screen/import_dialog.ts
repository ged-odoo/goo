import { Component, computed, onWillUnmount, signal, t, useProps, xml } from "@odoo/owl";
import type { Type } from "@odoo/owl";
import { errorMessage, postJSON } from "../core/utils.ts";
import { dumpLabel } from "../core/database_plugin.ts";
import type { RunbotDump } from "../core/database_plugin.ts";

// what ImportDatabaseDialog resolves with (null when discarded)
export type ImportPick = { name: string; cleanup: string[] } & (
  { source: "runbot"; url: string } | { source: "file"; file: File }
);

const OTHER = "__other__"; // the version select's "another bundle…" entry

// the post-restore steps (backend RESTORE_CLEANUPS), all ticked by default
const CLEANUPS = [
  { key: "crons", label: "Disable scheduled actions (crons)" },
  { key: "assets", label: "Clear cached asset bundles" },
  { key: "admin", label: "Log in as admin/admin (every password = its login)" },
];

// a database name built from free text: invalid characters become "-"
function dbName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
}

// "Import database": restore a runbot build's dump (a starred version, or any
// bundle found through runbot's search; Enterprise or Community; the base or the
// full "all" database) or a local dump file (.zip / .sql.gz, e.g. an odoo.sh
// backup) into a new database. The runbot dump picked is the one of the bundle's
// newest batch that still has it (backend RunbotService.bundle_dumps).
export class ImportDatabaseDialog extends Component {
  static template = xml`
    <div class="dialog-backdrop" t-on-click="() => this.done(null)">
      <div class="dialog" t-on-click.stop="() => {}">
        <h2 class="dialog-title">Import database</h2>
        <div class="dialog-body" data-form-type="other">
          <div class="dialog-field">
            <label>Source</label>
            <select class="imp-source" t-att-value="this.source()" t-on-change="(ev) => this.source.set(ev.target.value)">
              <option value="runbot" t-att-selected="this.source() === 'runbot'">Runbot build</option>
              <option value="file" t-att-selected="this.source() === 'file'">Dump file (.zip / .sql.gz)</option>
            </select>
          </div>
          <t t-if="this.source() === 'runbot'">
            <div class="dialog-field">
              <label>Version</label>
              <div t-if="!this.version()" class="dim">loading runbot versions…</div>
              <select t-else="" class="imp-version" t-on-change="(ev) => this.pickVersion(ev.target.value)">
                <option t-foreach="this.versionOptions()" t-as="o" t-key="o.value" t-att-value="o.value" t-att-selected="this.version() === o.value" t-out="o.label"/>
              </select>
              <div t-if="this.versionsError()" class="dialog-field-hint imp-versions-error" t-out="this.versionsError()"/>
            </div>
            <div t-if="this.version() === this.OTHER" class="dialog-field">
              <label>Bundle</label>
              <input type="text" class="imp-bundle" list="imp-bundles" placeholder="search runbot bundles…"
                     t-att-value="this.query()"
                     t-on-input="(ev) => this.onSearch(ev.target.value)"
                     t-on-change="(ev) => this.pickBundle(ev.target.value)"/>
              <datalist id="imp-bundles">
                <option t-foreach="this.matches()" t-as="b" t-key="b" t-att-value="b"/>
              </datalist>
            </div>
            <div class="dialog-field">
              <label>Edition</label>
              <select class="imp-edition" t-att-value="this.edition()" t-on-change="(ev) => this.edition.set(ev.target.value)">
                <option value="enterprise" t-att-selected="this.edition() === 'enterprise'">Enterprise</option>
                <option value="community" t-att-selected="this.edition() === 'community'">Community</option>
              </select>
            </div>
            <div class="dialog-field">
              <label>Data</label>
              <select class="imp-data" t-att-value="this.data()" t-on-change="(ev) => this.data.set(ev.target.value)">
                <option value="all" t-att-selected="this.data() === 'all'">Full (all modules)</option>
                <option value="base" t-att-selected="this.data() === 'base'">Base</option>
              </select>
              <div class="dialog-field-hint imp-dump" t-out="this.dumpHint()"/>
            </div>
          </t>
          <div t-else="" class="dialog-field">
            <label>Dump file</label>
            <input type="file" class="imp-file" accept=".zip,.gz" t-on-change="(ev) => this.file.set(ev.target.files[0] || null)"/>
          </div>
          <div class="dialog-field">
            <label>Database name</label>
            <input type="text" class="imp-name" t-att-value="this.name()" t-att-placeholder="this.defaultName()"
                   t-on-input="(ev) => this.typedName.set(ev.target.value)"/>
          </div>
          <div class="dialog-field">
            <label t-foreach="this.CLEANUPS" t-as="c" t-key="c.key" class="edit-check">
              <input type="checkbox" t-att-checked="this.cleanup().includes(c.key)" t-on-change="(ev) => this.toggleCleanup(c.key, ev.target.checked)"/>
              <t t-out="c.label"/>
            </label>
          </div>
        </div>
        <div class="dialog-foot">
          <span t-if="this.error()" class="form-error" t-out="this.error()"/>
          <button class="pbtn primary" t-att-disabled="!this.ready()" t-on-click="() => this.ok()">Import</button>
          <button class="pbtn" t-on-click="() => this.done(null)">Discard</button>
        </div>
      </div>
    </div>`;

  props = useProps({
    done: t.function<[ImportPick | null], void>(),
    // the screen's database-name check ("" when the name is usable)
    badName: t.any() as Type<(name: string) => string>,
  });

  OTHER = OTHER;
  CLEANUPS = CLEANUPS;
  source = signal<string>("runbot");
  versions = signal<string[]>([]); // runbot's starred series, newest first
  versionsError = signal("");
  version = signal(""); // a starred version, or OTHER
  other = signal(""); // the bundle picked under "Another bundle…"
  query = signal(""); // what's typed in its search input (picked on change)
  matches = signal<string[]>([]); // runbot's search results for the typed bundle name
  edition = signal<string>("enterprise");
  data = signal<string>("all");
  dumps = signal<RunbotDump[] | null>([]); // the bundle's dumps; null while looking them up
  file = signal<File | null>(null);
  typedName = signal<string | null>(null); // null until the user types a name
  cleanup = signal<string[]>(CLEANUPS.map((c) => c.key));
  _timer?: ReturnType<typeof setTimeout>;
  _bundle = ""; // the bundle whose dumps are being looked up (drops stale replies)

  // the version select's options: the starred versions, then "Another bundle…"
  versionOptions = computed(() => [
    ...this.versions().map((v) => ({ value: v, label: v })),
    { value: OTHER, label: "Another bundle…" },
  ]);

  // the runbot bundle the form currently points at ("" when none yet)
  bundle = computed(() => (this.version() === OTHER ? this.other() : this.version()));

  // the dump matching the edition + data choices, from that edition's Run build
  dump = computed(() =>
    (this.dumps() || []).find(
      (d) =>
        d.db === this.data() &&
        /\brun\b/i.test(d.slot) &&
        d.slot.toLowerCase().includes(this.edition()),
    ),
  );

  defaultName = computed(() => {
    if (this.source() === "file")
      return dbName(this.file()?.name.replace(/\.(zip|sql\.gz|gz)$/i, "") || "");
    const bundle = this.bundle();
    return bundle
      ? dbName(`${bundle}-${this.edition() === "enterprise" ? "ent" : "com"}-${this.data()}`)
      : "";
  });

  name = computed(() => this.typedName() ?? this.defaultName());

  dumpHint = computed(() => {
    if (!this.bundle()) return "";
    if (this.dumps() === null) return "looking up the bundle's dumps…";
    const d = this.dump();
    if (!d) return `no ${this.edition()} ${this.data()} dump in the bundle's latest batches`;
    return `${dumpLabel(d)}, build ${d.build}`;
  });

  error = computed(() => {
    if (this.source() === "file") {
      const file = this.file();
      if (!file) return "choose a dump file";
      if (!/\.(zip|sql\.gz)$/i.test(file.name))
        return "only .zip and .sql.gz dumps can be imported";
    } else if (this.dumps() === null) {
      return ""; // still looking: the hint says so, and `ready` keeps Import off
    } else if (!this.dump()) {
      return this.bundle() ? "no dump to import" : "choose a version";
    }
    return this.props.badName(this.name().trim());
  });

  // the form can be submitted: valid, and not waiting on runbot for the dumps
  ready = computed(() => !this.error() && (this.source() === "file" || this.dumps() !== null));

  setup(): void {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.done(null);
    };
    document.addEventListener("keydown", onKey);
    onWillUnmount(() => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(this._timer);
    });
    this._loadVersions();
  }

  async _loadVersions(): Promise<void> {
    try {
      const res = await postJSON<{ versions?: string[] }>("/api/runbot/sticky");
      if (!res.versions?.length) throw new Error("runbot is unreachable");
      this.versions.set(res.versions);
    } catch (e) {
      this.versionsError.set(`could not load runbot's versions: ${errorMessage(e)}`);
    }
    if (!this.version()) this.pickVersion(this.versions()[0] || OTHER);
  }

  pickVersion(version: string): void {
    this.version.set(version);
    this._loadDumps(this.bundle());
  }

  pickBundle(name: string): void {
    this.other.set(name.trim());
    this._loadDumps(this.bundle());
  }

  // runbot's bundle search, debounced while typing (fills the input's datalist)
  onSearch(query: string): void {
    this.query.set(query);
    clearTimeout(this._timer);
    const q = query.trim();
    if (q.length < 3) return this.matches.set([]);
    this._timer = setTimeout(async () => {
      try {
        const res = await postJSON<{ bundles?: string[] }>("/api/runbot/search", { query: q });
        this.matches.set(res.bundles || []);
      } catch {
        this.matches.set([]);
      }
    }, 300);
  }

  async _loadDumps(bundle: string): Promise<void> {
    this._bundle = bundle;
    if (!bundle) return this.dumps.set([]);
    this.dumps.set(null);
    let dumps: RunbotDump[] = [];
    try {
      dumps =
        (await postJSON<{ dumps?: RunbotDump[] }>("/api/runbot/dumps", { branch: bundle })).dumps ||
        [];
    } catch {
      // runbot unreachable: no dump to offer, the hint says so
    }
    if (bundle === this._bundle) this.dumps.set(dumps);
  }

  toggleCleanup(key: string, checked: boolean): void {
    const rest = this.cleanup().filter((k) => k !== key);
    this.cleanup.set(checked ? [...rest, key] : rest);
  }

  done(result: ImportPick | null): void {
    this.props.done(result);
  }

  ok(): void {
    if (!this.ready()) return;
    const common = { name: this.name().trim(), cleanup: this.cleanup() };
    const file = this.file();
    const dump = this.dump();
    if (this.source() === "file" && file) this.done({ ...common, source: "file", file });
    else if (dump) this.done({ ...common, source: "runbot", url: dump.url });
  }
}
