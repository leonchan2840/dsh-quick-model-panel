'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { effortState, teamDecision, sharedFavorites } = require('../src/host-view.cjs');
const { resolveEffort, selectionFor, createFavorites } = require('../src/logic.cjs');
const { horizontalLayout, triggerSummary } = require('../src/view.cjs');
const { buildClient } = require('../build.cjs');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const model = (id, ids, d) => ({provider:'test', id, raw:{reasoning:{efforts:ids.map(id=>({id, name:id})), defaultEffort:d}}});
const a = model('a',['low','high'],'high'), b = model('b',['high','max'],'max'), c = model('c',['low','medium'],'medium');
test('implicit effective effort carries across compatible models', () => {
 const e=effortState(a, {model:'a'}, resolveEffort, 'Default'); assert.equal(e.index,1); assert.equal(selectionFor(b,e.effective).reasoningEffort,'high');
});
test('incompatible effort resolves to the new advertised default', () => {assert.equal(selectionFor(c,effortState(a,{reasoningEffort:'high'},resolveEffort,'Default').effective).reasoningEffort,'medium');});
test('provider default is separate from the first real level and can be explicitly returned to',()=>{
 const x=effortState(model('z',['low','high']),{},resolveEffort,'Default');assert.deepEqual(x.levels.map(v=>v.id),[null,'low','high']);assert.equal(x.index,0);assert.equal(x.effective,undefined);
});
test('invalid advertised default does not become a real effort',()=>{assert.equal(effortState(model('z',['low'],'bad'),{},resolveEffort,'Default').levels[0].id,null);});
test('no selected model/no effort yields no slider',()=>{assert.deepEqual(effortState(undefined,null,resolveEffort,'Default').levels,[]);});
test('trigger shows the committed catalog effort name rather than its opaque ID',()=>{
 const m={provider:'p',id:'m',name:'GPT Example',raw:{reasoning:{efforts:[{id:'l',name:'低'},{id:'h',name:'高'}],defaultEffort:'l'}}};
 const e=effortState(m,{reasoningEffort:'h'},resolveEffort,'默认');
 assert.deepEqual(triggerSummary(m.name,e.levels,e.index,'选择模型'),{model:'GPT Example',effort:'高',text:'GPT Example · 高'});
});
test('trigger follows compatible retained effort and the new model default on switching',()=>{
 const current=effortState(a,{},resolveEffort,'默认');
 for(const [target,expected] of [[b,'high'],[c,'medium']]){
  const selection=selectionFor(target,current.effective), e=effortState(target,selection,resolveEffort,'默认');
  assert.equal(triggerSummary(target.id,e.levels,e.index,'选择模型').text,target.id+' · '+expected);
 }
});
test('trigger uses localized provider-default labels without inventing the first effort',()=>{
 for(const label of ['默认','Default']){
  const m=model('unset',['low','high']), e=effortState(m,{},resolveEffort,label);
  assert.equal(triggerSummary(m.id,e.levels,e.index,'Choose model').text,'unset · '+label);
  assert.equal(e.effective,undefined);
 }
 const e=effortState(a,{},resolveEffort,'默认');
 assert.equal(triggerSummary(a.id,e.levels,e.index,'选择模型').text,'a · high');
});
test('trigger omits depth for unavailable metadata, unsupported models and invalid indices',()=>{
 for(const m of [undefined,{id:'plain',raw:{}}]){
  const e=effortState(m,{reasoningEffort:'high'},resolveEffort,'默认');
  assert.deepEqual(triggerSummary('plain',e.levels,e.index,'选择模型'),{model:'plain',effort:'',text:'plain'});
 }
 for(const index of [-1,undefined,NaN,0.5,2,'0']) assert.equal(triggerSummary('m',[{label:'高'}],index,'选择模型').text,'m');
 assert.deepEqual(triggerSummary(undefined,[{label:'高'}],0,'选择模型'),{model:'选择模型',effort:'',text:'选择模型'});
});
test('trigger retains unknown saved effort IDs rather than displaying a fallback as current',()=>{
 const e=effortState(a,{reasoningEffort:'ultra'},resolveEffort,'默认');
 assert.equal(triggerSummary(a.id,e.levels,e.index,'选择模型','ultra').text,'a · ultra');
 assert.equal(triggerSummary(a.id,e.levels,e.index,'选择模型','high').text,'a · high');
 const named=[{id:'low',label:'低'},{id:'high',label:'高'}];
 assert.equal(triggerSummary('m',named,0,'选择模型','high').text,'m · 高');
 assert.equal(triggerSummary('m',named,0,'选择模型','<unknown>').text,'m · <unknown>');
});
test('saved effort cannot leak onto an absent model or unsupported/missing reasoning metadata',()=>{
 assert.equal(triggerSummary('plain',[],-1,'选择模型','ultra').text,'plain');
 assert.equal(triggerSummary(undefined,[{id:'high',label:'高'}],0,'选择模型','high').text,'选择模型');
});
test('trigger preserves full long or markup-looking names as plain display data',()=>{
 const name='<script>'+('very-long-model-'.repeat(40)), label='<img src=x onerror=bad>';
 assert.equal(triggerSummary(name,[{label}],0,'Choose model').text,name+' · '+label);
});
test('trigger source wiring uses committed index, separate depth text and full accessible summary',()=>{
 const view=read('src/view.cjs'),css=read('src/panel.css');
 assert.match(view,/triggerSummary\(modelName, levels, effortIndex, translate\('chooseModel'\), current\?\.reasoningEffort\)/);
 assert.match(view,/title: trigger\.text, 'aria-label': translate\('title'\) \+ ': ' \+ trigger\.text/);
 assert.match(view,/className: 'dsh-qmp-trigger-effort' \}, '· ' \+ trigger\.effort/);
 assert.match(css,/\.dsh-qmp-trigger-label \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis/);
 assert.match(css,/\.dsh-qmp-trigger-effort \{[^}]*flex: 0 0 auto;[^}]*max-width: 45%/);
});
test('team disable after model use requires confirmation, decline never writes',()=>{
 const h={lastUsed:{model:'x'}}, m={enabled:true}; assert.equal(teamDecision(m,h,false,false),'confirm');assert.equal(teamDecision(m,h,false,true),'write');assert.equal(teamDecision(m,h,true,false),'unchanged');
});
test('unused session can disable directly; unknown history cannot write',()=>{assert.equal(teamDecision({enabled:true},{lastUsed:null},false,false),'write'); assert.equal(teamDecision({enabled:true},undefined,false,true),'blocked');assert.equal(teamDecision(undefined,{},true,true),'blocked');});
test('same-window favorites are observable; snapshots stable; explicit unstar stays empty',()=>{
 const map=new Map(), store=sharedFavorites({getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)},createFavorites);let changes=0;
 const stop=store.subscribe(()=>changes++);store.seed(a);const snap=store.getSnapshot();store.refresh();assert.strictEqual(store.getSnapshot(),snap);assert.equal(changes,1);
 store.toggle(a);store.seed(b);assert.deepEqual(store.getSnapshot(),[]);assert.equal(changes,2);stop();store.toggle(b);assert.equal(changes,2);
});
test('rapid local star toggles notify once per mutation, keep the catalog out of storage and survive reopening',()=>{
 const data=new Map(); let reads=0,writes=0; const storage={getItem:k=>{reads++;return data.get(k)??null;},setItem:(k,v)=>{writes++;data.set(k,v);}};
 const store=sharedFavorites(storage,createFavorites);store.seed(a);let seen=[];store.subscribe(()=>seen.push(store.getSnapshot().map(m=>m.id)));
 const start={reads,writes};assert.equal(store.toggle(b).ok,true);assert.equal(store.toggle(c).ok,true);assert.equal(store.toggle(b).ok,true);
 assert.deepEqual(seen,[['a','b'],['a','b','c'],['a','c']]);assert.equal(writes-start.writes,3);assert.equal(reads-start.reads,3);
 assert.deepEqual(sharedFavorites(storage,createFavorites).getSnapshot(),[{provider:'test',id:'a'},{provider:'test',id:'c'}]);
});
test('failed local storage does not publish a successful-looking favorite',()=>{
 let fail=false;const map=new Map(),store=sharedFavorites({getItem:k=>map.get(k)??null,setItem:(k,v)=>{if(fail)throw Error('full');map.set(k,v);}},createFavorites);
 store.seed(a);const before=store.getSnapshot();let notified=0;store.subscribe(()=>notified++);fail=true;
 assert.equal(store.toggle(b).ok,false);assert.strictEqual(store.getSnapshot(),before);assert.equal(notified,0);
});
test('right-edge anchor leaves room for right-side picker',()=>{assert.deepEqual(horizontalLayout(1200,800,true),{width:340,side:'right',left:504});assert.equal(horizontalLayout(1200,800,false).left,800);});
test('exact minimum desktop width and narrow viewport stay within edges',()=>{assert.equal(horizontalLayout(704,500,true).side,'right');assert.deepEqual(horizontalLayout(375,340,true),{width:340,side:'inside',left:27});assert.equal(horizontalLayout(320,100,true).width,304);});
test('actual client artifact matches its sources and declares one lazy module without running UI',()=>{
 const js=read('client.js');assert.equal(js,buildClient()); let descriptor; vm.runInNewContext(js,{window:{__ModuleLoader__:{load:d=>{assert.equal(descriptor,undefined);descriptor=d;}}}});
 assert.equal(descriptor.id,JSON.parse(read('package.json')).name);assert.equal(typeof descriptor.factory,'function');assert.deepEqual([...js.matchAll(/\brequire\(['"]([^'"]+)['"]\)/g)].map(m=>m[1]),['react','react-dom']);
});
test('default effort labels stay short without changing effort selection',()=>{
 const labels=JSON.parse(read('src/host-locales.json'));
 assert.equal(labels.zh['host.default'],'默认');assert.equal(labels.en['host.default'],'Default');
});
test('manifest and both language resources ship with all runtime parts',()=>{
 const pkg=JSON.parse(read('package.json'));assert.equal(pkg.engines.dsh,'0.2.2-rc.3');assert.equal(pkg.dsh.client.platform,'web');assert.equal(pkg.dsh.bundle.patch,'./cordis.patch.yml');
 assert.equal(pkg.license,'MIT'); assert.equal(pkg.private,true);
 for (const name of ['index.js','client.js','icon.svg','README.md','LICENSE','SECURITY.md','cordis.patch.yml','locale/en.json','locale/zh.json']) assert.ok(read(name).length>0);
 assert.deepEqual(pkg.files,['index.js','client.js','cordis.patch.yml','locale/*.json','icon.svg','README.md','LICENSE','SECURITY.md']);
 for (const file of ['src/view-locales.json','src/host-locales.json']) {const d=JSON.parse(read(file));assert.deepEqual(Object.keys(d.zh).sort(),Object.keys(d.en).sort());}
 for (const lang of ['en','zh']){const d=JSON.parse(read('locale/'+lang+'.json')).meta;assert.ok(d.title&&d.description);}
});
