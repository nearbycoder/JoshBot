import {createHash, randomUUID} from 'node:crypto';
import * as v from 'valibot';

import {assertQuota as kitAssertQuota, assertRevision as kitAssertRevision, assertStateVersion as kitAssertStateVersion, serializedBytes as kitSerializedBytes} from './feature-kit/bounded-state.js';
import {civilDate as kitCivilDate, dateInZone as kitDateInZone} from './feature-kit/civil-time.js';
import {boundedText as kitBoundedText, type DisplayPart, pageAt as kitPageAt, paginateParts as kitPaginateParts, parsePage as kitParsePage, pipeFields as kitPipeFields} from './feature-kit/command-and-display.js';
import metadata from './learning-transfer.metadata.js';
import type {AgentFeature, AgentFeatureContext} from './types.js';

class CommandError extends Error {}
// Only pure local/kit validation messages are user-facing; backend/provider exceptions stay private.
function checked<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : 'Invalid input.');
  }
}
const boundedText: typeof kitBoundedText = (...args) => checked(() => kitBoundedText(...args));
const pipeFields: typeof kitPipeFields = (...args) => checked(() => kitPipeFields(...args));
const parsePage: typeof kitParsePage = (...args) => checked(() => kitParsePage(...args));
const paginateParts: typeof kitPaginateParts = (...args) => checked(() => kitPaginateParts(...args));
const pageAt: typeof kitPageAt = (...args) => checked(() => kitPageAt(...args));
const assertQuota: typeof kitAssertQuota = (...args) => checked(() => kitAssertQuota(...args));
const assertRevision: typeof kitAssertRevision = (...args) => checked(() => kitAssertRevision(...args));
const assertStateVersion: typeof kitAssertStateVersion = (...args) =>
    checked(() => kitAssertStateVersion(...args));
const serializedBytes: typeof kitSerializedBytes = (...args) => checked(() => kitSerializedBytes(...args));
const civilDate: typeof kitCivilDate = (...args) => checked(() => kitCivilDate(...args));
const dateInZone: typeof kitDateInZone = (...args) => checked(() => kitDateInZone(...args));

const route = '/nobo-help agent learning-transfer';
const id = v.pipe(v.string(), v.uuid());
const rev = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
const text = (bytes: number, units = bytes) => v.pipe(v.string(), v.check(s => {
  try {
    boundedText(s, {label: 'Text', maxBytes: bytes, maxUnits: units, trim: false, allowEmpty: true});
    return true;
  } catch {
    return false;
  }
}));
const day = v.pipe(v.string(), v.check(s => {
  try {
    civilDate(s);
    return true;
  } catch {
    return false;
  }
}));
const observation = v.strictObject({id, date: day, text: text(240), planRevision: rev});
const reflection = v.strictObject({text: text(240), planRevision: rev, observationRevision: rev});
const record = v.strictObject({
  id,
  revision: rev,
  planRevision: rev,
  observationRevision: rev,
  lesson: text(120),
  sourceLabel: text(120),
  sourceExcerpt: text(1800, 600),
  opportunity: text(180),
  action: text(300),
  prediction: text(240),
  observations: v.pipe(v.array(observation), v.maxLength(5)),
  reflection: v.nullable(reflection)
});
type Application = v.InferOutput<typeof record>;
const schema = v.strictObject({version: v.literal(1), records: v.pipe(v.array(record), v.maxLength(20))});
type State = v.InferOutput<typeof schema>;
const initial: State = {
  version: 1,
  records: []
};
const sizes = {
  lesson: 120,
  sourceLabel: 120,
  sourceExcerpt: 1800,
  opportunity: 180,
  action: 300,
  prediction: 240
};
type Field = keyof typeof sizes;
function validate(raw: unknown): State {
  assertStateVersion(raw, 1);
  const parsed = v.safeParse(schema, raw);
  if (!parsed.success)
    throw new CommandError(
        'Invalid saved learning-transfer data; preserved. Ask a maintainer to repair state; help remains available.');
  const ids: string[] = [];
  for (const a of parsed.output.records) {
    ids.push(a.id, ...a.observations.map(o => o.id));
    if (a.planRevision > a.revision || a.observationRevision > a.revision ||
        a.observations.some(o => !o.text.trim() || o.planRevision > a.planRevision) ||
        (a.reflection &&
         (!a.reflection.text.trim() || a.reflection.planRevision > a.planRevision ||
          a.reflection.observationRevision > a.observationRevision))) {
      throw new CommandError('Invalid saved assessment revisions; data preserved.');
    }
    if (a.reflection?.planRevision === a.planRevision &&
        a.reflection.observationRevision === a.observationRevision &&
        !a.observations.some(o => o.planRevision === a.planRevision))
      throw new CommandError('Invalid current reflection without current observations; data preserved.');
    if (a.observations.some(o => o.planRevision === a.planRevision) && !ready(a))
      throw new CommandError('Invalid current observation without a complete plan; data preserved.');
  }
  if (new Set(ids).size !== ids.length) throw new CommandError('Duplicate saved IDs; data preserved.');
  return parsed.output;
}
const ready = (a: Application) =>
    !!(a.lesson.trim() && a.sourceLabel.trim() && a.sourceExcerpt.trim() && a.opportunity.trim() &&
       a.action.trim() && a.prediction.trim());
