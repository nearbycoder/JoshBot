import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, addCivilDays, civilDaysBetween, dateInZone } from "./feature-kit/civil-time.js";
import metadata from "./renewal-radar.metadata.js";

const MAX_RECORDS = 40;
type RecordData = { id:string; title:string; revision:number; createdAt:string; updatedAt:string;
  renewalDate:string|null; noticeDays:number|null; amountMinorUnits:number|null; currencyLabel:string|null;
  billingUnit:"month"|"year"|null; interval:number|null; status:"unreviewed"|"keep"|"change";
  termsNote:string; reviewNote:string; confirmationNote:string };
type State = { version:1; records:RecordData[] };
function validateRecord(value:unknown): asserts value is RecordData {
  object(value,["id","title","revision","createdAt","updatedAt","renewalDate","noticeDays","amountMinorUnits","currencyLabel","billingUnit","interval","status","termsNote","reviewNote","confirmationNote"]); validBase(value);
  if(value.renewalDate!==null) civilDate(value.renewalDate);
  for(const [key,max] of [["noticeDays",366],["amountMinorUnits",100_000_000],["interval",120]] as const) if(value[key]!==null) validNumber(value[key],key==="interval"?1:0,max);
  if(value.currencyLabel!==null) currency(value.currencyLabel);
  if(value.billingUnit!==null && value.billingUnit!=="month" && value.billingUnit!=="year") throw new Error("Invalid billing unit.");
  if(value.status!=="unreviewed" && value.status!=="keep" && value.status!=="change") throw new Error("Invalid decision.");
  validText(value.termsNote,1000,true);validText(value.reviewNote,160,true);validText(value.confirmationNote,160,true);
  if(value.renewalDate!==null&&value.noticeDays!==null)addCivilDays(value.renewalDate as string,-(value.noticeDays as number));
}
function projectLifecycle(s:State):State {
  // Two explicit lifecycle notes, each <=160 UTF-8 bytes (worst JSON escaping
  // is two bytes per allowed control), plus nullable date and revision growth.
  return {...s,records:s.records.map(r=>({...r,revision:MAX_REVISION,renewalDate:r.renewalDate??"9999-12-31",status:"unreviewed",reviewNote:"\n".repeat(160),confirmationNote:"\n".repeat(160)}))};
}
function currency(v:unknown):string { if(typeof v!=="string"||!/^[A-Z][A-Z0-9]{0,11}$/.test(v)) fail("Currency label must be 1–12 uppercase ASCII letters/digits, starting with a letter; no conversion.");return v; }
function money(v:string):number {
  if(!/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(v)) fail("Amount must be decimal money with at most 2 places, 0–1000000.00.");
  const [a,b=""] = v.split("."), n=BigInt(a)*100n+BigInt(b.padEnd(2,"0"));if(n>100_000_000n) fail("Amount maximum is 1000000.00.");return Number(n);
}
function amount(n:bigint,d=1n):string { const rounded=(2n*n+d)/(2n*d);return `${rounded/100n}.${String(rounded%100n).padStart(2,"0")}`; }
function cost(r:RecordData):string[] {
  if(r.amountMinorUnits===null||r.currencyLabel===null||r.billingUnit===null||r.interval===null) return ["Cost unknown: enter amount, currency, billingUnit and interval with edit."];
  const n=BigInt(r.amountMinorUnits), months=BigInt(r.interval*(r.billingUnit==="year"?12:1));
  return [`${r.currencyLabel} ${amount(n)}/${r.interval} ${r.billingUnit}(s): ${r.currencyLabel} ${amount(n,months)}/month equivalent; ${r.currencyLabel} ${amount(n*12n,months)}/year equivalent.`,
    `Exact formulas in minor units: monthly ${n}/${months}; yearly ${n*12n}/${months}. Display rounded half up to 0.01; equivalents are not invoices.`];
}
function notice(r:RecordData):string|null { return r.renewalDate===null||r.noticeDays===null?null:checked(()=>addCivilDays(r.renewalDate!,-r.noticeDays!)); }
function validateNotice(r:RecordData):void { notice(r); }
const EDIT_FIELDS=["title","renewalDate","noticeDays","amount","currency","billingUnit","interval","termsNote","reviewNote","confirmationNote"];
function setField(r:RecordData,k:string,v:string,clear=false):void {
  if(!EDIT_FIELDS.includes(k)) fail(`Field must be ${EDIT_FIELDS.join(", ")}. Use review for decisions.`);
  if(k==="title"||k==="termsNote"||k==="reviewNote"||k==="confirmationNote") r[k]=text(v,k,k==="termsNote"?1000:160,clear);
  else if(k==="renewalDate") r.renewalDate=clear?null:checked(()=>civilDate(v));
  else if(k==="noticeDays") r.noticeDays=clear?null:integer(v,0,366,"Notice days");
  else if(k==="amount") r.amountMinorUnits=clear?null:money(v);
  else if(k==="currency") r.currencyLabel=clear?null:currency(v);
  else if(k==="interval") r.interval=clear?null:integer(v,1,120,"Billing interval");
  else { if(!clear&&v!=="month"&&v!=="year") fail("Billing unit must be month or year."); r.billingUnit=clear?null:v as "month"|"year"; }
  validateNotice(r);
}
async function executeDomain(verb:string,rest:string,context:AgentFeatureContext):Promise<string> {
  if(verb==="add") {
    const v=fields(rest,160,10,3,12,12,5,3),r:RecordData={...base(context,"renewal",text(v[0],"Label",160)),renewalDate:null,noticeDays:null,amountMinorUnits:null,currencyLabel:null,billingUnit:null,interval:null,status:"unreviewed",termsNote:"",reviewNote:"",confirmationNote:""};
    for(const [i,k] of ["renewalDate","noticeDays","amount","currency","billingUnit","interval"].entries())setField(r,k,v[i+1]);
    return mutate(context,undefined,s=>{s.records.push(r);return saved(r.id,`Entered terms saved. Notice by ${notice(r)}. ${cost(r)[0]}`);});
  }
  if(verb==="edit"||verb==="clear") {
    const v=verb==="edit"?fields(rest,80,24,1000):words(rest,3);if(verb==="clear"&&v[2]!=="confirm")fail("Use clear ID FIELD confirm.");
    return mutate(context,v[0],(_,r)=>{if(verb==="clear"&&v[1]==="status"){r!.status="unreviewed";r!.reviewNote="";}else setField(r!,v[1],verb==="clear"?"":v[2],verb==="clear");return saved(v[0],"Entered field updated; no external action.");},verb==="clear"?"remove":"content");
  }
  if(verb==="review"||verb==="reschedule") {
    const [id,value,note]=fields(rest,80,10,160);text(note,"Explicit decision/confirmation note",160);
    if(verb==="review"&&value!=="keep"&&value!=="change")fail("Decision must be keep or change; this is only your local decision.");
    if(verb==="reschedule")checked(()=>civilDate(value));
    return mutate(context,id,(_,r)=>{if(verb==="review"){r!.status=value as "keep"|"change";r!.reviewNote=note;}else {r!.renewalDate=value;r!.confirmationNote=note;validateNotice(r!);}return saved(id,verb==="review"?"Local decision recorded. No subscription changed.":"Manually confirmed date recorded. No renewal, cancellation or reminder was performed.");},"lifecycle");
  }
  if(verb==="upcoming"||verb==="costs") {
    const args=words(rest,verb==="upcoming"?1:0,verb==="upcoming"?4:3),days=verb==="upcoming"?integer(args[0],0,3660,"Horizon days"):0;
    const s=await read(context),today=dateInZone(context.now,context.timezone),command=verb==="upcoming"?`upcoming ${days}`:"costs";
    const token=`1-${createHash("sha256").update(JSON.stringify({s,today})).digest("hex")}`,paging=args.slice(verb==="upcoming"?1:0);
    const page=aggregatePage(paging,token,command),end=verb==="upcoming"?checked(()=>addCivilDays(today,days)):today;
    const rows=verb==="costs"?s.records:s.records.filter(r=>!notice(r)||notice(r)!<=end).slice().sort((a,b)=>(notice(a)??"~").localeCompare(notice(b)??"~")||a.id.localeCompare(b.id));
    const lines=[`As of ${today} (${context.timezone}); manually entered terms.`,verb==="costs"?"Currencies are separate labels; no conversion or cross-currency totals.":`Notice deadlines through ${end}, including overdue and unknown. Late notice does not establish cancellation rights.`];
    for(const r of rows){lines.push(`${r.id} · ${r.title} · local decision: ${r.status}`);if(verb==="costs")lines.push(...cost(r));else{const n=notice(r),remaining=n===null?null:civilDaysBetween(today,n);lines.push(`Notice by: ${n??"unknown"}; renewal: ${r.renewalDate??"unknown"}; ${remaining===null?"unknown timing":remaining<0?`${-remaining} civil days past notice`:remaining===0?"notice date today":`${remaining} civil days until notice`}.`);}lines.push(`Next: ${ROUTE} show ${r.id}`);}
    if(!rows.length)lines.push("No matching saved terms.",`Next: ${metadata.example}`);
    return report(lines,command,page,`Private · ${verb}`,token);
  }
  fail("Unknown command. Use help for supported syntax.");
}
function aggregatePage(args:string[],token:string,command:string):number {
  if(args.length!==0&&args.length!==1&&args.length!==3) fail("Use the complete emitted page command.");
  if(args.length===3&&(args[1]!=="rev"||args[2]!==token)) fail(`Saved data/date changed; stale continuation rejected. Restart: ${ROUTE} ${command}`);
  return checked(()=>parsePage(args[0]));
}
const ROUTE = `/nobo-help agent ${metadata.id}`;
const MAX_REVISION = 999_999_999;
const EMPTY: State = { version: 1, records: [] };
class CommandError extends Error {}
function fail(message: string): never { throw new CommandError(message); }
function checked<T>(fn: () => T): T {
  try { return fn(); } catch (error) { if (error instanceof Error) fail(error.message); throw error; }
}
function text(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
  return checked(() => boundedText(value, { label, maxBytes, allowEmpty }));
}
function fields(input: string, ...limits: number[]): string[] {
  return checked(() => pipeFields(input, limits.map((maxBytes, i) => ({ label: `Field ${i + 1}`, maxBytes: maxBytes + 2, allowEmpty: true }))).map((value, i) => boundedText(value, { label: `Field ${i + 1}`, maxBytes: limits[i], allowEmpty: true })));
}
function integer(value: string, min: number, max: number, label = "Minutes"): number {
  return checked(() => parseInteger(value, { min, max, label }));
}
function words(value: string, min: number, max = min): string[] {
  const parts = value.trim() ? value.trim().split(/\s+/u) : [];
  if (parts.length < min || parts.length > max) fail("Wrong arguments. Use the exact syntax in help.");
  return parts;
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.slice().sort().join(",")) throw new Error("Invalid object fields.");
}
function validText(value: unknown, maxBytes: number, allowEmpty = false): void {
  boundedText(value, { label: "Saved text", maxBytes, allowEmpty, trim: false });
}
function validNumber(value: unknown, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error("Invalid number.");
}
function validId(value: unknown): void {
  if (typeof value !== "string" || !/^[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid ID.");
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new Error("Duplicate values.");
}
function validBase(record: Record<string, unknown>): void {
  validId(record.id); validText(record.title, 160, true); validNumber(record.revision, 1, MAX_REVISION);
  for (const value of [record.createdAt, record.updatedAt]) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Invalid timestamp.");
  }
}
function decode(value: unknown): State {
  try {
    serializedBytes(value); assertStateVersion(value, 1); object(value, ["version", "records"]);
    if (!Array.isArray(value.records) || value.records.length > MAX_RECORDS) throw new Error("Invalid records.");
    for (const record of value.records) validateRecord(record);
    unique(value.records.map(record => record.id));
    return value as unknown as State;
  } catch { fail("Saved data could not be read safely. It was preserved; no reset or mutation was performed."); }
}
const envelope = (record: RecordData) => ({ feature: metadata.id, version: 1, record });
function quota(state: State, kind: "content" | "lifecycle"): void {
  checked(() => {
    const future = projectLifecycle(state);
    assertQuota(state, kind === "content"
      ? { kind, records: state.records.map(envelope), future: { value: future, records: future.records.map(envelope) }, limits: { maxBytes: 49_152, contentBytes: 32_768, maxRecordBytes: 24_576, maxRecords: MAX_RECORDS } }
      : { kind, records: state.records.map(envelope), limits: { maxBytes: 49_152, contentBytes: 32_768, maxRecordBytes: 24_576, maxRecords: MAX_RECORDS } });
  });
}
function find(state: State, id: string): RecordData {
  const result = state.records.find(record => record.id === id);
  if (!result) fail("Item not found in your private records. Use list to find a saved ID.");
  return result;
}
async function read(context: AgentFeatureContext): Promise<State> {
  const value = await context.store.read<unknown>("state");
  context.signal?.throwIfAborted();
  return value === null ? structuredClone(EMPTY) : decode(value);
}
async function mutate(context: AgentFeatureContext, id: string | undefined, change: (state: State, record?: RecordData) => string,
  kind: "content" | "lifecycle" | "remove" = "content"): Promise<string> {
  // Bind intent once, outside the retryable transform. The snapshot also guards
  // removals at the revision ceiling; unrelated records may still retry.
  const intended = id === undefined ? undefined : JSON.stringify(find(await read(context), id));
  const timestamp = context.now.toISOString();
  return context.store.update<State, string>("state", EMPTY, current => {
    const state = structuredClone(decode(current));
    const record = id === undefined ? undefined : find(state, id);
    if (record && JSON.stringify(record) !== intended) fail(`This item changed before the command could be saved. Inspect it, then retry: ${ROUTE} show ${id}`);
    const result = change(state, record);
    if (record && state.records.includes(record)) {
      // Refuse further writes at the revision ceiling except removals. This prevents
      // a same-clock lifecycle ABA from restoring an indistinguishable snapshot.
      if (record.revision >= MAX_REVISION && kind !== "remove") fail("Revision limit reached. Export this record and create a new one.");
      record.revision = Math.min(MAX_REVISION, record.revision + 1); record.updatedAt = timestamp;
    }
    if (state.records.length > MAX_RECORDS) fail(`Maximum ${MAX_RECORDS} records. Use list, export, then delete ID confirm to free space.`);
    decode(state);
    // Removal remains possible for readable legacy state over the current byte cap.
    if (kind !== "remove") quota(state, kind);
    else if (serializedBytes(state) > serializedBytes(current)) quota(state, "lifecycle");
    return { value: state, result };
  });
}
function base(context: AgentFeatureContext, prefix: string, title: string) {
  return { id: `${prefix}-${randomUUID()}`, title, revision: 1, createdAt: context.now.toISOString(), updatedAt: context.now.toISOString() };
}
function saved(id: string, detail: string, next = `show ${id}`): string {
  return `Saved privately: ${id}\n${detail}\nNext: ${ROUTE} ${next}`;
}
// A content stamp keeps removals at the revision ceiling distinguishable too.
function pageVersion(record: RecordData): string {
  return `${record.revision}-${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}
function recordPage(record: RecordData, command: string, args: string[]): number {
  if (args.length !== 0 && args.length !== 1 && args.length !== 3) fail("Use PAGE rev REV from the emitted continuation, or restart page 1.");
  const page = checked(() => parsePage(args[0]));
  if (args.length === 3) {
    if (args[1] !== "rev" || !/^[1-9]\d{0,8}-[a-f0-9]{64}$/.test(args[2])) fail("Invalid revision token. Copy the complete continuation or restart page 1.");
    if (args[2] !== pageVersion(record)) fail(`This item changed; stale continuation rejected. Restart page 1: ${ROUTE} ${command} 1`);
  }
  return page;
}
function view(parts: { text: string; atomic?: boolean }[], command: string, page = 1, title = "Private · unsaved report", revision?: string): string {
  return checked(() => pageAt(paginateParts(parts, { mode: "plain", title, command: n => `${ROUTE} ${command} ${n}${revision ? ` rev ${revision}` : ""}` }), page).text);
}
function report(lines: string[], command: string, page = 1, title?: string, revision?: string): string {
  return view(lines.map(line => ({ text: `${line}\n`, atomic: true })), command, page, title, revision);
}
async function common(verb: string, rest: string, context: AgentFeatureContext): Promise<string | undefined> {
  if (verb === "list") {
    const args = words(rest, 0, 1), page = checked(() => parsePage(args[0]));
    const state = await read(context), total = Math.max(1, Math.ceil(state.records.length / 10));
    if (page > total) fail(`Current list has ${total} page(s). Reopen list 1.`);
    if (!state.records.length) return `No saved items yet.\nNext: ${metadata.example}`;
    const rows = state.records.slice((page - 1) * 10, page * 10).map(r => `${r.id} — ${(r.title || "(title cleared)").replace(/[\r\n]/g, " ")} · revision ${r.revision}`);
    return `Private · current list · page ${page}/${total} · ${(page - 1) * 10 + 1}–${Math.min(page * 10, state.records.length)} of ${state.records.length}\n${rows.join("\n")}\nNext: ${ROUTE} ${page < total ? `list ${page + 1}` : `show ${state.records[(page - 1) * 10].id}`}`;
  }
  if (verb === "show" || verb === "export") {
    const args = words(rest, 1, verb === "show" ? 4 : 1), record = find(await read(context), args[0]);
    if (verb === "export") {
      const result = JSON.stringify(envelope(record));
      if (serializedBytes(envelope(record)) > 24_576) fail(`This legacy record exceeds the export ceiling. Retrieve all parts with show ${record.id}.`);
      return result;
    }
    const json = JSON.stringify(envelope(record), null, 2);
    // Every field is <=1000 UTF-8 bytes (<=2000 serialized units with escapes); IDs and JSON lines stay intact.
    return view(json.split("\n").map(line => ({ text: line + "\n", atomic: true })), `show ${record.id}`, recordPage(record, `show ${record.id}`, args.slice(1)),
      `Saved privately: ${record.id} · revision ${record.revision}`, pageVersion(record));
  }
  if (verb === "delete") {
    const args = words(rest, 1, 2);
    if (args[1] !== undefined && args[1] !== "confirm") fail("Use delete ID confirm.");
    if (args[1] !== "confirm") {
      const record = find(await read(context), args[0]);
      return `Delete ${record.id} and all its owned children?\nNext: ${ROUTE} delete ${record.id} confirm`;
    }
    return mutate(context, args[0], state => {
      state.records = state.records.filter(record => record.id !== args[0]);
      return `Deleted privately: ${args[0]} and its owned children.\nNext: ${ROUTE} list`;
    }, "remove");
  }
  return undefined;
}

export default {
  ...metadata,
  async execute(command: string, context: AgentFeatureContext): Promise<string> {
    if (!command.trim() || command.trim() === "help") return metadata.help;
    try {
      text(command, "Command", 16_000);
      context.signal?.throwIfAborted();
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.trim())!;
      const verb = match[1], rest = match[2] ?? "";
      return await common(verb, rest, context) ?? await executeDomain(verb, rest, context);
    } catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof CommandError) return `${error.message}\nNext: ${ROUTE} help`;
      return `This command could not be completed safely. Any dispatched save may have completed; inspect your private records before repeating it.\nNext: ${ROUTE} list`;
    }
  },
} satisfies AgentFeature;
