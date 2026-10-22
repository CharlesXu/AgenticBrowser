import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
const args=process.argv.slice(2);
const at=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const discoveryFile=at('--discovery'), number=Number(at('--number')), output=at('--output');
if(!discoveryFile || (!args.includes('--list') && (!Number.isInteger(number)||number<1||!output))){
 console.error('Usage: node scripts/bind-space.mjs --discovery <private browser discovery.json> --list\n  or --number <active space number> --output <new private connection.json>');process.exit(1);
}
const info=await stat(discoveryFile);
if(!info.isFile()||info.size>1048576||(process.platform!=='win32'&&(info.mode&0o077)))throw Error('Discovery must be a private local file.');
const discovery=JSON.parse(await readFile(discoveryFile,'utf8'));
if(!Number.isInteger(discovery.port)||discovery.port<1||discovery.port>65535)throw Error('Invalid local endpoint.');
const spaces=[];
for(const [space,token] of Object.entries(discovery.tasks??{})){
 if(!/^task-[a-z0-9-]{1,64}$/.test(space)||typeof token!=='string')continue;
 const res=await fetch(`http://127.0.0.1:${discovery.port}/space`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({space,action:'observe'}),signal:AbortSignal.timeout(3000),redirect:'error'});
 if(!res.ok)continue;
 const state=await res.json();spaces.push({space,token,number:state.number,name:state.name,owner:state.owner});
}
if(args.includes('--list')) console.log(JSON.stringify(spaces.map(({token,...safe})=>safe),null,2));
else {
 const matches=spaces.filter(s=>s.number===number);if(matches.length!==1)throw Error('Choose an existing non-main space from --list.');
 const chosen=matches[0], path=resolve(output);await mkdir(dirname(path),{recursive:true,mode:0o700});
 // Refuse to replace an existing binding; display numbers may be recycled, credentials may not.
 await writeFile(path,JSON.stringify({port:discovery.port,space:chosen.space,token:chosen.token})+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({connection:path,space:chosen.space,number:chosen.number}));
}
