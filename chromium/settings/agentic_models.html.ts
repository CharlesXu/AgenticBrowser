import {html} from 'chrome://resources/lit/v3_0/lit.rollup.js';
import type {AgenticModelsElement} from './agentic_models.js';
import {providers} from './agentic_model_api.js';
export function getHtml(this: AgenticModelsElement) {return html`
    <section><div class="heading"><h2>${this.t('title')}</h2><cr-button @click="${this.onAddClick}"
         ?disabled="${this.running}">${this.t('add')}</cr-button></div>
    <p class="hint">${this.t('hint')}</p>
    ${!this.configs.length?html`<p>${this.t('empty')}</p>`:''}
    ${this.configs.map((c,index)=>html`<div class="provider" data-config="${index}">
      <div class="name"><span class="dot ${c.verified?'ok':''}" role="img" aria-label="${this.t(c.verified?'verified':'untested')}"></span>${c.name||this.t('custom')}</div>
      <div class="row"><label>${this.t('provider')}<select aria-label="${this.t('provider')}" .value="${c.provider}" ?disabled="${c.custom||c.busy||this.running}" @change="${this.onProviderChange}"
        >${providers.map(p=>html`<option value="${p.id}" ?selected="${c.provider===p.id}">${this.configs.some(x=>x.provider===p.id&&!x.custom&&x.verified)?'🟢 ':''}${p.name}</option>`)}</select></label>
        <cr-checkbox class="custom" .checked="${c.custom}" ?disabled="${c.busy||this.running}" @checked-changed="${this.onCustomCheckedChanged}"
        >Custom</cr-checkbox>
      </div>
      ${c.custom?html`<div class="row"><label>${this.t('name')}<input aria-label="${this.t('name')}" data-field="name" .value="${c.name}" ?disabled="${c.busy||this.running}" @input="${this.onFieldInput}"
         @change="${this.onConnectChange}"
        ></label><label>${this.t('protocol')}<select .value="${c.protocol}" ?disabled="${c.busy||this.running}" @change="${this.onProtocolChange}"
        >${[['openai','OpenAI Chat'],['responses','OpenAI Responses'],['anthropic','Anthropic'],['gemini','Google Gemini'],['typesafe','TypeSafe Jev']].map(([id,label])=>html`<option value="${id}" ?selected="${c.protocol===id}">${label}</option>`)}</select></label></div>
      <div class="row"><label>${this.t('url')}<input aria-label="${this.t('url')}" type="text" data-field="url" .value="${c.url}" placeholder="api.example.com" ?disabled="${c.busy||this.running}" @input="${this.onFieldInput}"
         @change="${this.onUrlChange}"
        ></label></div>`:''}
      <div class="row"><label>API Key<input aria-label="API Key" type="password" autocomplete="off" data-field="key" .value="${c.key}" placeholder="${c.hasKey?this.t('key_saved'):this.t('key')}" ?disabled="${c.busy||this.running}" @input="${this.onFieldInput}"
         @change="${this.onConnectChange}"
        ></label>
      <label>${this.t('model')}<select aria-label="${this.t('model')}" .value="${c.model}" ?disabled="${c.busy||this.running||!c.models.length}" @change="${this.onModelChange}"
        ><option value="">${this.t('model')}</option>${c.models.map(m=>html`<option value="${m}" ?selected="${c.model===m}">${m}</option>`)}</select></label></div>
      <div class="actions"><cr-button ?disabled="${c.busy||this.running}" @click="${this.onFetchClick}"
        >${this.t('fetch')}</cr-button><cr-button ?disabled="${c.busy||this.running||!c.model}" @click="${this.onTestClick}"
        >${this.t('test')}</cr-button><cr-button ?disabled="${c.busy||this.running}" @click="${this.onRemoveClick}"
        >${this.t('remove')}</cr-button></div>
      <div class="status ${c.status.includes(this.t('failed'))?'error':''}" role="status">${c.status||this.t(c.verified?'verified':'untested')}</div>
    </div>`)}</section>
    <section><div class="heading"><h2>${this.t('task')}</h2><cr-button ?disabled="${this.running}" @click="${this.onRefreshClick}"
        >${this.t('refresh')}</cr-button></div><p>${this.t('task_hint')}</p>
      <div class="row"><label>${this.t('decision')}<select data-field="decisionId" .value="${this.decisionId}" ?disabled="${this.running}" @change="${this.onTaskFieldChange}"
        ><option value="">${this.t('decision')}</option>${this.configs.filter(c=>c.verified&&c.protocol==='typesafe').map(c=>html`<option value="${c.id}">${c.name} · ${c.model}</option>`)}</select></label><label>${this.t('text_model')}<select data-field="textId" .value="${this.textId}" ?disabled="${this.running}" @change="${this.onTaskFieldChange}"
        ><option value="">${this.t('text_model')}</option>${this.configs.filter(c=>c.verified&&c.protocol!=='typesafe').map(c=>html`<option value="${c.id}">${c.name} · ${c.model}</option>`)}</select></label></div>
      <div class="row"><label>${this.t('space')}<select data-field="spaceId" .value="${this.spaceId}" ?disabled="${this.running}" @change="${this.onTaskFieldChange}"
        >${this.spaces.map(s=>html`<option value="${s.id}" ?selected="${this.spaceId===s.id}" ?disabled="${!s.available}">${this.t('space')} ${s.number} · ${s.title}${s.available?'':' · '+this.t('unavailable')}</option>`)}</select></label></div>
      <label>${this.t('goal')}<textarea .value="${this.goal}" ?disabled="${this.running}" @input="${this.onGoalInput}"
        ></textarea></label>
      <div class="row"><cr-button class="action-button" ?disabled="${this.running||!this.decisionId||!this.spaceId||!this.goal.trim()}" @click="${this.onStartClick}"
        >${this.t('start')}</cr-button><cr-button ?disabled="${!this.running}" @click="${this.onStopClick}"
        >${this.t('stop')}</cr-button></div>
      <div class="status task-state" role="status">${this.taskStatus?this.t(this.taskStatus):''} ${this.steps?`${this.steps} ${this.t('steps')}`:''} ${this.taskDetail==='model_declared_done'?'':this.taskDetail}</div>
    </section>`;}
