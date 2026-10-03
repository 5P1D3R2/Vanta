/* VANTA backend v6 · admin simulation + demo-wallet simulation · Daraja STK Push
   Env: MONGO_URI, JWT_SECRET, ALLOW_DEV_CONFIRM, DARAJA_KEY, DARAJA_SECRET,
        MPESA_CB_SECRET, ADMIN_EMAIL (this account always wins, both wallets)
   Optional: DEMO_WIN_RATE (0-1, default 0.95) — win rate for normal users' DEMO trades
   Verify: /version → {"v":"6.0-admin-sim"} */
const express=require('express'),cors=require('cors'),mongoose=require('mongoose'),
      jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs');
const app=express();
app.use(cors());
app.use(express.json());
const JWT_SECRET=process.env.JWT_SECRET||'change-me';
const DEV_CONFIRM=process.env.ALLOW_DEV_CONFIRM==='true';
const MIN_DEPOSIT=4, KES_PER_USD=129;
const DEMO_WIN_RATE=Math.min(1,Math.max(0,parseFloat(process.env.DEMO_WIN_RATE||'0.95')));
const ADMIN_EMAIL=(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
const VERSION='6.0-admin-sim';
const isSimUser=u=>!!(ADMIN_EMAIL&&u&&String(u.email||'').trim().toLowerCase()===ADMIN_EMAIL);
const withSim=(j,u)=>{j.sim=isSimUser(u);return j};

/* ── Daraja config ── */
const MPESA={
  BASE:(process.env.DARAJA_ENV||'sandbox')==='production'
    ?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke',
  KEY:(process.env.DARAJA_KEY||'').trim(),
  SECRET:(process.env.DARAJA_SECRET||'').trim(),
  SHORTCODE:'174379',
  PASSKEY:(process.env.DARAJA_PASSKEY||'').trim()
    ||'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  CB:process.env.MPESA_CB_SECRET
    ?'https://vanta-1-7q8l.onrender.com/mpesa/callback/'+process.env.MPESA_CB_SECRET.trim()
    :'',
};
let mpTok=null;
async function readJson(r,label){
  const txt=await r.text();
  try{return JSON.parse(txt)}
  catch{throw new Error(label+' returned HTTP '+r.status+' non-JSON: '+txt.slice(0,120))}
}
async function safToken(){
  if(!MPESA.KEY||!MPESA.SECRET)throw new Error('Daraja keys not configured (check Render env)');
  if(mpTok&&mpTok.exp>Date.now())return mpTok.tok;
  const r=await fetch(MPESA.BASE+'/oauth/v1/generate?grant_type=client_credentials',
    {headers:{Authorization:'Basic '+Buffer.from(MPESA.KEY+':'+MPESA.SECRET).toString('base64')}});
  const j=await readJson(r,'Daraja auth');
  if(!j.access_token)throw new Error('Daraja auth rejected: '+(j.errorMessage||JSON.stringify(j).slice(0,150)));
  mpTok={tok:j.access_token,exp:Date.now()+3500e3};return mpTok.tok;
}
function stkPassword(){
  const ts=new Date(Date.now()+3*3600e3).toISOString().replace(/\D/g,'').slice(0,14);
  return{ts,pass:Buffer.from(MPESA.SHORTCODE+MPESA.PASSKEY+ts).toString('base64')};}
const normPhone=v=>{let d=(v||'').replace(/\D/g,'');
  if(d.startsWith('0'))d='254'+d.slice(1);
  if(d.length===9&&/^[17]/.test(d))d='254'+d;
  return d};

/* ── assets + price engine ── */
const ASSETS=[
  {id:'EURUSD',name:'EUR/USD',cat:'Forex',start:1.08423,vol:0.00006,dec:5,payout:85},
  {id:'GBPUSD',name:'GBP/USD',cat:'Forex',start:1.27164,vol:0.00009,dec:5,payout:83},
  {id:'USDJPY',name:'USD/JPY',cat:'Forex',start:154.281,vol:0.011,dec:3,payout:82},
  {id:'BTCUSD',name:'BTC/USD',cat:'Crypto',start:67432,vol:16,dec:0,payout:88},
  {id:'ETHUSD',name:'ETH/USD',cat:'Crypto',start:3418.4,vol:1.2,dec:1,payout:86},
  {id:'XAUUSD',name:'GOLD',cat:'Commodity',start:2382.6,vol:0.5,dec:2,payout:84}];
const P={};ASSETS.forEach(a=>P[a.id]={price:a.start,drift:0});
function gauss(){let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)}
setInterval(()=>{for(const a of ASSETS){const s=P[a.id];
  if(Math.random()<0.03)s.drift=(Math.random()-0.5)*a.vol*0.9;
  const pull=(a.start-s.price)/a.start*a.vol*0.35;
  s.price=Math.max(a.start*0.3,s.price+s.drift+s.vol*gauss()+pull);}},400);

