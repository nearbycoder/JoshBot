import {add,find,InputError,label,parts,touch,type Entry,type Feature} from "./core.js";
const aliases=(e:Entry)=>e.data.aliases as string[];
const terms=(e:Entry)=>[e.title,...aliases(e)].map(v=>v.toLocaleLowerCase("en-US"));
function available(entries:Entry[],term:string,exclude?:string){if(term.length>80)throw new InputError("Terms and aliases are limited to 80 characters.");if(entries.some(e=>e.id!==exclude&&terms(e).includes(term.toLocaleLowerCase("en-US"))))throw new InputError("That term or alias already belongs to another definition.");}
export const glossary:Feature={
 id:"glossary",title:"Personal glossary",description:"Keep definitions and aliases, find exact terms and quiz yourself on your own vocabulary.",
 help:"define ADR | Architecture decision record\nalias <id> | Architecture record\nlookup adr\nrevise <id> | Updated definition\nquiz <id> (answer hidden)\nanswer <id>\nunalias <id> | Architecture record",
 validateRename(entries,entry,title){available(entries,title,entry.id);},
 run(entries,verb,args,now){
  if(verb==="define"){const [term,definition]=parts(args,2);available(entries,term);return label(add(entries,term,definition,now,{aliases:[]}));}
  if(verb==="lookup"){const match=entries.find(e=>terms(e).includes(args.trim().toLocaleLowerCase("en-US")));return match?`${label(match)}\n${match.body}\nAliases: ${aliases(match).join(", ")||"none"}`:"No exact term or alias found. Try list <part of a term>.";}
  if(verb==="quiz"){const e=find(entries,args);return `What does ${e.title} mean?\nUse answer ${e.id.slice(0,8)} when you are ready.`;}
  if(verb==="answer"){const e=find(entries,args);return e.title+"\n"+e.body;}
  if(["alias","unalias","revise"].includes(verb)){
   const [id,value]=parts(args,2),e=find(entries,id);
   if(verb==="alias"){available(entries,value,e.id);if(terms(e).includes(value.toLocaleLowerCase("en-US")))throw new InputError("This entry already has that term or alias.");if(aliases(e).length>=10)throw new InputError("Use at most 10 aliases.");aliases(e).push(value);}
   else if(verb==="unalias"){if(!aliases(e).some(a=>a.toLowerCase()===value.toLowerCase()))throw new InputError("Alias not found.");e.data.aliases=aliases(e).filter(a=>a.toLowerCase()!==value.toLowerCase());}
   else e.body=value;
   touch(e,now);return `${label(e)}\n${e.body}\nAliases: ${aliases(e).join(", ")||"none"}`;
  }
 }
};
