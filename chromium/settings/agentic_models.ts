import 'chrome://resources/cr_elements/cr_button/cr_button.js';
import 'chrome://resources/cr_elements/cr_checkbox/cr_checkbox.js';
import type {CSSResultGroup} from 'chrome://resources/lit/v3_0/lit.rollup.js';
import {CrLitElement,css} from 'chrome://resources/lit/v3_0/lit.rollup.js';
import {sendWithPromise} from 'chrome://resources/js/cr.js';
import {providers,normalizeUrl,modelPage,textRequest} from './agentic_model_api.js';
import {getHtml} from './agentic_models.html.js';
import type {JsonObject} from './agentic_model_api.js';
import {DecisionRunner} from './agentic_decision.js';

interface TaskSpace {id:string;number:number;title:string;available:boolean;}
interface Config {id:string;provider:string;name:string;custom:boolean;url:string;protocol:string;key:string;hasKey:boolean;model:string;models:string[];revision:string;verified:boolean;busy:boolean;status:string;}
export class AgenticModelsElement extends CrLitElement {
  static get is(){return 'agentic-models';}
  static override get styles():CSSResultGroup {return css`
    :host{display:block;color:var(--cr-primary-text-color);font:inherit}
    section{background:var(--cr-card-background-color);border-radius:12px;box-shadow:var(--cr-card-shadow);margin:0 0 20px;padding:24px}
    h2{font-size:16px;font-weight:500;margin:0 0 12px}p,.status{color:var(--cr-secondary-text-color);font-size:12px;line-height:1.6}
    .heading,.row,.actions{display:flex;align-items:center;gap:12px}.heading{justify-content:space-between}.row{margin:12px 0;flex-wrap:wrap}
    .provider{border-top:1px solid var(--cr-separator-color);padding:16px 0}.provider:first-of-type{margin-top:16px}
    label{display:flex;flex-direction:column;gap:6px;flex:1;min-width:160px;font-size:12px}
    select,input,textarea{box-sizing:border-box;background:var(--cr-input-background-color,var(--cr-card-background-color));color:var(--cr-primary-text-color);border:1px solid var(--cr-separator-color);border-radius:8px;padding:9px 12px;font:inherit;width:100%;min-height:36px;outline-offset:2px}
    select:focus,input:focus,textarea:focus{outline:2px solid var(--cr-focus-outline-color)}select:disabled,input:disabled{opacity:.5}
    textarea{resize:vertical;min-height:84px}.custom{padding-top:18px;white-space:nowrap}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--cr-secondary-text-color);margin-right:7px}.dot.ok{background:#16863c}
    .name{font-weight:500;font-size:14px}.status{min-height:19px;margin:8px 0;overflow-wrap:anywhere}.status.error{color:var(--cr-error-color,#c5221f)}
    .actions{flex-wrap:wrap}cr-button{font-size:12px}.task-state{font-variant-numeric:tabular-nums}.hint{margin-bottom:18px}
  `;}
  override render(){return getHtml.bind(this)();}
  static override get properties(){return {configs:{type:Array},labels:{type:Object},spaces:{type:Array},taskStatus:{type:String},taskDetail:{type:String},steps:{type:Number},running:{type:Boolean},spaceId:{type:String},decisionId:{type:String},textId:{type:String},goal:{type:String}};}
  protected accessor configs:Config[]=[];
  protected accessor labels:Record<string,string>={};
  protected accessor spaces:TaskSpace[]=[];
  protected accessor taskStatus='';protected accessor taskDetail='';protected accessor steps=0;protected accessor running=false;
  protected accessor spaceId='';protected accessor decisionId='';protected accessor textId='';protected accessor goal='';
  private runner:DecisionRunner|undefined;
  protected t(key:string){return this.labels[key]||key;}
  private call<T=unknown>(data:JsonObject):Promise<T>{return sendWithPromise('agenticModels',data);}
  override connectedCallback(){super.connectedCallback();void this.load();}
  override disconnectedCallback(){void this.runner?.stop();super.disconnectedCallback();}
  private async load(){try{const result=await this.call<{labels:Record<string,string>,configs:Config[]}>({op:'list'});this.labels=result.labels;this.configs=result.configs.map(c=>({...c,key:'',models:c.models||[],busy:false,status:''}));await this.refreshSpaces();}catch(e){this.taskDetail=String(e);}}
  private redrawRows(){this.configs=[...this.configs];}
  protected add(){const p=providers[0];this.configs=[...this.configs,{...p,id:'',provider:p.id,custom:false,key:'',hasKey:false,model:'',models:[],revision:'',verified:false,busy:false,status:''}];}
  protected change<K extends keyof Config>(c:Config,key:K,value:Config[K]){c[key]=value;c.verified=false;c.status='';if(['url','protocol','provider','custom'].includes(key)){c.key='';c.hasKey=false;c.models=[];c.model='';}this.redrawRows();}
  protected provider(c:Config,id:string){const p=providers.find(p=>p.id===id)!;this.change(c,'provider',id);Object.assign(c,{name:p.name,url:p.url,protocol:p.protocol});this.redrawRows();}
  protected custom(c:Config,value:boolean){if(c.custom===value)return;this.change(c,'custom',value);if(value){c.name='';c.url='';c.protocol='openai';}else this.provider(c,c.provider);this.redrawRows();}
  protected normalizeEndpoint(c:Config){try{c.url=normalizeUrl(c.url);this.redrawRows();void this.connect(c);}catch(e){c.status=String(e);this.redrawRows();}}
  private async save(c:Config){const saved=await this.call({op:'save',id:c.id,key:c.key,config:{provider:c.provider,custom:c.custom,name:c.name,url:normalizeUrl(c.url),protocol:c.protocol,model:c.model,models:c.models}});Object.assign(c,saved,{key:''});this.redrawRows();}
  private async request(c:Config,path:string,body?:unknown,test=false){return this.call({op:'request',id:c.id,revision:c.revision,path,...(body?{body}:{}),test});}
  protected async connect(c:Config){
    if(c.busy||!c.name.trim()||!c.url.trim()||(!c.key.trim()&&!c.hasKey))return;
    c.busy=true;c.verified=false;c.status=this.t('testing');this.redrawRows();
    try {
      await this.save(c);const found=new Set<string>(),visited=new Set<string>();let path=c.protocol==='anthropic'?'models?limit=100':c.protocol==='gemini'?'models?pageSize=1000':'models';
      while(path){if(visited.has(path)||visited.size>=100)throw Error('model_list_incomplete');visited.add(path);const page=modelPage(c.protocol,await this.request(c,path));for(const name of page.models)found.add(name);path=page.next;}
      c.models=[...found].sort();if(!c.models.length)throw Error('empty_model_list');
      if(!c.models.includes(c.model))c.model=c.models.find(m=>/jev-latest|flash|mini|haiku|chat|mercury/i.test(m))||c.models[0];
      await this.save(c);await this.probe(c);
    }catch(e){c.verified=false;c.status=this.t('failed')+': '+String(e);}finally{c.busy=false;this.redrawRows();}
  }
  private async probe(c:Config){
    if(c.protocol==='typesafe')await this.request(c,'systemone',{model:c.model,state:'Connection test. The correct answer is OK.',questions:{probe:{type:'choice',criteria:{OK:'Connection test succeeded',FAIL:'Connection test failed'},instructions:'Choose OK.'}}},true);
    else {const req=textRequest(c.protocol,c.model,'Reply with OK.');await this.request(c,req.path,req.body,true);}
    c.verified=true;c.status=this.t('verified')+' · '+c.model+' · '+c.models.length+' '+this.t('listed');
  }
  protected async test(c:Config){if(c.busy)return;c.busy=true;c.verified=false;c.status=this.t('testing');this.redrawRows();try{await this.save(c);await this.probe(c);}catch(e){c.status=this.t('failed')+': '+String(e);}finally{c.busy=false;this.redrawRows();}}
  protected async removeProvider(c:Config){if(c.id)await this.call({op:'remove',id:c.id});this.configs=this.configs.filter(x=>x!==c);}
  protected async refreshSpaces(){const result=await this.call<{spaces:TaskSpace[]}>({op:'spaces'});this.spaces=result.spaces;if(!this.spaces.some(s=>s.id===this.spaceId))this.spaceId=this.spaces.find(s=>s.available)?.id||'';}
  protected async start(){
    const decision=this.configs.find(c=>c.id===this.decisionId&&c.verified&&c.protocol==='typesafe');const text=this.configs.find(c=>c.id===this.textId&&c.verified&&c.protocol!=='typesafe');
    if(!decision||!this.spaceId||!this.goal.trim())return;
    this.running=true;this.steps=0;this.taskDetail='';
    this.runner=new DecisionRunner(d=>this.call(d),(status,steps,detail)=>{this.taskStatus=status;this.steps=steps;this.taskDetail=detail;});
    await this.runner.run(this.spaceId,this.goal.trim(),decision,text);this.running=false;await this.refreshSpaces();
  }
  protected async stop(){await this.runner?.stop();this.taskStatus='stopped';}

