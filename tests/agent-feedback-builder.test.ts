import test from "node:test";
import assert from "node:assert/strict";
import feature from "../lib/agent-features/feedback-builder.js";
import { createAgentFeatureFixture, deferred } from "./helpers/agent-feature-fixture.js";
async function create(f:ReturnType<typeof createAgentFeatureFixture>){return /feedback-[\da-f-]{36}/.exec(await f.run(feature.example.split("feedback-builder ")[1]))![0];}
async function record(f:ReturnType<typeof createAgentFeatureFixture>,id:string){return JSON.parse(await f.run(`export ${id}`)).record;}

test("catalog first example produces observation-impact-request feedback without any service",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),observation="The document arrived after the meeting began",impact="I could not prepare questions",request="Share the document one working day before the meeting";
 assert.match(await f.run(`check ${id}`),/Missing: observable behavior\/example, personal impact, specific request/);
 await f.run(`behavior ${id} | ${observation}`);await f.run(`impact ${id} | ${impact}`);await f.run(`request ${id} | ${request}`);
 const draft=await f.run(`draft ${id}`);assert.ok(draft.includes(`Observation supplied: ${observation}`));assert.ok(draft.includes(`Personal impact: ${impact}`));assert.ok(draft.includes(`Requested change: ${request}`));assert.match(draft,/Missing: none/);
 assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});assert.match(await f.run(`polish ${id}`),/Optional assistance unavailable/);assert.ok((await f.run(`draft ${id}`)).includes(observation));
});
test("exact motive text stays an interpretation; lexical matches retain case and are labeled heuristics",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),motive="I think they don't care about my time";
 await f.run(`inference ${id} | ${motive}`);await f.run(`behavior ${id} | You ALWAYS deliberately arrive late`);await f.run(`request ${id} | Try harder`);
 const check=await f.run(`check ${id}`);assert.match(check,/Lexical heuristics only/);assert.ok(check.includes('"ALWAYS"'));assert.ok(check.includes('"deliberately"'));assert.ok(check.includes('"Try harder"'));
 let draft=await f.run(`draft ${id}`);assert.ok(draft.includes(motive));assert.ok(!draft.includes(`Observation supplied: ${motive}`));
 await f.run(`reclassify ${id} confirm`);const r=await record(f,id);assert.equal(r.behavior,"");assert.equal(r.inferences[1].text,"You ALWAYS deliberately arrive late");
 draft=await f.run(`draft ${id}`);assert.match(draft,/missing observable example/);assert.match(draft,/unverified; not an observation/);
});
test("all fields and labeled interpretations can be edited and cleared; bad inputs are atomic",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);
 for(const field of ["title","situation","behavior","impact","request","positive"]){await f.run(`edit ${id} | ${field} | Exact & <label>`);assert.equal((await record(f,id))[field],"Exact & <label>");await f.run(`clear ${id} ${field} confirm`);assert.equal((await record(f,id))[field],"");}
 await f.run(`inference ${id} | Interpretation`);const e=(await record(f,id)).inferences[0];await f.run(`interpretation ${id} edit ${e.id} | Revised interpretation`);assert.equal((await record(f,id)).inferences[0].text,"Revised interpretation");
 const raw=f.backend.data.get(f.key("state"));for(const cmd of [`request ${id} | a | b`,`edit ${id} | intent | invented`,`behavior ${id} | bad\\q`])assert.doesNotMatch(await f.run(cmd),/^Saved/);assert.equal(f.backend.data.get(f.key("state")),raw);
 await f.run(`interpretation ${id} remove ${e.id} confirm`);assert.equal((await record(f,id)).inferences.length,0);await f.run(`delete ${id} confirm`);assert.match(await f.run("list"),/No saved items/);
});
test("final retained interpretation is recoverable and near-quota Unicode remains renderable/deletable",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);for(let i=0;i<20;i++)await f.run(`inference ${id} | ${i} ${"🧭".repeat(220)}`);
 const r=await record(f,id);assert.equal(r.inferences.length,20);assert.match(await f.run(`inference ${id} | too many`),/Maximum 20/);
 let cmd=`show ${id}`,output="",n=0;do{const reply=await f.run(cmd);assert.ok(reply.length<=3500);output+=reply;cmd=/Next: \/nobo-help agent feedback-builder (show \S+ \d+)/.exec(reply)?.[1]??"";n++;}while(cmd&&n<30);
 assert.ok(output.includes(r.inferences[19].text));assert.ok(output.includes(r.inferences[19].id));
 const id2=await create(f);let full=false;for(let i=0;i<20;i++){const raw=f.backend.data.get(f.key("state"));const reply=await f.run(`inference ${id2} | ${"漢".repeat(320)}`);if(!reply.startsWith("Saved")){assert.match(reply,/quota/);assert.equal(f.backend.data.get(f.key("state")),raw);full=true;break;}}assert.ok(full);
 assert.match(await f.run(`check ${id2}`),/Lexical heuristics/);assert.match(await f.run(`delete ${id2} confirm`),/^Deleted/);
});
test("polish cannot rewrite interpretations into observed facts, or accept fabricated references/quotes/oversize",async()=>{
 let mode="valid";const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{const {sources}=JSON.parse(input);const sections=sources.map((s:{ref:string;quote:string})=>({...s,text:s.quote}));if(mode==="motive")sections.find((s:{ref:string})=>s.ref.startsWith("inference-")).text="They are disrespectful";if(mode==="observation")sections.find((s:{ref:string})=>s.ref==="behavior").text="They intentionally delayed it";if(mode==="unknown")sections[0].ref="fake";if(mode==="quote")sections[0].quote="changed";if(mode==="huge")return "x".repeat(4001);return JSON.stringify({sections});}}});
 const id=await create(f);await f.run(`behavior ${id} | The document arrived at 10:03`);await f.run(`inference ${id} | I suspect a misunderstanding`);const raw=f.backend.data.get(f.key("state"));
 assert.match(await f.run(`polish ${id}`),/unsaved suggestion/);for(mode of ["motive","observation","unknown","quote","huge"])assert.match(await f.run(`polish ${id}`),/Optional assistance unavailable/);
 assert.equal(f.backend.data.get(f.key("state")),raw);assert.equal(f.calls.generate,6);
});
test("edits and deletion discard pending suggestions; private owners cannot inspect another case",async()=>{
 for(const action of ["edit","delete"]){const gate=deferred<void>(),entered=deferred<void>();const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{entered.resolve();await gate.promise;const {sources}=JSON.parse(input);return JSON.stringify({sections:sources.map((s:{ref:string;quote:string})=>({...s,text:s.quote}))});}}});const id=await create(f),pending=f.run(`polish ${id}`);await entered.promise;
 await f.run(action==="edit"?`impact ${id} | I missed a question`:`delete ${id} confirm`);const raw=f.backend.data.get(f.key("state"));gate.resolve();assert.match(await pending,/stale result was discarded/);assert.equal(f.backend.data.get(f.key("state")),raw);assert.match(await f.run(`show ${id}`,{owner:{teamId:"TOTHER",userId:"UOTHER"}}),/not found/);}
});