/* ── models ── */
const User=mongoose.model('User',new mongoose.Schema({name:String,
  email:{type:String,unique:true,index:true},passwordHash:String,
  wallets:{demo:{type:Number,default:10000},real:{type:Number,default:0}},
  createdAt:{type:Number,default:()=>Date.now()}}));
const Trade=mongoose.model('Trade',new mongoose.Schema({user:{type:Object,index:true},
  asset:String,dir:String,kind:{type:String,default:'updown'},option:String,target:Number,
  legs:Array,mult:Number,amount:Number,account:String,payout:Number,entry:Object,
  entryTime:Number,expiry:Number,status:{type:String,index:true},close:Object,
  closeTime:Number,result:String,profit:Number,
  sim:{type:Boolean,default:false}},{versionKey:false}));
const Tx=mongoose.model('Tx',new mongoose.Schema({user:{type:Object,index:true},
  type:String,method:String,amount:Number,fee:{type:Number,default:0},total:Number,
  bonus:{type:Number,default:0},bonusCode:String,status:String,time:Number,
  confirmedAt:Number,address:String,instructions:Object,checkoutId:String,
  paidAt:Number,mpesaReceipt:String},{versionKey:false}));

const r2=v=>Math.round(v*100)/100;
const pub=o=>{const x=o.toObject?o.toObject():{...o};const j={...x,id:String(x._id)};
  delete j._id;delete j.__v;delete j.user;return j};
const h=f=>(req,res)=>f(req,res).catch(e=>{
  console.error('ERR:',e.message);res.status(500).json({message:e.message||'Server error'})});
async function credit(uid,acc,v){const u=await User.findById(uid);
  u.wallets[acc]=r2(u.wallets[acc]+v);await u.save()}
const auth=(req,res,next)=>{const hd=req.headers.authorization||'';
  try{req.uid=jwt.verify(hd.slice(7),JWT_SECRET).uid;next()}
  catch{res.status(401).json({message:'Please log in again'})}};

function digitOf(id){const a=ASSETS.find(x=>x.id===id);
  const s=P[id].price.toFixed(a.dec);return +s[s.length-1]}
function digitMult(option,t){
  const prob=option==='even'||option==='odd'?.5
    :option==='over'?(9-t)/10:option==='under'?t/10
    :option==='match'?.1:.9;
  return Math.max(1.01,Math.floor((0.95/prob)*100)/100)}

app.get('/version',(req,res)=>res.json({v:VERSION}));

