/* VANTA backend · Express + MongoDB
   Env vars needed: MONGO_URI, JWT_SECRET
   ALLOW_DEV_CONFIRM=true  → TEST ONLY, see /deposits/:id/confirm           */
const express=require('express'),cors=require('cors'),mongoose=require('mongoose'),
      jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs');
const app=express();
app.use(cors());                 /* TODO in production: cors({origin:'https://5p1d3r2.github.io'}) */
app.use(express.json());
const JWT_SECRET=process.env.JWT_SECRET||'change-me';
const DEV_CONFIRM=process.env.ALLOW_DEV_CONFIRM==='true';

/* ── assets + price engine ─────────────────────────────────────────────
   ⚠ SIMULATED random walk so you can develop end-to-end. Before taking
   real money this MUST be replaced with real market data (e.g. Binance
   API for crypto) — a fictional feed + real deposits is not a real
   exchange, and regulators will treat it as fraud. */
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
  asset:String,dir:String,amount:Number,account:String,payout:Number,entry:Number,
  entryTime:Number,expiry:Number,status:{type:String,index:true},close:Number,
  closeTime:Number,result:String,profit:Number},{versionKey:false}));
const Tx=mongoose.model('Tx',new mongoose.Schema({user:{type:Object,index:true},
  type:String,method:String,amount:Number,fee:{type:Number,default:0},total:Number,
  bonus:{type:Number,default:0},bonusCode:String,status:String,time:Number,
  confirmedAt:Number,address:String,instructions:Object,checkoutId:String,
  paidAt:Number,mpesaReceipt:String},{versionKey:false}));

/* ── helpers ── */
const r2=v=>Math.round(v*100)/100;
const pub=o=>{const x=o.toObject?o.toObject():{...o};const j={...x,id:String(x._id)};
  delete j._id;delete j.__v;delete j.user;return j};
const h=f=>(req,res)=>f(req,res).catch(()=>res.status(500).json({message:'Server error'}));
async function credit(uid,acc,v){const u=await User.findById(uid);
  u.wallets[acc]=r2(u.wallets[acc]+v);await u.save()}
const auth=(req,res,next)=>{const hd=req.headers.authorization||'';
  try{req.uid=jwt.verify(hd.slice(7),JWT_SECRET).uid;next()}
  catch{res.status(401).json({message:'Please log in again'})}};

