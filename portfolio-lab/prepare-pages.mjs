import {createHash} from 'node:crypto';
import {copyFile,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateSnapshot} from './market-snapshot.mjs';

const project=dirname(fileURLToPath(import.meta.url));

async function filesIn(directory,prefix='') {
  const files=[];
  for(const entry of await readdir(join(directory,prefix),{withFileTypes:true})) {
    const path=prefix?`${prefix}/${entry.name}`:entry.name;
    if(entry.isSymbolicLink())throw Error(`Pages does not support symbolic links: ${path}`);
    if(entry.isDirectory())files.push(...await filesIn(directory,path));
    else if(entry.isFile())files.push(path);
  }
  return files.sort();
}

/** Publish one coherent HTML, module, stylesheet and font version per release. */
export async function preparePages({source=join(project,'dist'),output=join(project,'artifacts','pages')}={}) {
  source=resolve(source);output=resolve(output);
  if(source===output||source.startsWith(output+sep)||output.startsWith(source+sep))throw Error('Pages output must be separate from the source directory.');
  const files=await filesIn(source),available=new Set(files);
  for(const required of ['index.html','app.js','style.css','fonts.css','vendor/echarts.min.js','vendor/xlsx.full.min.js','data/market-data.json']) {
    if(!available.has(required))throw Error(`Missing required website file: ${required}`);
  }
  // Keep publication limited to genuine, complete official observations.
  validateSnapshot(JSON.parse(await readFile(join(source,'data/market-data.json'),'utf8')));
  const content=new Map();
  for(const file of files)content.set(file,await readFile(join(source,file)));
  for(const file of files.filter(name=>name.endsWith('.js')&&!name.startsWith('vendor/'))) {
    const imports=content.get(file).toString().matchAll(/\b(?:import|export)\s+(?:[^;'"`]*?\s+from\s*)?['"](\.[^'"]+)['"]/g);
    for(const [,specifier] of imports) {
      const dependency=relative(source,resolve(source,dirname(file),specifier)).split(sep).join('/');
      if(!available.has(dependency))throw Error(`Missing module ${specifier} imported by ${file}`);
    }
  }
  const assets=files.filter(file=>file!=='index.html'&&!file.startsWith('data/'));
  const hash=createHash('sha256');
  // Data refreshes preserve code URLs; changing HTML or any asset changes all URLs.
  for(const file of ['index.html',...assets])hash.update(file+'\0').update(content.get(file)).update('\0');
  const revision=hash.digest('hex').slice(0,16),prefix=`assets/${revision}/`;
  const html=content.get('index.html').toString().replace(/\b(src|href)=(['"])([^'"]+)\2/g,(match,attribute,quote,url)=>{
    if(!assets.includes(url))return match;
    return `${attribute}=${quote}${prefix}${url}${quote}`;
  });
  if(!html.includes(`src="${prefix}app.js"`))throw Error('The page must load the versioned application entry point.');
  // Validate before replacing any previous local artifact.
  await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
  for(const file of files) {
    await mkdir(dirname(join(output,file)),{recursive:true});
    await copyFile(join(source,file),join(output,file));
  }
  for(const file of assets) {
    const destination=join(output,prefix,file);await mkdir(dirname(destination),{recursive:true});
    await writeFile(destination,content.get(file));
  }
  await writeFile(join(output,'index.html'),html);
  await writeFile(join(output,'.nojekyll'),'');
  const manifest={revision,assets:prefix,commit:process.env.GITHUB_SHA||null};
  await writeFile(join(output,'build.json'),JSON.stringify(manifest)+'\n');
  return {output,...manifest};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.length&&(args.length!==2||args[0]!=='--output'||!args[1]))throw Error('Usage: node prepare-pages.mjs [--output DIRECTORY]');
  const result=await preparePages(args.length?{output:resolve(args[1])}:{});
  console.log(`Prepared GitHub Pages: ${result.output}; asset revision ${result.revision}.`);
}
