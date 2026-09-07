import {add,find,InputError,label,number,parts,touch,type Entry,type Feature} from "./core.js";
type Criterion={name:string;weight:number};type Option={name:string;scores:{criterion:string;value:number}[]};
const criteria=(e:Entry)=>e.data.criteria as Criterion[],options=(e:Entry)=>e.data.options as Option[];
export function rankScorecard(e:Entry){
 if(!criteria(e).length||!options(e).length)throw new InputError("Add at least one criterion and option before ranking.");
 const incomplete=options(e).flatMap(o=>criteria(e).filter(c=>!o.scores.some(s=>s.criterion===c.name)).map(c=>o.name+" / "+c.name));
 if(incomplete.length)throw new InputError("Score every pairing first. Missing: "+incomplete.join(", "));
 const weight=criteria(e).reduce((n,c)=>n+c.weight,0),rows=options(e).map(o=>({name:o.name,score:criteria(e).reduce((n,c)=>n+c.weight*o.scores.find(s=>s.criterion===c.name)!.value,0)/(5*weight)*100})).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
 return label(e)+"\n"+rows.map((r,i)=>`${i+1}. ${r.name}: ${r.score.toFixed(1)}%`).join("\n")+"\n"+(rows.length>1&&Math.abs(rows[0].score-rows[1].score)<0.000001?"Top score is tied. ":"")+"Scores reflect your inputs, not an independent recommendation.";
}
export const scorecards:Feature={
 id:"scorecards",title:"Decision scorecards",description:"Compare options with weighted criteria, complete scoring and transparent rankings.",
 help:"create Choose architecture\ncriterion <id> | Simplicity | 5\noption <id> | Bolt\nscore <id> | Bolt | Simplicity | 4\nrank <id>\nremove-option <id> | Bolt | confirm\nremove-criterion <id> | Simplicity | confirm",
 run(entries,verb,args,now){
  if(verb==="create")return label(add(entries,args,"",now,{criteria:[],options:[]}));
  if(verb==="rank")return rankScorecard(find(entries,args));
  if(["criterion","option","score","remove-option","remove-criterion"].includes(verb)){
   const fields=parts(args,verb==="option"?2:verb==="score"?4:3),e=find(entries,fields[0]),name=fields[1];if(name.length>80)throw new InputError("Names are limited to 80 characters.");
   if(verb==="criterion"){const weight=number(fields[2],1,10),existing=criteria(e).find(c=>c.name===name);if(existing)existing.weight=weight;else{if(criteria(e).length>=10)throw new InputError("Use at most 10 criteria.");criteria(e).push({name,weight});}}
   if(verb==="option"){if(options(e).some(o=>o.name===name))throw new InputError("Option already exists.");if(options(e).length>=10)throw new InputError("Use at most 10 options.");options(e).push({name,scores:[]});}
   if(verb==="score"){const o=options(e).find(o=>o.name===name),c=criteria(e).find(c=>c.name===fields[2]);if(!o||!c)throw new InputError("Option or criterion not found; names are case-sensitive.");const value=number(fields[3],0,5),existing=o.scores.find(s=>s.criterion===c.name);if(existing)existing.value=value;else o.scores.push({criterion:c.name,value});}
   if(verb.startsWith("remove-")){if(fields[2]!=="confirm")throw new InputError("Removal needs | confirm.");if(verb==="remove-option"){if(!options(e).some(o=>o.name===name))throw new InputError("Option not found.");e.data.options=options(e).filter(o=>o.name!==name);}else{if(!criteria(e).some(c=>c.name===name))throw new InputError("Criterion not found.");e.data.criteria=criteria(e).filter(c=>c.name!==name);options(e).forEach(o=>o.scores=o.scores.filter(s=>s.criterion!==name));}}
   e.body=`Criteria: ${criteria(e).map(c=>c.name+" (weight "+c.weight+")").join(", ")}\nOptions: ${options(e).map(o=>o.name).join(", ")}`;touch(e,now);return label(e)+"\n"+e.body;
  }
 }
};