/* ── auth ── */
app.post('/auth/register',h(async(req,res)=>{
  const name=(req.body.name||'').trim(),email=(req.body.email||'').trim().toLowerCase(),
        pw=req.body.password||'';
  if(name.length<2)return res.status(400).json({message:'Enter your name'});
  if(!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({message:'That email doesn\u2019t look right'});
  if(pw.length<6)return res.status(400).json({message:'Use at least 6 characters'});
  if(await User.findOne({email}))return res.status(400).json({message:'An account with this email already exists'});
  const u=await User.create({name,email,passwordHash:await bcrypt.hash(pw,10)});
  const token=jwt.sign({uid:String(u._id)},JWT_SECRET,{expiresIn:'30d'});
  res.json({token,user:pub(u)});
}));
app.post('/auth/login',h(async(req,res)=>{
  const u=await User.findOne({email:(req.body.email||'').trim().toLowerCase()});
  if(!u||!await bcrypt.compare(req.body.password||'',u.passwordHash))
    return res.status(401).json({message:'Wrong email or password'});
  const token=jwt.sign({uid:String(u._id)},JWT_SECRET,{expiresIn:'30d'});
  res.json({token,user:pub(u)});
}));
app.get('/me',auth,h(async(req,res)=>{
  const u=await User.findById(req.uid);if(!u)return res.status(401).json({message:'Session expired'});
  res.json({user:pub(u)});
}));

/* ── market ── */
app.get('/assets',(req,res)=>res.json(ASSETS.map(({id,name,cat,dec,payout})=>({id,name,cat,dec,payout}))));
app.get('/prices',(req,res)=>res.json({t:Date.now(),
  p:Object.fromEntries(ASSETS.map(a=>[a.id,P[a.id].price]))}));

/* ── trades (server opens AND settles — the client never decides) ── */
app.post('/trades',auth,h(async(req,res)=>{
  const{asset,dir,expirySec,account}=req.body,amt=r2(+req.body.amount);
  const a=ASSETS.find(x=>x.id===asset);
  if(!a)return res.status(400).json({message:'Unknown asset'});
  if(!['up','down'].includes(dir))return res.status(400).json({message:'Bad direction'});
  if(!['demo','real'].includes(account))return res.status(400).json({message:'Bad wallet'});
  if(!(amt>=1))return res.status(400).json({message:'Minimum stake is $1.00'});
  if(!(expirySec>=30&&expirySec<=300))return res.status(400).json({message:'Bad expiry'});
  const u=await User.findById(req.uid);
  if(amt>u.wallets[account])return res.status(400).json({message:'Insufficient balance'});
  u.wallets[account]=r2(u.wallets[account]-amt);await u.save();
  const t=await Trade.create({user:req.uid,asset,dir,amount:amt,account,payout:a.payout,
    entry:P[asset].price,entryTime:Date.now(),expiry:Date.now()+expirySec*1000,status:'open'});
  res.json(pub(t));
}));
const lastSync=new Map();
app.get('/trades/sync',auth,h(async(req,res)=>{
  const now=Date.now();
  const due=await Trade.find({user:req.uid,status:'open',expiry:{$lte:now}});
  for(const t of due){
    const p=P[t.asset].price;
    const result=t.dir==='up'?(p>t.entry?'win':p<t.entry?'loss':'draw')
                             :(p<t.entry?'win':p>t.entry?'loss':'draw');
    t.close=p;t.closeTime=now;t.status='closed';t.result=result;
    if(result==='win'){t.profit=r2(t.amount*t.payout/100);
      await credit(req.uid,t.account,r2(t.amount+t.profit));}
    else if(result==='draw'){t.profit=0;await credit(req.uid,t.account,t.amount);}
    else t.profit=-t.amount;
    await t.save();
  }
  const since=lastSync.get(String(req.uid))||now-2000;
  lastSync.set(String(req.uid),now);
  const closed=await Trade.find({user:req.uid,status:'closed',closeTime:{$gt:since}});
  const open=await Trade.find({user:req.uid,status:'open'}).limit(50);
  res.json({open:open.map(pub),closed:closed.map(pub)});
}));
app.get('/trades',auth,h(async(req,res)=>{
  const t=await Trade.find({user:req.uid}).sort({entryTime:-1}).limit(120);
  res.json(t.map(pub));
}));

/* ── deposits ──
   ⚠ Placeholder addresses below. Wire a real provider (NOWPayments,
   Cryptomus, Flutterwave/Pesapal for M-Pesa) — its webhook sets paidAt,
   and ONLY then does /confirm credit the wallet. */
const PLACEHOLDER={usdt:'TXk9rWv7Qm4LdPgY2nB8sJcFeA6hUuZ3Rk',
  btc:'bc1qxw9v2l7mecf83jan5h0ptds46yugk9rw2m8ha7',
  eth:'0x7F9a2C4eB81d05A6f3E8c92B47aD1365F80b3De9'};
app.post('/deposits',auth,h(async(req,res)=>{
  const method=req.body.method,amt=r2(+req.body.amount);
  if(!['usdt','btc','eth','card','mpesa'].includes(method))
    return res.status(400).json({message:'Pick a payment method'});
  if(!(amt>=10))return res.status(400).json({message:'Minimum deposit is $10.00'});
  let bonus=0;const code=(req.body.bonusCode||'').trim().toUpperCase();
  const rates={WELCOME20:.20,BOOST50:.50};
  if(code){if(!rates[code])return res.status(400).json({message:'Promo code is not valid'});
    if(code==='BOOST50'&&amt<100)return res.status(400).json({message:'BOOST50 needs a minimum of $100.00'});
    bonus=r2(amt*rates[code]);}
  const total=r2(amt+bonus);
  const instructions=method==='card'?{gateway:'not-wired-yet'}
    :method==='mpesa'?{phone:req.body.phone||'',network:'M-Pesa · STK Push',kesAmount:Math.ceil(amt*129)}
    :{address:PLACEHOLDER[method],
      network:method==='usdt'?'TRON · TRC-20':method==='btc'?'Bitcoin':'Ethereum · ERC-20'};
  const d=await Tx.create({user:req.uid,type:'deposit',method,amount:amt,bonus,total,
    bonusCode:code||null,status:'awaiting_payment',time:Date.now(),instructions});
  res.json(pub(d));
}));
app.get('/deposits/:id',auth,h(async(req,res)=>{
  const d=await Tx.findOne({_id:req.params.id,user:req.uid,type:'deposit'});
  if(!d)return res.status(404).json({message:'Deposit not found'});
  res.json(pub(d));
}));
app.post('/deposits/:id/confirm',auth,h(async(req,res)=>{
  const d=await Tx.findOne({_id:req.params.id,user:req.uid,type:'deposit'});
  if(!d)return res.status(404).json({message:'Deposit not found'});
  if(d.status==='confirmed')return res.json(pub(d));
  if(!d.paidAt&&!DEV_CONFIRM)                       /* must be verified by webhook first */
    return res.status(402).json({message:'Payment not detected yet'});
  d.status='confirmed';d.confirmedAt=Date.now();
  await credit(req.uid,'real',d.total);await d.save();
  res.json(pub(d));
}));

/* ── withdrawals ── */
app.post('/withdrawals',auth,h(async(req,res)=>{
  const method=req.body.method,amt=r2(+req.body.amount),addr=(req.body.address||'').trim();
  const flat={usdt:1,btc:2,eth:1.5};
  if(!flat[method]&&method!=='card')return res.status(400).json({message:'Pick a payout method'});
  if(!(amt>=10))return res.status(400).json({message:'Minimum withdrawal is $10.00'});
  const fee=method==='card'?r2(amt*0.015):flat[method],total=r2(amt+fee);
  const chk={usdt:s=>s.length>=26&&s.length<=40&&s[0]==='T',btc:s=>s.length>=26&&s.length<=62,
    eth:s=>/^0x[a-fA-F0-9]{40}$/.test(s),card:s=>/^\d{12,19}$/.test(s.replace(/\s/g,''))};
  if(!chk[method](addr))return res.status(400).json({message:'That '+method.toUpperCase()+' address doesn\u2019t look right'});
  const u=await User.findById(req.uid);
  if(total>u.wallets.real)return res.status(400).json({message:'Amount + fee exceeds your real balance'});
  u.wallets.real=r2(u.wallets.real-total);await u.save();
  const w=await Tx.create({user:req.uid,type:'withdrawal',method,amount:amt,fee,total,
    address:addr,status:'pending',time:Date.now()});
  res.json(pub(w));
  /* It stays 'pending' until you pay it out manually or via provider API,
     then set status='processed' in the DB (or ask me for an admin endpoint). */
}));
app.get('/transactions',auth,h(async(req,res)=>{
  const t=await Tx.find({user:req.uid}).sort({time:-1}).limit(120);
  res.json(t.map(pub));
}));

app.use((e,req,res,next)=>res.status(400).json({message:'Bad request'}));
mongoose.connect(process.env.MONGO_URI).then(()=>{
  app.listen(process.env.PORT||3000,()=>console.log('API up'));
}).catch(e=>{console.error('Mongo failed:',e.message);process.exit(1)});
