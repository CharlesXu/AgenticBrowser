import {readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const en=JSON.parse(await readFile(resolve(root,'locales/en-US.json'),'utf8'));
const zh=JSON.parse(await readFile(resolve(root,'locales/zh-CN.json'),'utf8'));
if(JSON.stringify(Object.keys(en).sort())!==JSON.stringify(Object.keys(zh).sort()))
  throw new Error('Locale keys must match');
for(const key of Object.keys(en))
  if(JSON.stringify(en[key].match(/\$\d/g)?.sort())!==JSON.stringify(zh[key].match(/\$\d/g)?.sort()))
    throw new Error(`Locale placeholders differ: ${key}`);
const product=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(product.version)) throw new Error('Invalid product version');
let commit='uncommitted', modified=false;
try {
  commit=execFileSync('git',['rev-parse','--short=16','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  modified=!!execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'}).trim();
} catch {}
const body=`// Generated from locales/*.json and package.json; do not edit.\n#pragma once
#include <initializer_list>
#include <string_view>
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/browser_process.h"
#define AGENTIC_BROWSER_VERSION ${JSON.stringify(product.version)}
#define AGENTIC_BROWSER_COMMIT ${JSON.stringify(commit+(modified?' +modified':''))}
inline std::u16string AgenticText(std::string_view key,
    std::initializer_list<std::u16string> values = {}) {
  struct Entry {std::string_view key; const char* en; const char* zh;};
  static constexpr Entry strings[] = {
${Object.keys(en).map(key=>`    {${JSON.stringify(key)}, ${JSON.stringify(en[key])}, ${JSON.stringify(zh[key])}},`).join('\n')}
  };
  const bool chinese = g_browser_process && g_browser_process->GetApplicationLocale().starts_with("zh");
  for (const auto& entry : strings) {
    if (entry.key == key)
      return base::ReplaceStringPlaceholders(base::UTF8ToUTF16(chinese ? entry.zh : entry.en),
          base::span<const std::u16string>(values), nullptr);
  }
  return base::UTF8ToUTF16(key);
}
`;
const path=resolve(root,'.chromium/src/chrome/browser/agentic_strings.h');
if(await readFile(path,'utf8').catch(()=>null)!==body) await writeFile(path,body);
console.log(`Agentic Browser ${product.version} · ${commit}${modified?' +modified':''}`);
