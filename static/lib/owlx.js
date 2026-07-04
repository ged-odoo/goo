// vendor/owl-orm/owl-global.js
var owl = globalThis.owl;
var getScope = owl.getScope;
var Scope = owl.Scope;
var computed = owl.computed;
var signal = owl.signal;

// vendor/owl-orm/orm.ts
var Model = class {
  id;
  orm;
  #dp;
  constructor(id, dp, orm) {
    this.id = id;
    this.orm = orm;
    this.#dp = dp;
  }
  setup() {
  }
  onCreate() {
  }
  delete() {
    this.orm.delete(this);
  }
  isDirty() {
    return this.#dp.table.dirtyRecords().has(this.id);
  }
  toJSON() {
    const obj = { id: this.id };
    const fields2 = this.#dp.table.fields;
    for (let f of fields2) {
      obj[f.name] = f.getRawValue(this.#dp);
    }
    return obj;
  }
};
var _signals = [];
var _index = 0;
var _dp;
var _table;
var Field = class {
  name = "";
  config;
  index = _index;
  table = _table;
  constructor(config) {
    this.config = config;
  }
  setValue(dp, value) {
    if (this.config.onChange) {
      const fn = dp.data[this.name].__onchange;
      fn.call(dp.record, value, (v) => this._setValue(dp, v));
    } else {
      return this._setValue(dp, value);
    }
  }
  _setValue(dp, value) {
    if (!dp.draft && this.config.readonly) {
      throw new Error(`Cannot edit readonly field "${this.name}" on model "${this.table.Model.id}"`);
    }
    if (this.config.selection) {
      if (dp.draft) {
        if (value !== void 0 && !this.config.selection.includes(value)) {
          throw new Error(`Invalid value "${value}" for field "${this.name}" on model "${this.table.Model.id}" (expected one of: ${this.config.selection.join(", ")})`);
        }
      } else {
        if (!this.config.selection.includes(value)) {
          throw new Error(`Invalid value "${value}" for field "${this.name}" on model "${this.table.Model.id}" (expected one of: ${this.config.selection.join(", ")})`);
        }
      }
    }
    dp.changes()[this.index] = value;
    this.table.dirtyRecords().add(dp.record.id);
    signal.trigger(dp.changes);
  }
  getValue(dp) {
    const index = this.index;
    const _change = dp.changes()[index];
    if (_change !== void 0) {
      return _change;
    }
    const _data = dp.rawData();
    let val = _data[index];
    if (typeof _data[index] === "function") {
      val = _data[index]();
    }
    if (val !== void 0) {
      return val;
    }
    const def = this.config.defaultValue;
    return typeof def === "function" ? def() : def;
  }
  getRawValue(dp) {
    return this.getValue(dp);
  }
};
var Many2OneField = class extends Field {
  getValue(dp) {
    let value = super.getValue(dp);
    if (value === null) {
      return value;
    }
    if (typeof value !== "string") {
      value = value.id;
    }
    const M = this.config.comodel();
    return this.table.orm._getTable(M).getDatapointById(value).record;
  }
  getRawValue(dp) {
    return this.getValue(dp)?.id || null;
  }
};
var One2ManyField = class extends Field {
  getValue(dp) {
    let value = super.getValue(dp);
    if (!value.length) {
      return [];
    }
    const M = this.config.comodel();
    const targetTable = this.table.orm._getTable(M);
    const activeIds = new Set(targetTable.activeRecords().map((r) => r.id));
    return value.filter((v) => activeIds.has(v.id || v)).map((v) => targetTable.getDatapointById(v.id || v).record);
  }
  getRawValue(dp) {
    return this.getValue(dp).map((r) => r.id);
  }
};
function createField(FieldClass, config) {
  const dp = _dp;
  const table = _table;
  if (!table.isReady) {
    table.fields.push(new FieldClass(config));
  }
  const field = table.fields[_index++];
  const fieldValue = computed(() => field.getValue(dp), {
    set: field.setValue.bind(field, dp)
  });
  _signals.push(fieldValue);
  return fieldValue;
}
function makeField(FieldClass, defaultValue) {
  return (options = {}) => createField(FieldClass, { defaultValue, ...options });
}
function many2One(options) {
  return createField(Many2OneField, { defaultValue: null, ...options });
}
function one2many(options) {
  return createField(One2ManyField, { defaultValue: [], ...options });
}
var fields = {
  char: makeField(Field, ""),
  number: makeField(Field, 0),
  bool: makeField(Field, false),
  json: makeField(Field, null),
  many2one: many2One,
  one2many
};
var DataPoint = class {
  record;
  table;
  draft;
  // rawValue is: value for scalar fields, id or null for m2o, list of ids for o2m
  rawData;
  // changes: new value for scalar fields, id or null for m2o, list of ids for o2m
  changes;
  // for scalar fields: value, for m2o: null or corresponding record, for o2m: list of records
  data = {};
  constructor(orm, table, id, initialState, draft, ctx) {
    this.table = table;
    this.draft = draft;
    const _rawData = [];
    const _changes = [];
    _signals = [];
    this.rawData = signal.Array(_rawData);
    this.changes = signal.Array(_changes);
    _dp = this;
    _table = table;
    _index = 0;
    let record;
    if (ctx) {
      ctx.run(() => {
        record = new table.Model(id, this, orm);
      });
    } else {
      record = new table.Model(id, this, orm);
    }
    if (!table.isReady) {
      for (let i = 0; i < _signals.length; i++) {
        const s = _signals[i];
        for (let k in record) {
          if (record[k] === s) {
            table.indexToField.push(k);
            table.fieldToIndex[k] = i;
            table.fields[i].name = k;
          }
        }
      }
      table.isReady = true;
    }
    for (let f in initialState) {
      if (f === "id") continue;
      const idx = table.fieldToIndex[f];
      if (idx === void 0) {
        throw new Error(
          `Unknown field "${f}" in initial state for model "${table.Model.id}"`
        );
      }
      let value = initialState[f];
      _rawData[table.fieldToIndex[f]] = value;
    }
    for (let f of table.fields) {
      if (_rawData[f.index] === void 0 && typeof f.config.defaultValue === "function") {
        _rawData[f.index] = f.config.defaultValue();
      }
    }
    for (let f of table.fields) {
      const n = f.name;
      const i = f.index;
      const rawValue = _rawData[i];
      if (!draft && f.config.required && (rawValue === void 0 || rawValue === null || rawValue === "")) {
        throw new Error(`Missing required field "${n}" on model "${table.Model.id}"`);
      }
      if (f.config.selection) {
        if (draft) {
          if (rawValue !== void 0 && !f.config.selection.includes(rawValue)) {
            throw new Error(`Invalid value "${rawValue}" for field "${n}" on model "${table.Model.id}" (expected one of: ${f.config.selection.join(", ")})`);
          }
        } else {
          const effectiveValue = rawValue !== void 0 ? rawValue : f.config.defaultValue;
          if (!f.config.selection.includes(effectiveValue)) {
            throw new Error(`Invalid value "${effectiveValue}" for field "${n}" on model "${table.Model.id}" (expected one of: ${f.config.selection.join(", ")})`);
          }
        }
      }
      const s = _signals[i];
      if (f.config.onChange) {
        s.__onchange = f.config.onChange;
      }
      this.data[n] = s;
    }
    this.record = record;
    table.datapoints[id] = this;
    record.setup();
  }
};
var Table = class {
  parent = null;
  orm;
  Model;
  isReady = false;
  // true when field <-> index map has been done
  indexToField = [];
  // field index => key name in record
  fieldToIndex = {};
  datapoints = {};
  fields = [];
  baseRecords = signal.Array([]);
  recordChanges = signal.Array([]);
  dirtyRecords = signal.Set(/* @__PURE__ */ new Set());
  // updated records
  constructor(orm, M) {
    this.orm = orm;
    this.Model = M;
  }
  activeDatapoints = computed(() => {
    let base = this.baseRecords().slice();
    for (let r of this.recordChanges()) {
      if (r.type === "add") {
        if (!base.includes(r.id)) {
          base.push(r.id);
        }
      } else {
        base = base.filter((id) => id !== r.id);
      }
    }
    return base.map((id) => this.getDatapointById(id));
  });
  activeRecords = computed(
    () => this.activeDatapoints().map((dp) => dp.record)
  );
  getDatapointById(id) {
    const dp = this.datapoints[id];
    if (dp) {
      return dp;
    }
    if (this.orm._parent) {
      const pTable = this.orm._parent._getTable(this.Model);
      const parentDp = pTable.getDatapointById(id);
      const dp2 = new DataPoint(
        this.orm,
        this,
        id,
        parentDp.data,
        true,
        this.orm._ctx
      );
      return dp2;
    }
    throw new Error(`Record "${id}" not found in model "${this.Model.id}"`);
  }
  pendingChanges() {
    const additions = /* @__PURE__ */ new Set();
    const deletions = /* @__PURE__ */ new Set();
    for (let change of this.recordChanges()) {
      if (change.type === "add") {
        additions.add(change.id);
        deletions.delete(change.id);
      } else {
        if (additions.has(change.id)) {
          additions.delete(change.id);
        } else {
          deletions.add(change.id);
        }
      }
    }
    const updates = [];
    for (let id of this.dirtyRecords()) {
      if (!additions.has(id) && !deletions.has(id)) {
        const diff = { id };
        const dp = this.datapoints[id];
        const changes = dp.changes();
        for (let i = 0; i < changes.length; i++) {
          let change = changes[i];
          if (change !== void 0) {
            diff[this.indexToField[i]] = change;
          }
        }
        updates.push(diff);
      }
    }
    if (additions.size || updates.length || deletions.size) {
      const result = {};
      if (additions.size) {
        result.additions = [...additions].map(
          (id) => this.datapoints[id].record.toJSON()
        );
      }
      if (deletions.size) {
        result.deletions = [...deletions];
      }
      if (updates.length) {
        result.updates = updates;
      }
      return result;
    }
    return null;
  }
};
var ORM = class _ORM {
  static uuid() {
    const str = Date.now().toString(36) + "-xxxx-xxxx";
    return str.replace(/[x]/g, () => (Math.random() * 16 | 0).toString(16));
  }
  static fromJSON(obj, models) {
    const orm = new _ORM();
    orm.loadJSON(obj, models);
    return orm;
  }
  _parent;
  _ctx;
  #applyingChanges = false;
  constructor(parent) {
    this._parent = parent || null;
    if (parent) {
      this._ctx = parent._ctx;
      const pdata = parent.#db();
      for (let mId in pdata) {
        const ptable = pdata[mId];
        const table = this._getTable(ptable.Model);
        table.baseRecords = computed(() => {
          return ptable.activeDatapoints().map((dp) => dp.record.id);
        });
      }
    } else {
      this._ctx = getScope();
    }
  }
  toJSON() {
    const store = {};
    const data = this.#db();
    for (let m in data) {
      const records = data[m].activeRecords().map((r) => r.toJSON());
      if (records.length) {
        store[m] = records;
      }
    }
    return store;
  }
  #db = signal.Object({});
  _getTable(M) {
    const id = M.id;
    const data = this.#db();
    if (!(id in data)) {
      const table = new Table(this, M);
      data[id] = table;
    }
    return data[id];
  }
  loadJSON(json, models) {
    for (let id in json) {
      const M = models.find((m) => m.id === id);
      if (!M) {
        throw new Error(`Unknown model "${id}" in JSON (registered models: ${models.map((m) => m.id).join(", ")})`);
      }
      const table = this._getTable(M);
      for (let record of json[id]) {
        new DataPoint(
          this,
          table,
          record.id,
          record,
          !!this._parent,
          this._ctx
        );
        table.baseRecords().push(record.id);
      }
    }
  }
  create(M, initialState = {}) {
    const table = this._getTable(M);
    const id = initialState.id || _ORM.uuid();
    const dp = new DataPoint(
      this,
      table,
      id,
      initialState,
      !!this._parent,
      this._ctx
    );
    table.recordChanges().push({ type: "add", id });
    this.#linkRelations(dp);
    if (!this._parent && !this.#applyingChanges) {
      dp.record.onCreate();
    }
    return dp.record;
  }
  #linkRelations(dp) {
    for (let field of dp.table.fields) {
      if (field instanceof Many2OneField) {
        const value = field.getValue(dp);
        if (value) {
          const coTable = this._getTable(value.constructor);
          for (let cf of coTable.fields) {
            if (cf instanceof One2ManyField) {
              const cfg = cf.config;
              if (cfg.comodel() === dp.table.Model && cfg.inverse === field.name) {
                const codp = coTable.getDatapointById(value.id);
                const raw = Field.prototype.getValue.call(cf, codp) || [];
                const ids = raw.map(
                  (v) => typeof v === "string" ? v : v.id
                );
                if (!ids.includes(dp.record.id)) {
                  cf._setValue(codp, [...ids, dp.record.id]);
                }
              }
            }
          }
        }
      }
    }
  }
  pendingChanges = computed(() => {
    const result = {};
    const data = this.#db();
    for (let id in data) {
      const table = data[id];
      const changes = table.pendingChanges();
      if (changes) {
        result[id] = changes;
      }
    }
    return result;
  });
  applyChanges(changes, models = []) {
    this.#applyingChanges = true;
    const data = this.#db();
    for (let modelId in changes) {
      const modelChanges = changes[modelId];
      let table = data[modelId];
      if (!table) {
        const M = models.find((m) => m.id === modelId);
        if (!M) {
          throw new Error(`Unknown model "${modelId}" in changeset (registered models: ${models.map((m) => m.id).join(", ")})`);
        }
        table = this._getTable(M);
      }
      for (let r of modelChanges.additions || []) {
        this.create(table.Model, r);
      }
      for (let id of modelChanges.deletions || []) {
        const dp = table.datapoints[id];
        this.delete(dp.record);
      }
      for (let update of modelChanges.updates || []) {
        const id = update.id;
        const dp = table.datapoints[id];
        const changes2 = dp.changes();
        for (let k in update) {
          if (k !== "id") {
            changes2[table.fieldToIndex[k]] = update[k];
          }
        }
        signal.trigger(dp.changes);
        table.dirtyRecords().add(id);
      }
    }
    this.#applyingChanges = false;
  }
  draft() {
    return new _ORM(this);
  }
  /**
   * Push draft changes to the parent ORM. Only valid on a draft ORM
   * created via `orm.draft()`. Additions, deletions, and field updates
   * are applied to the parent atomically; `onCreate()` fires on newly
   * added records in the parent after they land. Throws if this ORM
   * has no parent.
   */
  commit() {
    if (!this._parent) {
      throw new Error("commit() is for draft ORMs \u2014 use flush() on a root ORM");
    }
    const data = this.#db();
    const changes = this.pendingChanges();
    const models = Object.values(data).map((s) => s.Model);
    this._parent.applyChanges(changes, models);
    for (let modelId in changes) {
      const parentTable = this._parent._getTable(data[modelId].Model);
      for (let r of changes[modelId].additions || []) {
        parentTable.datapoints[r.id].record.onCreate();
      }
    }
    this.#clearPending();
  }
  /**
   * Acknowledge pending changes on a root ORM: bake current field
   * values into `rawData`, consolidate `baseRecords`, and reset all
   * dirty tracking so that `pendingChanges()` returns `{}`. This does
   * NOT move data anywhere — it just resets the "what changed since
   * last flush" baseline. Throws if called on a draft ORM.
   */
  flush() {
    if (this._parent) {
      throw new Error("flush() is for root ORMs \u2014 use commit() on a draft ORM");
    }
    const data = this.#db();
    for (let modelId in data) {
      const table = data[modelId];
      const datapoints = table.activeDatapoints();
      const updates = table.dirtyRecords();
      table.baseRecords.set(datapoints.map((r) => r.record.id));
      for (let id of updates) {
        const dp = table.datapoints[id];
        const _nextRawData = dp.rawData();
        for (let f of table.fields) {
          _nextRawData[f.index] = f.getRawValue(dp);
        }
      }
    }
    this.#clearPending();
  }
  #clearPending() {
    const data = this.#db();
    for (let modelId in data) {
      const table = data[modelId];
      const dirty = table.dirtyRecords();
      table.dirtyRecords.set(/* @__PURE__ */ new Set());
      table.recordChanges.set([]);
      for (let id of dirty) {
        const dp = table.datapoints[id];
        dp.changes().length = 0;
        signal.trigger(dp.changes);
      }
    }
  }
  discard() {
    const data = this.#db();
    for (let modelId in data) {
      const table = data[modelId];
      table.recordChanges.set([]);
      for (let id of table.dirtyRecords()) {
        const dp = table.datapoints[id];
        dp.changes().length = 0;
        signal.trigger(dp.changes);
      }
      table.dirtyRecords.set(/* @__PURE__ */ new Set());
    }
  }
  records(M) {
    const table = this._getTable(M);
    return table.activeRecords();
  }
  records$(M) {
    const table = this._getTable(M);
    return table.activeRecords;
  }
  getById(M, id) {
    const table = this._getTable(M);
    const dp = table.datapoints[id];
    return dp ? dp.record : null;
  }
  delete(record) {
    const table = this._getTable(record.constructor);
    this.#unlinkRelations(table.datapoints[record.id]);
    table.recordChanges().push({ type: "delete", id: record.id });
  }
  #unlinkRelations(dp) {
    for (let field of dp.table.fields) {
      if (field instanceof Many2OneField) {
        const value = field.getValue(dp);
        if (value) {
          const coTable = this._getTable(value.constructor);
          for (let cf of coTable.fields) {
            if (cf instanceof One2ManyField) {
              const cfg = cf.config;
              if (cfg.comodel() === dp.table.Model && cfg.inverse === field.name) {
                const codp = coTable.getDatapointById(value.id);
                const raw = Field.prototype.getValue.call(cf, codp) || [];
                const ids = raw.map(
                  (v) => typeof v === "string" ? v : v.id
                );
                if (ids.includes(dp.record.id)) {
                  cf._setValue(
                    codp,
                    ids.filter((id) => id !== dp.record.id)
                  );
                }
              }
            }
          }
        }
      }
    }
  }
};
export {
  Model,
  ORM,
  fields
};
