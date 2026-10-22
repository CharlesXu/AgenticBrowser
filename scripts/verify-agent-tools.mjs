import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const file=process.argv[2];if(!file)throw Error('Pass a test-only task connection file.');
const client=new Client({name:'agentic-tools-smoke',version:'0.1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/mcp.ts'),'--connection',resolve(file)],stderr:'pipe'});
transport.stderr?.on('data',()=>{});
let control;
async function call(name,fields={},error=false){const reply=await client.callTool({name,arguments:fields});assert.equal(!!reply.isError,error,name);return reply;}
async function data(name,fields={},error=false){const reply=await call(name,fields,error);return JSON.parse(reply.content.find(c=>c.type==='text').text);}
const checks={};
try{
 await client.connect(transport);
 const seen=await data('space_observe');assert.equal(new URL(seen.url).hostname,'127.0.0.1');assert.equal(seen.owner,'available');
 control=await data('space_claim');let target={...control,tab:seen.tab};
 const snapshot=await data('space_snapshot',target);
 const field=snapshot.nodes.find(n=>n.role==='textbox');assert.ok(field?.ref,'fixture textbox exposed');
 await data('space_fill',{...target,ref:field.ref,text:'语义填写123'});
 const after=await data('space_snapshot',target);assert.ok(after.nodes.some(n=>n.role==='textbox'&&n.value?.value==='语义填写123'));checks.snapshotAndFill=true;
 const stale=await data('space_click_ref',{...target,ref:field.ref},true);assert.equal(stale.error,'stale_reference');checks.oldSnapshotRejected=true;
 const logout=after.nodes.find(n=>n.role==='button'&&n.name==='退出登录');await data('space_click_ref',{...target,ref:logout.ref});
 for(let i=0;i<20;i++){if(!(await(await fetch(new URL(seen.url).origin+'/fixture/reports')).json())['task-a']?.account)break;await new Promise(r=>setTimeout(r,50));}
 const button=after.nodes.find(n=>n.role==='button'&&n.name==='登录测试账号');assert.ok(button?.ref);await data('space_click_ref',{...target,ref:button.ref});
 const base=new URL(seen.url).origin;let logged=false;for(let i=0;i<20;i++){if((await(await fetch(base+'/fixture/reports')).json())['task-a']?.account){logged=true;break;}await new Promise(r=>setTimeout(r,50));}assert.ok(logged);checks.semanticClick=true;
 const screenshot=await call('space_screenshot',target);assert.ok(screenshot.content.some(c=>c.type==='image'&&c.data.length>100));checks.screenshot=true;
 await data('space_new_tab',target);let newSeen=await data('space_observe',control);assert.notEqual(newSeen.tab,seen.tab);target={...control,tab:newSeen.tab};
 assert.equal((await data('space_tabs',target)).tabs.length,2);
 await data('space_select_tab',{...target,targetTab:seen.tab});target={...control,tab:(await data('space_observe',control)).tab};assert.equal(target.tab,seen.tab);
 await data('space_close_tab',{...target,targetTab:newSeen.tab});assert.equal((await data('space_tabs',target)).tabs.length,1);checks.spaceLocalTabs=true;
 const targetURL=new URL(seen.url);targetURL.searchParams.set('fresh-document','1');await data('space_navigate',{...target,url:targetURL.href});
 for(let i=0;i<30;i++){if((await data('space_observe',control)).url===targetURL.href)break;await new Promise(r=>setTimeout(r,50));}
 const moved=await data('space_click_ref',{...target,ref:button.ref},true);assert.equal(moved.error,'stale_reference');checks.navigationInvalidatesReferences=true;
 const discovery=JSON.parse(await readFile(file,'utf8'));
 const main=await fetch(`http://127.0.0.1:${discovery.port}/space`,{method:'POST',headers:{Authorization:`Bearer ${discovery.token}`},body:JSON.stringify({...target,space:'main',action:'snapshot'})});assert.equal(main.status,403);checks.mainDenied=true;
 await data('space_release',control);control=undefined;
 await writeFile('evidence/agent-tools-20261023.json',JSON.stringify({status:'passed',checks},null,2)+'\n');console.log({status:'passed',checks});
}finally{if(control)await data('space_release',control).catch(()=>{});await client.close();}
