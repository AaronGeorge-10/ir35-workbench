/* Client login routing. Work email domain -> that organisation's own Workbench.
   Domains are not stored in readable form: each entry is a SHA-256 of the domain,
   and the destination is masked with a key derived from the domain, so the page
   source does not list who the clients are. To add a client, regenerate this table
   (see README-site.md). */
(function(){
 var T={"947c7e212fb0cb2a93002884c84aac3a95aa8ff5deedbc11bf2a380d7b7ca815": "caa9119bd4f0a5ca"};
 function hex(b){return Array.prototype.map.call(new Uint8Array(b),function(x){return ('0'+x.toString(16)).slice(-2);}).join('');}
 async function sha(s){return crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));}
 async function route(domain){
  var id=hex(await sha('ir35wb-id:'+domain)); var enc=T[id]; if(!enc) return null;
  var k=new Uint8Array(await sha('ir35wb-route:'+domain)); var out='';
  for(var i=0;i<enc.length/2;i++){out+=String.fromCharCode(parseInt(enc.substr(i*2,2),16)^k[i]);}
  return /^\/[a-z0-9-]+\/$/.test(out)?out:null;
 }
 var f=document.getElementById('loginForm'); if(!f) return;
 var msg=document.getElementById('loginMsg');
 function say(h){msg.innerHTML=h;msg.classList.add('show');}
 f.addEventListener('submit',async function(e){
  e.preventDefault(); msg.classList.remove('show');
  var v=(document.getElementById('email').value||'').trim().toLowerCase();
  var at=v.lastIndexOf('@');
  if(at<1||at===v.length-1){say('Enter your work email address.');return;}
  var dom=v.slice(at+1), p=null;
  try{ p=await route(dom); if(!p&&dom.split('.').length>2){ p=await route(dom.split('.').slice(-2).join('.')); } }catch(err){}
  if(p){ say('Taking you to your organisation&rsquo;s sign-in&hellip;'); window.location.href=p; return; }
  say('We couldn&rsquo;t match that email address to an organisation using the IR35 Workbench.<br><br>'
   +'<b>Contractors:</b> please use the link in your invitation email.<br>'
   +'<b>Everyone else:</b> email <a href="mailto:hello@ir35workbench.co.uk">hello@ir35workbench.co.uk</a> and we&rsquo;ll help.');
 });
})();
