import {lstat,open} from "node:fs/promises";
import {constants} from "node:fs";
import {isAbsolute} from "node:path";
import {invariant} from "./artifacts.js";
import {createRunnerClient} from "./client.js";
import {dockerArguments} from "./docker.js";
export interface RunnerConfig {origin:string;token:string;dockerImage:string;dockerNetwork?:string;resourceProfile?:"default"|"github-hosted";dependencyPreparation?:"npm-registry";publicationRecovery?:"remote-checkpoint";workDirectory?:string;recoveryDirectory?:string}
/** A credential is loaded by the controller only. No environment or command overrides. */
export async function readRunnerConfig(path:string):Promise<RunnerConfig>{
 try{
  const stat=await lstat(path);invariant(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=16384&&(stat.mode&0o077)===0&&(!process.getuid||stat.uid===process.getuid()));
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let raw:unknown;
  try{const current=await file.stat();invariant(current.ino===stat.ino&&current.dev===stat.dev&&current.size<=16384&&current.nlink===1&&(current.mode&0o077)===0&&(!process.getuid||current.uid===process.getuid()));raw=JSON.parse(await file.readFile("utf8"));}finally{await file.close();}
  invariant(raw&&typeof raw==="object"&&!Array.isArray(raw));const value=raw as Record<string,unknown>;
  invariant(Object.keys(value).every(key=>["origin","token","dockerImage","dockerNetwork","resourceProfile","dependencyPreparation","publicationRecovery","workDirectory","recoveryDirectory"].includes(key))&&typeof value.origin==="string"&&typeof value.token==="string"&&typeof value.dockerImage==="string");
  invariant(value.resourceProfile===undefined||value.resourceProfile==="default"||value.resourceProfile==="github-hosted");
  invariant(value.dependencyPreparation===undefined||value.dependencyPreparation==="npm-registry"&&value.resourceProfile==="github-hosted"&&(value.dockerNetwork===undefined||value.dockerNetwork==="none"));
  invariant(value.publicationRecovery===undefined||value.publicationRecovery==="remote-checkpoint"&&value.resourceProfile==="github-hosted");
  invariant(value.dockerNetwork===undefined||typeof value.dockerNetwork==="string");invariant(value.workDirectory===undefined||typeof value.workDirectory==="string"&&isAbsolute(value.workDirectory)&&!/[\r\n,]/.test(value.workDirectory));
  invariant(value.recoveryDirectory===undefined||typeof value.recoveryDirectory==="string"&&isAbsolute(value.recoveryDirectory)&&!/[\r\n,]/.test(value.recoveryDirectory));
  createRunnerClient({origin:value.origin,token:value.token});dockerArguments(value.dockerImage,"flora-config","/source","/runner",value.dockerNetwork as string|undefined,value.resourceProfile as "default"|"github-hosted"|undefined);
  return value as unknown as RunnerConfig;
 }catch{throw new Error("INVALID_RUNNER_CONFIG");}
}
