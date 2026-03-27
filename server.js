// StorySpark Production Server v2 - FIXED
// Handles: /api/story  /api/illustrate  /api/upload  /img/:id  /fal  /pay
'use strict';
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');

const PORT                 = process.env.PORT                 || 3000;
const FAL_KEY              = process.env.FAL_KEY              || '';
const ANTHROPIC_KEY        = process.env.ANTHROPIC_KEY        || '';
const APP_URL              = process.env.APP_URL              || `http://localhost:${PORT}`;
const PAYFAST_MERCHANT_ID  = process.env.PAYFAST_MERCHANT_ID  || '';
const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY || '';
const PAYFAST_PASSPHRASE   = process.env.PAYFAST_PASSPHRASE   || '';
const IS_PROD              = process.env.NODE_ENV === 'production';

// ── temp image store ─────────────────────────────────────────────────────────
const tempImages = new Map();
let imgCounter = 0;

// ── helpers ──────────────────────────────────────────────────────────────────
function setCors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,x-api-key,anthropic-version');
}
function readBody(req){
  return new Promise((resolve,reject)=>{
    const c=[];req.on('data',d=>c.push(d));req.on('end',()=>resolve(Buffer.concat(c)));req.on('error',reject);
  });
}
function httpsReq(opts,body){
  return new Promise((resolve,reject)=>{
    const r=https.request(opts,res=>{
      const c=[];res.on('data',d=>c.push(d));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(c)}));
    });
    r.on('error',reject);
    if(body&&body.length) r.write(body);
    r.end();
  });
}
function json(res,data,status=200){
  setCors(res);
  res.writeHead(status,{'Content-Type':'application/json'});
  res.end(JSON.stringify(data));
}
function getHost(req){
  const h=req.headers['x-forwarded-host']||req.headers['host']||`localhost:${PORT}`;
  const p=req.headers['x-forwarded-proto']||(h.includes('railway.app')||h.includes('storytime.co.za')?'https':'http');
  return `${p}://${h}`;
}

// ── fal.ai: submit + poll + result ───────────────────────────────────────────
async function falRun(endpoint, params){
  if(!FAL_KEY) throw new Error('FAL_KEY not configured on server');
  
  // FIX: Unwrap if double-nested (input.input.prompt instead of input.prompt)
  let cleanParams = params;
  if(params && params.input && typeof params.input === 'object'){
    console.log('[FAL] ⚠️  Detected double-nesting, unwrapping...');
    cleanParams = params.input;
  }
  
  console.log(`[FAL] Submitting to ${endpoint}`);
  console.log(`[FAL] Clean params:`, JSON.stringify(cleanParams, null, 2));
  
  // Submit - wrap in {input: ...} as per fal.ai spec
  const payload = {input: cleanParams};
  const fb=Buffer.from(JSON.stringify(payload));
  
  const sub=await httpsReq({
    hostname:'queue.fal.run',path:`/${endpoint}`,method:'POST',
    headers:{'Authorization':`Key ${FAL_KEY}`,'Content-Type':'application/json','Content-Length':fb.length}
  },fb);
  
  if(sub.status!==200){
    const errorBody = sub.body.toString();
    console.error(`[FAL] Submit failed ${sub.status}:`, errorBody);
    throw new Error(`Fal submit error: ${errorBody.substring(0,200)}`);
  }
  
  const {request_id} = JSON.parse(sub.body.toString());
  if(!request_id) throw new Error('No request_id in response');
  
  console.log(`[FAL] Job queued: ${request_id}`);

  // Poll for completion
  for(let i=0;i<120;i++){
    await new Promise(r=>setTimeout(r,3000));
    const poll=await httpsReq({
      hostname:'queue.fal.run',path:`/${endpoint}/requests/${request_id}/status`,method:'GET',
      headers:{'Authorization':`Key ${FAL_KEY}`}
    },null);
    const status=JSON.parse(poll.body.toString());
    
    if(status.status==='COMPLETED'){
      const resultReq=await httpsReq({
        hostname:'queue.fal.run',path:`/${endpoint}/requests/${request_id}`,method:'GET',
        headers:{'Authorization':`Key ${FAL_KEY}`}
      },null);
      const fullResult = JSON.parse(resultReq.body.toString());
      console.log(`[FAL] ✅ Complete`);
      
      // Return data field if it exists, otherwise full response
      return fullResult.data || fullResult;
    }
    if(status.status==='FAILED'){
      console.error(`[FAL] Job failed:`, status);
      throw new Error(`Fal job failed: ${status.error || 'unknown'}`);
    }
  }
  throw new Error('Fal timeout after 6 minutes');
}

