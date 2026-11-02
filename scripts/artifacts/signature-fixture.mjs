import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
const exec = promisify(execFile);
export const jdkTool = name => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', name) : '/usr/bin/' + name;
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i=0;i<8;i++) n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0; });
function crc32(bytes) { let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0; }
// Small stored ZIP fixture writer. Never used by production verification.
export function zipFixture(entries) {
  let offset=0;const local=[],central=[];
  for(const [name,value] of entries){const bytes=Buffer.from(value),n=Buffer.from(name),crc=crc32(bytes),h=Buffer.alloc(30),c=Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc,14);h.writeUInt32LE(bytes.length,18);h.writeUInt32LE(bytes.length,22);h.writeUInt16LE(n.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(bytes.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);
    local.push(h,n,bytes);central.push(c,n);offset+=h.length+n.length+bytes.length;
  }
  const end=Buffer.alloc(22),cd=Buffer.concat(central);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,cd,end]);
}
export function readFixtureEntries(bytes) {
  let end=bytes.length-22;while(end>=0&&bytes.readUInt32LE(end)!==0x06054b50)end--;
  if(end<0)throw new Error('FIXTURE_ZIP_INVALID');let pos=bytes.readUInt32LE(end+16);const entries=[];
  for(let i=0;i<bytes.readUInt16LE(end+10);i++){
    const method=bytes.readUInt16LE(pos+10),size=bytes.readUInt32LE(pos+20),len=bytes.readUInt16LE(pos+28),extra=bytes.readUInt16LE(pos+30),comment=bytes.readUInt16LE(pos+32),offset=bytes.readUInt32LE(pos+42),name=bytes.subarray(pos+46,pos+46+len).toString();
    const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28),data=bytes.subarray(start,start+size);
    if(![0,8].includes(method))throw new Error('FIXTURE_METHOD');entries.push([name,method===8?inflateRawSync(data):Buffer.from(data)]);pos+=46+len+extra+comment;
  }return entries;
}
export async function signedBundleFixture({ expired=false }={}) {
  const root=await mkdtemp(join(await realpath(tmpdir()),'flora-signature-')),pass=randomBytes(24).toString('hex');
  const unsigned=join(root,'unsigned.aab'),signed=join(root,'signed.aab'),store=join(root,'test-only.p12'),cert=join(root,'cert.der');
  const entries=[['BundleConfig.pb','synthetic config; NOT a real compiled app'],['base/manifest/AndroidManifest.xml','synthetic manifest'],['base/dex/classes.dex','synthetic dex']];
  try {
    await writeFile(unsigned,zipFixture(entries));
    await exec(jdkTool('keytool'),['-genkeypair','-alias','upload','-keystore',store,'-storetype','PKCS12','-storepass',pass,'-keyalg','RSA','-keysize','2048','-sigalg','SHA256withRSA','-dname','CN=Flora Ephemeral Test Only','-validity',expired?'1':'3650',...(expired?['-startdate','2020/01/01 00:00:00']:[])],{timeout:20000,maxBuffer:65536});
    await exec(jdkTool('keytool'),['-exportcert','-alias','upload','-keystore',store,'-storepass',pass,'-file',cert],{timeout:10000,maxBuffer:65536});
    await exec(jdkTool('jarsigner'),['-keystore',store,'-storepass',pass,'-sigalg','SHA256withRSA','-digestalg','SHA-256','-signedjar',signed,unsigned,'upload'],{timeout:20000,maxBuffer:65536});
    const signerSha256=new X509Certificate(await readFile(cert)).fingerprint256.replaceAll(':','').toLowerCase();
    const context={appId:'app-a',jobId:'signed-one',repository:'owner/app',sourceSha:'b'.repeat(40),platform:'android',runnerId:'runner-a'};
    const policy={scheme:'aab-jar-v1',javaExecutable:jdkTool('java'),expectedSignerSha256:signerSha256};
    async function manifest(path=signed){const bytes=await readFile(path);return {...context,byteCount:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}
    return {root,unsigned,signed,entries,policy,context,manifest,close:()=>rm(root,{recursive:true,force:true})};
  } catch {await rm(root,{recursive:true,force:true});throw new Error('SIGNATURE_TEST_JDK_FIXTURE_FAILED');}
}
