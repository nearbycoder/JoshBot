import {createHash, randomUUID} from 'node:crypto';
import * as v from 'valibot';
import {assertQuota, assertStateVersion, serializedBytes} from './feature-kit/bounded-state.js';
import {civilDate} from './feature-kit/civil-time.js';
import {boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt, type DisplayPart} from './feature-kit/command-and-display.js';
import metadata from './interruption-audit.metadata.js';
import type {AgentFeature, AgentFeatureContext} from './types.js';
const route = '/nobo-help agent interruption-audit';
class InputError extends Error {}
function checked<T>(f: () => T): T {
  try { return f(); } catch (e) { throw new InputError(e instanceof Error ? e.message : 'Invalid input.'); }
}
const text = (bytes: number, units = bytes) => v.pipe(v.string(), v.check(s => {
  try { boundedText(s, {label: 'Text', maxBytes: bytes, maxUnits: units, trim: false, allowEmpty: true}); return true; } catch { return false; }
}));
const idSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
const revSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
const daySchema = v.pipe(v.string(), v.check(s => { try { civilDate(s); return true; } catch { return false; } }));
function bump(n: number, removal = false) {
  if (n === Number.MAX_SAFE_INTEGER && !removal)
    throw new InputError('Revision limit reached. Export saved records before explicit field removal or delete ID confirm. This finite limit cannot be retried or reset.');
  return Math.min(Number.MAX_SAFE_INTEGER, n + 1);
}
function writable(state: {revision: number}, record?: {revision: number}) {
  bump(state.revision);
  if (record) bump(record.revision);
}
const stamp = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = (input: string, limits: number[], empty = false) => checked(() => pipeFields(input,
  limits.map(maxBytes => ({label: 'Field', maxBytes: maxBytes + 32, allowEmpty: empty})))
  .map((x, i) => boundedText(x, {label: 'Field', maxBytes: limits[i], trim: false, allowEmpty: empty})));
const date = (s: string) => checked(() => civilDate(s));
const num = (s: string, min: number, max: number) => checked(() => parseInteger(s, {min, max}));
function guard(value: {revision: number}, expected?: string, digest?: string) {
  if (expected !== undefined && (value.revision !== num(expected, 1, Number.MAX_SAFE_INTEGER) || digest !== stamp(value)))
    throw new InputError('Saved content changed; restart this view or command.');
}
function assertSame(actual: unknown, expected: unknown) {
  if (stamp(actual) !== stamp(expected)) throw new InputError('Saved content changed; reopen it before retrying.');
}
function parts(body: string): DisplayPart[] {
  return body.split(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|(?:calendar|toolbox):[A-Za-z0-9:_-]+|e1:[0-9a-f]{64}|[0-9a-f]{64})/g)
    .map((text, i) => ({text, atomic: i % 2 === 1}));
}
function pages(body: string, command: string, value: {revision: number}, page = 1) {
  return checked(() => pageAt(paginateParts(parts(body), {mode: 'plain', title: `Revision ${value.revision}`,
    command: n => `${route} ${command} page ${n} rev ${value.revision} stamp ${stamp(value)}`}), page).text);
}
const minutes = v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1440)));
const basis = v.picklist(['measured', 'estimated', 'unknown']);
const logSchema = v.strictObject({id: idSchema, revision: revSchema, kind: v.literal('log'), date: v.nullable(daySchema),
  category: text(80), task: text(240), disruption: minutes, recovery: minutes, basis});
const ruleSchema = v.strictObject({id: idSchema, revision: revSchema, kind: v.literal('rule'), category: text(80), advice: text(400)});
const rangeSchema = v.strictObject({id: idSchema, revision: revSchema, kind: v.literal('range'), start: daySchema, end: daySchema});
const schema = v.strictObject({version: v.literal(1), revision: revSchema,
  records: v.pipe(v.array(v.variant('kind', [logSchema, ruleSchema, rangeSchema])), v.maxLength(93))});
