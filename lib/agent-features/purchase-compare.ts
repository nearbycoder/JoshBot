import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import metadata from "./purchase-compare.metadata.js";
const MAX_RECORDS=12;
type Offer={id:string;name:string;priceMinor:number|null;shippingMinor:number|null;discountMinor:number|null;quantityMilli:number|null;recurringMinorPerMonth:number|null;lifeMonths:number|null};
type RecordData={id:string;title:string;revision:number;createdAt:string;updatedAt:string;currency:string;unit:string;horizonMonths:number|null;offers:Offer[]};
type State={version:1;records:RecordData[]};
function decimal(v:string,places:number,min:bigint,max:bigint,label:string):number{
 if(!new RegExp(`^(0|[1-9]\\d*)(?:\\.\\d{1,${places}})?$`).test(v))fail(`${label} must be plain nonnegative decimal with at most ${places} places, or unknown.`);const [a,b=""]=v.split("."),scale=10n**BigInt(places),n=BigInt(a)*scale+BigInt(b.padEnd(places,"0"));if(n<min||n>max)fail(`${label} outside its supported range; quantity must be positive and amounts/quantity at most 1000000.`);return Number(n);
}
function currency(v:unknown):string{if(typeof v!=="string"||!/^[A-Z][A-Z0-9]{0,11}$/.test(v))fail("Currency must be a 1–12 character uppercase ASCII label, starting with a letter.");return v;}
function money(n:bigint,d=1n):string{const cents=(2n*n+d)/(2n*d);return `${cents/100n}.${String(cents%100n).padStart(2,"0")}`;}
function quantity(n:number):string{return `${Math.floor(n/1000)}.${String(n%1000).padStart(3,"0")}`.replace(/\.?0+$/,"");}
const NUMERIC_FIELDS={price:"priceMinor",shipping:"shippingMinor",discount:"discountMinor",usableQuantity:"quantityMilli",recurringCostPerMonth:"recurringMinorPerMonth",lifeMonths:"lifeMonths"} as const;
function checkDiscount(o:Offer):void{if(o.priceMinor!==null&&o.shippingMinor!==null&&o.discountMinor!==null&&o.discountMinor>o.priceMinor+o.shippingMinor)fail("Discount exceeds entered price + shipping subtotal.");}
function setOffer(o:Offer,k:string,v:string,clear=false):void{
 if(k==="name"){o.name=text(v,"Offer name",160,clear);return;}
 if(!Object.hasOwn(NUMERIC_FIELDS,k))fail("Offer fields: name, price, shipping, discount, usableQuantity, recurringCostPerMonth, lifeMonths.");
 const field=NUMERIC_FIELDS[k as keyof typeof NUMERIC_FIELDS];o[field]=clear||v==="unknown"?null:k==="lifeMonths"?integer(v,1,1200,"Life months"):decimal(v,k==="usableQuantity"?3:2,k==="usableQuantity"?1n:0n,k==="usableQuantity"?1_000_000_000n:100_000_000n,k);checkDiscount(o);
}
function validateRecord(v:unknown):asserts v is RecordData{
 object(v,["id","title","revision","createdAt","updatedAt","currency","unit","horizonMonths","offers"]);validBase(v);validText(v.currency,12,true);if(v.currency)currency(v.currency);validText(v.unit,40,true);if(v.horizonMonths!==null)validNumber(v.horizonMonths,1,1200);
 if(!Array.isArray(v.offers)||v.offers.length>8)throw new Error("Invalid offers.");for(const o of v.offers){object(o,["id","name",...Object.values(NUMERIC_FIELDS)]);validId(o.id);validText(o.name,160,true);for(const field of Object.values(NUMERIC_FIELDS))if(o[field]!==null)validNumber(o[field],field==="quantityMilli"||field==="lifeMonths"?1:0,field==="quantityMilli"?1_000_000_000:field==="lifeMonths"?1200:100_000_000);checkDiscount(o as unknown as Offer);}unique(v.offers.map(o=>o.id));
}
function projectLifecycle(s:State):State{return {...s,records:s.records.map(r=>({...r,revision:MAX_REVISION}))};}
function net(o:Offer):bigint|null{return o.priceMinor===null||o.shippingMinor===null||o.discountMinor===null?null:BigInt(o.priceMinor)+BigInt(o.shippingMinor)-BigInt(o.discountMinor);}
function offerLines(r:RecordData,o:Offer):string[]{
 const n=net(o),lines=[`Offer ${o.id} · ${o.name||"(name cleared)"}`],missing=Object.entries(NUMERIC_FIELDS).filter(([k,f])=>k!=="lifeMonths"&&o[f]===null).map(([k])=>k);
 if(missing.length)lines.push(`Unknown entered fields: ${missing.join(", ")}. Unknown is not zero.`);
 if(n===null)lines.push("Delivered cost unknown: price, shipping or discount is missing.");
 else{lines.push(`Net delivered cost: ${r.currency||"[unknown currency]"} ${money(n)} = ${money(BigInt(o.priceMinor!))} + ${money(BigInt(o.shippingMinor!))} − ${money(BigInt(o.discountMinor!))} (entered price + shipping − discount).`);if(o.quantityMilli!==null&&r.unit&&r.currency)lines.push(`Unit cost: ${r.currency} ${money(n*1000n,BigInt(o.quantityMilli))}/${r.unit} = ${money(n)} / ${quantity(o.quantityMilli)} ${r.unit}. Exact minor-unit ratio ${n*1000n}/${o.quantityMilli}; display rounded half up to 0.01.`);else lines.push("Unit cost unknown: common currency/unit or usable quantity missing.");}
 if(n===null||o.recurringMinorPerMonth===null||r.horizonMonths===null||!r.currency)lines.push("Horizon cost unknown: delivered/recurring cost, horizon or currency missing.");
 else{const h=BigInt(r.horizonMonths),recurring=BigInt(o.recurringMinorPerMonth)*h;if(o.lifeMonths===null)lines.push(`Replacement-aware horizon cost unknown: lifeMonths not supplied. One-purchase scenario only: ${r.currency} ${money(n+recurring)} = ${money(n)} + ${money(BigInt(o.recurringMinorPerMonth))} × ${h} months; excludes replacements.`);
 else{const life=BigInt(o.lifeMonths),copies=(h+life-1n)/life,total=n*copies+recurring;lines.push(`Horizon ${h} months: ${copies} purchase(s) = ceil(${h}/${life}); ${r.currency} ${money(total)} = ${money(n)} × ${copies} + ${money(BigInt(o.recurringMinorPerMonth))} × ${h}.`);if(o.quantityMilli!==null&&r.unit)lines.push(`Horizon per common usable unit: ${r.currency} ${money(total*1000n,BigInt(o.quantityMilli))}/${r.unit}.`);lines.push("Assumption: entire entered bundle lasts lifeMonths; same price/shipping/discount on each replacement, purchase at start and each expiry before horizon, recurring cost each month. No demand, quality or resale inferred.");}}
 return lines;
}
function comparisonLines(r:RecordData):string[]{
 const lines=[`${r.id} · ${r.title}`,`Common currency ${r.currency||"unknown"}; user-normalized usable unit ${r.unit||"unknown"}; horizon ${r.horizonMonths??"unknown"} months.`,"Ranks entered unit cost only, before any unentered tax. No exchange rates, quality, resale, live price or purchase recommendation inferred."];
 const ranked=r.offers.filter(o=>net(o)!==null&&o.quantityMilli!==null&&r.currency&&r.unit).slice().sort((a,b)=>{const x=net(a)!*BigInt(b.quantityMilli!)-net(b)!*BigInt(a.quantityMilli!);return x<0n?-1:x>0n?1:r.offers.indexOf(a)-r.offers.indexOf(b);});
 if(ranked.length){lines.push("Unit-cost order (exact ratios; displayed rounding can tie):");for(const [i,o]of ranked.entries())lines.push(`${i+1}. ${o.id} · ${o.name||"(name cleared)"}: ${r.currency} ${money(net(o)!*1000n,BigInt(o.quantityMilli!))}/${r.unit}`);}
 else lines.push("No complete same-currency/common-unit offers to rank.");
 for(const o of r.offers)lines.push(...offerLines(r,o));if(!r.offers.length)lines.push("No offers entered; use offer add from help.");lines.push(`Next: ${ROUTE} show ${r.id}`);return lines;
}
async function executeDomain(verb:string,rest:string,context:AgentFeatureContext):Promise<string>{
 if(verb==="create"){const [title,c,u,h]=fields(rest,160,12,40,4),r:RecordData={...base(context,"comparison",text(title,"Comparison",160)),currency:currency(c),unit:text(u,"Common usable unit",40),horizonMonths:integer(h,1,1200,"Horizon months"),offers:[]};return mutate(context,undefined,s=>{s.records.push(r);return saved(r.id,"Common currency, unit and horizon saved. Enter only already normalized quantities/costs.");});}
 if(verb==="edit"||verb==="clear"){const v=verb==="edit"?fields(rest,80,20,160):words(rest,3);if(verb==="clear"&&v[2]!=="confirm")fail("Use clear ID FIELD confirm.");return mutate(context,v[0],(_,r)=>{const k=v[1],val=verb==="clear"?"":v[2];if(k==="title"||k==="unit")r![k]=text(val,k,k==="title"?160:40,verb==="clear");else if(k==="currency")r!.currency=verb==="clear"?"":currency(val);else if(k==="horizonMonths")r!.horizonMonths=verb==="clear"||val==="unknown"?null:integer(val,1,1200,"Horizon months");else fail("Fields: title, currency, unit, horizonMonths.");return saved(v[0],"Field updated. Currency/unit edits relabel your normalized inputs; no conversion was performed.",`compare ${v[0]}`);},verb==="clear"?"remove":"content");}
 if(verb==="offer"){
  const m=/^(\S+)\s+(add|edit|clear|remove)\s+([\s\S]+)$/.exec(rest);if(!m)fail("Use offer ID add NAME | PRICE | SHIPPING | DISCOUNT | QUANTITY | MONTHLY_COST; see help for exact edits.");const [,id,mode,input]=m;
  if(mode==="remove"||mode==="clear"){const v=words(input,mode==="remove"?2:3);if(v.at(-1)!=="confirm")fail("Offer removal/clear requires confirm.");return mutate(context,id,(_,r)=>{const o=r!.offers.find(o=>o.id===v[0]);if(!o)fail("Offer not found in this comparison.");if(mode==="remove")r!.offers=r!.offers.filter(x=>x!==o);else setOffer(o,v[1],"",true);return saved(id,"Offer input removed; comparisons now use the current explicit fields.",`compare ${id}`);},"remove");}
  if(mode==="edit"){const [child,k,v]=fields(input,80,24,160);return mutate(context,id,(_,r)=>{const o=r!.offers.find(o=>o.id===child);if(!o)fail("Offer not found.");setOffer(o,k,v);return saved(id,"Entered offer field updated.",`compare ${id}`);});}
  const [name,p,s,d,q,c]=fields(input,160,12,12,12,12,12),o:Offer={id:`offer-${randomUUID()}`,name:text(name,"Offer name",160),priceMinor:null,shippingMinor:null,discountMinor:null,quantityMilli:null,recurringMinorPerMonth:null,lifeMonths:null};
  for(const [k,v]of [["price",p],["shipping",s],["discount",d],["usableQuantity",q],["recurringCostPerMonth",c]])setOffer(o,k,v);
  return mutate(context,id,(_,r)=>{if(r!.offers.length>=8)fail("Maximum 8 offers. Remove one explicitly first.");r!.offers.push(o);return saved(id,`Offer ${o.id} saved. Lifespan remains unknown until explicitly entered.`,`compare ${id}`);});
 }
 if(verb==="compare"){const args=words(rest,1,4),r=find(await read(context),args[0]);return report(comparisonLines(r),`compare ${r.id}`,recordPage(r,`compare ${r.id}`,args.slice(1)),"Private · entered-cost comparison",pageVersion(r));}
 if(verb==="what-if"){const [id,child,k,v]=fields(rest,80,80,24,12);if(!Object.hasOwn(NUMERIC_FIELDS,k))fail("What-if field must be price, shipping, discount, usableQuantity, recurringCostPerMonth or lifeMonths.");const r=find(await read(context),id),o=structuredClone(r.offers.find(o=>o.id===child));if(!o)fail("Offer not found in this comparison.");setOffer(o,k,v);return [`Private · unsaved what-if · ${id} · revision ${r.revision}`,`Only ${child}: ${k} = ${v}; saved offers unchanged.`,...offerLines(r,o),`Next: ${ROUTE} compare ${id}`].join("\n");}
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
      if (record.revision >= MAX_REVISION && kind === "content") fail("Revision limit reached. Export this record and create a new one.");
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
