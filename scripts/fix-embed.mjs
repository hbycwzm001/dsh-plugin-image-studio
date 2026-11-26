// 修复被 $ 替换符破坏的 VENDOR_JS / VENDOR_CSS 行，用纯字符串切片重写。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clientPath = join(root, 'client.js');
const js = readFileSync(join(root, 'vendor', 'xyflow.global.js'), 'utf8');
const css = readFileSync(join(root, 'vendor', 'xyflow.css'), 'utf8');

let src = readFileSync(clientPath, 'utf8');

const jsLine = src.indexOf('    const VENDOR_JS = "');
if (jsLine < 0) throw new Error('找不到 VENDOR_JS 行');
const cssLine = src.indexOf('\n    const VENDOR_CSS = "', jsLine);
if (cssLine < 0) throw new Error('找不到 VENDOR_CSS 行');
const cssEnd = src.indexOf('\n', cssLine + 1);
if (cssEnd < 0) throw new Error('VENDOR_CSS 行没有结束');

const head = src.slice(0, jsLine);
const tail = src.slice(cssEnd + 1);

const rebuilt =
  '    const VENDOR_JS = ' + JSON.stringify(js) + ';\n' +
  '    const VENDOR_CSS = ' + JSON.stringify(css) + ';';

writeFileSync(clientPath, head + rebuilt + '\n' + tail, 'utf8');
console.log('rebuilt client.js ->', ((head + rebuilt + tail).length / 1024).toFixed(0) + 'kb');
