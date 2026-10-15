// portable/app/launch.mjs — PAGE.exe 가 bin\node.exe 로 실행하는 진입점. 로직은 server/src/portable/launch.ts.
import { fileURLToPath } from 'node:url';
import { main } from './server/dist/portable/launch.js';

process.exitCode = await main(fileURLToPath(new URL('..', import.meta.url)));
