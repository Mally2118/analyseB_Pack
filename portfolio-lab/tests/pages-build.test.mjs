import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,rm,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {preparePages} from '../prepare-pages.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'portfolio-pages-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=join(directory,'source'),output=join(directory,'published');
  await cp(new URL('../dist',import.meta.url),source,{recursive:true});
  return {source,output};
}

test('published HTML versions all modules, styles, libraries and fonts while retaining official data at the repository root',async t=>{
  const options=await fixture(t),build=await preparePages(options),html=await readFile(join(build.output,'index.html'),'utf8');
  for(const file of ['app.js','style.css','fonts.css','vendor/echarts.min.js','vendor/xlsx.full.min.js','favicon.svg'])assert.ok(html.includes(build.assets+file));
  assert.equal(await readFile(join(build.output,build.assets,'engine.js'),'utf8'),await readFile(join(options.source,'engine.js'),'utf8'));
  assert.equal(await readFile(join(build.output,build.assets,'macro.js'),'utf8'),await readFile(join(options.source,'macro.js'),'utf8'));
  assert.ok((await readFile(join(build.output,build.assets,'fonts/plex-sans-400-normal-cyrillic.woff2'))).length>0);
  assert.deepEqual(await readFile(join(build.output,'data/market-data.json')),await readFile(join(options.source,'data/market-data.json')));
  assert.equal(JSON.parse(await readFile(join(build.output,'build.json'),'utf8')).revision,build.revision);
});

test('changing a stylesheet or HTML moves every code URL to a new release, but data-only refreshes retain asset URLs',async t=>{
  const options=await fixture(t),first=await preparePages(options);
  const dataPath=join(options.source,'data/market-data.json'),data=JSON.parse(await readFile(dataPath,'utf8'));
  data.downloadedAt=new Date(Date.parse(data.downloadedAt)+1000).toISOString();await writeFile(dataPath,JSON.stringify(data));
  assert.equal((await preparePages(options)).revision,first.revision);
  const css=join(options.source,'style.css');await writeFile(css,(await readFile(css,'utf8'))+'\n/* next release */\n');
  const changed=await preparePages(options);assert.notEqual(changed.revision,first.revision);
  assert.ok((await readFile(join(options.output,'index.html'),'utf8')).includes(`${changed.assets}app.js`));
  const index=join(options.source,'index.html');await writeFile(index,(await readFile(index,'utf8')).replace('lang="ru"','lang="ru" data-release="next"'));
  assert.notEqual((await preparePages(options)).revision,changed.revision);
});

test('missing ES modules and corrupted statistics block packaging without replacing the previous working artifact',async t=>{
  const options=await fixture(t),first=await preparePages(options),previous=await readFile(join(options.output,'index.html'),'utf8');
  const macroPath=join(options.source,'macro.js'),macro=await readFile(macroPath);
  await unlink(macroPath);await assert.rejects(preparePages(options),/Missing module .*macro\.js/);
  assert.equal(await readFile(join(options.output,'index.html'),'utf8'),previous);
  await writeFile(macroPath,macro);
  const dataPath=join(options.source,'data/market-data.json'),data=JSON.parse(await readFile(dataPath,'utf8'));
  data.demo=true;await writeFile(dataPath,JSON.stringify(data));
  await assert.rejects(preparePages(options),/Снимок статистики/);
  assert.equal(JSON.parse(await readFile(join(first.output,'build.json'),'utf8')).revision,first.revision);
});
