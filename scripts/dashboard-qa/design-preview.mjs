/** Private local preview with a copy of the native acceptance dataset. */
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {openDatabase,migrate,createSqliteDogfoodStore} from '@app-ops/db';
import {createDogfoodService,createBlockedProvider,startDashboard} from '@app-ops/dashboard';
const directory=resolve('dist/design-preview');await mkdir(directory,{recursive:true});
const destination=join(directory,'workspace.db');
try{await access(destination);}catch{
  const source=new DatabaseSync(resolve('dist/native-qa-2026-10-12/acceptance.db'),{readOnly:true});
  try{await backup(source,destination);}finally{source.close();}
}
const db=openDatabase(destination);migrate(db);
const service=await createDogfoodService(createSqliteDogfoodStore(db),[createBlockedProvider()],Date.now);
const server=await startDashboard({service,port:4173});
console.log(JSON.stringify({origin:server.origin,bootstrapUrl:server.bootstrapUrl,preview:'isolated-native-qa-copy'}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await server.close();await service.close();db.close();process.exit();});
