import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import metadata from "./pantry-plan.metadata.js";
const MAX_RECORDS=12;
// LCM(1..100) makes every permitted serving ratio exact in one bounded integer
// coordinate. It never grows with the number of plans or consumptions.
const gcd=(a:bigint,b:bigint):bigint=>{while(b){const t=a%b;a=b;b=t;}return a;};
const SERVING_SCALE=Array.from({length:100},(_,i)=>BigInt(i+1)).reduce((a,b)=>a/gcd(a,b)*b,1n);
const DENOMINATOR=1000n*SERVING_SCALE;
type Ingredient={id:string;name:string;quantity:string;unit:string};
type Stock=Ingredient&{remaining:string};
type Preview={token:string;servings:number;sourceStamp:string};
type RecordData={id:string;title:string;revision:number;createdAt:string;updatedAt:string;baseServings:number|null;ingredients:Ingredient[];stock:Stock[];preview:Preview|null};
type State={version:1;records:RecordData[]};
function normalized(name:string):string{return name.normalize("NFC").toLowerCase().replace(/\s+/gu," ").trim();}
function unit(v:unknown):string{if(typeof v!=="string"||!/^[a-z][a-z0-9-]{0,23}$/.test(v))fail("Unit must be 1–24 lowercase ASCII letters/digits/hyphens, starting with a letter; only g/kg and ml/l convert.");return v;}
function family(u:string):string{return u==="g"||u==="kg"?"g":u==="ml"||u==="l"?"ml":u;}
function key(e:Ingredient):string{return JSON.stringify([normalized(e.name),family(e.unit)]);}
function quantity(v:unknown):string{if(typeof v!=="string"||!/^(0|[1-9]\d*)(?:\.\d{1,3})?$/.test(v))fail("Quantity must be 0–1000000, at most 3 decimal places.");const [a,b=""]=v.split("."),n=BigInt(a)*1000n+BigInt(b.padEnd(3,"0"));if(n>1_000_000_000n)fail("Quantity maximum is 1000000.");return v;}
function coordinate(e:Ingredient):bigint{const [a,b=""]=quantity(e.quantity).split(".");return (BigInt(a)*1000n+BigInt(b.padEnd(3,"0")))*SERVING_SCALE*(e.unit==="kg"||e.unit==="l"?1000n:1n);}
function sourceStamp(r:RecordData):string{return createHash("sha256").update(JSON.stringify({title:r.title,baseServings:r.baseServings,ingredients:r.ingredients,stock:r.stock})).digest("hex");}
function display(n:bigint):string{const d=DENOMINATOR;if(n%d===0n)return String(n/d);const g=gcd(n,d);if((n*1000n)%d===0n){const x=n*1000n/d;return `${x/1000n}.${String(x%1000n).padStart(3,"0")}`.replace(/0+$/,"");}return `${n/g}/${d/g} (exact fraction)`;}
function validateRecord(v:unknown):asserts v is RecordData{
 object(v,["id","title","revision","createdAt","updatedAt","baseServings","ingredients","stock","preview"]);validBase(v);if(v.baseServings!==null)validNumber(v.baseServings,1,100);
 for(const field of ["ingredients","stock"] as const){if(!Array.isArray(v[field])||v[field].length>20)throw new Error("Invalid ingredient/pantry rows.");for(const e of v[field]){object(e,["id","name","quantity","unit",...(field==="stock"?["remaining"]:[])]);validId(e.id);validText(e.name,160);if(!normalized(e.name as string))throw new Error("Empty key.");quantity(e.quantity);unit(e.unit);if(field==="stock"&&(typeof e.remaining!=="string"||! /^(0|[1-9]\d{0,59})$/.test(e.remaining)||BigInt(e.remaining)>coordinate(e as unknown as Ingredient)))throw new Error("Invalid remaining stock.");}unique(v[field].map(e=>e.id));}
 const r=v as unknown as RecordData;unique(r.stock.map(key));
 if(v.preview!==null){object(v.preview,["token","servings","sourceStamp"]);validId(v.preview.token);validNumber(v.preview.servings,1,100);if(typeof v.preview.sourceStamp!=="string"||!/^[a-f0-9]{64}$/.test(v.preview.sourceStamp)||v.preview.sourceStamp!==sourceStamp(r)||!r.baseServings||!r.ingredients.length)throw new Error("Invalid/stale stored preview.");}
}
function projectLifecycle(s:State):State{return {...s,records:s.records.map(r=>({...r,revision:MAX_REVISION,preview:{token:"plan-00000000-0000-0000-0000-000000000000",servings:100,sourceStamp:"f".repeat(64)}}))};}
type Need={name:string;unit:string;needed:bigint;available:bigint|null;stockId:string|null;incompatible:boolean;ingredients:string[]};
function needs(r:RecordData,servings:number):Need[]{if(r.baseServings===null)fail("Base servings unknown. Use edit ID | baseServings | NUMBER.");if(!r.ingredients.length)fail("Add ingredients before planning.");const map=new Map<string,Need>();for(const e of r.ingredients){const k=key(e),entry=map.get(k);if(entry){entry.needed+=coordinate(e)*BigInt(servings)/BigInt(r.baseServings);entry.ingredients.push(e.id);}else{const s=r.stock.find(s=>key(s)===k);map.set(k,{name:normalized(e.name),unit:family(e.unit),needed:coordinate(e)*BigInt(servings)/BigInt(r.baseServings),available:s?BigInt(s.remaining):null,stockId:s?.id??null,incompatible:r.stock.some(s=>normalized(s.name)===normalized(e.name)&&family(s.unit)!==family(e.unit)),ingredients:[e.id]});}}return [...map.values()];}
function previewLines(r:RecordData):string[]{if(!r.preview)fail(`No current preview. Next: ${ROUTE} show ${r.id}`);const p=r.preview,lines=[`Recipe ${r.id} · ${r.title}`,`Preview only: ${r.baseServings} base servings → ${p.servings} servings. Stock has not been consumed.`,`Plan token ${p.token}`,"Only matching normalized names and compatible unit keys combine. Missing stock is unknown; enter an explicit zero to know the gap."];
 for(const n of needs(r,p.servings)){lines.push(`${n.name} [${n.unit}]: ${display(n.needed)} ${n.unit} needed; ${n.available===null?"unknown stock; shopping gap unknown":`${display(n.available)} ${n.unit} available; ${display(n.needed>n.available?n.needed-n.available:0n)} ${n.unit} shopping gap`}${n.incompatible?"; incompatible pantry units also entered, excluded":""}.`);for(const id of n.ingredients)lines.push(`Ingredient ${id}`);if(n.stockId)lines.push(`Pantry ${n.stockId}`);}
 lines.push("Exact fractions are retained and consumed without decimal rounding. No substitution, density, nutrition or food-safety inference.",`Next: ${ROUTE} use ${r.id} ${p.token} confirm`);return lines;
}
async function executeDomain(verb:string,rest:string,context:AgentFeatureContext):Promise<string>{
 if(verb==="create"){const [title,servings]=fields(rest,160,3),r:RecordData={...base(context,"recipe",text(title,"Recipe",160)),baseServings:integer(servings,1,100,"Servings"),ingredients:[],stock:[],preview:null};return mutate(context,undefined,s=>{s.records.push(r);return saved(r.id,"Recipe saved. Add ingredients, then enter stock (zero is explicit). ");});}
 if(verb==="edit"||verb==="clear"){const v=verb==="edit"?fields(rest,80,20,160):words(rest,3);if(verb==="clear"&&v[2]!=="confirm")fail("Use clear ID FIELD confirm.");return mutate(context,v[0],(_,r)=>{if(v[1]==="title")r!.title=text(verb==="clear"?"":v[2],"Title",160,verb==="clear");else if(v[1]==="baseServings")r!.baseServings=verb==="clear"?null:integer(v[2],1,100,"Base servings");else if(v[1]!=="preview"||verb!=="clear")fail("Field must be title/baseServings; clear also accepts preview.");r!.preview=null;return saved(v[0],"Field updated; prior consumption preview invalidated.");},verb==="clear"?"remove":"content");}
 if(verb==="ingredient"||verb==="pantry"){
  const m=/^(\S+)\s+(add|edit|remove)\s+([\s\S]+)$/.exec(rest);if(!m)fail(`Use ${verb} ID edit CHILD | NAME | QUANTITY | UNIT; remove CHILD confirm. ingredient also supports add.`);const [,id,mode,input]=m;if(verb==="pantry"&&mode==="add")fail("Use stock ID | NAME | QUANTITY | UNIT to set pantry stock.");
  if(mode==="remove"){const [child,confirm]=words(input,2);if(confirm!=="confirm")fail("Removal requires confirm.");return mutate(context,id,(_,r)=>{const list=verb==="ingredient"?r!.ingredients:r!.stock;if(!list.some(e=>e.id===child))fail("Row not found in this recipe.");if(verb==="ingredient")r!.ingredients=r!.ingredients.filter(e=>e.id!==child);else r!.stock=r!.stock.filter(e=>e.id!==child);r!.preview=null;return saved(id,"Row removed; preview invalidated.");},"remove");}
  const v=fields(input,...(mode==="edit"?[80]:[]),160,12,24),child=mode==="edit"?v.shift()!:`ingredient-${randomUUID()}`,entry:Ingredient={id:child,name:text(v[0],"Ingredient",160),quantity:quantity(v[1]),unit:unit(v[2])};
  return mutate(context,id,(_,r)=>{if(verb==="ingredient"){if(mode==="add"){if(r!.ingredients.length>=20)fail("Maximum 20 ingredients.");r!.ingredients.push(entry);}else{const e=r!.ingredients.find(e=>e.id===child);if(!e)fail("Ingredient not found.");Object.assign(e,entry);}}else{const e=r!.stock.find(e=>e.id===child);if(!e)fail("Pantry row not found.");if(r!.stock.some(s=>s.id!==child&&key(s)===key(entry)))fail("Pantry key already exists; edit that row or remove it explicitly.");Object.assign(e,entry,{remaining:String(coordinate(entry))});}r!.preview=null;return saved(id,`Row ${child} saved; preview invalidated. ${verb==="pantry"?"Entered stock replaces remaining amount.":""}`);});
 }
 if(verb==="stock"){const [id,name,q,u]=fields(rest,80,160,12,24),entry:Stock={id:`stock-${randomUUID()}`,name:text(name,"Ingredient",160),quantity:quantity(q),unit:unit(u),remaining:"0"};entry.remaining=String(coordinate(entry));return mutate(context,id,(_,r)=>{const existing=r!.stock.find(e=>key(e)===key(entry));if(existing){const stableId=existing.id;Object.assign(existing,entry,{id:stableId});}else{if(r!.stock.length>=20)fail("Maximum 20 pantry rows.");r!.stock.push(entry);}r!.preview=null;return saved(id,`Pantry ${existing?.id??entry.id} amount replaced explicitly; preview invalidated.`);});}
 if(verb==="plan"){const [id,target]=fields(rest,80,3),servings=integer(target,1,100,"Servings"),token=`plan-${randomUUID()}`;await mutate(context,id,(_,r)=>{needs(r!,servings);r!.preview={token,servings,sourceStamp:sourceStamp(r!)};return "";},"lifecycle");const r=find(await read(context),id);if(r.preview?.token!==token)fail("Recipe changed; preview was invalidated. Run plan again.");return report(previewLines(r),`preview ${id}`,1,"Private · saved consumption preview",pageVersion(r));}
 if(verb==="preview"){const args=words(rest,1,4),r=find(await read(context),args[0]);return report(previewLines(r),`preview ${r.id}`,recordPage(r,`preview ${r.id}`,args.slice(1)),"Private · saved consumption preview",pageVersion(r));}
 if(verb==="use"){const [id,token,confirm]=words(rest,3);if(confirm!=="confirm")fail("Use ID PLAN_TOKEN confirm is required to consume stock.");return mutate(context,id,(_,r)=>{const p=r!.preview;if(!p||p.token!==token||p.sourceStamp!==sourceStamp(r!))fail("Stale or already used preview token. Make a fresh plan.");for(const n of needs(r!,p.servings)){if(n.stockId&&n.available!==null){const stock=r!.stock.find(s=>s.id===n.stockId)!;stock.remaining=String(n.available>n.needed?n.available-n.needed:0n);}}r!.preview=null;return saved(id,"Reviewed available stock consumed once. Missing/insufficient stock was not invented or purchased; preview removed.");},"lifecycle");}
 fail("Unknown command. Use help for supported syntax.");
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