const status = (a: Application) => !a.observations.some(o => o.planRevision === a.planRevision) ? 'planned' :
    a.reflection?.planRevision === a.planRevision &&
        a.reflection.observationRevision === a.observationRevision ?
                                                                                                  'reviewed' :
                                                                                                  'tried';
const envelope = (a: Application) => ({feature: metadata.id, version: 1, record: a});
const get = (s: State, key: string) => {
  const a = s.records.find(a => a.id === key);
  if (!a) throw new CommandError(`Application not found. Use ${route} list`);
  return a;
};
function parts(s: string): DisplayPart[] {
  return s.split(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/g)
      .map((text, i) => ({text, atomic: i % 2 === 1}));
}
function page(a: Application, verb: string, body: string, n = 1, expected?: string) {
  if (expected) assertRevision(a.revision, Number(expected));
  return pageAt(
             paginateParts(parts(body), {
               mode: 'plain',
               title: `${a.id} · ${status(a)} · revision ${a.revision}`,
               command: p => `${route} ${verb} ${a.id} page ${p} rev ${a.revision}`
             }),
             n)
      .text;
}
function review(a: Application) {
  const gaps = (Object.keys(sizes) as Field[]).filter(k => !a[k].trim());
  return `Learning-to-action review · ${status(a)}\nLesson: ${a.lesson}\nProvenance label (unverified): ${
             a.sourceLabel}\nExact supplied excerpt: ${a.sourceExcerpt}\nOpportunity: ${
             a.opportunity}\nAction: ${a.action}\nPredicted observation: ${a.prediction}\nMissing links: ${
             gaps.join(', ') || 'none'}\n` +
      (a.observations
           .map(
               o => `Observation ${o.id} · civil date ${o.date} · ${
                   o.planRevision === a.planRevision ?
                       'current plan' :
                       'STALE: earlier plan'}\nActual (user report): ${o.text}\n`)
           .join('') ||
       'No actual observations; application has not been reported.\n') +
      (a.reflection ? `Next adjustment (${
                          status(a) === 'reviewed' ?
                              'current' :
                              'STALE; reflect again after current observations'}): ${a.reflection.text}\n` :
                      'No reflection yet.\n') +
      `These are user reports; no outcomes or goal/card progress are inferred.\nNext: ${route} show ${a.id}`;
}
function future(s: State): State {
  // Every accepted application reserves all five observations, plan fields and reflection.
  // With byte-limited fields, backslashes have the largest JSON representation (2 bytes each).
  return {
    version: 1,
    records: s.records.map(
        a => ({
          ...a,
          revision: Number.MAX_SAFE_INTEGER,
          planRevision: Number.MAX_SAFE_INTEGER,
          observationRevision: Number.MAX_SAFE_INTEGER,
          opportunity: '\\'.repeat(180),
          action: '\\'.repeat(300),
          prediction: '\\'.repeat(240),
          observations:
              Array.from({length: 5}, (_, i) => ({
                                        id: a.observations[i]?.id ?? '00000000-0000-4000-8000-000000000000',
                                        date: '9999-12-31',
                                        text: '\\'.repeat(240),
                                        planRevision: Number.MAX_SAFE_INTEGER
                                      })),
          reflection: {
            text: '\\'.repeat(240),
            planRevision: Number.MAX_SAFE_INTEGER,
            observationRevision: Number.MAX_SAFE_INTEGER
          }
        }))
  };
}
function admit(s: State, lifecycle: boolean) {
  for (const a of s.records) {
    page(a, 'show', JSON.stringify(envelope(a), null, 2));
    page(a, 'review', review(a));
  }
  const projected = future(s), limits = {maxRecords: 20};
  if (lifecycle)
    assertQuota(s, {kind: 'lifecycle', records: s.records.map(envelope), limits});
  else
    assertQuota(s, {
      kind: 'content',
      records: s.records.map(envelope),
      limits,
      future: {value: projected, records: projected.records.map(envelope)}
    });
}
const fields = (s: string, limits: number[]) =>
    pipeFields(s, limits.map(maxBytes => ({label: 'Field', maxBytes: maxBytes + 32, allowEmpty: false})))
        .map((x, i) => boundedText(x, {label: 'Field', maxBytes: limits[i], trim: false}));