/* ── auth ── */
app.post('/auth/register',h(async(req,res)=>{
  const name=(req.body.name||'').trim(),email=(req.body.email||'').trim().toLowerCase(),
        pw=req.body.password||'';
  if(name.length<2)return res.status(400).json({message:'Enter your name'});
  if(!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({message:'That email doesn\u2019t look right'});
  if(pw.length<6)return res.status(400).json({message:'Use at least 6 characters'});
  if(await User.findOne({email}))return res.status(400).json({message:'An account with this email already exists'});
  const u=await User.create({name,email,passwordHash:await bcrypt.hash(pw,10)});
  res.json({token:jwt.sign({uid:String(u._id)},JWT_SECRET,{expiresIn:'30d'}),user:withSim(pub(u),u)});
}));
app.post('/auth/login',h(async(req,res)=>{
  const u=await User.findOne({email:(req.body.email||'').trim().toLowerCase()});
  if(!u||!await bcrypt.compare(req.body.password||'',u.passwordHash))
    return res.status(401).json({message:'Wrong email or password'});
  res.json({token:jwt.sign({uid:String(u._id)},JWT_SECRET,{expiresIn:'30d'}),user:withSim(pub(u),u)});
}));
app.get('/me',auth,h(async(req,res)=>{
  const u=await User.findById(req.uid);if(!u)return res.status(401).json({message:'Session expired'});
  res.json({user:withSim(pub(u),u)});
}));
app.get('/assets',(req,res)=>res.json(ASSETS.map(({id,name,cat,dec,payout})=>({id,name,cat,dec,payout}))));
app.get('/prices',(req,res)=>res.json({t:Date.now(),
  p:Object.fromEntries(ASSETS.map(a=>[a.id,P[a.id].price]))}));

/* ── trades ── */
app.post('/trades',auth,h(async(req,res)=>{
  const{dir,expirySec,account,kind,option,target,legs}=req.body;
  const asset=req.body.asset,amt=r2(+req.body.amount);
  if(!['demo','real'].includes(account))return res.status(400).json({message:'Bad wallet'});
  if(!(amt>=1))return res.status(400).json({message:'Minimum stake is $1.00'});
  if(!(expirySec>=1&&expirySec<=300))return res.status(400).json({message:'Bad expiry'});
  const u=await User.findById(req.uid);
  if(amt>u.wallets[account])return res.status(400).json({message:'Insufficient balance'});
  const sim=isSimUser(u);
  const base={user:req.uid,amount:amt,account,entryTime:Date.now(),
    expiry:Date.now()+expirySec*1000,status:'open',sim};
  let t;
  if(kind==='digits'){
    const a=ASSETS.find(x=>x.id===asset);
    if(!a)return res.status(400).json({message:'Unknown asset'});
    if(!['even','odd','over','under','match','differ'].includes(option))
      return res.status(400).json({message:'Bad digit option'});
    let tg=null;
    if(option!=='even'&&option!=='odd'){
      tg=+target;if(!(tg>=0&&tg<=9&&Number.isInteger(tg)))
        return res.status(400).json({message:'Pick a digit 0-9'});}
    const mult=digitMult(option,tg);
    u.wallets[account]=r2(u.wallets[account]-amt);await u.save();
    t=await Trade.create({...base,kind:'digits',asset,option,target:tg,mult,entry:digitOf(asset)});
  }else if(kind==='acc'){
    if(!Array.isArray(legs)||legs.length<2||legs.length>5)
      return res.status(400).json({message:'Accumulator needs 2-5 legs'});
    const seen=new Set();let mult=1;const entries=[];
    for(const l of legs){
      const a=ASSETS.find(x=>x.id===l.asset);
      if(!a)return res.status(400).json({message:'Unknown asset in leg'});
      if(!['up','down'].includes(l.dir))return res.status(400).json({message:'Bad leg direction'});
      if(seen.has(l.asset))return res.status(400).json({message:'Each market can appear once'});
      seen.add(l.asset);mult*=(1+a.payout/100);
      entries.push({asset:l.asset,dir:l.dir,entry:P[l.asset].price});}
    mult=r2(mult);
    u.wallets[account]=r2(u.wallets[account]-amt);await u.save();
    t=await Trade.create({...base,kind:'acc',asset:entries[0].asset,legs:entries,mult,entry:entries[0].entry});
  }else{
    const a=ASSETS.find(x=>x.id===asset);
    if(!a)return res.status(400).json({message:'Unknown asset'});
    if(!['up','down'].includes(dir))return res.status(400).json({message:'Bad direction'});
    u.wallets[account]=r2(u.wallets[account]-amt);await u.save();
    t=await Trade.create({...base,kind:'updown',asset,dir,payout:a.payout,entry:P[asset].price});
  }
  res.json(pub(t));
}));
const lastSync=new Map();
app.get('/trades/sync',auth,h(async(req,res)=>{
  const now=Date.now();
  const due=await Trade.find({user:req.uid,status:'open',expiry:{$lte:now}});
  for(const t of due){
    /* sim if: stored flag (admin, any wallet) OR demo wallet (normal users) */
    const sim=(t.sim===true)||t.account==='demo';
    /* admin → always win; normal demo → DEMO_WIN_RATE; real non-admin → real engine */
    const wantWin=sim&&(t.account==='demo'?Math.random()<DEMO_WIN_RATE:true);
    try{
      if(t.kind==='digits'){
        const a=ASSETS.find(x=>x.id===t.asset);
        let d=a?digitOf(t.asset):5;
        if(wantWin){
          if(t.option==='even')d=(d%2===0)?d:(d+1)%10;
          else if(t.option==='odd')d=(d%2===1)?d:((d+1)%10);
          else if(t.option==='over')d=Math.min(9,(t.target==null?4:t.target)+1);
          else if(t.option==='under')d=Math.max(0,(t.target==null?5:t.target)-1);
          else if(t.option==='match')d=(t.target==null?d:t.target);
          else d=((t.target==null?d:t.target)+1)%10;
        }
        t.close=d;
        if(t.entry==null||Number.isNaN(t.entry))t.entry=d;
        const win=wantWin?true:(t.option==='even'?d%2===0:t.option==='odd'?d%2===1
          :t.option==='over'?d>(t.target==null?0:t.target):t.option==='under'?d<(t.target==null?9:t.target)
          :t.option==='match'?d===t.target:d!==t.target);
        t.result=win?'win':'loss';
        t.profit=win?r2(t.amount*(t.mult||digitMult(t.option,t.target))):-t.amount;
        if(win)await credit(req.uid,t.account,r2(t.amount+t.profit));
      }else if(t.kind==='acc'){
        if(wantWin){
          t.close=P[t.asset]?P[t.asset].price:0;t.result='win';
          t.profit=r2(t.amount*(t.mult||2));
          await credit(req.uid,t.account,r2(t.amount+t.profit));
        }else{
          let lost=false,flat=false;
          for(const l of (t.legs||[])){const p=P[l.asset]?P[l.asset].price:0;
            if(l.dir==='up'){if(p<l.entry)lost=true;else if(p===l.entry)flat=true;}
            else{if(p>l.entry)lost=true;else if(p===l.entry)flat=true;}}
          t.close=P[t.asset]?P[t.asset].price:0;
          t.result=lost?'loss':flat?'draw':'win';
          if(t.result==='win'){t.profit=r2(t.amount*(t.mult||2));
            await credit(req.uid,t.account,r2(t.amount+t.profit));}
          else if(t.result==='draw'){t.profit=0;await credit(req.uid,t.account,t.amount);}
          else t.profit=-t.amount;
        }
      }else{
        const a=ASSETS.find(x=>x.id===t.asset);
        if(t.entry==null||Number.isNaN(t.entry))t.entry=P[t.asset]?P[t.asset].price:(a?a.start:0);
        let p=P[t.asset]?P[t.asset].price:t.entry;
        if(wantWin)p=t.dir==='up'?t.entry+Math.max(0.00001,t.entry*0.00001)
                                 :t.entry-Math.max(0.00001,t.entry*0.00001);
        const result=t.dir==='up'?(p>t.entry?'win':p<t.entry?'loss':'draw')
                                 :(p<t.entry?'win':p>t.entry?'loss':'draw');
        t.close=p;t.result=result;
        if(result==='win'){t.profit=r2(t.amount*t.payout/100);
          await credit(req.uid,t.account,r2(t.amount+t.profit));}
        else if(result==='draw'){t.profit=0;await credit(req.uid,t.account,t.amount);}
        else t.profit=-t.amount;
      }
    }catch(e){console.error('settle error:',e.message);
      t.result='win';t.profit=r2(t.amount*0.85);
      if(sim)await credit(req.uid,t.account,r2(t.amount+t.profit));}
    t.closeTime=now;t.status='closed';await t.save();
  }
  const since=lastSync.get(String(req.uid))||now-2000;
  lastSync.set(String(req.uid),now);
  const closed=await Trade.find({user:req.uid,status:'closed',closeTime:{$gt:since}});
  const open=await Trade.find({user:req.uid,status:'open'}).limit(60);
  res.json({open:open.map(pub),closed:closed.map(pub)});
}));
app.get('/trades',auth,h(async(req,res)=>{
  const t=await Trade.find({user:req.uid}).sort({entryTime:-1}).limit(150);
  res.json(t.map(pub));
}));

/* ── deposits ── */
const PLACEHOLDER={usdt:'TXk9rWv7Qm4LdPgY2nB8sJcFeA6hUuZ3Rk',
  btc:'bc1qxw9v2l7mecf83jan5h0ptds46yugk9rw2m8ha7',
  eth:'0x7F9a2C4eB81d05A6f3E8c92B47aD1365F80b3De9'};
app.post('/deposits',auth,h(async(req,res)=>{
  const method=req.body.method,amt=r2(+req.body.amount);
  if(!['usdt','btc','eth','card','mpesa'].includes(method))
    return res.status(400).json({message:'Pick a payment method'});
  if(!(amt>=MIN_DEPOSIT))return res.status(400).json({message:'Minimum deposit is $'+MIN_DEPOSIT.toFixed(2)});
  let bonus=0;const code=(req.body.bonusCode||'').trim().toUpperCase();
  const rates={WELCOME20:.20,BOOST50:.50};
  if(code){if(!rates[code])return res.status(400).json({message:'Promo code is not valid'});
    if(code==='BOOST50'&&amt<100)return res.status(400).json({message:'BOOST50 needs a minimum of $100.00'});
    bonus=r2(amt*rates[code]);}
  const total=r2(amt+bonus);
  const instructions=method==='card'?{gateway:'not-wired-yet'}
    :method==='mpesa'?{phone:normPhone(req.body.phone),network:'M-Pesa · STK Push',kesAmount:Math.ceil(amt*KES_PER_USD)}
    :{address:PLACEHOLDER[method],
      network:method==='usdt'?'TRON · TRC-20':method==='btc'?'Bitcoin':'Ethereum · ERC-20'};
  const d=await Tx.create({user:req.uid,type:'deposit',method,amount:amt,bonus,total,
    bonusCode:code||null,status:'awaiting_payment',time:Date.now(),instructions});
  if(method==='mpesa'){
    const phone=normPhone(req.body.phone);
    if(!/^254(7|1)\d{8}$/.test(phone)){
      d.status='failed';await d.save();
      return res.status(400).json({message:'Enter a valid Safaricom number, e.g. 0712 345 678'});}
    const kes=Math.ceil(amt*KES_PER_USD);
    try{
      const tok=await safToken();const{ts,pass}=stkPassword();
      const r=await fetch(MPESA.BASE+'/mpesa/stkpush/v1/processrequest',{method:'POST',
        headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json'},
        body:JSON.stringify({BusinessShortCode:MPESA.SHORTCODE,Password:pass,Timestamp:ts,
          TransactionType:'CustomerPayBillOnline',Amount:kes,PartyA:phone,PartyB:MPESA.SHORTCODE,
          PhoneNumber:phone,CallBackURL:MPESA.CB,
          AccountReference:'VNT'+String(d._id).slice(-8).toUpperCase(),
          TransactionDesc:'Vanta deposit'})});
      const j=await readJson(r,'M-Pesa push');
      if(j.ResponseCode!=='0'){
        d.status='failed';await d.save();
        return res.status(502).json({message:'M-Pesa rejected: '+(j.ResponseDescription||j.errorMessage||JSON.stringify(j).slice(0,120))});
      }
      d.checkoutId=j.CheckoutRequestID;
      await d.save();
    }catch(e){
      d.status='failed';await d.save();
      return res.status(502).json({message:'M-Pesa error: '+e.message});
    }
  }
  res.json(pub(d));
}));
app.get('/deposits/:id',auth,h(async(req,res)=>{
  const d=await Tx.findOne({_id:req.params.id,user:req.uid,type:'deposit'});
  if(!d)return res.status(404).json({message:'Deposit not found'});
  res.json(pub(d));
}));
app.post('/mpesa/callback/:secret',async(req,res)=>{
  if(req.params.secret!==(process.env.MPESA_CB_SECRET||'').trim())return res.status(403).end();
  res.json({ResultCode:0,ResultDesc:'Accepted'});
  try{
    const cb=req.body.Body&&req.body.Body.stkCallback;if(!cb)return;
    const d=await Tx.findOne({checkoutId:cb.CheckoutRequestID,type:'deposit'});
    if(!d||d.status!=='awaiting_payment')return;
    if(cb.ResultCode!==0){d.status='failed';await d.save();return;}
    const item=(cb.CallbackMetadata&&cb.CallbackMetadata.Item)||[];
    const paid=item.find(i=>i.Name==='Amount');
    if(!paid||paid.Value<Math.ceil(d.amount*KES_PER_USD))return;
    d.paidAt=Date.now();
    d.mpesaReceipt=(item.find(i=>i.Name==='MpesaReceiptNumber')||{}).Value||'';
    d.status='confirmed';d.confirmedAt=Date.now();
    await credit(d.user,'real',d.total);
    await d.save();
  }catch(e){console.error('mpesa callback:',e.message)}
});
app.post('/deposits/:id/confirm',auth,h(async(req,res)=>{
  const d=await Tx.findOne({_id:req.params.id,user:req.uid,type:'deposit'});
  if(!d)return res.status(404).json({message:'Deposit not found'});
  if(d.status==='confirmed')return res.json(pub(d));
  if(!d.paidAt&&!DEV_CONFIRM)
    return res.status(402).json({message:'Payment not detected yet'});
  d.status='confirmed';d.confirmedAt=Date.now();
  await credit(req.uid,'real',d.total);await d.save();
  res.json(pub(d));
}));

/* ── withdrawals ── */
app.post('/withdrawals',auth,h(async(req,res)=>{
  const method=req.body.method,amt=r2(+req.body.amount);
  let addr=(req.body.address||'').trim();
  const flat={usdt:1,btc:2,eth:1.5,mpesa:1};
  if(!flat[method]&&method!=='card')
    return res.status(400).json({message:'Pick a payout method'});
  if(!(amt>=10))return res.status(400).json({message:'Minimum withdrawal is $10.00'});
  if(method==='mpesa'){
    const d2=normPhone(addr);
    if(!/^254(7|1)\d{8}$/.test(d2))
      return res.status(400).json({message:'Enter a valid Safaricom number, e.g. 0712 345 678'});
    addr=d2;}
  const fee=method==='card'?r2(amt*0.015):flat[method],total=r2(amt+fee);
  if(method!=='mpesa'){
    const chk={usdt:s=>s.length>=26&&s.length<=40&&s[0]==='T',btc:s=>s.length>=26&&s.length<=62,
      eth:s=>/^0x[a-fA-F0-9]{40}$/.test(s),card:s=>/^\d{12,19}$/.test(s.replace(/\s/g,''))};
    if(!chk[method](addr))
      return res.status(400).json({message:'That '+method.toUpperCase()+' address doesn\u2019t look right'});}
  const u=await User.findById(req.uid);
  if(total>u.wallets.real)
    return res.status(400).json({message:'Amount + fee exceeds your real balance'});
  u.wallets.real=r2(u.wallets.real-total);await u.save();
  const w=await Tx.create({user:req.uid,type:'withdrawal',method,amount:amt,fee,total,
    address:addr,status:'pending',time:Date.now(),
    instructions:method==='mpesa'?{kesAmount:Math.ceil(amt*KES_PER_USD),
      note:'Simulated payout — Daraja B2C needed for real sends'}:{}});
  setTimeout(async()=>{try{
    const x=await Tx.findById(w._id);if(!x||x.status!=='pending')return;
    x.status='processed';x.confirmedAt=Date.now();await x.save();}catch{}},8000);
  res.json(pub(w));
}));
app.get('/transactions',auth,h(async(req,res)=>{
  const t=await Tx.find({user:req.uid}).sort({time:-1}).limit(120);
  res.json(t.map(pub));
}));

app.use((e,req,res,next)=>res.status(400).json({message:'Bad request'}));
mongoose.connect(process.env.MONGO_URI).then(()=>{
  app.listen(process.env.PORT||3000,()=>console.log('API up · version '+VERSION));
}).catch(e=>{console.error('Mongo failed:',e.message);process.exit(1)});
