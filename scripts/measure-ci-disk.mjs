import assert from 'node:assert/strict';
import {mkdir,readFile,statfs,writeFile,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';

const [target,command,...args]=process.argv.slice(2);
assert(/^(macos|windows|linux)-(x64|arm64)$/.test(target)&&command);
const dir=resolve('.runtime/ci'),file=resolve(dir,`disk-${target}.json`);
await mkdir(dir,{recursive:true});
const samples=[],startedAt=new Date().toISOString();let sampling=false;
async function sample() {
 if(sampling)return;sampling=true;
 try {
  const fs=await statfs(process.cwd());
  let phase='starting';try{phase=(await readFile(resolve(dir,`phase-${target}.txt`),'utf8')).trim();}catch{}
  const freeGiB=fs.bavail*fs.bsize/1024**3,totalGiB=fs.blocks*fs.bsize/1024**3;
  samples.push({at:new Date().toISOString(),phase,freeGiB});
  const baseline=samples.find(s=>s.phase==='checkout')||samples[0];
  const workload=samples.filter(s=>s.at>=baseline.at);
  const minimumFreeGiB=Math.min(...workload.map(s=>s.freeGiB));
  const report={target,sourceCommit:process.env.GITHUB_SHA,startedAt,sampleIntervalSeconds:5,
   measurement:'Observed workspace filesystem usage, including OS activity; short peaks may fall between samples.',
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