async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  boundedText(command, {label: 'Command', maxBytes: 16000});
  if (command === 'help') return metadata.help;
  const s = validate(await ctx.store.read('state') ?? initial), newId = randomUUID(),
        date = dateInZone(ctx.now, ctx.timezone);
  const usage = (state: State) =>
      `${state.records.length}/20 applications; ${serializedBytes(state)}/49152 saved bytes; ${
          serializedBytes(
              future(state))}/49152 projected lifecycle bytes (32768 content admission). Free space: ${
          route} list, then delete ID confirm.`;
  const save =
      (change: (state: State) => Application | null, mode: 'content'|'lifecycle'|'remove' = 'content') =>
          ctx.store.update('state', initial, raw => {
            const state = validate(raw), a = change(state);
            validate(state);
            if (mode !== 'remove') admit(state, mode === 'lifecycle');
            return {
              value: state,
              result: `${
                  a ? `Saved privately: ${a.id} · ${status(a)} · revision ${a.revision}\nNext: ${
                          route} review ${a.id}` :
                      'Deleted privately.'}\n${usage(state)}`
            };
          });
  const edit =
      (key: string, change: (a: Application) => void, mode: 'content'|'lifecycle'|'remove' = 'content') => {
        const expected = get(s, key).revision;
        return save(state => {
          const a = get(state, key);
          assertRevision(a.revision, expected);
          change(a);
          a.revision++;
          return a;
        }, mode);
      };
  let m: RegExpMatchArray|null;
  if ((m = command.match(/^list(?: (?:page )?(\d+))?(?: snapshot ([0-9a-f]{64}))?$/))) {
    const snapshot = createHash('sha256').update(JSON.stringify(s)).digest('hex');
    if (m[2] && m[2] !== snapshot) throw new CommandError('Saved records changed; restart list from page 1.');
    const n = parsePage(m[1]), all = [...s.records].sort((a, b) => a.id.localeCompare(b.id));
    if (n > Math.max(1, Math.ceil(all.length / 10)))
      throw new CommandError(`Page out of range. Use ${route} list`);
    return `${usage(s)}\nCurrent list ${n}/${Math.max(1, Math.ceil(all.length / 10))}\n${
        all.slice((n - 1) * 10, n * 10)
            .map(a => `${a.id} · ${a.lesson || 'Untitled'} · ${status(a)}`)
            .join('\n') ||
        `No saved items. Start: ${metadata.example}`}\n${
        n * 10 < all.length ? `Next: ${route} list ${n + 1} snapshot ${snapshot}` :
                              `Open: ${route} show ID`}`;
  }
  if ((m = command.match(/^(show|review) (\S+)(?: (?:page )?(\d+))?(?: rev (\d+))?$/))) {
    const a = get(s, m[2]);
    return page(
        a, m[1], m[1] === 'show' ? JSON.stringify(envelope(a), null, 2) : review(a), parsePage(m[3]), m[4]);
  }
  if ((m = command.match(/^export (\S+)$/))) {
    const out = envelope(get(s, m[1]));
    if (serializedBytes(out) > 24576)
      throw new CommandError('Legacy record exceeds export limit; use show pages, then delete.');
    return JSON.stringify(out);
  }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) {
    const a = get(s, m[1]);
    if (!m[2]) return `Deletes application and its observations/reflection: ${route} delete ${a.id} confirm`;
    return save(state => {
      assertRevision(get(state, a.id).revision, a.revision);
      state.records = state.records.filter(x => x.id !== a.id);
      return null;
    }, 'remove');
  }
  if (command.startsWith('create ')) {
    const [lesson, sourceLabel, sourceExcerpt] = fields(command.slice(7), [120, 120, 1800]);
    boundedText(sourceExcerpt, {label: 'Source excerpt', maxBytes: 1800, maxUnits: 600, trim: false});
    return save(state => {
      if (state.records.length === 20)
        throw new CommandError('Twenty applications retained; delete one first.');
      const a: Application = {
        id: newId,
        revision: 1,
        planRevision: 1,
        observationRevision: 1,
        lesson,
        sourceLabel,
        sourceExcerpt,
        opportunity: '',
        action: '',
        prediction: '',
        observations: [],
        reflection: null
      };
      state.records.push(a);
      return a;
    });
  }
  if ((m = command.match(/^apply (\S+)\s*\|([\s\S]*)$/))) {
    const key = m[1], [opportunity, action] = fields(m[2], [180, 300]);
    return edit(key, a => {
      a.opportunity = opportunity;
      a.action = action;
      a.planRevision++;
    }, 'lifecycle');
  }
  if ((m = command.match(/^(predict|observe|reflect) (\S+)\s*\|([\s\S]*)$/))) {
    const [, verb, key, input] = m, [value] = fields(input, [240]);
    return edit(key, a => {
      if (verb === 'predict') {
        a.prediction = value;
        a.planRevision++;
      } else if (verb === 'observe') {
        if (!ready(a))
          throw new CommandError(
              'Complete lesson, provenance, opportunity, action and prediction before observe; use review.');
        if (a.observations.length === 5)
          throw new CommandError(
              'Five observations retained; remove an observation explicitly before adding another.');
        a.observations.push({id: newId, date, text: value, planRevision: a.planRevision});
        a.observationRevision++;
      } else {
        if (!a.observations.some(o => o.planRevision === a.planRevision))
          throw new CommandError('Observe the current plan before reflecting.');
        a.reflection = {
          text: value,
          planRevision: a.planRevision,
          observationRevision: a.observationRevision
        };
      }
    }, 'lifecycle');
  }
  if ((m = command.match(
           /^edit (\S+) (lesson|sourceLabel|sourceExcerpt|opportunity|action|prediction)\s*\|([\s\S]*)$/))) {
    const key = m[1], field = m[2] as Field, [value] = fields(m[3], [sizes[field]]);
    if (field === 'sourceExcerpt')
      boundedText(value, {label: 'Source excerpt', maxBytes: 1800, maxUnits: 600, trim: false});
    return edit(key, a => {
      a[field] = value;
      a.planRevision++;
    }, ['opportunity', 'action', 'prediction'].includes(field) ? 'lifecycle' : 'content');
  }
  if ((m = command.match(
           /^clear (\S+) (lesson|sourceLabel|sourceExcerpt|opportunity|action|prediction|reflection) confirm$/))) {
    const key = m[1], field = m[2];
    return edit(key, a => {
      if (field === 'reflection')
        a.reflection = null;
      else {
        a[field as Field] = '';
        a.planRevision++;
      }
    }, 'remove');
  }
  if ((m = command.match(/^observation (\S+) edit (\S+)\s*\|([\s\S]*)$/))) {
    const key = m[1], oid = m[2], [day, value] = fields(m[3], [10, 240]);
    civilDate(day);
    return edit(key, a => {
      const o = a.observations.find(o => o.id === oid);
      if (!o) throw new CommandError('Observation not found; use show.');
      if (!ready(a)) throw new CommandError('Complete the plan before reasserting an observation.');
      Object.assign(o, {date: day, text: value, planRevision: a.planRevision});
      a.observationRevision++;
    }, 'lifecycle');
  }
  if ((m = command.match(/^observation (\S+) remove (\S+) confirm$/))) {
    const key = m[1], oid = m[2];
    return edit(key, a => {
      if (!a.observations.some(o => o.id === oid)) throw new CommandError('Observation not found.');
      a.observations = a.observations.filter(o => o.id !== oid);
      a.observationRevision++;
    }, 'remove');
  }
  throw new CommandError(`Unknown or incomplete command. Use ${route} help`);
}
export default {
  ...metadata,
  async execute(command: string, ctx: AgentFeatureContext):
      Promise<string> {
        try {
          return await execute(command, ctx);
        } catch (error) {
          ctx.signal?.throwIfAborted();
          if (error instanceof CommandError)
            return `${error.message}
Next: ${route} help`;
          return `Saved work could not be read or confirmed safely. Inspect before retrying; a dispatched save may have completed. Help remains available; ask the operator about scoped state recovery if this persists.
Next: ${route} list`;
        }
      },
} satisfies AgentFeature;
