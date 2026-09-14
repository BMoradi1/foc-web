// Selection state is independent of the console and of network commands.
export class Selection {
  ids = [];
  groups = new Map();
  set(ids) { this.ids = [...new Set(ids)].slice(0, 12); }
  toggle(id) { this.set(this.ids.includes(id) ? this.ids.filter(i => i !== id) : [...this.ids, id]); }
  prune(valid) { this.ids = this.ids.filter(valid); }
  assign(key, valid) { this.groups.set(key, this.ids.filter(valid)); }
  recall(key, valid) { this.set((this.groups.get(key) || []).filter(valid)); }
}
