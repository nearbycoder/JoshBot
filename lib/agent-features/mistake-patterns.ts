import {createHash, randomUUID} from 'node:crypto';
import * as v from 'valibot';

import {assertQuota as kitAssertQuota, assertRevision as kitAssertRevision, assertStateVersion as kitAssertStateVersion, serializedBytes as kitSerializedBytes} from './feature-kit/bounded-state.js';
import {civilDate as kitCivilDate} from './feature-kit/civil-time.js';
import {boundedText as kitBoundedText, type DisplayPart, pageAt as kitPageAt, paginateParts as kitPaginateParts, parsePage as kitParsePage, pipeFields as kitPipeFields} from './feature-kit/command-and-display.js';
import metadata from './mistake-patterns.metadata.js';
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
const serializedBytes: typeof kitSerializedBytes = (...args) =>
    checked(() => kitSerializedBytes(...args));
const civilDate: typeof kitCivilDate = (...args) => checked(() => kitCivilDate(...args));

const route = '/nobo-help agent mistake-patterns';
const help = `${metadata.help}\nRule/evidence versions have an intentional finite limit of 9,007,199,254,740,991. At exhaustion, changes/removals needing a new version are refused; valid saved data and history stay unchanged. Use export ID for the complete record, then delete ID confirm only to erase that entire root and its history, or create a separate record from explicitly re-entered data. Root revision ceilings still permit removals when semantic versions have capacity.`;
// These versions identify retained evidence, so exhaustion must never reuse one.
function nextVersion(current: number, subject: string, rootId: string): number {
  if (current === Number.MAX_SAFE_INTEGER)
    throw new CommandError(`This operation needs a new ${subject} version, but the finite history limit is exhausted. Saved data is unchanged; this removal/change was not applied. Export the complete record: ${route} export ${rootId}. To erase this entire record and its owned history: ${route} delete ${rootId} confirm. You may instead create a separate record from explicitly re-entered data.`);
  return current + 1;
}

const id = v.pipe(v.string(), v.uuid()),
      rev = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
