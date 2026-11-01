import assert from 'node:assert/strict';
import {mkdir,readFile,statfs,writeFile,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {cpus,freemem,totalmem} from 'node:os';

const [target,command,...args]=process.argv.slice(2);
assert(/^(macos|windows|linux)-(x64|arm64)$/.test(target)&&command);
const dir=resolve('.runtime/ci'),file=resolve(dir,`disk-${target}.json`);
await mkdir(dir,{recursive:true});
const samples=[],startedAt=new Date().toISOString();let sampling=false,previousCpu;
async function sample() {
 if(sampling)return;sampling=true;
 try {
  const fs=await statfs(process.cwd());
  let phase='starting';try{phase=(await readFile(resolve(dir,`phase-${target}.txt`),'utf8')).trim();}catch{}
  const freeGiB=fs.bavail*fs.bsize/1024**3,totalGiB=fs.blocks*fs.bsize/1024**3;
  const cpu=cpus().map(({times})=>({total:Object.values(times).reduce((a,b)=>a+b,0),idle:times.idle}));
  const deltas=previousCpu?.length===cpu.length?cpu.map((c,i)=>({total:c.total-previousCpu[i].total,idle:c.idle-previousCpu[i].idle})):[];
  const valid=deltas.length>0&&deltas.every(c=>c.total>0&&c.idle>=0&&c.idle<=c.total);
  const cpuTotalMs=valid?deltas.reduce((sum,c)=>sum+c.total,0):null;
  const cpuBusyMs=valid?deltas.reduce((sum,c)=>sum+c.total-c.idle,0):null;
  const intervalPhase=samples.at(-1)?.phase===phase?phase:null;
  previousCpu=cpu;
  samples.push({at:new Date().toISOString(),phase,freeGiB,intervalPhase,cpuTotalMs,cpuBusyMs,
   cpuBusyPercent:valid?100*cpuBusyMs/cpuTotalMs:null,
   perCpuBusyPercent:valid?deltas.map(c=>100*(c.total-c.idle)/c.total):null,
   freeMemoryGiB:freemem()/1024**3});
  const baseline=samples.find(s=>s.phase==='checkout')||samples[0];
  const workload=samples.filter(s=>s.at>=baseline.at);
  const minimumFreeGiB=Math.min(...workload.map(s=>s.freeGiB));
  const compilation=samples.filter(s=>s.intervalPhase==='compile'&&s.cpuTotalMs!==null);
  const compileCpuTotalMs=compilation.reduce((sum,s)=>sum+s.cpuTotalMs,0);
  const report={target,sourceCommit:process.env.GITHUB_SHA,startedAt,sampleIntervalSeconds:5,
   measurement:'Observed workspace filesystem usage, including OS activity; short peaks may fall between samples.',
   resourceMeasurement:'CPU is host-wide busy time from OS counter deltas, including other processes. Free memory is os.freemem(), not reclaimable memory, process RSS, swap or I/O pressure. Phase-boundary CPU intervals are excluded from compile averages.',
   logicalCpus:cpu.length,totalMemoryGiB:totalmem()/1024**3,
   compileCpuBusyPercent:compileCpuTotalMs?100*compilation.reduce((sum,s)=>sum+s.cpuBusyMs,0)/compileCpuTotalMs:null,
   minimumFreeMemoryGiB:Math.min(...workload.map(s=>s.freeMemoryGiB)),
   totalGiB,initialFreeGiB:samples[0].freeGiB,buildStartFreeGiB:baseline.freeGiB,
   minimumFreeGiB,peakUsedGiB:totalGiB-minimumFreeGiB,peakGrowthGiB:Math.max(0,baseline.freeGiB-minimumFreeGiB),samples};
  await writeFile(file+'.tmp',JSON.stringify(report,null,2)+'\n');await rename(file+'.tmp',file);
 }finally{sampling=false;}
}
await sample();
const timer=setInterval(()=>sample().catch(error=>console.error('Disk sample:',error.message)),5000);
let code;
try {
 const child=spawn(command,args,{stdio:'inherit'});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
 code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',value=>done(value??1));});
}finally{
 clearInterval(timer);while(sampling)await new Promise(done=>setTimeout(done,20));await sample();
 console.log('Disk usage report:',file);
}
process.exitCode=code;