  private eventConfig(e:Event):Config {
    const row=(e.currentTarget as HTMLElement).closest<HTMLElement>('[data-config]');
    return this.configs[Number(row?.dataset['config'])];
  }
  protected onAddClick(){this.add();}
  protected onRefreshClick(){void this.refreshSpaces();}
  protected onStartClick(){void this.start();}
  protected onStopClick(){void this.stop();}
  protected onProviderChange(e:Event){this.provider(this.eventConfig(e),(e.target as HTMLSelectElement).value);}
  protected onCustomCheckedChanged(e:CustomEvent<{value:boolean}>){this.custom(this.eventConfig(e),e.detail.value);}
  protected onProtocolChange(e:Event){this.change(this.eventConfig(e),'protocol',(e.target as HTMLSelectElement).value);}
  protected onFieldInput(e:Event){const input=e.target as HTMLInputElement;const key=input.dataset['field'];if(key==='name'||key==='url'||key==='key')this.change(this.eventConfig(e),key,input.value);}
  protected onConnectChange(e:Event){void this.connect(this.eventConfig(e));}
  protected onUrlChange(e:Event){this.normalizeEndpoint(this.eventConfig(e));}
  protected onModelChange(e:Event){const c=this.eventConfig(e);this.change(c,'model',(e.target as HTMLSelectElement).value);void this.test(c);}
  protected onFetchClick(e:Event){void this.connect(this.eventConfig(e));}
  protected onTestClick(e:Event){void this.test(this.eventConfig(e));}
  protected onRemoveClick(e:Event){void this.removeProvider(this.eventConfig(e));}
  protected onTaskFieldChange(e:Event){const select=e.target as HTMLSelectElement;const key=select.dataset['field'];if(key==='decisionId'||key==='textId'||key==='spaceId')this[key]=select.value;}
  protected onGoalInput(e:Event){this.goal=(e.target as HTMLTextAreaElement).value;}

}
declare global {interface HTMLElementTagNameMap {'agentic-models':AgenticModelsElement;}}
customElements.define(AgenticModelsElement.is,AgenticModelsElement);
