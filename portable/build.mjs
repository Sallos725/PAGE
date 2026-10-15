// portable/build.mjs — 포터블 폴더 조립 (스펙 §2). 서버(npm run build + prune --omit=dev)·웹(npm run build)을 먼저 빌드해 둔다.
// 사용: node portable/build.mjs --node <node(.exe)> [--launcher <PAGE.exe>] --out <없는 폴더>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const node = arg('--node'), launcher = arg('--launcher'), out = arg('--out');
if (!node || !out) { console.error('usage: node portable/build.mjs --node <node(.exe)> [--launcher <PAGE.exe>] --out <dir>'); process.exit(2); }
if (fs.existsSync(out)) { console.error('out already exists — refusing to overwrite'); process.exit(2); }

const need = ['server/dist/index.js', 'server/dist/portable/launch.js', 'server/node_modules', 'server/vendor', 'web/dist/index.html'];
for (const n of need) if (!fs.existsSync(path.join(repo, n))) { console.error(`missing ${n} — build server and web first`); process.exit(2); }
if (['typescript', 'vitest'].some((d) => fs.existsSync(path.join(repo, 'server/node_modules', d)))) { console.error('server/node_modules has dev deps — run npm prune --omit=dev'); process.exit(2); }

const cp = (from, to) => fs.cpSync(path.join(repo, from), path.join(out, to), { recursive: true, verbatimSymlinks: true });
fs.mkdirSync(path.join(out, 'bin'), { recursive: true });
const nodeDest = path.join(out, 'bin', node.toLowerCase().endsWith('.exe') ? 'node.exe' : 'node');
fs.copyFileSync(node, nodeDest);
fs.chmodSync(nodeDest, 0o755); // 리눅스 스모크용 (Windows 에서는 영향 없음)
if (launcher) fs.copyFileSync(launcher, path.join(out, 'PAGE.exe'));
cp('server/package.json', 'app/server/package.json');
cp('server/dist', 'app/server/dist');
cp('server/vendor', 'app/server/vendor');
cp('server/node_modules', 'app/server/node_modules');
cp('web/dist', 'app/web/dist');
cp('portable/app/launch.mjs', 'app/launch.mjs');
// 메모장이 바로 읽게 UTF-8 BOM + CRLF 로 (저장소 파일은 LF 그대로)
const readme = fs.readFileSync(path.join(repo, 'portable/읽어주세요.txt'), 'utf8').replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n');
fs.writeFileSync(path.join(out, '읽어주세요.txt'), '\uFEFF' + readme);
cp('LICENSE', 'LICENSE');
cp('NOTICE.md', 'NOTICE.md');
console.log('assembled');
