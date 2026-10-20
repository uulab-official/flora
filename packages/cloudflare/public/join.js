import {createOrgUi} from './organization.js';
/** Consume a fragment before any await; never put it in URLs, storage or logs. */
export async function startJoin(env,root){
  let nonce=new URLSearchParams(String(env.location.hash??'').slice(1)).get('invite')??'',correctable=false;
  env.history.replaceState(null,'','/join');
  const request=async(method,path,body)=>{
    const response=await env.fetch(path,{method,credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok){
      if(response.status===400&&path==='/api/auth/member/accept'){
        try{const value=await response.json();correctable=['INVALID_PASSWORD','INVALID_REQUEST','INVALID_INPUT'].includes(value?.error);}catch{/* Unknown responses remain one-shot. */}
      }
      throw Object.assign(new Error('JOIN_UNAVAILABLE'),{status:response.status});
    }
    return response.json();
  };
  const u=createOrgUi(root,{request,invalidate(){env.location.replace('/login');}}),{el,input}=u;
  root.className='org-console join-console';
  const login=el('a','이미 등록했거나 응답을 확인하지 못했다면 로그인으로 이동');login.href='/login';root.append(login);
  root.append(el('span','FLORA · TEAM ACCESS','org-eyebrow'),el('h1','함께 앱을 운영하세요'),el('p','초대받은 계정의 비밀번호를 등록해 조직에 참여합니다.','subtle'),u.status);
  const dispose=()=>{nonce='';u.dispose();};env.addEventListener?.('pagehide',dispose);
  if(!nonce||nonce.length>512){u.message('등록 링크를 확인해 주세요.');return dispose;}
  await u.run('POST','/api/auth/member/preview',{nonce},preview=>{
    const email=input('이메일','email'),password=input('새 비밀번호 · 15자 이상','password'),confirm=input('비밀번호 확인','password'),form=el('form','','org-form');
    email.input.value='';form.append(el('p','초대받은 주소: '+(preview.maskedEmail??''),'subtle'));password.input.autocomplete=confirm.input.autocomplete='new-password';
    const submit=el('button','계정 등록 · 로그인','button primary');submit.type='submit';form.append(el('h2',preview.organizationName??'조직 참여'),email.field,password.field,confirm.field,submit);
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(submit.disabled||!u.alive()||!nonce)return;
      const body={nonce,email:email.input.value,password:password.input.value,confirmation:confirm.input.value},length=Array.from(body.password).length;
      if(length<15||length>128||body.password!==body.confirmation){u.message('비밀번호는 15~128자로 입력하고 확인란과 일치시켜 주세요.');return;}
      password.input.value=confirm.input.value='';submit.disabled=true;correctable=false;
      await u.run('POST','/api/auth/member/accept',body,()=>{nonce='';dispose();env.location.replace('/projects');});
      if(correctable&&u.alive()&&nonce){submit.disabled=false;u.message('입력값을 확인하고 수정한 뒤 다시 제출해 주세요.');}
    });root.append(form);
  });return dispose;
}
if(typeof window!=='undefined'&&window.location.pathname==='/join')void startJoin(window,window.document.getElementById('join-root'));
