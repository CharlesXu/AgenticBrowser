import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { normalizeUrl, modelPage, validateChoice, textRequest, textResponse, providers } from '../chromium/settings/agentic_model_api.ts';

// Protocol boundaries only; no credentials or real provider calls.
assert.equal(normalizeUrl(' example.com '), 'https://example.com/v1/');
assert.equal(normalizeUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1/');
assert.equal(normalizeUrl('https://example.com/api/paas/v4/'), 'https://example.com/api/paas/v4/');
for (const url of ['https://user:secret@example.com', 'file:///tmp/key', 'https://example.com?api_key=secret']) assert.throws(() => normalizeUrl(url));
assert.deepEqual(modelPage('typesafe', { models: [{ name: 'remote-new-model' }] }), { models: ['remote-new-model'], next: '' });
assert.equal(modelPage('gemini', { models: [{ name: 'models/test' }], nextPageToken: 'page 2' }).next, 'models?pageSize=1000&pageToken=page%202');
assert.equal(modelPage('anthropic', { data: [{ id: 'a' }], has_more: true, last_id: 'a' }).next, 'models?limit=100&after_id=a');
assert.throws(() => modelPage('openai', { message: 'unauthorized' }));
assert.throws(() => modelPage('openai', { data: [{ id: 42 }] }));
assert.equal(validateChoice({ choice: 'CLICK', confidence: .8, probabilities: { CLICK: .8, WAIT: .2 } }, ['CLICK', 'WAIT']), 'CLICK');
assert.throws(() => validateChoice({ choice: 'INVENTED', confidence: 1, probabilities: { INVENTED: 1 } }, ['CLICK']));
assert.throws(() => validateChoice({ choice: 'CLICK', confidence: .9, probabilities: { CLICK: .1, WAIT: .9 } }, ['CLICK', 'WAIT']));
assert.equal(textRequest('responses', 'model', 'test').path, 'responses');
assert.equal(textResponse('anthropic', { content: [{ type: 'text', text: 'OK' }] }), 'OK');
assert.equal(textResponse('gemini', { candidates: [{ content: { parts: [{ text: 'OK' }] } }] }), 'OK');
assert.throws(() => textResponse('openai', { error: 'bad key' }));
assert.equal(new Set(providers.map(p => p.id)).size, providers.length);
for (const p of providers) assert.equal(normalizeUrl(p.url), p.url);
console.log(`Model protocol checks passed; ${providers.length} endpoint presets, no static model IDs.`);

// Delayed decisions must not type or call the text model after takeover / stop.
const source = await readFile(new URL('../chromium/settings/agentic_decision.ts', import.meta.url), 'utf8');
const apiUrl = new URL('../chromium/settings/agentic_model_api.ts', import.meta.url).href;
const chessSource = await readFile(new URL('../chromium/settings/agentic_xiangqi.ts', import.meta.url), 'utf8');
const chessUrl = 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(chessSource).replace('./agentic_model_api.js', apiUrl)).toString('base64');
const compiled = stripTypeScriptTypes(source).replace('./agentic_model_api.js', apiUrl).replace('./agentic_xiangqi.js', chessUrl);
const {DecisionRunner} = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise,resolve}; };
const pending = [deferred(),deferred()], requested = [deferred(),deferred()], paused = deferred();
let owner = 'available', requests = 0, helperCalls = 0, inputs = 0, resumes = 0;
const runner = new DecisionRunner(async data => {
  if (data.op === 'stop') { owner = 'available'; return {}; }
  if (data.op === 'request') {
    if (data.id === 'text') { helperCalls++; throw Error('unexpected text call'); }
    const index = requests++; requested[index].resolve(); return pending[index].promise;
  }
  const action = data.request.action;
  if (action === 'claim') owner = 'agent';
  if (action === 'resume') { owner = 'agent'; resumes++; }
  if (action === 'snapshot') return {nodes:[{ref:'ref:1',role:'textbox',name:'Test input',value:{value:''}}]};
  if (['clickRef','fillRef','scroll'].includes(action)) inputs++;
  return {owner,tab:1};
}, status => {if (status === 'paused') paused.resolve();});
const choice = key => ({choice:key,confidence:1,probabilities:{[key]:1}});
const answer = {answers:{operation:{choice:'TYPE_TEXT',confidence:1,probabilities:{SCROLL_DOWN:0,SCROLL_UP:0,WAIT:0,DONE:0,BLOCKED:0,TYPE_TEXT:1}},type_text_target:choice('1')}};
const running = runner.run('task-a','Fill test input',{id:'decision',model:'test'},{id:'text',model:'test',protocol:'openai'});
await requested[0].promise;
owner = 'human'; pending[0].resolve(answer);
await paused.promise;
assert.equal(helperCalls,0); assert.equal(inputs,0);
owner = 'awaiting-resume';
await requested[1].promise;
assert.equal(resumes,1);
await runner.stop(); pending[1].resolve(answer); await running;
assert.equal(owner,'available'); assert.equal(helperCalls,0); assert.equal(inputs,0);
console.log('Delayed response checks passed: takeover pauses follow-up calls, return resumes, stop drops late results.');

// Rule boundaries for the complete legal-choice list, not chess strength.
const {legalMoves} = await import(chessUrl);
const start=[];
const back=['rook','horse','elephant','advisor','king','advisor','elephant','horse','rook'];
for(const [color,home,cannon,pawn] of [['red',0,2,3],['black',9,7,6]]) {
  back.forEach((kind,file)=>start.push({kind,color,file,rank:home}));
  for(const file of [1,7])start.push({kind:'cannon',color,file,rank:cannon});
  for(const file of [0,2,4,6,8])start.push({kind:'pawn',color,file,rank:pawn});
}
assert.equal(legalMoves(start,'red').length,44);
assert.equal(legalMoves(start,'black').length,44);
assert(!legalMoves(start,'red').some(m=>m.id==='a3_b3')); // Uncrossed pawn.
assert(!legalMoves(start.concat({kind:'pawn',color:'red',file:1,rank:1}),'red').some(m=>m.id==='b0_c2')); // Horse leg.
const facing=[{kind:'king',color:'red',file:4,rank:0},{kind:'king',color:'black',file:4,rank:9},{kind:'rook',color:'red',file:4,rank:4}];
assert(!legalMoves(facing,'red').some(m=>m.id==='e4_d4')); // Exposes facing kings.
console.log('Xiangqi legal-choice checks passed: opening 44/44, pawn river, horse leg, king exposure.');

let wrongPageCalls=0,wrongPageResult='';
const wrongPage=new DecisionRunner(async data=>{
  if(data.op==='request')wrongPageCalls++;
  return {owner:'agent',url:'https://play.xiangqi.com/computer'};
},(status,_step,detail)=>{wrongPageResult=status+detail;});
await wrongPage.run('task-a','下象棋',{id:'decision',model:'test'});
assert.equal(wrongPageCalls,0);assert(wrongPageResult.includes('xiangqi_computer_page_required'));
console.log('Xiangqi route check passed: setup / online pages never fall through to generic actions.');
