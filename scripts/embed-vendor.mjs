// 把 vendor/ 下的 React Flow 产物内嵌进 client.js，避免依赖任何静态路由或 CDN。
// 用法：node scripts/embed-vendor.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const jsPath = join(root, 'vendor', 'xyflow.global.js');
const cssPath = join(root, 'vendor', 'xyflow.css');
const clientPath = join(root, 'client.js');

const js = readFileSync(jsPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');
let src = readFileSync(clientPath, 'utf8');

const jsMarker = /const VENDOR_JS = '\/\*<<VENDOR_JS>>\*\/';/;
const cssMarker = /const VENDOR_CSS = '\/\*<<VENDOR_CSS>>\*\/';/;

if (!jsMarker.test(src)) throw new Error('client.js 里找不到 VENDOR_JS 占位符');
if (!cssMarker.test(src)) throw new Error('client.js 里找不到 VENDOR_CSS 占位符');

src = src.replace(jsMarker, `const VENDOR_JS = ${JSON.stringify(js)};`);
src = src.replace(cssMarker, `const VENDOR_CSS = ${JSON.stringify(css)};`);

writeFileSync(clientPath, src, 'utf8');
console.log(`embedded: js ${(js.length / 1024).toFixed(1)}kb, css ${(css.length / 1024).toFixed(1)}kb -> client.js ${(src.length / 1024).toFixed(0)}kb`);
