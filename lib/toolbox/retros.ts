import {add,find,InputError,label,number,parts,touch,type Entry,type Feature} from "./core.js";
type Card={number:number;category:string;text:string;priority:number;resolved:boolean};
const cards=(e:Entry)=>e.data.cards as Card[];
function report(e:Entry){return label(e)+"\n"+["keep","change","try"].map(category=>category.toUpperCase()+"\n"+cards(e).filter(c=>c.category===category).sort((a,b)=>b.priority-a.priority||a.number-b.number).map(c=>`${c.number}. [${c.resolved?"resolved":"open"}; priority ${c.priority}] ${c.text}`).join("\n")).join("\n\n");}
export const retros:Feature={
 id:"retros",title:"Retrospective boards",description:"Prepare a personal keep/change/try retrospective and prioritize improvements before sharing.",
 help:"create Sprint 12\nadd <id> | keep | Small PRs\nadd <id> | change | Slow reviews\npriority <id> | 2 | 5\nresolve <id> | 2 · reopen <id> | 2\nedit <id> | 2 | Faster reviews\nreport <id>",
 run(entries,verb,args,now){
  if(verb==="create")return label(add(entries,args,"",now,{cards:[],next:1}));
  if(verb==="report")return report(find(entries,args));
  if(["add","priority","resolve","reopen","edit"].includes(verb)){const [id,field,value]=parts(args,["resolve","reopen"].includes(verb)?2:3),e=find(entries,id);
   if(verb==="add"){if(!["keep","change","try"].includes(field))throw new InputError("Category must be keep, change or try.");if(cards(e).length>=50)throw new InputError("A board holds at most 50 cards.");cards(e).push({number:Number(e.data.next),category:field,text:value,priority:3,resolved:false});e.data.next=Number(e.data.next)+1;}
   else{const card=cards(e).find(c=>c.number===number(field,1));if(!card)throw new InputError("Card number not found.");if(verb==="priority"){const p=number(value,1,5);if(!Number.isInteger(p))throw new InputError("Priority is a whole number from 1 to 5.");card.priority=p;}else if(verb==="edit")card.text=value;else card.resolved=verb==="resolve";}
   e.body=cards(e).map(c=>c.text).join("\n");touch(e,now);return report(e);
  }
 }
};
