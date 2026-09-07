import { add, find, InputError, label, parts, requireText, touch, type Feature } from "./core.js";
function variables(template: string) {
  const names = [...new Set([...template.matchAll(/\{\{([a-z][a-z0-9_]{0,29})\}\}/g)].map(m => m[1]))];
  if (names.length > 10 || /\{\{|\}\}/.test(template.replace(/\{\{([a-z][a-z0-9_]{0,29})\}\}/g, ""))) throw new InputError("Use at most 10 variables like {{topic}} (lowercase names, up to 30 characters).");
  return names;
}
export const prompts: Feature = {
 id:"prompts", title:"Reusable prompts", description:"Save parameterized prompts and preview filled-in text without making a model call.",
 help:"add Explain | Explain {{topic}} to a {{audience}}\nvariables <id>\nrender <id> | topic=Redis | audience=beginner\nedit <id> | New {{topic}} template",
 run(entries, verb, args, now) {
  if (verb === "add" || verb === "edit") {
   const [target, template] = parts(args, 2); requireText(template); variables(template);
   const entry = verb === "add" ? add(entries,target,template,now) : find(entries,target);
   entry.body = template; touch(entry,now); return `${label(entry)}\nVariables: ${variables(template).join(", ") || "none"}\n${template}`;
  }
  if (verb === "variables") return variables(find(entries,args).body).join(", ") || "No variables; render <id> returns the saved text.";
  if (verb === "render") {
   const [id,...pairs] = args.split("|").map(p=>p.trim()), entry=find(entries,id), expected=variables(entry.body), values=new Map<string,string>();
   for (const pair of pairs) { const match=pair.match(/^([a-z][a-z0-9_]{0,29})=([\s\S]+)$/); if(!match || !expected.includes(match[1]) || values.has(match[1])) throw new InputError("Supply each expected variable once as name=value; no unknown names."); values.set(match[1],requireText(match[2])); }
   const missing=expected.filter(name=>!values.has(name)); if(missing.length) throw new InputError("Missing values: "+missing.join(", "));
   return entry.body.replace(/\{\{([a-z][a-z0-9_]{0,29})\}\}/g,(_,name:string)=>values.get(name)!)+"\n\nPreview only — copy this text into a conversation when ready.";
  }
 }
};
