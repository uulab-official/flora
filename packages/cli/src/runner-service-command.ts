import {fileURLToPath,pathToFileURL} from 'node:url';
import {isAbsolute} from 'node:path';
import type {CliIO} from './main.js';

const help='flora runner service-config --service <absolute-service.json>\nGenerates a systemd user unit beside the existing private configuration. Does not install, start, contact Flora, or change credentials. Run this on the target Linux server after flora setup runner.\n';
const safeCodes=new Set(['PRIVATE_PATH_REQUIRED','INVALID_SERVICE_CONFIG','RUNNER_SERVICE_HOST_UNSUPPORTED','RUNNER_SERVICE_VM_START_UNSUPPORTED','RUNNER_SERVICE_EXECUTABLE_UNSAFE','RUNNER_SERVICE_OUTPUT_CONFLICT']);
export async function runRunnerServiceCommand(argv:readonly string[],io:CliIO):Promise<number>{
 if(argv.length===1&&argv[0]==='--help'){io.stdout(help);return 0;}
 if(argv.length!==3||argv[0]!=='service-config'||argv[1]!=='--service'||!argv[2]||!isAbsolute(argv[2])){io.stderr('USAGE_ERROR\n'+help);return 2;}
 try{
  const modulePath=pathToFileURL(fileURLToPath(new URL('../../../scripts/local-runner/systemd.mjs',import.meta.url))).href;
  const {generateSystemdService}=await import(modulePath) as {generateSystemdService(path:string):Promise<unknown>};
  io.stdout(JSON.stringify(await generateSystemdService(argv[2]),null,2)+'\n');return 0;
 }catch(error){const code=error instanceof Error&&safeCodes.has(error.message)?error.message:'RUNNER_SERVICE_CONFIG_FAILED';io.stderr(JSON.stringify({error:code})+'\n');return 1;}
}
