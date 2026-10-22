import { readFile, writeFile, mkdir, readdir, copyFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Format/size conversion only. The selected PORTAL design remains the master.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const master = resolve(root, 'assets/branding/portal.png');
const bytes = await readFile(master);
const mono = resolve(root, 'assets/branding/portal-mono.png');
const digest = createHash('sha256').update(bytes).update(await readFile(mono)).digest('hex').slice(0,16);
const cache = resolve(root, '.runtime/branding', digest);
const theme = resolve(root, '.chromium/src/chrome/app/theme');
await mkdir(cache, {recursive:true});
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function png(size, monochrome = false) {
  const path = resolve(cache, `${monochrome ? 'mono-' : ''}${size}.png`);
  if (!await exists(path)) execFileSync('/usr/bin/sips', ['-z', String(size), String(size), monochrome ? mono : master, '--out', path], {stdio:'ignore'});
  return path;
}
async function files(dir) {
  const found=[];
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    const path=resolve(dir,entry.name);
    if(entry.isDirectory()) found.push(...await files(path)); else found.push(path);
  }
  return found;
}
const resources=[...await files(theme), ...await files(resolve(root,'.chromium/src/components/resources'))].filter(path =>
  /\/(?:default_\d+_percent\/)?chromium\/product_logo[^/]*\.(png|svg)$/.test(path));
for (const target of resources) {
  if (target.endsWith('.svg')) {
    await writeFile(target, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024"><image width="1024" height="1024" xlink:href="data:image/png;base64,${bytes.toString('base64')}"/></svg>\n`);
    continue;
  }
  const old=await readFile(target),width=old.readUInt32BE(16),height=old.readUInt32BE(20);
  const square=await png(Math.min(width,height),target.includes('_mono'));
  if(width===height) await copyFile(square,target);
  else execFileSync('/usr/bin/sips',['-p',String(height),String(width),square,'--out',target],{stdio:'ignore'});
}
for (const scale of [1,2]) {
  const target=resolve(theme,`default_${scale*100}_percent/chromium/agentic_logo_mono.png`);
  await copyFile(await png(24*scale,true),target);
}
const iconset=resolve(cache,'app.iconset'),catalog=resolve(cache,'Assets.xcassets'),appIcon=resolve(catalog,'AppIcon.appiconset');
await mkdir(iconset,{recursive:true});await mkdir(appIcon,{recursive:true});
const images=[];
for(const size of [16,32,128,256,512]) for(const scale of [1,2]) {
  const filename=`icon_${size}x${size}${scale===2?'@2x':''}.png`;
  const converted=await png(size*scale);
  await copyFile(converted,resolve(iconset,filename));
  await copyFile(converted,resolve(appIcon,filename));
  images.push({filename,idiom:'mac',scale:`${scale}x`,size:`${size}x${size}`});
}
await writeFile(resolve(catalog,'Contents.json'),JSON.stringify({info:{author:'xcode',version:1}}));
await writeFile(resolve(appIcon,'Contents.json'),JSON.stringify({images,info:{author:'xcode',version:1}}));
if(!await exists(resolve(cache,'app.icns')))
  execFileSync('/usr/bin/iconutil',['-c','icns',iconset,'-o',resolve(cache,'app.icns')],{stdio:'pipe'});
if(!await exists(resolve(cache,'Assets.car')))
  execFileSync('/usr/bin/xcrun',['actool','--compile',cache,'--platform','macosx','--minimum-deployment-target','11.0','--app-icon','AppIcon','--output-partial-info-plist',resolve(cache,'partial.plist'),catalog],{stdio:'pipe'});
for(const file of ['app.icns','Assets.car'])await copyFile(resolve(cache,file),resolve(theme,'chromium/mac',file));
console.log(`Agentic Browser icon prepared: ${resources.length} UI resources and macOS app icons.`);