type State = v.InferOutput<typeof schema>;
type Record = State['records'][number];
type Log = v.InferOutput<typeof logSchema>;
const initial: State = {version: 1, revision: 1, records: []};
const envelope = (record: Record) => ({feature: metadata.id, version: 1, record});
function validate(raw: unknown): State {
  checked(() => assertStateVersion(raw, 1));
  const p = v.safeParse(schema, raw);
  if (!p.success) throw new InputError('Invalid saved interruption-audit schema; data preserved. Ask the operator for scoped recovery.');
  const s = p.output;
  if (new Set(s.records.map(r => r.id)).size !== s.records.length || s.records.filter(r => r.kind === 'log').length > 80 ||
      s.records.filter(r => r.kind === 'rule').length > 12 || s.records.filter(r => r.kind === 'range').length > 1 ||
      s.records.some(r => r.kind === 'range' && r.start > r.end)) throw new InputError('Invalid saved counts, IDs or range; data preserved.');
  return s;
}
const get = (s: State, id: string) => {
  const r = s.records.find(x => x.id === id);
  if (!r) throw new InputError('Record not found. Use list.');
  return r;
};
function future(s: State): State {
  return {...s, revision: Number.MAX_SAFE_INTEGER, records: s.records.map<Record>(r => r.kind === 'log' ?
    {...r, revision: Number.MAX_SAFE_INTEGER, disruption: 1440, recovery: 1440, basis: 'estimated'} :
    {...r, revision: Number.MAX_SAFE_INTEGER}).concat(s.records.some(r => r.kind === 'range') ? [] : [{id: '00000000-0000-4000-8000-000000000000', revision: Number.MAX_SAFE_INTEGER, kind: 'range', start: '9999-01-01', end: '9999-12-31'}])};
}
function admit(s: State, mode: 'content' | 'lifecycle' | 'remove') {
  const projected = future(s), limits = {maxRecords: 93};
  checked(() => assertQuota(s, mode === 'content' ? {kind: 'content', records: s.records.map(envelope), limits,
    future: {value: projected, records: projected.records.map(envelope)}} : {kind: 'lifecycle', records: s.records.map(envelope), limits}));
  if (mode !== 'remove') checked(() => assertQuota(projected, {kind: 'lifecycle', records: projected.records.map(envelope), limits}));
}
const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b), n = sorted.length;
  return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null;
};
function summary(logs: Log[]) {
  const sums = logs.map(l => l.disruption === null || l.recovery === null ? null : l.disruption + l.recovery);
  const known = sums.filter((x): x is number => x !== null);
  return `${logs.length} entries; ${logs.reduce((n, l) => n + (l.disruption ?? 0) + (l.recovery ?? 0), 0)} total reported minutes (known components); ` +
    `${logs.filter(l => l.disruption === null).length} unknown disruption, ${logs.filter(l => l.recovery === null).length} unknown recovery; ` +
    `median complete-entry total ${median(known) ?? 'unknown'} minutes (n=${known.length}); ` +
    `median known recovery ${median(logs.flatMap(l => l.recovery === null ? [] : [l.recovery])) ?? 'unknown'} minutes`;
}
function report(s: State, range: v.InferOutput<typeof rangeSchema>) {
  const all = s.records.filter((r): r is Log => r.kind === 'log');
  const logs = all.filter(l => l.date !== null && l.date >= range.start && l.date <= range.end);
  const rows = [`Interruption review ${range.start} through ${range.end} (inclusive)\n${summary(logs)}\n`];
  for (const b of ['measured', 'estimated', 'unknown'] as const) rows.push(`${b}: ${summary(logs.filter(l => l.basis === b))}\n`);
  for (const category of [...new Set(logs.map(l => l.category))].sort()) {
    rows.push(`Category ${category || '(unspecified)'}: ${summary(logs.filter(l => l.category === category))}\n`);
    for (const rule of s.records) if (rule.kind === 'rule' && rule.category === category && rule.category && rule.advice)
      rows.push(`Chosen prevention rule ${rule.id}: ${rule.advice}\n`);
  }
  for (const day of [...new Set(logs.map(l => l.date!))].sort()) rows.push(`${day}: ${summary(logs.filter(l => l.date === day))}\n`);
  rows.push(`${all.filter(l => l.date === null).length} undated entries excluded. Missing days are unobserved. User reports only; no Slack inference or causal claim.\n`);
  return rows.join('');
}
const minute = (x: string) => x === 'unknown' ? null : num(x, 0, 1440);
function inputLog(input: string): Omit<Log, 'id' | 'revision' | 'kind'> {
  const [d, category, task, disruption, recovery, b] = fields(input, [10, 80, 240, 7, 7, 9]);
  if (b !== 'measured' && b !== 'estimated') throw new InputError('Basis must be measured or estimated.');
  return {date: date(d), category, task, disruption: minute(disruption), recovery: minute(recovery), basis: b};
}
async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  checked(() => boundedText(command, {label: 'Command', maxBytes: 16000}));
  if (command === 'help') return metadata.help;
  const s = validate(await ctx.store.read('state') ?? initial), newId = randomUUID();
  const save = (change: (next: State) => Record | null, mode: 'content' | 'lifecycle' | 'remove' = 'content') => {
    if (mode !== 'remove') writable(s);
    return ctx.store.update('state', initial, raw => {
      const next = validate(raw); if (mode !== 'remove') writable(next);
      const r = change(next); next.revision = bump(next.revision, mode === 'remove'); validate(next); admit(next, mode);
      return {value: next, result: r ? `Saved privately: ${r.id} · revision ${r.revision}\nNext: ${route} ${r.kind === 'range' ? 'report' : 'show'} ${r.id}` : 'Deleted privately. Use list to inspect remaining records.'};
    });
  };
  const edit = (id: string, change: (r: Record) => void, mode: 'content' | 'lifecycle' | 'remove' = 'content') => {
    const expected = get(s, id); if (mode !== 'remove') writable(s, expected);
    return save(next => {const r = get(next, id); assertSame(r, expected); if (mode !== 'remove') writable(next, r); change(r); r.revision = bump(r.revision, mode === 'remove'); return r;}, mode);
  };
  let m: RegExpMatchArray | null;
  if ((m = command.match(/^list(?: (?:page )?(\d+))?$/))) {
    const n = checked(() => parsePage(m![1])), records = [...s.records].sort((a,b) => a.id.localeCompare(b.id));
    if (n > Math.max(1, Math.ceil(records.length / 10))) throw new InputError('Page out of range; restart list.');
    return `Current list ${n}/${Math.max(1, Math.ceil(records.length/10))}; ${serializedBytes(s)}/49152 bytes\n` +
      (records.slice((n-1)*10,n*10).map(r => `${r.id} · ${r.kind} · ${r.kind === 'range' ? `${r.start}–${r.end}` : r.category || '(unspecified)'}`).join('\n') || `No records. Start: ${metadata.example}`) +
      (n*10 < records.length ? `\nNext: ${route} list ${n+1}` : '');
  }
  if ((m = command.match(/^(show|report) (\S+)(?: (?:page )?(\d+))?(?: rev (\d+) stamp ([0-9a-f]{64}))?$/))) {
    // The report's complete contributing state is checked before range/child lookup.
    if (m[1] === 'report') guard(s, m[4], m[5]);
    const r = get(s,m[2]); if (m[1] === 'show') guard(r,m[4],m[5]);
    if (m[1] === 'report' && r.kind !== 'range') throw new InputError('Use a saved range ID from list.');
    return pages(m[1] === 'show' ? JSON.stringify(envelope(r),null,2) : report(s,r as v.InferOutput<typeof rangeSchema>),
      `${m[1]} ${r.id}`,m[1] === 'show' ? r : s,checked(() => parsePage(m![3])));
  }
  if ((m = command.match(/^export (\S+)$/))) {
    const out = envelope(get(s,m[1])); if (serializedBytes(out) > 24576) throw new InputError('Export too large; use show pages.'); return JSON.stringify(out);
  }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) {
    const r = get(s,m[1]); if (!m[2]) return `Remove this ${r.kind}: ${route} delete ${r.id} confirm`;
    return save(next => {assertSame(get(next,r.id),r); next.records = next.records.filter(x=>x.id!==r.id); return null;},'remove');
  }
  if (command.startsWith('log ')) {
    const input = inputLog(command.slice(4));
    return save(next => {const r: Log = {id:newId,revision:1,kind:'log',...input}; next.records.push(r); return r;});
  }
  if (command.startsWith('rule ')) {
    const [category, advice] = fields(command.slice(5),[80,400]);
    return save(next => {const r: Record={id:newId,revision:1,kind:'rule',category,advice};next.records.push(r);return r;});
  }
  if (command.startsWith('review ')) {
    const [start,end] = fields(command.slice(7),[10,10]); date(start);date(end);if(start>end) throw new InputError('Range end must not precede start.');
    const expected = s.records.find(r=>r.kind==='range'); writable(s, expected);
    const next = await ctx.store.update('state',initial,raw=>{
      const current=validate(raw), existing=current.records.find(r=>r.kind==='range'); assertSame(existing??null,expected??null); writable(current, existing);
      const r: Record={id:expected?.id??newId,revision:expected?bump(expected.revision):1,kind:'range',start,end};
      current.records=current.records.filter(x=>x.kind!=='range');current.records.push(r);current.revision=bump(current.revision);validate(current);admit(current,'lifecycle');
      return {value:current,result:current};
    });
    const range=next.records.find(r=>r.kind==='range')! as v.InferOutput<typeof rangeSchema>;
    return pages(report(next,range),`report ${range.id}`,next);
  }
  if ((m=command.match(/^edit (\S+)\s*\|([\s\S]*)$/))) {
    const expected=get(s,m[1]);
    if(expected.kind==='log') {const input=inputLog(m[2]);return edit(expected.id,r=>Object.assign(r,input));}
    if(expected.kind==='rule') {const [category,advice]=fields(m[2],[80,400]);return edit(expected.id,r=>Object.assign(r,{category,advice}));}
    const [start,end]=fields(m[2],[10,10]);date(start);date(end);if(start>end) throw new InputError('Invalid range.');
    return edit(expected.id,r=>Object.assign(r,{start,end}),'lifecycle');
  }
  if ((m=command.match(/^measure (\S+)\s*\|([\s\S]*)$/))) {
    const [d,r,b]=fields(m[2],[7,7,9]); if(b!=='measured'&&b!=='estimated') throw new InputError('Basis must be measured or estimated.');
    const disruption=minute(d), recovery=minute(r);
    return edit(m[1],log=>{if(log.kind!=='log')throw new InputError('Use a log ID.');Object.assign(log,{disruption,recovery,basis:b});},'lifecycle');
  }
  if ((m=command.match(/^clear (\S+) (date|category|task|disruption|recovery|basis|advice) confirm$/))) {
    const field=m[2];return edit(m[1],r=>{
      if(r.kind==='range') throw new InputError('Delete the range configuration to remove it.');
      if(field==='category')r.category='';
      else if(r.kind==='rule'&&field==='advice')r.advice='';
      else if(r.kind==='log'&&field==='task')r.task='';
      else if(r.kind==='log'&&field==='basis')r.basis='unknown';
      else if(r.kind==='log'&&(field==='date'||field==='disruption'||field==='recovery'))r[field]=null;
      else throw new InputError('Field does not belong to this record.');
    },'remove');
  }
  throw new InputError(`Unknown or incomplete command. Use ${route} help`);
}
export default {...metadata, async execute(command:string,ctx:AgentFeatureContext) {
  try {return await execute(command,ctx);} catch(e) {ctx.signal?.throwIfAborted();return e instanceof InputError ? `${e.message}\nNext: ${route} help` :
    `Saved work could not be read or confirmed safely. Inspect before retrying; a dispatched save may have completed.\nNext: ${route} list`;}
}} satisfies AgentFeature;
