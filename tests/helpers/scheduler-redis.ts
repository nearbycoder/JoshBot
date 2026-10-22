// Deterministic Redis model for scheduler races. The optional isolated Redis
// test exercises the same production Lua scripts against an actual server.
export class SchedulerRedis {
  now = Date.now();
  values = new Map<string, string>();
  sorted = new Map<string, Map<string, number>>();
  sets = new Map<string, Set<string>>();
  expires = new Map<string, number>();

  read(key: string) {
    if ((this.expires.get(key) ?? Infinity) <= this.now) {
      this.values.delete(key);
      this.expires.delete(key);
    }
    return this.values.get(key) ?? null;
  }

  async get(key: string) { return this.read(key); }
  async set(key: string, value: string) { this.values.set(key, value); return "OK"; }
  async del(key: string) { this.expires.delete(key); return Number(this.values.delete(key)); }
  async sMembers(key: string) { return [...(this.sets.get(key) ?? [])]; }
  async sAdd(key: string, value: string) {
    const set = this.sets.get(key) ?? new Set<string>();
    this.sets.set(key, set);
    const added = !set.has(value);
    set.add(value);
    return Number(added);
  }
  async sRem(key: string, value: string) { return Number(this.sets.get(key)?.delete(value) ?? false); }
  async zAdd(key: string, entry: { score: number; value: string }) {
    const set = this.sorted.get(key) ?? new Map<string, number>();
    this.sorted.set(key, set);
    set.set(entry.value, entry.score);
    return 1;
  }
  async zRem(key: string, id: string) { return Number(this.sorted.get(key)?.delete(id) ?? false); }
  async zScore(key: string, id: string) { return this.sorted.get(key)?.get(id) ?? null; }
  async zRangeByScore(key: string, min: number, max: number, options: { LIMIT: { offset: number; count: number } }) {
    return [...(this.sorted.get(key) ?? [])]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .slice(options.LIMIT.offset, options.LIMIT.offset + options.LIMIT.count)
      .map(([id]) => id);
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    // No awaits: each operation is atomic, as Redis EVAL is.
    const [recordKey, dueKey, leaseKey] = options.keys as [string, string, string];
    const [id, token, original, after, nextRunAt] = options.arguments as [string, string, string, string, string];
    const due = this.sorted.get(dueKey);
    if (script.startsWith("-- scheduler-lease:claim")) {
      const score = due?.get(id);
      if (score === undefined || score > this.now) return null;
      const record = this.read(recordKey);
      if (record === null) { due?.delete(id); return null; }
      if (this.read(leaseKey) !== null) return null;
      this.values.set(leaseKey, token);
      this.expires.set(leaseKey, this.now + Number(original));
      due!.set(id, this.now + Number(original));
      return record;
    }
    if (script.startsWith("-- scheduler-lease:")) {
      if (this.read(leaseKey) !== token) return 0;
      const unchanged = this.read(recordKey) === original && due?.has(id);
      if (script.startsWith("-- scheduler-lease:check")) return Number(Boolean(unchanged));
      if (script.startsWith("-- scheduler-lease:renew")) {
        if (!unchanged) return 0;
        this.expires.set(leaseKey, this.now + Number(after));
        due!.set(id, this.now + Number(after));
        return 1;
      }
      if (script.startsWith("-- scheduler-lease:finish")) {
        this.values.delete(leaseKey);
        this.expires.delete(leaseKey);
        if (!unchanged) return 0;
        if (after === "") {
          this.values.delete(recordKey);
          due!.delete(id);
          for (const key of options.keys.slice(3)) this.sets.get(key)?.delete(id);
        } else {
          this.values.set(recordKey, after);
          due!.set(id, Number(nextRunAt));
        }
        return 1;
      }
    }
    // Reminder edit CAS, exercised while a worker is paused in generation.
    if (script.includes("ZSCORE") && options.keys.length === 2) {
      const [before, replacement, at, jobId] = options.arguments as [string, string, string, string];
      if (this.read(recordKey) !== before || !due?.has(jobId)) return 0;
      this.values.set(recordKey, replacement);
      due.set(jobId, Number(at));
      return 1;
    }
    throw new Error("Unsupported scheduler test script");
  }
}
