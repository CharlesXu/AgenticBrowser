// Small real-browser smoke check. Supply an explicitly authorized test space.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const connection=process.argv[2];
if(!connection)throw Error('Usage: node scripts/verify-page-tools.mjs <private test connection> [packaged mcp.ts]');
const fixture=createServer((req,res)=>{
  res.setHeader('content-type','text/html; charset=utf-8');
  if(req.url==='/child')return res.end('<label>Frame input<input id="frame-input"></label>');
  res.end(`<!doctype html><title>Page tools smoke</title><label>Name<input id="name"></label><button id="dialog" onclick="document.querySelector('#answer').textContent=prompt('Test prompt')">Prompt</button><output id="answer"></output><iframe src="http://localhost:${fixture.address().port}/child"></iframe>`);
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const client=new Client({name:'agentic-page-smoke',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[process.argv[3]||resolve('src/mcp.ts'),'--connection',connection],stderr:'pipe'});
transport.stderr?.on('data',()=>{});
const call=async(name,fields={},error=false)=>{
  const result=await client.callTool({name,arguments:fields});
  assert.equal(!!result.isError,error,`${name}: ${result.isError ? result.content.find(c=>c.type==='text')?.text : 'unexpected success'}`);
  return result;
};
const data=async(...args)=>JSON.parse((await call(...args)).content.find(c=>c.type==='text').text);
let control,created,previous;
try{
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length,33);
  const guide=await client.readResource({uri:'agentic-browser://guide'});
  assert.ok(guide.contents.some(c=>c.text?.includes('version: "0.4.0"')));
  control=await data('space_claim');
  previous=(await data('space_observe',control)).tab;
  await data('space_new_tab',{...control,tab:previous});
  created=(await data('space_observe',control)).tab;
  const target={...control,tab:created};
  await data('space_navigate',{...target,url:`http://127.0.0.1:${fixture.address().port}`});
  await data('page_wait',{...target,condition:'selector',value:'#frame-input'});
  const snap=await data('page_snapshot',target);
  assert.ok(snap.nodes.some(n=>n.name==='Frame input'));
  const ref=snap.nodes.find(n=>n.role==='textbox'&&n.name==='Name').ref;
  await data('page_action',{...target,operation:'fill',selector:ref,value:'MCP 中文'});
  assert.equal(await data('page_evaluate',{...target,expression:'document.querySelector("#name").value'}),'MCP 中文');
  await data('page_keyboard',{...target,operation:'press',value:'ControlOrMeta+A'});
  await data('page_keyboard',{...target,operation:'insertText',value:'replacement'});
  assert.equal(await data('page_evaluate',{...target,expression:'document.querySelector("#name").value'}),'replacement');
  await data('page_action',{...target,operation:'fill',selector:'#frame-input',value:'iframe 中文'});
  assert.ok((await data('page_snapshot',target)).nodes.some(n=>n.value==='iframe 中文'));
  await data('page_action',{...target,operation:'click',selector:'#dialog'});
  await data('page_dialog',{...target,accept:true,promptText:'answer'});
  await data('page_wait',{...target,condition:'function',value:'document.querySelector("#answer").textContent === "answer"'});
  for(const method of ['Browser.getVersion','Target.getTargets','Runtime.enable'])await data('page_cdp',{...target,method},true);
  await data('page_cdp',{...target,method:'Runtime.evaluate',params:{expression:'1'},session:'not-a-child'},true);
  assert.ok((await call('page_screenshot',target)).content.some(c=>c.type==='image'&&c.data.length>100));
  await data('space_close_tab',{...target,targetTab:created});created=undefined;
  await data('space_select_tab',{...control,tab:(await data('space_observe',control)).tab,targetTab:previous});
  await data('space_release',control);control=undefined;
  await data('page_evaluate',{...target,expression:'document.title'},true);
  console.log(JSON.stringify({status:'passed',tools:33,packaged:!!process.argv[3],refs:true,crossOriginFrame:true,shortcut:true,dialog:true,screenshot:true,protocolBoundary:true,releasedLeaseRejected:true}));
}finally{
  if(control){
    if(created)await data('space_close_tab',{...control,tab:(await data('space_observe',control)).tab,targetTab:created}).catch(()=>{});
    await data('space_release',control).catch(()=>{});
  }
  await client.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
}
