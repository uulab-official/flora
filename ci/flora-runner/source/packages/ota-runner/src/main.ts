#!/usr/bin/env node
import {readRunnerConfig} from "./config.js";
import {createRunnerClient,RunnerHttpFailure} from "./client.js";
import {createGitHubSourceProvider} from "./source.js";
import {createDockerExecutor} from "./docker.js";
import {dirname,join,resolve} from "node:path";
import {reconcilePublication,pendingRecoveryJournals,reconcileRemotePublications} from "./recovery.js";
import {runDaemon,runOne} from "./daemon.js";
async function main(){
 const args=process.argv.slice(2),once=args.includes("--once"),index=args.indexOf("--config"),reconcile=args.indexOf("--reconcile");
 if(index<0||!args[index+1]||reconcile>=0&&(once||!args[reconcile+1])||args.length!==(reconcile>=0?4:once?3:2)||args.some((arg,i)=>i!==index+1&&i!==(reconcile>=0?reconcile+1:-1)&&!["--config","--once","--reconcile"].includes(arg))){process.stderr.write("Usage: flora-ota-runner --config /absolute/private/runner.json [--once | --reconcile /absolute/private/recovery.json]\n");process.exitCode=2;return;}
 const config=await readRunnerConfig(args[index+1]!);const controller=new AbortController(),stop=()=>controller.abort();process.once("SIGINT",stop);process.once("SIGTERM",stop);
 try{
  const client=createRunnerClient(config);
  if(reconcile>=0){const result=await reconcilePublication(client,resolve(args[reconcile+1]!),config.publicationRecovery==="remote-checkpoint");process.stdout.write(JSON.stringify({state:"succeeded",jobId:result.job.id,platform:result.job.platform,deploymentId:result.deployment.id})+"\n");return;}
  const recoveryDirectory=config.recoveryDirectory??join(dirname(resolve(args[index+1]!)),"recovery"),pending=await pendingRecoveryJournals(recoveryDirectory);
  if(config.publicationRecovery==="remote-checkpoint")await reconcileRemotePublications(client,recoveryDirectory);
  else if(pending.length){process.stdout.write(JSON.stringify({state:"publication_unknown",recoveryJournal:pending[0]})+"\n");throw new Error("PUBLICATION_RECONCILIATION_REQUIRED");}
  const executor=createDockerExecutor({image:config.dockerImage,...(config.dockerNetwork?{network:config.dockerNetwork}:{}),...(config.resourceProfile?{resourceProfile:config.resourceProfile}:{}),...(config.dependencyPreparation?{dependencyPreparation:config.dependencyPreparation}:{})});await executor.verify(controller.signal);
  const options={client,recoveryDirectory,source:createGitHubSourceProvider(),executor,signal:controller.signal,...(config.workDirectory?{workDirectory:config.workDirectory}:{}),...(config.publicationRecovery==="remote-checkpoint"?{remoteCheckpoint:true}:{}),...(config.resourceProfile==="github-hosted"?{diagnostics:true}:{})};
  if(once){const result=await runOne(options);process.stdout.write(JSON.stringify(result)+"\n");if(!["empty","succeeded"].includes(result.state))process.exitCode=1;}
  else await runDaemon({...options,onOutcome:result=>process.stdout.write(JSON.stringify(result)+"\n")});
 }finally{process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);}
}
void main().catch(error=>{const code=error instanceof RunnerHttpFailure?error.message:error instanceof Error&&["INVALID_RUNNER_CONFIG","ISOLATION_UNAVAILABLE","ISOLATION_CLEANUP_UNCONFIRMED","PUBLICATION_RECONCILIATION_REQUIRED","INVALID_RECOVERY_JOURNAL","RECOVERY_JOURNAL_UNAVAILABLE","RECOVERY_CLEANUP_UNCONFIRMED","RECOVERY_CHECKPOINT_UNAVAILABLE","PUBLICATION_RESULT_UNCONFIRMED"].includes(error.message)?error.message:"RUNNER_STOPPED";process.stderr.write(code+"\n");process.exitCode=1;});
