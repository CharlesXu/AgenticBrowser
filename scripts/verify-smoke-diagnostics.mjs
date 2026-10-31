import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

// Exercise real subprocess failures without opening a browser or user Profile.
const dir=await mkdtemp(join(tmpdir(),'agentic-smoke-diagnostics-'));
try {
 for(const [name,executable] of [['missing',join(dir,'absent-browser')],['exited',process.execPath]]) {
  const report=join(dir,name+'.json');
  const child=spawnSync(process.execPath,[resolve('scripts/smoke-release.mjs'),executable,report],{encoding:'utf8',timeout:10000});
  assert.equal(child.error,undefined);assert.notEqual(child.status,0);
  const failure=JSON.parse(await readFile(report,'utf8'));
  assert.equal(failure.status,'failed');assert.equal(failure.phase,'three spaces and shared login');
  assert.deepEqual(failure.checks,{});assert(failure.stderr.length<=12000);
  if(name==='missing')assert.equal(failure.process.spawnError.code,'ENOENT');
  else {assert.notEqual(failure.process.exitCode,null);assert.notEqual(failure.process.exitCode,0);assert(failure.stderr.length>0);}
  assert(!JSON.stringify(failure).includes('--user-data-dir='+tmpdir()),'Temporary Profile path must be redacted');
 }
 console.log('Smoke launch/exit failure diagnostics passed; no browser launched.');
}finally{await rm(dir,{recursive:true,force:true});}
