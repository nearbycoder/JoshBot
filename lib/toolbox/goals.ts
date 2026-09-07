import {add,date,find,InputError,label,number,parts,touch,type Entry,type Feature} from "./core.js";
type Checkin={at:string;value:number;note:string};
const report=(e:Entry,now:Date)=>{const target=Number(e.data.target),current=Number(e.data.current),remaining=Math.max(0,target-current),days=Math.ceil((Date.parse(String(e.data.due))-Date.parse(now.toISOString().slice(0,10)))/86400000);return `${label(e)}\n${current}/${target} ${e.data.unit} · ${(current/target*100).toFixed(1)}%\nDue ${e.data.due} · ${remaining===0?"Goal reached":days<0?"Overdue":days===0?"Due today":days+" days left"}\n${remaining?remaining+" "+e.data.unit+" remaining; "+(remaining/Math.max(1,days)).toFixed(1)+" per day to finish.":"Nice work — target met."}\nRecent check-ins\n${(e.data.history as Checkin[]).slice(-5).map(c=>c.at+" · "+c.value+" · "+c.note).join("\n")}`;};
export const goals:Feature={
 id:"goals",title:"Measurable goals",description:"Track increasing numeric goals, dated check-ins, deadlines and the pace needed to finish.",
 help:"create Read books | 12 | books | 2026-12-31\nprogress <id> | 3 | Finished a novel\nreport <id>\ntarget <id> | 15\ndue <id> | 2027-01-31\nProgress is an absolute total, not an increment.",
 run(entries,verb,args,now){
  if(verb==="create"){const [title,target,unit,due]=parts(args,4);date(due);if(unit.length>40)throw new InputError("Use a unit of at most 40 characters.");return report(add(entries,title,"",now,{target:number(target,0.001),unit,due,current:0,history:[]}),now);}
  if(verb==="report")return report(find(entries,args),now);
  if(["progress","target","due"].includes(verb)){const [id,value,note]=parts(args,verb==="progress"?3:2),e=find(entries,id);
   if(verb==="progress"){if(note.length>500)throw new InputError("Check-in notes are limited to 500 characters.");e.data.current=number(value);e.data.history=[...(e.data.history as Checkin[]),{at:now.toISOString(),value:Number(e.data.current),note}].slice(-20);e.body=note;}
   if(verb==="target")e.data.target=number(value,0.001);
   if(verb==="due")e.data.due=date(value);
   touch(e,now);return report(e,now);
  }
 }
};
