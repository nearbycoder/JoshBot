#!/usr/bin/env node
/** Offline, bounded benchmark of the real runtime and server built by production Vite. */
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const seed = 20261022;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Linux resourceUsage.maxRSS can include the fork parent before exec. VmHWM is
// the exec'd benchmark process's resident high-water mark.
const highWaterRss = () => process.platform === 'linux' ? Number(readFileSync('/proc/self/status','utf8').match(/^VmHWM:\s+(\d+)/m)[1])*1024 : process.memoryUsage().rss;
const mib = bytes => +(bytes / 1048576).toFixed(2);
const quantile = (values, p) => +[...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.ceil(values.length*p)-1)].toFixed(3);

async function worker(bundle, mode) {
  // No inherited credentials, provider access or production records. Trap network
  // before importing the application; only loopback is allowed for server smoke.
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Benchmark forbids external fetch');
    return nativeFetch(input, options);
  };
  const cpu = process.cpuUsage(), started = performance.now();
  const loop = monitorEventLoopDelay({resolution: 10}); loop.enable();
  let peak = process.memoryUsage().rss;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  if (mode === 'server') {
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    const api = createServer((_req, res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ok:true,bot_id:'BBENCH',user_id:'UBENCH',team_id:'TBENCH'})); }).listen(0,'127.0.0.1');
    await once(api,'listening');
    const { startNoboServer } = await import(bundle);
    const server = await startNoboServer({signingSecret:'offline-benchmark',token:'xoxb-offline',port:0,host:'127.0.0.1',backgroundRunners:false,clientOptions:{slackApiUrl:`http://127.0.0.1:${api.address().port}/api/`,retryConfig:{retries:0},timeout:1000}});
    const readyMs = performance.now()-started;
    const health = await fetch(`http://127.0.0.1:${server.server.address().port}/healthz`);
    if (health.status !== 200) throw new Error('Production bootstrap health failed');
    await sleep(100); globalThis.gc?.();
    const idle = process.memoryUsage();
    await server.stop(); api.close(); api.closeAllConnections();
    clearInterval(sampler); loop.disable();
    return {mode,readyMs:+readyMs.toFixed(2),idleRssMiB:mib(idle.rss),idleHeapMiB:mib(idle.heapUsed),peakRssMiB:mib(Math.max(peak,highWaterRss())),cpuMs:+((process.cpuUsage(cpu).user+process.cpuUsage(cpu).system)/1000).toFixed(2)};
  }
  if (mode === 'maximum') {
    const { runAgentFeature } = await import(bundle);
    const latencies=[];
    let largestBytes=0;
    const services={generate:async()=>{throw new Error('No inference');},search:async()=>{throw new Error('No search');},readContext:async()=>{
      await sleep(5);
      // 1,500 unique records, near16MiB total; each text is under the adapter's12k bound.
      const items=Array.from({length:1500},(_,i)=>({id:`note-${i}`,kind:'note',title:`Evidence ${i}`,text:`${i} `+'x'.repeat(10900),metadata:{source:'synthetic'},updatedAt:'2026-10-22T12:00:00Z'}));
      largestBytes=items.reduce((sum,item)=>sum+Buffer.byteLength(item.text),0);
      return items;
    }};
    const feature={id:'maximum-benchmark',title:'Maximum',description:'Offline validation',help:'Help',execute:async(_,ctx)=>String((await ctx.services.readContext()).length)};
    const outcomes=await Promise.all(Array.from({length:3},async(_,i)=>{
      const start=performance.now();
      const answer=await runAgentFeature(feature,'read',{teamId:'TBENCH',userId:`UMAX${i}`},{timezone:'UTC',backend:{get:async()=>null,compareSet:async()=>true},services});
      latencies.push(performance.now()-start);return answer;
    }));
    if(outcomes.some(answer=>answer!=='1500'))throw new Error(`Maximum context failed: ${outcomes}`);
    await sleep(30);clearInterval(sampler);loop.disable();
    return {mode,offered:3,accepted:3,rejected:0,itemsPerInvocation:1500,textBytesPerInvocation:largestBytes,p95Ms:quantile(latencies,.95),eventLoopMaxMs:+(loop.max/1e6).toFixed(3),peakRssMiB:mib(Math.max(peak,highWaterRss())),cpuMs:+((process.cpuUsage(cpu).user+process.cpuUsage(cpu).system)/1000).toFixed(2)};
  }
  const { handleAgentCommand } = await import(bundle);
  const owner = {teamId:'TBENCH',userId:'UBENCH',channelId:'CBENCH'};
  await handleAgentCommand('help',owner);
  const coldHelpMs = performance.now()-started;
  await sleep(50); globalThis.gc?.();
  const idle = process.memoryUsage();
  const data = new Map();
  let reads=0,writes=0,contextCalls=0,activeContext=0,peakContext=0;
  const backend = {async get(key){reads++;return data.get(key)??null;},async compareSet(key,previous,next){writes++;if((data.get(key)??null)!==previous)return false;data.set(key,next);return true;}};
  const services = {
    async generate(){throw new Error('Deterministic benchmark must not infer');},
    async search(){throw new Error('Deterministic benchmark must not search');},
    async readContext(){
      contextCalls++; activeContext++; peakContext=Math.max(peakContext,activeContext);
      try {await sleep(10);return Array.from({length:600},(_,i)=>({id:`note-${seed}-${i}`,kind:'note',title:`Atlas evidence ${i}`,text:`Atlas reference ${i} `+'bounded offline evidence '.repeat(60),updatedAt:'2026-10-22T12:00:00Z'}));}
      finally {activeContext--;}
    }
  };
  const settings = {backend,services,timezone:'UTC',now:new Date('2026-10-22T12:00:00Z')};
  for(let i=0;i<40;i++) await handleAgentCommand(`inbox capture ${i} `+'synthetic '.repeat(390),owner,settings);
  const deterministic=[];
  for(let i=0;i<100;i++){const start=performance.now();await handleAgentCommand('inbox list',owner,settings);deterministic.push(performance.now()-start);}
  const burst=[],busy=[];let accepted=0,rejected=0;
  let profiler;
  if(process.env.NOBO_BENCH_PROFILE){
    const { Session }=await import('node:inspector/promises');
    profiler=new Session();profiler.connect();await profiler.post('Profiler.enable');await profiler.post('Profiler.start');
  }
  const stressCpu=process.cpuUsage(),stressStart=performance.now();
  for(let round=0;round<3;round++) await Promise.all(Array.from({length:32},async(_,i)=>{
    const start=performance.now();
    const result=await handleAgentCommand('recall search Atlas --limit 10',{...owner,userId:`UBENCH${i}`,requestId:`burst-${round}-${i}`},settings);
    const elapsed=performance.now()-start;
    if(/busy/i.test(result)){rejected++;busy.push(elapsed);}else {accepted++;burst.push(elapsed);}
  }));
  const stressCpuMs=(process.cpuUsage(stressCpu).user+process.cpuUsage(stressCpu).system)/1000;
  const stressWallMs=performance.now()-stressStart;
  const burstContextCalls=contextCalls;
  if(profiler){const {profile}=await profiler.post('Profiler.stop');profiler.disconnect();await writeFile(process.env.NOBO_BENCH_PROFILE,JSON.stringify(profile));}
  const mixed={offered:60,accepted:0,rejected:0,deterministicAccepted:0,recallAccepted:0,deterministicP95Ms:0,recallP95Ms:0,wallMs:0,cpuMs:0,completedPerSecond:0};
  const mixedDeterministic=[],mixedRecall=[],mixedTasks=[];
  const mixedStart=performance.now(),mixedCpu=process.cpuUsage();
  // Bounded closed-loop arrivals: 3 cheap commands : 1 recall, 10ms apart.
  // Actual arrival duration is reported; event-loop stalls delay this driver too.
  for(let i=0;i<60;i++){
    await sleep(10);
    const recall=i%4===3;
    mixedTasks.push((async()=>{
      const start=performance.now();
      const result=await handleAgentCommand(recall?'recall search Atlas --limit 10':'inbox list',{...owner,userId:recall?`UMIX${i}`:owner.userId},settings);
      if(/busy/i.test(result)){mixed.rejected++;return;}
      mixed.accepted++;const elapsed=performance.now()-start;
      if(recall){mixed.recallAccepted++;mixedRecall.push(elapsed);}else{mixed.deterministicAccepted++;mixedDeterministic.push(elapsed);}
    })());
  }
  await Promise.all(mixedTasks);
  mixed.wallMs=+(performance.now()-mixedStart).toFixed(2);
  mixed.cpuMs=+((process.cpuUsage(mixedCpu).user+process.cpuUsage(mixedCpu).system)/1000).toFixed(2);
  mixed.completedPerSecond=+(mixed.accepted/(mixed.wallMs/1000)).toFixed(2);
  mixed.deterministicP95Ms=mixedDeterministic.length?quantile(mixedDeterministic,.95):null;
  mixed.recallP95Ms=mixedRecall.length?quantile(mixedRecall,.95):null;
  await sleep(30);clearInterval(sampler);loop.disable();
  return {mode,seed,node:process.version,coldHelpMs:+coldHelpMs.toFixed(2),idleRssMiB:mib(idle.rss),idleHeapMiB:mib(idle.heapUsed),deterministic:{count:100,p50Ms:quantile(deterministic,.5),p95Ms:quantile(deterministic,.95)},overload:{offered:96,accepted,rejected,p50Ms:quantile(burst,.5),p95Ms:quantile(burst,.95),busyP95Ms:busy.length?quantile(busy,.95):null,peakContextCalls:peakContext,contextCalls:burstContextCalls,stressWallMs:+stressWallMs.toFixed(2),stressCpuMs:+stressCpuMs.toFixed(2)},mixed,eventLoopP95Ms:+(loop.percentile(95)/1e6).toFixed(3),eventLoopMaxMs:+(loop.max/1e6).toFixed(3),peakRssMiB:mib(Math.max(peak,highWaterRss())),cpuMs:+((process.cpuUsage(cpu).user+process.cpuUsage(cpu).system)/1000).toFixed(2),backend:{reads,writes,keys:data.size}};
}
if(process.argv[2]==='--worker') {
  try { const result=await worker(process.argv[3],process.argv[4]);process.send?.({result}); }
  catch(error){process.send?.({error:String(error?.stack??error)});process.exitCode=1;}
} else {
  await (async()=>{
  const { build } = await import('vite');
  const root=process.cwd(), directory=await mkdtemp(join(tmpdir(),'joshbot-agent-bench-'));
  try {
    await build({configFile:resolve('vite.config.ts'),logLevel:'error',build:{ssr:true,outDir:directory,emptyOutDir:true,rollupOptions:{input:{runtime:resolve('lib/agent-features/index.ts'),server:resolve('src/server.ts'),engine:resolve('lib/agent-features/runtime.ts')},output:{entryFileNames:'[name].mjs'}}}});
    await symlink(resolve('node_modules'),join(directory,'node_modules'),'dir');
    const profileFlag=process.argv.indexOf('--profile');
    const profile=profileFlag>=0?resolve(process.argv[profileFlag+1]):undefined;
    const run=mode=>new Promise((resolve,reject)=>{
      // Explicit environment allowlist: never inherit Redis/provider/Slack secrets.
      const child=fork(new URL(import.meta.url),['--worker',pathToFileURL(join(directory,`${mode==='runtime'?'runtime':mode==='maximum'?'engine':'server'}.mjs`)).href,mode],{execArgv:['--expose-gc','--max-old-space-size=384'],env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',TZ:'UTC',...(profile?{NOBO_BENCH_PROFILE:profile}:{})},stdio:['ignore','ignore','pipe','ipc']});
      let result,error,stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
      const timeout=setTimeout(()=>{child.kill();reject(new Error('Benchmark exceeded 45s'));},45000);
      child.on('message',message=>{result=message.result;error=message.error;});
      child.on('exit',code=>{clearTimeout(timeout);code===0&&result?resolve(result):reject(new Error(error??stderr??`Exit ${code}`));});
    });
    if(profile){console.log(JSON.stringify({profile,workload:'three32-commandrecallbursts',result:await run('runtime')},null,2));process.exitCode=0;return;}
    const runtime=[];for(let i=0;i<3;i++)runtime.push(await run('runtime'));
    const server=[];for(let i=0;i<3;i++)server.push(await run('server'));
    const maximum=[];for(let i=0;i<3;i++)maximum.push(await run('maximum'));
    const output={recordedAt:new Date().toISOString(),seed,node:process.version,commit:(()=>{try{return execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return 'archive';}})(),platform:process.platform,arch:process.arch,cpuModel:cpus()[0]?.model,runtime,maximum,server};
    const json=JSON.stringify(output,null,2);console.log(json);
    const outputFlag=process.argv.indexOf('--output');if(outputFlag>=0)await writeFile(process.argv[outputFlag+1],json+'\n');
    if(process.argv.includes('--check'))for(const sample of runtime){if(sample.peakRssMiB>256||sample.deterministic.p95Ms>50||sample.overload.p95Ms>250||sample.eventLoopMaxMs>150||sample.overload.peakContextCalls>3||sample.overload.accepted!==9||sample.overload.rejected!==87||sample.mixed.accepted!==60)throw new Error('Runtime performance budget exceeded');}
  } finally {await rm(directory,{recursive:true,force:true});}
  })();
}
