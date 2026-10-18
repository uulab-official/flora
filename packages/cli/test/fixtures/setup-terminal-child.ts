import { readSecret, createSetupIO } from "../../dist/setup/terminal.js";
try {
 const secret=process.argv[2]==="public" ? await createSetupIO().readPublic("Runner token") : await readSecret(process.stdin,process.stdout,"Runner token: ",new AbortController().signal);
 process.stdout.write(JSON.stringify({ok:secret==="synthetic-secret",raw:process.stdin.isRaw})+"\n");
} catch {process.stdout.write(JSON.stringify({cancelled:true,raw:process.stdin.isRaw})+"\n");}