// ── fetch remote image → base64 ──────────────────────────────────────────────
async function fetchImageB64(imgUrl){
  const pu=new URL(imgUrl);
  const r=await httpsReq({hostname:pu.hostname,path:pu.pathname+pu.search,method:'GET',headers:{'User-Agent':'StorySpark/1.0'}},null);
  const ct=r.headers['content-type']||'image/jpeg';
  return {dataUrl:`data:${ct};base64,${r.body.toString('base64')}`,url:imgUrl};
}

// ── PayFast signature ────────────────────────────────────────────────────────
function payfastSig(params,pass){
  let str=Object.entries(params).map(([k,v])=>`${k}=${encodeURIComponent(v).replace(/%20/g,'+')}`).join('&');
  if(pass) str+=`&passphrase=${encodeURIComponent(pass).replace(/%20/g,'+')}`;
  return crypto.createHash('md5').update(str).digest('hex');
}

// ════════════════════════════════════════════════════════════════════════════
const server=http.createServer(async(req,res)=>{
  const {pathname,query}=url.parse(req.url,true);
  if(req.method==='OPTIONS'){setCors(res);res.writeHead(204);res.end();return;}

  try{

    // ── /api/story — generate story text via Anthropic Claude ────────────────
    if(pathname==='/api/story'&&req.method==='POST'){
      const b=JSON.parse((await readBody(req)).toString());
      const {name,age,gender,loves,companions,theme,mood,power,pages=20}=b;

      if(!ANTHROPIC_KEY){json(res,{error:'ANTHROPIC_KEY not set on server'},503);return;}

      const pronoun=gender==='F'?'she/her':'he/him';
      const compStr=Array.isArray(companions)&&companions.length?companions.join(' and '):'';
      const prompt=`You are a children's picture book author. Write a personalised ${pages}-page storybook in JSON.

CHILD: ${name}, age ${age}, ${pronoun}
WORLD: ${theme?.name||'Adventure'} — ${theme?.env||'magical world'}
MOOD: ${mood||'Heartwarming'}
${loves?'LOVES: '+loves:''}
${compStr?'COMPANIONS: '+compStr:''}
${power?'SUPERPOWER: "'+power+'"':''}

Rules:
- Each page: 2-3 sentences, age-appropriate for ${age} year olds
- Use ${name}'s name naturally every few pages
- Each page must be a DIFFERENT scene/action/location
- Build arc: wonder → challenge → courage → triumph → joy
- Return EXACTLY ${pages} pages

Respond ONLY with a valid JSON array. No markdown, no backticks, no explanation:
[{"page":1,"text":"story text","sceneDesc":"vivid 15-word scene description for AI illustration","emoji":"🌟","mood":"wonder"}]`;

      const body=Buffer.from(JSON.stringify({
        model:'claude-opus-4-5',
        max_tokens:6000,
        messages:[{role:'user',content:prompt}]
      }));
      const r=await httpsReq({
        hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',
        headers:{
          'x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01',
          'Content-Type':'application/json','Content-Length':body.length
        }
      },body);
      const d=JSON.parse(r.body.toString());
      if(d.error) throw new Error(d.error.message||JSON.stringify(d.error));
      const raw=(d.content||[]).map(b=>b.text||'').join('').trim()
        .replace(/^```[a-z]*\n?/,'').replace(/```$/,'').trim();
      const story=JSON.parse(raw);
      json(res,{story});return;
    }

    // ── /api/upload — dataUrl → public URL ───────────────────────────────────
    if(pathname==='/api/upload'&&req.method==='POST'){
      const b=JSON.parse((await readBody(req)).toString());
      if(!b.dataUrl||!b.dataUrl.startsWith('data:')){json(res,{error:'Invalid dataUrl'},400);return;}
      const id=`${Date.now()}_${++imgCounter}`;
      tempImages.set(id,b.dataUrl);
      setTimeout(()=>tempImages.delete(id),30*60*1000);
      json(res,{url:`${getHost(req)}/img/${id}`});return;
    }

    // legacy route (old app.html)
    if(pathname==='/upload'&&req.method==='POST'){
      const b=JSON.parse((await readBody(req)).toString());
      if(!b.dataUrl||!b.dataUrl.startsWith('data:')){json(res,{error:'Invalid dataUrl'},400);return;}
      const id=`${Date.now()}_${++imgCounter}`;
      tempImages.set(id,b.dataUrl);
      setTimeout(()=>tempImages.delete(id),30*60*1000);
      json(res,{url:`${getHost(req)}/img/${id}`});return;
    }

    // ── /img/:id — serve temp image ──────────────────────────────────────────
    if(pathname.startsWith('/img/')){
      const id=pathname.slice(5);
      const d=tempImages.get(id);
      if(!d){res.writeHead(404);res.end('Not found or expired');return;}
      const m=d.match(/^data:([^;]+);base64,(.+)$/s);
      if(!m){res.writeHead(400);res.end('Bad data');return;}
      const buf=Buffer.from(m[2],'base64');
      setCors(res);
      res.writeHead(200,{'Content-Type':m[1],'Content-Length':buf.length,'Cache-Control':'no-store'});
      res.end(buf);return;
    }

    // ── /api/illustrate — generate illustration via Fal.ai ───────────────────
    if(pathname==='/api/illustrate'&&req.method==='POST'){
      const b=JSON.parse((await readBody(req)).toString());
      const {photoUrl,prompt,negPrompt,withFace=true}=b;
      if(!FAL_KEY){json(res,{error:'FAL_KEY not set on server'},503);return;}

      const PIXAR='Pixar 3D animated movie style, polished smooth surfaces, subsurface skin scattering, vibrant saturated colours, soft cinematic rim lighting, Disney-Pixar character design, expressive cartoon eyes, professional 3D render, depth of field, volumetric atmosphere';
      const NEG='realistic photograph, blurry, deformed, ugly, extra limbs, text, watermark, signature, bad anatomy, cross-eyed, distorted features, low quality, noise, adult face, old person, multiple people';

      let result;
      if(withFace&&photoUrl){
        result=await falRun('fal-ai/flux-pulid',{
          prompt:`${PIXAR}, ${prompt}`,
          reference_image_url:photoUrl,
          image_size:'landscape_4_3',
          num_inference_steps:20,
          guidance_scale:4,
          negative_prompt:`${NEG}${negPrompt?', '+negPrompt:''}`,
          true_cfg:1,
          id_weight:1,
          enable_safety_checker:false,
        });
      }else{
        result=await falRun('fal-ai/flux/schnell',{
          prompt:`${PIXAR}, ${prompt}`,
          image_size:'landscape_4_3',
          num_inference_steps:4,
          enable_safety_checker:false,
        });
      }

      // Extract image URL from result
      let imgUrl;
      if(result?.images?.[0]?.url){
        imgUrl=result.images[0].url;
      }else if(result?.image?.url){
        imgUrl=result.image.url;
      }else if(result?.url){
        imgUrl=result.url;
      }else{
        console.error('[ILLUSTRATE] No image URL in result:',JSON.stringify(result,null,2));
        throw new Error('No image URL in fal.ai response');
      }
      
      const {dataUrl}=await fetchImageB64(imgUrl);
      json(res,{dataUrl,url:imgUrl});return;
    }

    // ── /api/faceswap ─────────────────────────────────────────────────────────
    if(pathname==='/api/faceswap'&&req.method==='POST'){
      const b=JSON.parse((await readBody(req)).toString());
      const {faceUrl,sceneUrl}=b;
      if(!FAL_KEY){json(res,{error:'FAL_KEY not set'},503);return;}
      const result=await falRun('fal-ai/face-swap',{base_image_url:sceneUrl,swap_image_url:faceUrl});
      const imgUrl=result?.image?.url||result?.images?.[0]?.url;
      if(!imgUrl) throw new Error('No image in face swap response');
      const {dataUrl}=await fetchImageB64(imgUrl);
      json(res,{dataUrl,url:imgUrl});return;
    }

    // ── legacy /fal proxy (keep for backwards compat) ─────────────────────────
    if(pathname==='/fal'&&req.method==='POST'){
      const b=JSON.parse((await readBody(req)).toString());
      if(!FAL_KEY){json(res,{error:'FAL_KEY not set'},500);return;}
      const fb=Buffer.from(JSON.stringify({input:b.input}));
      const r=await httpsReq({
        hostname:'queue.fal.run',path:`/${b.endpoint}`,method:'POST',
        headers:{'Authorization':`Key ${FAL_KEY}`,'Content-Type':'application/json','Content-Length':fb.length}
      },fb);
      setCors(res);res.writeHead(r.status,{'Content-Type':'application/json'});res.end(r.body);return;
    }
    if(pathname.startsWith('/fal/status/')&&req.method==='GET'){
      const reqId=pathname.slice('/fal/status/'.length);
      const ep=query.endpoint||'fal-ai/flux-pulid';
      if(!FAL_KEY){json(res,{error:'FAL_KEY not set'},500);return;}
      const r=await httpsReq({hostname:'queue.fal.run',path:`/${ep}/requests/${reqId}/status`,method:'GET',headers:{'Authorization':`Key ${FAL_KEY}`}},null);
      setCors(res);res.writeHead(r.status,{'Content-Type':'application/json'});res.end(r.body);return;
    }
    if(pathname.startsWith('/fal/result/')&&req.method==='GET'){
      const reqId=pathname.slice('/fal/result/'.length);
      const ep=query.endpoint||'fal-ai/flux-pulid';
      if(!FAL_KEY){json(res,{error:'FAL_KEY not set'},500);return;}
      const r=await httpsReq({hostname:'queue.fal.run',path:`/${ep}/requests/${reqId}`,method:'GET',headers:{'Authorization':`Key ${FAL_KEY}`}},null);
      setCors(res);res.writeHead(r.status,{'Content-Type':'application/json'});res.end(r.body);return;
    }

    // ── /fetch-image ─────────────────────────────────────────────────────────
    if((pathname==='/fetch-image'||pathname==='/api/fetch-image')&&req.method==='POST'){
      const b=JSON.parse((await readBody(req)).toString());
      if(!b.url||!b.url.startsWith('http')){json(res,{error:'Invalid URL'},400);return;}
      const {dataUrl}=await fetchImageB64(b.url);
      json(res,{dataUrl});return;
    }

    // ── /api/payment/create ───────────────────────────────────────────────────
    if((pathname==='/api/payment/create'||pathname==='/pay/create')&&req.method==='POST'){
      const b=JSON.parse((await readBody(req)).toString());
      const products={
        digital:  {amount:'99.00', name:'StorySpark Digital Book (PDF)'},
        softcover:{amount:'299.00',name:'StorySpark Softcover Printed Book'},
        hardcover:{amount:'499.00',name:'StorySpark Hardcover Printed Book'},
      };
      const prod=products[b.product]||products.digital;
      const orderId=`SS_${Date.now()}_${b.bookId||'book'}`;
      const base=getHost(req);
      const params={
        merchant_id:  PAYFAST_MERCHANT_ID||'10000100',
        merchant_key: PAYFAST_MERCHANT_KEY||'46f0cd694581a',
        return_url:   `${base}/success?order=${orderId}`,
        cancel_url:   `${base}/?cancelled=1`,
        notify_url:   `${base}/api/payment/notify`,
        name_first:   (b.name||'Customer').split(' ')[0],
        name_last:    (b.name||'').split(' ').slice(1).join(' '),
        email_address:b.email||'',
        m_payment_id: orderId,
        amount:       prod.amount,
        item_name:    prod.name,
      };
      params.signature=payfastSig(params,PAYFAST_PASSPHRASE);
      const pfUrl=IS_PROD?'https://www.payfast.co.za/eng/process':'https://sandbox.payfast.co.za/eng/process';
      json(res,{paymentUrl:pfUrl,data:params,orderId});return;
    }

    // ── /api/payment/notify (PayFast ITN) ─────────────────────────────────────
    if((pathname==='/api/payment/notify'||pathname==='/pay/notify')&&req.method==='POST'){
      const b=(await readBody(req)).toString();
      const params=Object.fromEntries(new URLSearchParams(b));
      console.log('PayFast ITN:',params.m_payment_id,params.payment_status);
      res.writeHead(200);res.end('OK');return;
    }

    // ── /health ───────────────────────────────────────────────────────────────
    if(pathname==='/health'){
      json(res,{
        ok:true,time:new Date().toISOString(),
        fal:!!FAL_KEY,anthropic:!!ANTHROPIC_KEY,payfast:!!PAYFAST_MERCHANT_ID,
        tempImages:tempImages.size
      });return;
    }

    // ── serve app.html ────────────────────────────────────────────────────────
    const htmlFile=path.join(__dirname,'app.html');
    if(fs.existsSync(htmlFile)){
      const html=fs.readFileSync(htmlFile);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(html);
    }else{
      res.writeHead(404);res.end('app.html not found');
    }

  }catch(err){
    console.error('Server error:',err.message);
    try{json(res,{error:err.message},500);}catch(e){}
  }
});

server.listen(PORT,()=>{
  console.log(`\n  ╔═══════════════════════════════════════════╗`);
  console.log(`  ║   StorySpark Production Server v2-FIXED  ║`);
  console.log(`  ║   http://localhost:${PORT}                    ║`);
  console.log(`  ║   Fal.ai:     ${FAL_KEY      ?'✅ ready':'❌ set FAL_KEY'}              ║`);
  console.log(`  ║   Anthropic:  ${ANTHROPIC_KEY?'✅ ready':'❌ set ANTHROPIC_KEY'}        ║`);
  console.log(`  ║   PayFast:    ${PAYFAST_MERCHANT_ID?'✅ ready':'⚠️  sandbox mode'}          ║`);
  console.log(`  ╚═══════════════════════════════════════════╝\n`);
});
