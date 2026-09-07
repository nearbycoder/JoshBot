import { add, date, find, InputError, label, number, parts, touch, type Feature } from "./core.js";
export const journal:Feature={
 id:"journal",title:"Daily journal",description:"Dated reflections with mood, wins and lessons; review date ranges without sending them to a model.",
 help:"write 2026-09-07 | 4 | Shipped a feature | Start smaller next time\nentry 2026-09-07\nreview 2026-09-01 | 2026-09-30\nUse write again on the same date to replace that day's entry.",
 run(entries,verb,args,now){
  if(verb==="write"){const [day,mood,wins,lesson]=parts(args,4);date(day);const score=number(mood,1,5);if(!Number.isInteger(score))throw new InputError("Mood must be a whole number from 1 to 5.");let e=entries.find(e=>e.data.day===day);if(!e)e=add(entries,day,"",now);e.data={day,mood:score,wins,lesson};e.body=`Wins: ${wins}\nLessons: ${lesson}`;touch(e,now);return `${label(e)}\nMood: ${score}/5\n${e.body}`;}
  if(verb==="entry"){const day=date(args),e=entries.find(e=>e.data.day===day);if(!e)throw new InputError("No journal entry for that date.");return `${label(e)}\nMood: ${e.data.mood}/5\n${e.body}`;}
  if(verb==="review"){const [from,to]=parts(args,2);date(from);date(to);if(from>to)throw new InputError("Start date must precede end date.");const rows=entries.filter(e=>String(e.data.day)>=from&&String(e.data.day)<=to).sort((a,b)=>String(a.data.day).localeCompare(String(b.data.day)));if(!rows.length)return "No entries in that range.";return `${rows.length} days recorded · Average mood ${(rows.reduce((n,e)=>n+Number(e.data.mood),0)/rows.length).toFixed(1)}/5\n\n${rows.map(e=>`${e.data.day} · ${e.data.mood}/5\n${e.body}`).join("\n\n")}`;}
 }
};
