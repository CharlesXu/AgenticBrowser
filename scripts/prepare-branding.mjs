import { readFile, writeFile, mkdir, readdir, copyFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Format/size conversion only. The selected PORTAL design remains the master.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const master = resolve(root, 'assets/branding/portal.png');
const bytes = await readFile(master);
const mono = resolve(root, 'assets/branding/portal-mono.png');
const digest = createHash('sha256').update(bytes).update(await readFile(mono)).digest('hex').slice(0,16);
const cache = resolve(root, '.runtime/branding', digest + '-portable');
const source = resolve(process.env.AGENTIC_CHROMIUM_SRC || resolve(root, '.chromium/src'));
const theme = resolve(source, 'chrome/app/theme');
await mkdir(cache, {recursive:true});
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function png(size, monochrome = false) {
  const path = resolve(cache, `${monochrome ? 'mono-' : ''}${size}.png`);
  if (!await exists(path)) await sharp(monochrome ? mono : master).resize(size,size).png().toFile(path);
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
const resources=[...await files(theme), ...await files(resolve(source,'components/resources'))].filter(path => {
  const normalized=path.replaceAll('\\','/');
  return /\/(?:default_\d+_percent\/)?chromium\/product_logo[^/]*\.(png|svg)$/.test(normalized) ||
    /\/common\/favicon_ntp\.png$/.test(normalized);
});
for (const target of resources) {
  if (target.endsWith('.svg')) {
    await writeFile(target, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024"><image width="1024" height="1024" xlink:href="data:image/png;base64,${bytes.toString('base64')}"/></svg>\n`);
    continue;
  }
  const old=await readFile(target),width=old.readUInt32BE(16),height=old.readUInt32BE(20);
  const square=await png(Math.min(width,height),target.includes('_mono'));
  if(width===height) await copyFile(square,target);
  else await sharp(square).resize(width,height,{fit:'contain',background:'#ffffff'}).png().toFile(target);
}
for (const scale of [1,2]) {
  const target=resolve(theme,`default_${scale*100}_percent/chromium/agentic_logo_mono.png`);
  await copyFile(await png(24*scale,true),target);
}
// Windows ICO supports PNG frames; no platform-specific converter is needed.
const sizes=[16,24,32,48,64,128,256],frames=await Promise.all(sizes.map(async size=>readFile(await png(size))));
const header=Buffer.alloc(6+16*frames.length);header.writeUInt16LE(1,2);header.writeUInt16LE(frames.length,4);
let offset=header.length;
frames.forEach((frame,i)=>{const at=6+i*16;header[at]=sizes[i]%256;header[at+1]=sizes[i]%256;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(frame.length,at+8);header.writeUInt32LE(offset,at+12);offset+=frame.length;});
await writeFile(resolve(theme,'chromium/win/chromium.ico'),Buffer.concat([header,...frames]));

if(process.platform==='darwin') {
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
}
console.log(`Agentic Browser icon prepared: ${resources.length} UI resources, Windows ICO${process.platform==='darwin'?' and macOS app icons':''}.`);
