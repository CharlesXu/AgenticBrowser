const english = {
 navSpaces:'Spaces',navInstall:'For agents',navDownload:'Download',hero:'Your space.<br>Your agent’s space.',intro:'A familiar browser. Independent task spaces.<br>Keep browsing while your agent gets things done.',explore:'Get Agentic Browser',connectAgent:'Connect your Harness ↗',preview:'Developer preview · Built on Chromium · Bring your own Harness',mainSpace:'Main space · Yours to control',focus:'Stay focused.<br>Work in parallel.',agentSpace:'Space 1 · Agent at work',remoteSpace:'Space 2 · Remote viewing',illustration:'Workspace interaction concept',spacesHeading:'One sign-in.<br>Room for every task.',spacesTitle:'One window, multiple spaces',spacesBody:'An overview, workspace previews, and quick switching give each task its place. The main space stays human-only.',sessionTitle:'Your familiar session',sessionBody:'Spaces in the same profile share cookies and sign-in state. Tasks stay separate, and browsing stays familiar.',controlTitle:'Know who is in control',controlBody:'Blue for agent control, green for remote viewing, red for remote control. Observe, take over, and hand back explicitly.',remoteHeading:'Another screen.<br>The same work.',remoteBody:'View a task space through noVNC in your phone’s browser. Take over clicks and typing when needed, then return control to the original agent.',remoteLimit:'Trusted LAN preview. Rendering can continue while a Mac is locked; the computer must remain awake and signed in.',installHeading:'One request to your Harness.',installIntro:'Copy this prompt into a Harness that can install software on your computer.',copy:'Copy prompt',installLimit:'Check the platform and available Release first. If a matching package is unavailable, stop rather than treating a development build as an installer.',installGuide:'Read installation instructions ↗',downloadHeading:'Choose a build for your computer.',chooseOS:'Choose a system',osLabel:'Operating system',archLabel:'Architecture',chooseArch:'Choose architecture',noPackage:'Installer not yet released',platformLimit:'A macOS ARM64 development build is available locally. Windows, Linux, and other architectures have not been released. Only existing packages are offered.',credit:'Built on Chromium and other open-source software. Their copyright notices and licenses are preserved.',chromiumSecurity:'Chromium security',lightweight:'System fonts · No tracking scripts · No autoplay video'
};
const chinese = Object.fromEntries([...document.querySelectorAll('[data-t]')].map(el=>[el.dataset.t,el.innerHTML]));
const $ = id => document.getElementById(id);
let language = 'zh';
try { language = localStorage.getItem('language') || (navigator.language.startsWith('zh') ? 'zh' : 'en'); } catch {}
if (!['zh','en'].includes(language)) language='zh';
let manifest = {version:null,assets:[]};
let detection = 'unknown';
const prompts = {
 zh:'请按 https://charlesxu.github.io/AgenticBrowser/install.md 检查我的操作系统和芯片架构，安装对应的最新 Agentic Browser Release 及本 Harness 的官方 Skill、Plugin 和 MCP，保留已有配置、不要输出凭据，并验证可观察和操作一个非主空间；若安装包尚未发布或需要额外授权，请明确说明并停在该步骤。',
 en:'Follow https://charlesxu.github.io/AgenticBrowser/install.md to check my OS and architecture, install the latest matching Agentic Browser Release and its official Skill, Plugin, and MCP for this Harness, preserve existing configuration, keep credentials private, and verify observation and control of one non-main space; if a package is unavailable or additional authorization is required, explain and stop at that step.'
};
function renderLanguage() {
 const en=language==='en';document.documentElement.lang=en?'en':'zh-CN';document.title=en?'Agentic Browser — Your space. Your agent’s space.':'Agentic Browser — 人与 Agent，各有空间';
 for(const el of document.querySelectorAll('[data-t]'))el.innerHTML=(en?english:chinese)[el.dataset.t];
 $('language').textContent=en?'中文':'English';$('install-prompt').textContent=prompts[language];renderDownload();
}
function renderDownload() {
 const en=language==='en';
 $('release-status').textContent=manifest.version?(en?`Latest public release: ${manifest.version}`:`最新公开版本：${manifest.version}`):(en?'The first public installer is being prepared.':'首个公开安装包尚在准备中。');
 const asset=manifest.assets.find(a=>a.os===$('os').value&&a.arch===$('arch').value);
 const link=$('download-link');
 const allowed=asset&&/^https:\/\/github\.com\/CharlesXu\/[^/]+\/releases\/download\//i.test(asset.url);
 link.setAttribute('aria-disabled',String(!allowed));
 if(allowed){link.href=asset.url;link.textContent=en?'Download latest release':'下载最新版本';}else{link.removeAttribute('href');link.textContent=en?'Installer not yet released':'安装包尚未发布';}
 $('machine-hint').textContent=detection==='known'?(en?'Platform detected. You can change it above.':'已识别平台，可在上方手动修改。'):(en?'Browsers cannot always identify the chip. Please confirm the architecture.':'浏览器不一定能准确识别芯片，请手动确认架构。');
}
$('language').onclick=()=>{language=language==='zh'?'en':'zh';try{localStorage.setItem('language',language);}catch{}renderLanguage();};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(prompts[language]);$('copy').textContent=language==='en'?'Copied':'已复制';}catch{const range=document.createRange();range.selectNodeContents($('install-prompt'));getSelection().removeAllRanges();getSelection().addRange(range);$('copy').textContent=language==='en'?'Select and copy':'已选中，请复制';}};
$('os').onchange=()=>{detection='unknown';$('arch').value='';renderDownload();};$('arch').onchange=renderDownload;
const ua=navigator.userAgent;
$('os').value=/Windows/i.test(ua)?'windows':/Mac/i.test(ua)&&!/Mobile/i.test(ua)?'macos':/Linux/i.test(ua)&&!/Android/i.test(ua)?'linux':'';
renderLanguage();
// Desktop browser UA strings on Apple silicon may say Intel. Do not guess.
if(navigator.userAgentData?.getHighEntropyValues){
 try{const info=await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','platform']);
 const platform={macOS:'macos',Windows:'windows',Linux:'linux'}[info.platform];
 if(platform)$('os').value=platform;
 const architecture=info.bitness==='64'?(info.architecture==='arm'?'arm64':info.architecture==='x86'?'x64':''):'';
 if(platform&&architecture){$('arch').value=architecture;detection='known';}renderDownload();}catch{}
}
try{const response=await fetch('releases.json');if(!response.ok)throw Error('unavailable');const data=await response.json();if(Array.isArray(data.assets))manifest=data;}catch{}
renderDownload();
