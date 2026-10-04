import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/vendor', { recursive: true });
await copyFile('node_modules/echarts/dist/echarts.min.js', 'dist/vendor/echarts.min.js');
await copyFile('node_modules/xlsx/dist/xlsx.full.min.js', 'dist/vendor/xlsx.full.min.js');
await copyFile('node_modules/echarts/LICENSE', 'dist/vendor/ECHARTS-LICENSE.txt');
await copyFile('node_modules/xlsx/LICENSE', 'dist/vendor/SHEETJS-LICENSE.txt');