const text = (bytes: number) => v.pipe(v.string(), v.check(s => {
  try {
    boundedText(s, {label: 'Text', maxBytes: bytes, trim: false, allowEmpty: true});
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
const opportunity = v.strictObject({
  id,
  date: day,
  outcome: v.picklist(['success', 'failure']),
  evidence: text(160),
  ruleRevision: rev
});
const rule = v.strictObject({
  kind: v.literal('rule'),
  id,
  revision: rev,
  ruleRevision: rev,
  text: text(240),
  category: text(80),
  startDate: v.nullable(day),
  opportunities: v.pipe(v.array(opportunity), v.maxLength(60))
});
const incident = v.strictObject({
  kind: v.literal('case'),
  id,
  revision: rev,
  date: v.nullable(day),
  situation: text(180),
  observableError: text(300),
  category: text(80),
  preventionRuleId: v.nullable(id)
});
type Rule = v.InferOutput<typeof rule>;
type Case = v.InferOutput<typeof incident>;
type Record = Rule|Case;
const schema = v.strictObject({
  version: v.literal(1),
  records: v.pipe(v.array(v.variant('kind', [rule, incident])), v.maxLength(72))
});
type State = v.InferOutput<typeof schema>;
const initial: State = {
  version: 1,
  records: []
};
const rules = (s: State) => s.records.filter((r): r is Rule => r.kind === 'rule');
const cases = (s: State) => s.records.filter((r): r is Case => r.kind === 'case');
function validate(raw: unknown): State {
  assertStateVersion(raw, 1);
  const p = v.safeParse(schema, raw);
  if (!p.success)
    throw new CommandError(
        'Invalid saved mistake-patterns data; preserved. Ask a maintainer to repair state; help remains available.');
  const s = p.output, rs = rules(s), cs = cases(s), ids = s.records.map(r => r.id);
  if (rs.length > 12 || cs.length > 60 ||
      rs.reduce((n, r) => n + Math.max(1, r.opportunities.length), 0) > 60)
    throw new CommandError(
        'Count quota: 60 cases, 12 rules, 60 opportunities including each rule\'s reserved first follow-up.');
  for (const r of rs) {
    ids.push(...r.opportunities.map(o => o.id));
    if (r.ruleRevision > r.revision ||
        r.opportunities.some(
            o => !o.evidence.trim() || o.ruleRevision > r.ruleRevision ||
                (o.ruleRevision === r.ruleRevision &&
                 (!r.text.trim() || !r.category.trim() || !r.startDate))))
      throw new CommandError('Invalid saved rule/evidence revision; preserved.');
  }
  for (const c of cs)
    if (c.preventionRuleId && !rs.some(r => r.id === c.preventionRuleId && r.category === c.category))
      throw new CommandError(
          'A linked case needs an existing rule in the same category; unlink it before changing the category.');
  if (new Set(ids).size !== ids.length) throw new CommandError('Duplicate saved IDs; preserved.');
  return s;
}
const get = (s: State, key: string) => {
  const r = s.records.find(r => r.id === key);
  if (!r) throw new CommandError(`Record not found. Use ${route} list`);
  return r;
};
const getRule = (s: State, key: string) => {
  const r = get(s, key);
  if (r.kind !== 'rule') throw new CommandError('Use a rule ID from list.');
  return r;
};
const getCase = (s: State, key: string) => {
  const r = get(s, key);
  if (r.kind !== 'case') throw new CommandError('Use a case ID from list.');
  return r;
};
const envelope = (r: Record) => ({feature: metadata.id, version: 1, record: r});
// Content stamps protect same-revision removals without changing persisted schema.
const stamp = (r: Record) => createHash("sha256").update(JSON.stringify(envelope(r))).digest("hex");
const pageToken = (r: Record) => `${r.revision}:${stamp(r)}`;
function assertSnapshot(r: Record, expected: string) {
  if (stamp(r) !== expected) throw new CommandError("Record changed; inspect and retry from the current saved record.");
}
function checkPage(r: Record, page: number, expected?: string) {
  if (expected?.includes(":")) {
    if (expected === pageToken(r)) return;
  } else if (page === 1 && expected === undefined) return;
  else if (page === 1 && r.revision < Number.MAX_SAFE_INTEGER && expected === String(r.revision)) return;
  throw new CommandError(`Record changed or page snapshot missing. Restart: ${route} show ${r.id} page 1`);
}
function parts(s: string): DisplayPart[] {
  return s.split(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/g)
      .map((text, i) => ({text, atomic: i % 2 === 1}));
}
function page(r: Record, verb: string, body: string, n = 1, expected?: string, snapshot?: string) {
  checkPage(r, n, expected);
  return pageAt(
             paginateParts(parts(body), {
               mode: 'plain',
               title: `${r.kind} ${r.id} · revision ${r.revision}`,
               command: p => `${route} ${verb} ${r.id} page ${p} rev ${pageToken(r)}${
                   snapshot ? ` snapshot ${snapshot}` : ''}`
             }),
             n)
      .text;
}
function report(s: State, r: Rule) {
  const cs = cases(s).filter(c => c.category === r.category),
        current = r.opportunities.filter(o => o.ruleRevision === r.ruleRevision),
        stale = r.opportunities.length - current.length;
  const rows = [`Rule ${r.id}: ${r.text || 'unknown rule'}\nCategory: ${
      r.category ||
      'unknown'}; start civil date: ${r.startDate ?? 'unknown'}. Start date is included in AFTER.\n`];
  if (!r.startDate || !r.category.trim() || !r.text.trim())
    rows.push('Comparison unknown: supply rule, category and start date.\n');
  else
    for (const [label, after] of [['BEFORE (< start)', false], ['AFTER (>= start)', true]] as const) {
      const incidents = cs.filter(c => c.date !== null && (c.date >= r.startDate!) === after),
            exposures = current.filter(o => (o.date >= r.startDate!) === after),
            failures = exposures.filter(o => o.outcome === 'failure').length;
      rows.push(`${label}: ${incidents.length} recorded incidents; ${
          exposures.length ?
              `${exposures.length} recorded opportunities, ${exposures.length - failures} successes, ${
                  failures} failures; reported failure fraction ${failures}/${exposures.length}` :
              'opportunity denominator unknown (no reports); no rate or improvement inferred'}.\n`);
    }
  rows.push(`${cs.filter(c => c.date === null).length} undated cases excluded from date buckets; ${
      stale} stale opportunities excluded from current denominators.\n`);
  if (!r.startDate || !current.some(o => o.date >= r.startDate!))
    rows.push('MISSING FOLLOW-UP: no current opportunity reports on or after the start date.\n');
  if (rules(s).some(x => x.id !== r.id && x.category === r.category))
    rows.push('Overlapping category rules: observations cannot establish which rule caused a change.\n');
  rows.push(
      'Incident counts and opportunity reports are separate, potentially incomplete logs; incidents/opportunities is not an estimated recurrence rate. Categories are user labels, not diagnoses.\n');
  for (const c of cs)
    rows.push(`Case ${c.id} · ${c.date ?? 'undated'}: ${c.situation}\nObservable error: ${
        c.observableError}\nLinked rule: ${c.preventionRuleId ?? 'none'}\n`);
  for (const o of r.opportunities)
    rows.push(`Opportunity ${o.id} · ${o.date} · ${o.outcome} · ${
        o.ruleRevision === r.ruleRevision ? 'current rule' :
                                            'STALE earlier rule'}\nEvidence: ${o.evidence}\n`);
  return rows.join('');
}
function future(s: State): State {
  return {
    version: 1,
    records: s.records.map(
        r => r.kind === 'case' ? {
          ...r,
          revision: Number.MAX_SAFE_INTEGER,
          preventionRuleId: '00000000-0000-4000-8000-000000000000'
        } :
                                 {
                                   ...r,
                                   revision: Number.MAX_SAFE_INTEGER,
                                   ruleRevision: Number.MAX_SAFE_INTEGER,
                                   opportunities: (r.opportunities.length ? r.opportunities : [{
                                                    id: '00000000-0000-4000-8000-000000000000',
                                                    date: '9999-12-31',
                                                    outcome: 'failure' as const,
                                                    evidence: '\\'.repeat(160),
                                                    ruleRevision: Number.MAX_SAFE_INTEGER
                                                  }]).map((o, i) => ({
                                                            ...o,
                                                            ...(i === 0 ? {
                                                              evidence: '\\'.repeat(160),
                                                              date: '9999-12-31',
                                                              outcome: 'failure' as const
                                                            } :
                                                                          {}),
                                                            ruleRevision: Number.MAX_SAFE_INTEGER
                                                          }))
                                 })
  };
}
function admit(s: State, lifecycle: boolean) {
  for (const r of s.records) page(r, 'show', JSON.stringify(envelope(r), null, 2));
  const projected = future(s), limits = {maxRecords: 72};
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
const fields = (s: string, sizes: number[]) =>
    pipeFields(s, sizes.map(maxBytes => ({label: 'Field', maxBytes: maxBytes + 32})))
        .map((x, i) => boundedText(x, {label: 'Field', maxBytes: sizes[i], trim: false}));
async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  boundedText(command, {label: 'Command', maxBytes: 16000});
  if (command === 'help') return help;
  const s = validate(await ctx.store.read('state') ?? initial), newId = randomUUID();
  const usage = (state: State) => `${cases(state).length}/60 cases, ${rules(state).length}/12 rules, ${
      rules(state).reduce(
          (n, r) => n + r.opportunities.length,
          0)}/60 opportunities. ${serializedBytes(state)}/49152 saved bytes; ${
      serializedBytes(future(state))}/49152 projected bytes (32768 content). Free space: ${
      route} list, then delete ID confirm.`;
  const save = (change: (s: State) => Record | null, mode: 'content'|'lifecycle'|'remove' = 'content') =>
      ctx.store.update('state', initial, raw => {
        const state = validate(raw), r = change(state);
        validate(state);
        if (mode !== 'remove') admit(state, mode === 'lifecycle');
        return {
          value: state,
          result: `${
              r ? `Saved privately: ${r.id} · revision ${r.revision}\nNext: ${route} ${
                      r.kind === 'rule' ? 'review' : 'show'} ${r.id}` :
                  'Deleted privately.'}\n${usage(state)}`
        };
      });
  const edit =
      (key: string, change: (r: Record, state: State) => void,
       mode: 'content'|'lifecycle'|'remove' = 'content') => {
        const expected = stamp(get(s, key));
        return save(state => {
          const r = get(state, key);
          assertSnapshot(r, expected);
          if (mode !== 'remove' && r.revision === Number.MAX_SAFE_INTEGER)
            throw new CommandError("Revision limit reached; only explicit removals or deletion remain available.");
          change(r, state);
          r.revision = Math.min(r.revision + 1, Number.MAX_SAFE_INTEGER);
          return r;
        }, mode);
      };
  let m: RegExpMatchArray|null;
  if ((m = command.match(/^list(?: (?:page )?(\d+))?(?: snapshot ([0-9a-f]{64}))?$/))) {
    const snapshot = createHash('sha256').update(JSON.stringify(s)).digest('hex');
    if (m[2] && m[2] !== snapshot)
      throw new CommandError('Saved records changed; restart list from page 1.');
    const n = parsePage(m[1]), all = [...s.records].sort((a, b) => a.id.localeCompare(b.id)),
          total = Math.max(1, Math.ceil(all.length / 10));
    if (n > total) throw new CommandError('Page out of range; use list.');
    return `${usage(s)}\nCurrent list ${n}/${total}\n${
        all.slice((n - 1) * 10, n * 10)
            .map(r => `${r.kind} ${r.id} · ${r.kind === 'rule' ? r.text : r.situation}`)
            .join('\n') ||
        `No saved items. Start: ${metadata.example}`}\n${
        n < total ? `Next: ${route} list ${n + 1} snapshot ${snapshot}` : `Open: ${route} show ID`}`;
  }
  if ((m = command.match(
           /^(show|review) (\S+)(?: (?:page )?(\d+))?(?: rev (\d+(?::[a-f0-9]{64})?))?(?: snapshot ([0-9a-f]{64}))?$/))) {
    const r = get(s, m[2]), snapshot = createHash('sha256').update(JSON.stringify(s)).digest('hex');
    if (m[5] && m[5] !== snapshot)
      throw new CommandError('Case/rule data changed; restart review from page 1.');
    return page(
        r, m[1], m[1] === 'show' ? JSON.stringify(envelope(r), null, 2) : report(s, getRule(s, r.id)),
        parsePage(m[3]), m[4], m[1] === 'review' ? snapshot : undefined);
  }
  if ((m = command.match(/^export (\S+)$/))) {
    const out = envelope(get(s, m[1]));
    if (serializedBytes(out) > 24576)
      throw new CommandError('Legacy export too large; use show pages then delete.');
    return JSON.stringify(out);
  }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) {
    const r = get(s, m[1]);
    if (!m[2])
      return `Deletes this record and owned opportunities; linked cases are retained and unlinked: ${
          route} delete ${r.id} confirm`;
    return save(state => {
      assertSnapshot(get(state, r.id), stamp(r));
      const linked = cases(s).filter(c => c.preventionRuleId === r.id);
      const currentLinked = cases(state).filter(c => c.preventionRuleId === r.id);
      if (currentLinked.length !== linked.length || currentLinked.some(c => !linked.some(old => old.id === c.id && stamp(old) === stamp(c))))
        throw new CommandError("Linked cases changed; inspect before deleting the rule again.");
      state.records = state.records.filter(x => x.id !== r.id);
      for (const c of cases(state))
        if (c.preventionRuleId === r.id) {
          c.preventionRuleId = null;
          c.revision = Math.min(c.revision + 1, Number.MAX_SAFE_INTEGER);
        }
      return null;
    }, 'remove');
  }
  if (command.startsWith('record ')) {
    const [date, situation, observableError, category] = fields(command.slice(7), [10, 180, 300, 80]);
    civilDate(date);
    return save(state => {
      if (cases(state).length >= 60)
        throw new CommandError('Case count quota reached (60); delete a case first.');
      const c: Case = {
        kind: 'case',
        id: newId,
        revision: 1,
        date,
        situation,
        observableError,
        category,
        preventionRuleId: null
      };
      state.records.push(c);
      return c;
    });
  }
  if (command.startsWith('rule add ')) {
    const [text, category, startDate] = fields(command.slice(9), [240, 80, 10]);
    civilDate(startDate);
    return save(state => {
      if (rules(state).length >= 12)
        throw new CommandError('Rule count quota reached (12); delete a rule first.');
      const r: Rule = {
        kind: 'rule',
        id: newId,
        revision: 1,
        ruleRevision: 1,
        text,
        category,
        startDate,
        opportunities: []
      };
      state.records.push(r);
      return r;
    });
  }
  if ((m = command.match(
           /^edit (\S+) (date|situation|observableError|category|text|startDate)\s*\|([\s\S]*)$/))) {
    const [, key, field, input] = m, sizes: {[key: string]: number} = {
      date: 10,
      situation: 180,
      observableError: 300,
      category: 80,
      text: 240,
      startDate: 10
    },
                         [value] = fields(input, [sizes[field]]);
    if (field === 'date' || field === 'startDate') civilDate(value);
    return edit(key, r => {
      if (r.kind === 'case') {
        if (!['date', 'situation', 'observableError', 'category'].includes(field))
          throw new CommandError('Case fields: date, situation, observableError, category.');
        r[field as 'situation' | 'observableError' | 'category' | 'date'] = value;
      } else {
        if (!['text', 'category', 'startDate'].includes(field))
          throw new CommandError('Rule fields: text, category, startDate.');
        r[field as 'text' | 'category' | 'startDate'] = value;
        r.ruleRevision = nextVersion(r.ruleRevision, "rule/evidence", r.id);
      }
    });
  }
  if ((m = command.match(
           /^clear (\S+) (date|situation|observableError|category|text|startDate) confirm$/))) {
    const [, key, field] = m;
    return edit(key, r => {
      if (r.kind === 'case') {
        if (field === 'date')
          r.date = null;
        else if (['situation', 'observableError', 'category'].includes(field))
          r[field as 'situation' | 'observableError' | 'category'] = '';
        else
          throw new CommandError('Unknown case field.');
      } else {
        const revision = nextVersion(r.ruleRevision, "rule/evidence", r.id);
        if (field === 'startDate')
          r.startDate = null;
        else if (field === 'text' || field === 'category')
          r[field] = '';
        else
          throw new CommandError('Unknown rule field.');
        r.ruleRevision = revision;
      }
    }, 'remove');
  }
  if ((m = command.match(/^link (\S+)\s*\|([\s\S]*)$/))) {
    const key = m[1], [rid] = fields(m[2], [36]), expectedRule = stamp(getRule(s, rid));
    return edit(key, (_, state) => {
      const c = getCase(state, key), r = getRule(state, rid);
      assertSnapshot(r, expectedRule);
      if (c.category !== r.category) throw new CommandError('Case and rule categories must match.');
      c.preventionRuleId = r.id;
    }, 'lifecycle');
  }
  if ((m = command.match(/^unlink (\S+) confirm$/))) {
    const key = m[1];
    return edit(key, (_, state) => {
      getCase(state, key).preventionRuleId = null;
    }, 'remove');
  }
  if ((m = command.match(/^opportunity (\S+)\s*\|([\s\S]*)$/))) {
    const key = m[1], [date, outcome, evidence] = fields(m[2], [10, 7, 160]);
    civilDate(date);
    if (outcome !== 'success' && outcome !== 'failure')
      throw new CommandError('Outcome must be success or failure, as reported by you.');
    const lifecycle = getRule(s, key).opportunities.length === 0;
    return edit(key, (_, state) => {
      const r = getRule(state, key);
      if (!r.text.trim() || !r.category.trim() || !r.startDate)
        throw new CommandError('Complete rule, category and start date before reporting opportunities.');
      if (rules(state).reduce((n, rule) => n + Math.max(1, rule.opportunities.length), 0) +
              (r.opportunities.length ? 1 : 0) >
          60)
        throw new CommandError(
            'Opportunity count quota reached (60 including reserved first follow-ups); remove an opportunity first.');
      r.opportunities.push({id: newId, date, outcome, evidence, ruleRevision: r.ruleRevision});
    }, lifecycle ? 'lifecycle' : 'content');
  }
  if ((m = command.match(/^opportunity (\S+) edit (\S+)\s*\|([\s\S]*)$/))) {
    const [, key, oid, input] = m, [date, outcome, evidence] = fields(input, [10, 7, 160]);
    civilDate(date);
    if (outcome !== 'success' && outcome !== 'failure')
      throw new CommandError('Outcome must be success or failure.');
    return edit(key, (_, state) => {
      const r = getRule(state, key), o = r.opportunities.find(o => o.id === oid);
      if (!o) throw new CommandError('Opportunity not found; use show.');
      if (!r.text.trim() || !r.category.trim() || !r.startDate)
        throw new CommandError('Complete the rule before reasserting an opportunity.');
      Object.assign(o, {date, outcome, evidence, ruleRevision: r.ruleRevision});
    }, getRule(s, key).opportunities[0]?.id === oid ? 'lifecycle' : 'content');
  }
  if ((m = command.match(/^opportunity (\S+) remove (\S+) confirm$/))) {
    const [, key, oid] = m;
    return edit(key, (_, state) => {
      const r = getRule(state, key);
      if (!r.opportunities.some(o => o.id === oid)) throw new CommandError('Opportunity not found.');
      r.opportunities = r.opportunities.filter(o => o.id !== oid);
    }, 'remove');
  }
  // The pipe form keeps arbitrary labels distinct from pagination words, including
  // a category literally named "page 2". Generated filtered continuations use it.
  const filtered =
      command.match(/^patterns(?: page (\d+))?(?: snapshot ([0-9a-f]{64}))?\s*\|([\s\S]*)$/);
  if (filtered ||
      (m = command.match(/^patterns(?: ([\s\S]*?))?(?: page (\d+))?(?: snapshot ([0-9a-f]{64}))?$/))) {
    const snapshot = createHash('sha256').update(JSON.stringify(s)).digest('hex');
    const expectedSnapshot = filtered ? filtered[2] : m![3];
    if (expectedSnapshot && expectedSnapshot !== snapshot)
      throw new CommandError('Case/rule data changed; restart patterns from page 1.');
    const category = filtered ? fields(filtered[3], [80])[0] :
        m![1]                 ? boundedText(m![1], {label: 'Category', maxBytes: 80}) :
                                null,
          selected = category === null ? s.records : s.records.filter(r => r.category === category),
          groups = [...new Set(selected.map(r => r.category))].sort();
    const body =
        groups
            .map(cat => {
              const cs = cases(s).filter(c => c.category === cat),
                    rs = rules(s).filter(r => r.category === cat);
              return `Category ${cat || 'unknown'}: ${cs.length} cases, ${rs.length} rules.\n` +
                  cs.map(c => `Case ${c.id} · ${c.date ?? 'undated'}: ${c.observableError}\n`).join('') +
                  rs.map(
                        r => `Rule ${r.id}: ${r.text}\n${
                            r.opportunities.some(
                                o => o.ruleRevision === r.ruleRevision && r.startDate &&
                                    o.date >= r.startDate) ?
                                'Current post-start opportunity reports: ' +
                                    r.opportunities
                                        .filter(
                                            o => o.ruleRevision === r.ruleRevision && r.startDate &&
                                                o.date >= r.startDate)
                                        .length :
                                'MISSING FOLLOW-UP; denominator unknown'}\nReview: ${route} review ${
                            r.id}\n`)
                      .join('');
            })
            .join('\n') ||
        'No cases/rules in this category. Use list or record.';
    return pageAt(
               paginateParts(
                   parts(`Current category summary; user labels, no diagnosis or causal inference.\n${
                       body}`),
                   {
                     mode: 'plain',
                     command: p => `${route} patterns page ${p} snapshot ${snapshot}${
                         category === null ?
                             '' :
                             ` | ${category.replaceAll('\\', '\\\\').replaceAll('|', '\\|')}`}`
                   }),
               parsePage(filtered ? filtered[1] : m![2]))
        .text;
  }
  throw new CommandError(`Unknown or incomplete command. Use ${route} help`);
}
export default {
  ...metadata,
  help,
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
