import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {verifyCandidate} from './smoke-linux-arm64.mjs';

const dir=await mkdtemp(join(tmpdir(),'agentic-candidate-'));
const source='1'.repeat(40),upstream={version:'test',revision:'2'.repeat(40)},version='0.1.0';
const bytes=Buffer.from('candidate validation fixture');
const manifest={target:'linux-arm64',sourceCommit:source,upstream,version,binaryArchitecture:'arm64',componentBuild:false,smoke:'pending',asset:'Agentic-Browser-0.1.0-linux-arm64.tar.xz',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
const save=value=>writeFile(join(dir,'manifest.json'),JSON.stringify(value));
try {
 await writeFile(join(dir,manifest.asset),bytes);await save(manifest);
 assert.deepEqual(await verifyCandidate(dir,source,upstream,version),manifest);
 for(const change of [{sourceCommit:'3'.repeat(40)},{upstream:{...upstream,revision:'4'.repeat(40)}},{binaryArchitecture:'x64'},{componentBuild:true},{smoke:'passed'},{asset:'../../unexpected.tar.xz'},{bytes:bytes.length+1},{sha256:'0'.repeat(64)}]) {
  await save({...manifest,...change});
  await assert.rejects(verifyCandidate(dir,source,upstream,version));
 }
 await save(manifest);await writeFile(join(dir,manifest.asset),Buffer.alloc(bytes.length));
 await assert.rejects(verifyCandidate(dir,source,upstream,version));
 if(process.platform!=='linux'||process.arch!=='arm64') {
  const result=spawnSync(process.execPath,['scripts/smoke-linux-arm64.mjs'],{env:{...process.env,GITHUB_ACTIONS:'true'},encoding:'utf8'});
  assert.notEqual(result.status,0,'Wrong host must not approve a candidate');
  assert.match(result.stderr,/AssertionError/);
 }
 console.log('Candidate validation passed: correct source accepted; stale, corrupted, wrong-architecture and pre-approved inputs rejected. Native smoke not executed.');
}finally{await rm(dir,{recursive:true,force:true});}
