import os,pty,termios,subprocess,select,sys,time,json
master,slave=pty.openpty()
before=termios.tcgetattr(slave)
p=subprocess.Popen([sys.argv[1],sys.argv[2],sys.argv[3]],stdin=slave,stdout=slave,stderr=slave)
output=b''
deadline=time.monotonic()+12
try:
 while b'Runner token: ' not in output and time.monotonic()<deadline:
  ready,_,_=select.select([master],[],[],0.1)
  if ready:output+=os.read(master,4096)
 if b'Runner token: ' not in output:raise RuntimeError('prompt unavailable')
 os.write(master,b'\x03' if sys.argv[3] in ['cancel','public'] else b'synthetic-secret\r\n')
 while p.poll() is None and time.monotonic()<deadline:
  ready,_,_=select.select([master],[],[],0.1)
  if ready:output+=os.read(master,4096)
 if p.poll() is None:raise RuntimeError('child timeout')
 ready,_,_=select.select([master],[],[],0)
 if ready:output+=os.read(master,4096)
 after=termios.tcgetattr(slave)
 assert b'synthetic-secret' not in output,'secret was echoed'
 assert (before[3] & (termios.ECHO|termios.ICANON)) == (after[3] & (termios.ECHO|termios.ICANON)),'TTY not restored'
 assert (b'"cancelled":true' if sys.argv[3] in ['cancel','public'] else b'"ok":true') in output,'child result missing'
 print(json.dumps({'passed':True,'exitCode':p.returncode}))
finally:
 if p.poll() is None:p.kill();p.wait()
 os.close(master);os.close(slave)
