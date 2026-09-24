'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const source=path.resolve(require('electron'),'../../..');
const out=path.resolve(root,'dist','言外.app');
const version=require('../package.json').version;
if(fs.existsSync(out)){
  // Never overwrite silently: move the previous build aside with its version in the name.
  const previous=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(out,'Contents','Info.plist')],{encoding:'utf8'}).trim();
  const archive=path.join(root,'dist','旧版',`言外-${previous}-${Date.now()}.app`);
  fs.mkdirSync(path.dirname(archive),{recursive:true});
  fs.renameSync(out,archive);
  console.log('previous build moved to',archive);
}
fs.mkdirSync(path.dirname(out),{recursive:true});
execFileSync('/usr/bin/ditto',[source,out]);
const resources=path.join(out,'Contents','Resources');
const appDir=path.join(resources,'app');
fs.mkdirSync(appDir,{recursive:true});
for(const name of ['main.js','preload.js','panel-policy.js','input-sources.js','fill-policy.js','jev-cloud.js','cloud-settings.js','package.json','renderer','vendor','native','LICENSE','THIRD_PARTY_NOTICES.md']) fs.cpSync(path.join(root,name),path.join(appDir,name),{recursive:true, filter: sourcePath => !sourcePath.includes('/.module-cache')});
// A stable identity (YANWAI_SIGN_IDENTITY) keeps macOS privacy permissions across rebuilds;
// ad-hoc signing ('-') makes every build look like a new app to the permission system.
const identity=process.env.YANWAI_SIGN_IDENTITY||'-';
for (const name of ['notch-metrics','watch-chat','fill-text']) execFileSync('/usr/bin/codesign',['--force','--sign',identity,'--identifier',`com.zexuan.yanwai.mac.${name}`,path.join(appDir,'native',name)]);
const plist=path.join(out,'Contents','Info.plist');
for(const [key,value] of [['CFBundleName','言外'],['CFBundleDisplayName','言外 Mac'],['CFBundleIdentifier','com.zexuan.yanwai.mac']]) { try { execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${value}`,plist]); } catch (_) { execFileSync('/usr/libexec/PlistBuddy',['-c',`Add :${key} string ${value}`,plist]); } }
for(const key of ['CFBundleVersion','CFBundleShortVersionString']) execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${version}`,plist]);
// App icon: assets/icon.icns replaces Electron's default electron.icns.
const icon=path.join(root,'assets','icon.icns');
if(fs.existsSync(icon)) fs.copyFileSync(icon,path.join(resources,'electron.icns'));
else console.warn('assets/icon.icns missing: the app keeps the default Electron icon.');
try{execFileSync('/usr/libexec/PlistBuddy',['-c','Add :LSUIElement bool true',plist]);}catch(_){execFileSync('/usr/libexec/PlistBuddy',['-c','Set :LSUIElement true',plist]);}
execFileSync('/usr/bin/codesign',['--force','--deep','--sign',identity,'--preserve-metadata=entitlements',out],{stdio:'inherit'});
console.log(out);
