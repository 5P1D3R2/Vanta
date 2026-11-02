/* VANTA backend v6.3 · TinyPesa STK Push (auto-credit) · USDT TRC20 · referrals · admins · min stake 0.35
   ENVIRONMENT:
   MONGO_URI
   JWT_SECRET
   TINYPESA_API_KEY
   MPESA_CB_SECRET
   ADMIN_EMAIL

   OPTIONAL:
   ADMIN_EMAILS (comma-separated; any number of emails, e.g. a@x.com,b@y.com)
   TINYPESA_LINK_SLUG (default vantabinary2)
   DEMO_WIN_RATE (default 0.95)
   REFERRAL_BONUS (USD paid to the referrer when a friend makes a first
                   confirmed deposit; default 0 = no payout, stats only)

   TINYPESA SETUP (so deposits credit automatically):
   0. Test your credentials: open https://<your-render-app>.onrender.com/tinypesa-test/<MPESA_CB_SECRET>
      (set TINYPESA_USERNAME if your TinyPesa account username differs from the link name)
   1. Set TINYPESA_API_KEY and MPESA_CB_SECRET on Render.
   2. In your TinyPesa dashboard set the callback URL to
      https://<your-render-app>.onrender.com/mpesa/callback/<MPESA_CB_SECRET>
   Even without the webhook, the site checks the payment status itself
   every few seconds while the deposit screen is open.

   Verify: /version
*/

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const MIN_DEPOSIT = 4;
const MIN_STAKE = 0.35;
const MPESA_MAX = 1900;
const USDT_ADDRESS = 'TVQ2apPfjAL1BUFkvg2Ep8vEzs5KgtyGSP';
const REFERRAL_BONUS = Math.max(0, parseFloat(process.env.REFERRAL_BONUS || '0') || 0);
const KES_PER_USD = 129;

const DEMO_WIN_RATE = Math.min(
  1,
  Math.max(0, parseFloat(process.env.DEMO_WIN_RATE || '0.95'))
);

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const VERSION = '6.6-tinypesa-3way';

const isSimUser = u =>
  !!(ADMIN_EMAIL && u &&
  String(u.email || '').trim().toLowerCase() === ADMIN_EMAIL);

/* admins: ADMIN_EMAILS list + ADMIN_EMAIL */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(/[\s,;]+/)
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

if (ADMIN_EMAIL && !ADMIN_EMAILS.includes(ADMIN_EMAIL)) {
  ADMIN_EMAILS.push(ADMIN_EMAIL);
}

const isAdminUser = u =>
  !!(u && ADMIN_EMAILS.includes(
    String(u.email || '').trim().toLowerCase()
  ));

const withSim = (j, u) => {
  j.sim = isSimUser(u);
  j.admin = isAdminUser(u);
  return j;
};

/* ── TINYPESA CONFIGURATION ── */

const cleanEnv = v =>
  String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();

/* finds the TinyPesa key even if the variable name has a typo, extra
   space, different case or is called TINYPESA_APIKEY / TINYPESA_KEY */
function findTinyKey() {
  const exact = cleanEnv(process.env.TINYPESA_API_KEY);

  if (exact) return exact;

  for (const [name, value] of Object.entries(process.env)) {
    if (
      /^TINYPESA[\s_-]*.*(KEY|TOKEN)/i.test(name.trim()) &&
      cleanEnv(value)
    ) {
      return cleanEnv(value);
    }
  }

  return '';
}

const TINYPESA = {
  BASE: (process.env.TINYPESA_BASE ||
    'https://api.tinypesa.com/api/v1').replace(/\/+$/, ''),
  KEY: findTinyKey(),
  SLUG: (process.env.TINYPESA_USERNAME ||
    process.env.TINYPESA_LINK_SLUG || 'vantabinary2')
    .trim().replace(/^["']+|["']+$/g, '')
    .replace(/^https?:\/\/(www\.)?tinypesa\.com\//i, '')
    .replace(/\/+$/, '').trim()
};

async function readJson(response, label) {
  const txt = await response.text();

  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(
      label + ' returned HTTP ' + response.status +
      ' non-JSON: ' + txt.slice(0, 120)
    );
  }
}

const normPhone = value => {
  let digits = String(value || '').replace(/\D/g, '');

  if (digits.startsWith('0')) {
    digits = '254' + digits.slice(1);
  }

  if (digits.length === 9 && /^[17]/.test(digits)) {
    digits = '254' + digits;
  }

  return digits;
};

/* TinyPesa can be reached two ways. We try the documented public API first
   (ApiKey header only) and fall back to the username form if it is refused. */
const TP_VARIANTS = [
  {
    label: 'tinypesa.com public API (key only)',
    base: 'https://tinypesa.com/api/v1',
    init: '/express/initialize',
    username: false,
    form: true
  },
  {
    label: 'api.tinypesa.com (key only)',
    base: TINYPESA.BASE,
    init: '/express/initialize/',
    username: false,
    form: false
  },
  {
    label: 'api.tinypesa.com (key + username "' + TINYPESA.SLUG + '")',
    base: TINYPESA.BASE,
    init: '/express/initialize/',
    username: true,
    form: false
  }
];

let tpPreferred = 0;

function tinyUrl(v, kind, arg) {
  let url = v.base + (
    kind === 'init'
      ? v.init
      : '/express/get_status/' + encodeURIComponent(arg) + '/'
  );

  if (v.username) {
    url += '?username=' + encodeURIComponent(TINYPESA.SLUG);
  }

  return url;
}

/* a refusal = 401/403 or a web page (HTML) instead of an API (JSON) reply */
const tinyRefused = response =>
  response.status === 401 ||
  response.status === 403 ||
  /text\/html/i.test(response.headers.get('content-type') || '');

async function tinyRequest(kind, arg, body) {
  const order = [
    tpPreferred,
    ...TP_VARIANTS.map((_, i) => i).filter(i => i !== tpPreferred)
  ];

  let last = null;

  for (const i of order) {
    const v = TP_VARIANTS[i];

    const headers = {
      Accept: 'application/json',
      ApiKey: TINYPESA.KEY
    };

    let payload;

    if (body) {
      headers['Content-Type'] = v.form
        ? 'application/x-www-form-urlencoded'
        : 'application/json';

      payload = v.form
        ? new URLSearchParams(body).toString()
        : JSON.stringify(body);
    }

    const response = await fetch(tinyUrl(v, kind, arg), {
      method: body ? 'POST' : 'GET',
      headers,
      body: payload
    });

    if (tinyRefused(response)) {
      console.warn(
        'TinyPesa refused ' + v.label + ' with HTTP ' + response.status
      );

      /* keep the most informative refusal (a JSON one) to report */
      if (
        !last ||
        !/text\/html/i.test(response.headers.get('content-type') || '')
      ) {
        last = response;
      }

      continue;
    }

    tpPreferred = i;
    return { response, variant: i };
  }

  return { response: last, variant: -1 };
}

async function stkPush(amount, phone, ref = 'Payment') {
  if (!TINYPESA.KEY) {
    throw new Error('TINYPESA_API_KEY not configured');
  }

  const msisdn = normPhone(phone);

  if (!/^254[17]\d{8}$/.test(msisdn)) {
    throw new Error('Invalid Kenyan Safaricom number');
  }

  const { response } = await tinyRequest('init', null, {
    amount: Math.max(1, Math.round(amount)),
    msisdn,
    account_no: String(ref).slice(0, 20)
  });

  const data = await readJson(response, 'TinyPesa initiate');

  if (!response.ok) {
    throw new Error(
      data.message ||
      data.errorMessage ||
      ('TinyPesa HTTP ' + response.status)
    );
  }

  const requestId =
    data.request_id ||
    data.RequestID ||
    data.bulkID ||
    data.DepositId ||
    data.transaction_id ||
    data.id;

  if (
    data.status === false ||
    data.success === false ||
    data.success === 'false' ||
    !requestId
  ) {
    throw new Error(
      'TinyPesa rejected: ' +
      (data.message || data.errorMessage ||
      JSON.stringify(data).slice(0, 150))
    );
  }

  return {
    ...data,
    request_id: requestId
  };
}

/* ── TINYPESA CALLBACK PARSER ── */

function parseCallback(req) {
  const root = req.body || {};
  const body = root.Body || root;

  const callback =
    body.stkCallback ||
    root.stkCallback ||
    body;

  const items =
    (callback.CallbackMetadata &&
    callback.CallbackMetadata.Item) || [];

  const metadata = Object.fromEntries(
    items.map(item => [item.Name, item.Value])
  );

  return {
    ok: Number(
      callback.ResultCode ??
      body.ResultCode ??
      root.Code ??
      1
    ) === 0,

    checkoutId:
      callback.CheckoutRequestID ||
      body.CheckoutRequestID ||
      root.CheckoutRequestID ||
      '',

    tinyPesaId:
      body.TinyPesaID ||
      root.TinyPesaID ||
      '',

    externalRef:
      body.ExternalReference ||
      root.ExternalReference ||
      callback.ExternalReference ||
      '',

    receipt:
      metadata.MpesaReceiptNumber ||
      body.ref_no ||
      body.RefNo ||
      '',

    amount: Number(
      metadata.Amount ??
      body.Amount ??
      root.Amount ??
      0
    ),

    phone: String(
      metadata.PhoneNumber ??
      body.Msisdn ??
      body.PhoneNumber ??
      root.Msisdn ??
      ''
    ),

    raw: callback
  };
}

/* ── VERIFY PAYMENT WITH TINYPESA ── */

async function tinyPesaStatus(externalReference) {
  if (!TINYPESA.KEY) {
    throw new Error('TINYPESA_API_KEY is not configured');
  }

  const { response } = await tinyRequest('status', externalReference);

  const raw = await response.text();

  if (response.status === 400) {
    return null;
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      'TinyPesa status returned non-JSON HTTP ' +
      response.status
    );
  }

  if (!response.ok) {
    throw new Error(
      data.message ||
      ('TinyPesa status HTTP ' + response.status)
    );
  }

  return data;
}

/* ── CREDIT ONLY VERIFIED DEPOSITS ── */

async function verifyAndCreditDeposit(
  deposit,
  externalReference,
  callbackData = {}
) {
  if (!deposit || deposit.status !== 'awaiting_payment') {
    return false;
  }

  if (
    !externalReference ||
    externalReference !== deposit.externalReference
  ) {
    return false;
  }

  let live = await tinyPesaStatus(externalReference);
  let foundByRequestId = false;

  if (!live && deposit.tinyPesaId) {
    live = await tinyPesaStatus(deposit.tinyPesaId);
    foundByRequestId = !!live;
  }

  const complete =
    live &&
    (live.is_complete === true ||
     live.is_complete === 'true' ||
     live.is_complete === 1);

  if (!complete) {
    return false;
  }

  const liveRef = String(live.external_reference || '');

  /* if TinyPesa echoes a reference it must be ours; when we looked the
     payment up by our own request id the lookup itself proves identity */
  if (
    (liveRef && liveRef !== String(deposit.externalReference)) ||
    (!liveRef && !foundByRequestId && !deposit.tinyPesaId)
  ) {
    return false;
  }

  const paid = Number(live.amount);
  const expected = Math.ceil(
    Number(deposit.amount) * KES_PER_USD
  );

  if (!Number.isFinite(paid) || paid !== expected) {
    console.error(
      'Deposit amount mismatch; left uncredited',
      String(deposit._id),
      { paid, expected }
    );

    return false;
  }

  const session = await mongoose.startSession();
  let applied = false;

  try {
    await session.withTransaction(async () => {
      const fresh = await Tx.findOneAndUpdate(
        {
          _id: deposit._id,
          status: 'awaiting_payment',
          externalReference
        },
        {
          $set: {
            status: 'confirmed',
            paidAt: Date.now(),
            confirmedAt: Date.now(),

            mpesaReceipt: String(
              live.ref_no ||
              callbackData.receipt ||
              ''
            ),

            tinyPesaId: String(
              live.id ||
              callbackData.tinyPesaId ||
              deposit.tinyPesaId ||
              ''
            ),

            checkoutId: String(
              live.checkout_request_id ||
              callbackData.checkoutId ||
              deposit.checkoutId ||
              ''
            )
          }
        },
        {
          new: true,
          session
        }
      );

      if (!fresh) return;

      const update = await User.updateOne(
        { _id: fresh.user },
        {
          $inc: {
            'wallets.real': Number(fresh.total)
          }
        },
        { session }
      );

      if (!update.matchedCount) {
        throw new Error('Deposit owner account was not found');
      }

      applied = true;
    });
  } finally {
    await session.endSession();
  }

  if (applied) {
    rewardReferrer(deposit.user).catch(error =>
      console.error('Referral reward:', error.message)
    );
  }

  return applied;
}

async function syncDepositFromTinyPesa(deposit) {
  if (
    !deposit ||
    deposit.status !== 'awaiting_payment' ||
    !deposit.externalReference
  ) {
    return deposit;
  }

  try {
    await verifyAndCreditDeposit(
      deposit,
      deposit.externalReference,
      {}
    );
  } catch (error) {
    console.error('TinyPesa status check:', error.message);
  }

  return await Tx.findById(deposit._id) || deposit;
}

/* ── ASSETS + SIMULATED PRICE ENGINE ── */

const ASSETS = [
  {
    id: 'EURUSD',
    name: 'EUR/USD',
    cat: 'Forex',
    start: 1.08423,
    vol: 0.00006,
    dec: 5,
    payout: 85
  },
  {
    id: 'GBPUSD',
    name: 'GBP/USD',
    cat: 'Forex',
    start: 1.27164,
    vol: 0.00009,
    dec: 5,
    payout: 83
  },
  {
    id: 'USDJPY',
    name: 'USD/JPY',
    cat: 'Forex',
    start: 154.281,
    vol: 0.011,
    dec: 3,
    payout: 82
  },
  {
    id: 'BTCUSD',
    name: 'BTC/USD',
    cat: 'Crypto',
    start: 67432,
    vol: 16,
    dec: 0,
    payout: 88
  },
  {
    id: 'ETHUSD',
    name: 'ETH/USD',
    cat: 'Crypto',
    start: 3418.4,
    vol: 1.2,
    dec: 1,
    payout: 86
  },
  {
    id: 'XAUUSD',
    name: 'GOLD',
    cat: 'Commodity',
    start: 2382.6,
    vol: 0.5,
    dec: 2,
    payout: 84
  }
];

const P = {};

ASSETS.forEach(asset => {
  P[asset.id] = {
    price: asset.start,
    drift: 0
  };
});

function gauss() {
  let u = 0;
  let v = 0;

  while (!u) u = Math.random();
  while (!v) v = Math.random();

  return Math.sqrt(-2 * Math.log(u)) *
    Math.cos(2 * Math.PI * v);
}

setInterval(() => {
  for (const asset of ASSETS) {
    const state = P[asset.id];

    if (Math.random() < 0.03) {
      state.drift =
        (Math.random() - 0.5) * asset.vol * 0.9;
    }

    const pull =
      ((asset.start - state.price) / asset.start) *
      asset.vol * 0.35;

    state.price = Math.max(
      asset.start * 0.3,
      state.price +
      state.drift +
      asset.vol * gauss() +
      pull
    );
  }
}, 400);

/* ── DATABASE MODELS ── */

const User = mongoose.model(
  'User',
  new mongoose.Schema({
    name: String,

    email: {
      type: String,
      unique: true,
      index: true
    },

    passwordHash: String,

    referralCode: {
      type: String,
      unique: true,
      sparse: true,
      index: true
    },

    referredBy: {
      type: String,
      index: true,
      default: null
    },

    referralRewarded: {
      type: Boolean,
      default: false
    },

    referralEarned: {
      type: Number,
      default: 0
    },

    wallets: {
      demo: {
        type: Number,
        default: 10000
      },
      real: {
        type: Number,
        default: 0
      }
    },

    createdAt: {
      type: Number,
      default: () => Date.now()
    }
  })
);

const Trade = mongoose.model(
  'Trade',
  new mongoose.Schema({
    user: {
      type: Object,
      index: true
    },

    asset: String,
    dir: String,

    kind: {
      type: String,
      default: 'updown'
    },

    option: String,
    target: Number,
    legs: Array,
    mult: Number,
    amount: Number,
    account: String,
    payout: Number,
    entry: Object,
    entryTime: Number,
    expiry: Number,

    status: {
      type: String,
      index: true
    },

    close: Object,
    closeTime: Number,
    result: String,
    profit: Number,

    sim: {
      type: Boolean,
      default: false
    }
  }, { versionKey: false })
);

const Tx = mongoose.model(
  'Tx',
  new mongoose.Schema({
    user: {
      type: Object,
      index: true
    },

    type: String,
    method: String,
    amount: Number,

    fee: {
      type: Number,
      default: 0
    },

    total: Number,

    bonus: {
      type: Number,
      default: 0
    },

    bonusCode: String,
    status: String,
    time: Number,
    confirmedAt: Number,
    address: String,
    instructions: Object,
    checkoutId: String,

    externalReference: {
      type: String,
      index: true,
      unique: true,
      sparse: true
    },

    tinyPesaId: String,
    paidAt: Number,
    mpesaReceipt: String
  }, { versionKey: false })
);

/* ── HELPERS ── */

const r2 = value =>
  Math.round(value * 100) / 100;

const pub = object => {
  const value = object.toObject
    ? object.toObject()
    : { ...object };

  const result = {
    ...value,
    id: String(value._id)
  };

  delete result._id;
  delete result.__v;
  delete result.user;
  delete result.passwordHash;
  delete result.referralRewarded;

  return result;
};

const h = fn => (req, res) =>
  fn(req, res).catch(error => {
    console.error('ERR:', error.message);

    res.status(500).json({
      message: error.message || 'Server error'
    });
  });

async function credit(userId, account, value) {
  const user = await User.findById(userId);

  if (!user) {
    throw new Error('User not found while crediting wallet');
  }

  user.wallets[account] = r2(
    user.wallets[account] + value
  );

  await user.save();
}

/* ── REFERRALS ── */

async function uniqueReferralCode() {
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();

    if (!await User.exists({ referralCode: code })) {
      return code;
    }
  }

  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

async function ensureReferralCode(user) {
  if (user && !user.referralCode) {
    user.referralCode = await uniqueReferralCode();
    await user.save();
  }

  return user;
}

async function rewardReferrer(userId) {
  if (!(REFERRAL_BONUS > 0)) return;

  const friend = await User.findOneAndUpdate(
    {
      _id: userId,
      referredBy: { $ne: null },
      referralRewarded: { $ne: true }
    },
    { $set: { referralRewarded: true } }
  );

  if (!friend) return;

  await User.updateOne(
    { referralCode: friend.referredBy },
    {
      $inc: {
        'wallets.real': REFERRAL_BONUS,
        referralEarned: REFERRAL_BONUS
      }
    }
  );
}

const auth = (req, res, next) => {
  const header = req.headers.authorization || '';

  try {
    req.uid = jwt.verify(
      header.slice(7),
      JWT_SECRET
    ).uid;

    next();
  } catch {
    res.status(401).json({
      message: 'Please log in again'
    });
  }
};

function digitOf(id) {
  const asset = ASSETS.find(item => item.id === id);

  if (!asset || !P[id]) return 0;

  const formatted = P[id].price.toFixed(asset.dec);

  return Number(formatted[formatted.length - 1]);
}

function digitMult(option, target) {
  const probability =
    option === 'even' || option === 'odd' ? 0.5 :
    option === 'over' ? (9 - target) / 10 :
    option === 'under' ? target / 10 :
    option === 'match' ? 0.1 : 0.9;

  return Math.max(
    1.01,
    Math.floor((0.95 / probability) * 100) / 100
  );
}

/* ── VERSION ── */

/* open this address in a browser to confirm the deploy and settings:
   "mpesa": true  means TINYPESA_API_KEY is set on this service */
app.get('/version', (req, res) => {
  res.json({
    v: VERSION,
    mpesa: !!TINYPESA.KEY,
    callbackSecret: !!(process.env.MPESA_CB_SECRET || '').trim()
  });
});

app.get('/', (req, res) => {
  res.json({
    ok: true,
    v: VERSION,
    mpesa: !!TINYPESA.KEY,
    callbackSecret: !!(process.env.MPESA_CB_SECRET || '').trim()
  });
});

/* ── AUTHENTICATION ── */

app.post('/auth/register', h(async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (name.length < 2) {
    return res.status(400).json({
      message: 'Enter your name'
    });
  }

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({
      message: 'That email doesn’t look right'
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      message: 'Use at least 6 characters'
    });
  }

  if (await User.findOne({ email })) {
    return res.status(400).json({
      message: 'An account with this email already exists'
    });
  }

  const given = String(req.body.referralCode || '')
    .trim()
    .toUpperCase()
    .slice(0, 32);

  let referredBy = null;

  if (given) {
    const referrer = await User.findOne({ referralCode: given });

    if (referrer) referredBy = referrer.referralCode;
  }

  const user = await User.create({
    name,
    email,
    passwordHash: await bcrypt.hash(password, 10),
    referralCode: await uniqueReferralCode(),
    referredBy
  });

  res.json({
    token: jwt.sign(
      { uid: String(user._id) },
      JWT_SECRET,
      { expiresIn: '30d' }
    ),
    user: withSim(pub(user), user)
  });
}));

app.post('/auth/login', h(async (req, res) => {
  const user = await User.findOne({
    email: (req.body.email || '').trim().toLowerCase()
  });

  if (
    !user ||
    !await bcrypt.compare(
      req.body.password || '',
      user.passwordHash
    )
  ) {
    return res.status(401).json({
      message: 'Wrong email or password'
    });
  }

  await ensureReferralCode(user);

  res.json({
    token: jwt.sign(
      { uid: String(user._id) },
      JWT_SECRET,
      { expiresIn: '30d' }
    ),
    user: withSim(pub(user), user)
  });
}));

app.get('/me', auth, h(async (req, res) => {
  const user = await User.findById(req.uid);

  if (!user) {
    return res.status(401).json({
      message: 'Session expired'
    });
  }

  await ensureReferralCode(user);

  res.json({
    user: withSim(pub(user), user)
  });
}));

/* ── REFERRAL STATS ── */

app.get('/referrals', auth, h(async (req, res) => {
  const user = await User.findById(req.uid);

  if (!user) {
    return res.status(401).json({
      message: 'Session expired'
    });
  }

  await ensureReferralCode(user);

  const friends = await User.find(
    { referredBy: user.referralCode },
    { _id: 1 }
  );

  const ids = friends.map(f => String(f._id));

  const active = ids.length
    ? (await Tx.distinct('user', {
        type: 'deposit',
        status: 'confirmed',
        user: { $in: ids }
      })).length
    : 0;

  res.json({
    code: user.referralCode,
    total: ids.length,
    active,
    pending: 0,
    earned: r2(user.referralEarned || 0)
  });
}));

app.get('/assets', (req, res) => {
  res.json(
    ASSETS.map(({ id, name, cat, dec, payout }) => ({
      id,
      name,
      cat,
      dec,
      payout
    }))
  );
});

app.get('/prices', (req, res) => {
  res.json({
    t: Date.now(),
    p: Object.fromEntries(
      ASSETS.map(asset => [
        asset.id,
        P[asset.id].price
      ])
    )
  });
});

/* ── TRADES ── */

app.post('/trades', auth, h(async (req, res) => {
  const {
    dir,
    expirySec,
    account,
    kind,
    option,
    target,
    legs
  } = req.body;

  const assetId = req.body.asset;
  const amount = r2(+req.body.amount);

  if (!['demo', 'real'].includes(account)) {
    return res.status(400).json({
      message: 'Bad wallet'
    });
  }

  if (!(amount >= MIN_STAKE)) {
    return res.status(400).json({
      message: 'Minimum stake is $' + MIN_STAKE.toFixed(2)
    });
  }

  if (!(expirySec >= 1 && expirySec <= 300)) {
    return res.status(400).json({
      message: 'Bad expiry'
    });
  }

  const user = await User.findById(req.uid);

  if (!user) {
    return res.status(401).json({
      message: 'Session expired'
    });
  }

  if (amount > user.wallets[account]) {
    return res.status(400).json({
      message: 'Insufficient balance'
    });
  }

  const sim = isSimUser(user);

  const base = {
    user: req.uid,
    amount,
    account,
    entryTime: Date.now(),
    expiry: Date.now() + expirySec * 1000,
    status: 'open',
    sim
  };

  let trade;

  if (kind === 'digits') {
    const asset = ASSETS.find(item => item.id === assetId);

    if (!asset) {
      return res.status(400).json({
        message: 'Unknown asset'
      });
    }

    if (![
      'even',
      'odd',
      'over',
      'under',
      'match',
      'differ'
    ].includes(option)) {
      return res.status(400).json({
        message: 'Bad digit option'
      });
    }

    let digitTarget = null;

    if (option !== 'even' && option !== 'odd') {
      digitTarget = +target;

      if (
        !(digitTarget >= 0 &&
        digitTarget <= 9 &&
        Number.isInteger(digitTarget))
      ) {
        return res.status(400).json({
          message: 'Pick a digit 0-9'
        });
      }
    }

    const multiplier = digitMult(option, digitTarget);

    user.wallets[account] = r2(
      user.wallets[account] - amount
    );

    await user.save();

    trade = await Trade.create({
      ...base,
      kind: 'digits',
      asset: assetId,
      option,
      target: digitTarget,
      mult: multiplier,
      entry: digitOf(assetId)
    });

  } else if (kind === 'acc') {
    if (
      !Array.isArray(legs) ||
      legs.length < 2 ||
      legs.length > 5
    ) {
      return res.status(400).json({
        message: 'Accumulator needs 2-5 legs'
      });
    }

    const seen = new Set();
    let multiplier = 1;
    const entries = [];

    for (const leg of legs) {
      const asset = ASSETS.find(
        item => item.id === leg.asset
      );

      if (!asset) {
        return res.status(400).json({
          message: 'Unknown asset in leg'
        });
      }

      if (!['up', 'down'].includes(leg.dir)) {
        return res.status(400).json({
          message: 'Bad leg direction'
        });
      }

      if (seen.has(leg.asset)) {
        return res.status(400).json({
          message: 'Each market can appear once'
        });
      }

      seen.add(leg.asset);

      multiplier *= (1 + asset.payout / 100);

      entries.push({
        asset: leg.asset,
        dir: leg.dir,
        entry: P[leg.asset].price
      });
    }

    multiplier = r2(multiplier);

    user.wallets[account] = r2(
      user.wallets[account] - amount
    );

    await user.save();

    trade = await Trade.create({
      ...base,
      kind: 'acc',
      asset: entries[0].asset,
      legs: entries,
      mult: multiplier,
      entry: entries[0].entry
    });

  } else {
    const asset = ASSETS.find(item => item.id === assetId);

    if (!asset) {
      return res.status(400).json({
        message: 'Unknown asset'
      });
    }

    if (!['up', 'down'].includes(dir)) {
      return res.status(400).json({
        message: 'Bad direction'
      });
    }

    user.wallets[account] = r2(
      user.wallets[account] - amount
    );

    await user.save();

    trade = await Trade.create({
      ...base,
      kind: 'updown',
      asset: assetId,
      dir,
      payout: asset.payout,
      entry: P[assetId].price
    });
  }

  res.json(pub(trade));
}));

/* ── TRADE SETTLEMENT ── */

const lastSync = new Map();

app.get('/trades/sync', auth, h(async (req, res) => {
  const now = Date.now();

  const due = await Trade.find({
    user: req.uid,
    status: 'open',
    expiry: { $lte: now }
  });

  for (const trade of due) {
    const sim =
      trade.sim === true ||
      trade.account === 'demo';

    const wantWin = sim && (
      trade.account === 'demo'
        ? Math.random() < DEMO_WIN_RATE
        : true
    );

    try {
      if (trade.kind === 'digits') {
        const asset = ASSETS.find(
          item => item.id === trade.asset
        );

        let digit = asset ? digitOf(trade.asset) : 5;

        if (wantWin) {
          if (trade.option === 'even') {
            digit = digit % 2 === 0 ? digit : (digit + 1) % 10;
          } else if (trade.option === 'odd') {
            digit = digit % 2 === 1 ? digit : (digit + 1) % 10;
          } else if (trade.option === 'over') {
            digit = Math.min(
              9,
              (trade.target == null ? 4 : trade.target) + 1
            );
          } else if (trade.option === 'under') {
            digit = Math.max(
              0,
              (trade.target == null ? 5 : trade.target) - 1
            );
          } else if (trade.option === 'match') {
            digit = trade.target == null ? digit : trade.target;
          } else {
            digit = (
              (trade.target == null ? digit : trade.target) + 1
            ) % 10;
          }
        }

        trade.close = digit;

        if (
          trade.entry == null ||
          Number.isNaN(trade.entry)
        ) {
          trade.entry = digit;
        }

        const win = wantWin ? true : (
          trade.option === 'even' ? digit % 2 === 0 :
          trade.option === 'odd' ? digit % 2 === 1 :
          trade.option === 'over' ? digit > (trade.target == null ? 0 : trade.target) :
          trade.option === 'under' ? digit < (trade.target == null ? 9 : trade.target) :
          trade.option === 'match' ? digit === trade.target :
          digit !== trade.target
        );

        trade.result = win ? 'win' : 'loss';

        trade.profit = win
          ? r2(trade.amount * (
              trade.mult ||
              digitMult(trade.option, trade.target)
            ))
          : -trade.amount;

        if (win) {
          await credit(
            req.uid,
            trade.account,
            r2(trade.amount + trade.profit)
          );
        }

      } else if (trade.kind === 'acc') {
        if (wantWin) {
          trade.close = P[trade.asset]
            ? P[trade.asset].price
            : 0;

          trade.result = 'win';
          trade.profit = r2(
            trade.amount * (trade.mult || 2)
          );

          await credit(
            req.uid,
            trade.account,
            r2(trade.amount + trade.profit)
          );

        } else {
          let lost = false;
          let flat = false;

          for (const leg of (trade.legs || [])) {
            const price = P[leg.asset]
              ? P[leg.asset].price
              : 0;

            if (leg.dir === 'up') {
              if (price < leg.entry) lost = true;
              else if (price === leg.entry) flat = true;
            } else {
              if (price > leg.entry) lost = true;
              else if (price === leg.entry) flat = true;
            }
          }

          trade.close = P[trade.asset]
            ? P[trade.asset].price
            : 0;

          trade.result = lost
            ? 'loss'
            : flat
              ? 'draw'
              : 'win';

          if (trade.result === 'win') {
            trade.profit = r2(
              trade.amount * (trade.mult || 2)
            );

            await credit(
              req.uid,
              trade.account,
              r2(trade.amount + trade.profit)
            );

          } else if (trade.result === 'draw') {
            trade.profit = 0;

            await credit(
              req.uid,
              trade.account,
              trade.amount
            );

          } else {
            trade.profit = -trade.amount;
          }
        }

      } else {
        const asset = ASSETS.find(
          item => item.id === trade.asset
        );

        if (
          trade.entry == null ||
          Number.isNaN(trade.entry)
        ) {
          trade.entry = P[trade.asset]
            ? P[trade.asset].price
            : (asset ? asset.start : 0);
        }

        let price = P[trade.asset]
          ? P[trade.asset].price
          : trade.entry;

        if (wantWin) {
          const move = Math.max(
            0.00001,
            trade.entry * 0.00001
          );

          price = trade.dir === 'up'
            ? trade.entry + move
            : trade.entry - move;
        }

        const result = trade.dir === 'up'
          ? (price > trade.entry ? 'win' : price < trade.entry ? 'loss' : 'draw')
          : (price < trade.entry ? 'win' : price > trade.entry ? 'loss' : 'draw');

        trade.close = price;
        trade.result = result;

        if (result === 'win') {
          trade.profit = r2(
            trade.amount * trade.payout / 100
          );

          await credit(
            req.uid,
            trade.account,
            r2(trade.amount + trade.profit)
          );

        } else if (result === 'draw') {
          trade.profit = 0;

          await credit(
            req.uid,
            trade.account,
            trade.amount
          );

        } else {
          trade.profit = -trade.amount;
        }
      }

    } catch (error) {
      console.error('settle error:', error.message);

      trade.result = 'win';
      trade.profit = r2(trade.amount * 0.85);

      if (sim) {
        await credit(
          req.uid,
          trade.account,
          r2(trade.amount + trade.profit)
        );
      }
    }

    trade.closeTime = now;
    trade.status = 'closed';

    await trade.save();
  }

  const since =
    lastSync.get(String(req.uid)) ||
    now - 2000;

  lastSync.set(String(req.uid), now);

  const closed = await Trade.find({
    user: req.uid,
    status: 'closed',
    closeTime: { $gt: since }
  });

  const open = await Trade.find({
    user: req.uid,
    status: 'open'
  }).limit(60);

  res.json({
    open: open.map(pub),
    closed: closed.map(pub)
  });
}));

app.get('/trades', auth, h(async (req, res) => {
  const trades = await Trade.find({
    user: req.uid
  })
    .sort({ entryTime: -1 })
    .limit(150);

  res.json(trades.map(pub));
}));

/* ── DEPOSITS: TINYPESA STK PUSH ── */

app.post('/deposits', auth, h(async (req, res) => {
  const method = req.body.method;
  const amount = r2(+req.body.amount);

  /* USDT (TRC20): user sends to our address, then submits the TXID.
     The deposit is recorded as 'pending_review'. */
  if (method === 'usdt') {
    if (!(amount >= MIN_DEPOSIT)) {
      return res.status(400).json({
        message: 'Minimum deposit is $' + MIN_DEPOSIT.toFixed(2)
      });
    }

    const txid = String(req.body.txid || '').trim().toLowerCase();

    if (!/^[a-f0-9]{64}$/.test(txid)) {
      return res.status(400).json({
        message: 'Enter the 64-character transaction ID (TXID)'
      });
    }

    const ref = 'USDT-' + txid;

    if (await Tx.findOne({ externalReference: ref })) {
      return res.status(400).json({
        message: 'This transaction ID was already submitted'
      });
    }

    try {
      const usdt = await Tx.create({
        user: req.uid,
        type: 'deposit',
        method: 'usdt',
        amount,
        bonus: 0,
        total: amount,
        status: 'pending_review',
        time: Date.now(),
        address: USDT_ADDRESS,
        externalReference: ref,

        instructions: {
          txid,
          network: 'USDT · TRON (TRC20)',
          address: USDT_ADDRESS
        }
      });

      return res.json(pub(usdt));
    } catch (error) {
      return res.status(400).json({
        message: 'This transaction ID was already submitted'
      });
    }
  }

  if (method !== 'mpesa') {
    return res.status(400).json({
      message: 'Pick M-Pesa or USDT to deposit'
    });
  }

  if (!(amount >= MIN_DEPOSIT)) {
    return res.status(400).json({
      message: 'Minimum deposit is $' + MIN_DEPOSIT.toFixed(2)
    });
  }

  if (amount > MPESA_MAX) {
    return res.status(400).json({
      message: 'Maximum M-Pesa deposit is $' + MPESA_MAX
    });
  }

  let bonus = 0;

  const code = (req.body.bonusCode || '')
    .trim()
    .toUpperCase();

  const rates = {
    WELCOME20: 0.20,
    BOOST50: 0.50
  };

  if (code) {
    if (!rates[code]) {
      return res.status(400).json({
        message: 'Promo code is not valid'
      });
    }

    if (code === 'BOOST50' && amount < 100) {
      return res.status(400).json({
        message: 'BOOST50 needs a minimum of $100.00'
      });
    }

    bonus = r2(amount * rates[code]);
  }

  const phone = normPhone(req.body.phone);

  if (!/^254(7|1)\d{8}$/.test(phone)) {
    return res.status(400).json({
      message: 'Enter a valid Kenyan Safaricom number, e.g. 0712 345 678'
    });
  }

  if (!TINYPESA.KEY) {
    console.error('Deposit blocked: TINYPESA_API_KEY is not set');

    return res.status(503).json({
      message: 'M-Pesa deposits are unavailable right now. Please try USDT or try again later.'
    });
  }

  const kes = Math.ceil(amount * KES_PER_USD);
  const total = r2(amount + bonus);

  const deposit = await Tx.create({
    user: req.uid,
    type: 'deposit',
    method,
    amount,
    bonus,
    total,
    bonusCode: code || null,
    status: 'awaiting_payment',
    time: Date.now(),

    instructions: {
      phone,
      network: 'M-Pesa · TinyPesa STK Push',
      kesAmount: kes
    }
  });

  const externalReference =
    'VNT' + String(deposit._id).slice(-8).toUpperCase();

  deposit.externalReference = externalReference;

  deposit.instructions = {
    ...deposit.instructions,
    paymentReference: externalReference
  };

  await deposit.save();

  try {
    const response = await stkPush(
      kes,
      phone,
      externalReference
    );

    deposit.checkoutId = String(response.request_id);
    deposit.tinyPesaId = String(response.request_id);

    await deposit.save();

  } catch (error) {
    console.error(
      'TinyPesa STK initiate failed:',
      error.message
    );

    deposit.status = 'failed';
    await deposit.save();

    const credentialProblem =
      /unauthor|apikey|username|api key/i.test(error.message);

    return res.status(502).json({
      message: credentialProblem
        ? 'M-Pesa is temporarily unavailable. Please try again shortly or use USDT.'
        : 'M-Pesa error: ' + error.message
    });
  }

  res.json(pub(deposit));
}));

/* ── CHECK DEPOSIT STATUS ── */

app.get('/deposits/:id', auth, h(async (req, res) => {
  let deposit = await Tx.findOne({
    _id: req.params.id,
    user: req.uid,
    type: 'deposit'
  });

  if (!deposit) {
    return res.status(404).json({
      message: 'Deposit not found'
    });
  }

  deposit = await syncDepositFromTinyPesa(deposit);

  res.json(pub(deposit));
}));

/* ── TINYPESA WEBHOOK ── */

app.get('/mpesa/callback/:secret', (req, res) => {
  if (
    req.params.secret !==
    (process.env.MPESA_CB_SECRET || '').trim()
  ) {
    return res.status(403).end();
  }

  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.post('/mpesa/callback/:secret', async (req, res) => {
  if (
    req.params.secret !==
    (process.env.MPESA_CB_SECRET || '').trim()
  ) {
    return res.status(403).end();
  }

  res.status(200).json({
    ResultCode: 0,
    ResultDesc: 'Accepted'
  });

  try {
    const callback = parseCallback(req);

    const lookups = [];

    if (callback.externalRef) {
      lookups.push({ externalReference: callback.externalRef });
    }

    if (callback.checkoutId) {
      lookups.push({ checkoutId: callback.checkoutId });
    }

    if (callback.tinyPesaId) {
      lookups.push({ tinyPesaId: String(callback.tinyPesaId) });
    }

    if (!lookups.length) {
      console.error(
        'TinyPesa callback has no reference to match'
      );
      return;
    }

    const deposit = await Tx.findOne({
      $or: lookups,
      type: 'deposit',
      method: 'mpesa'
    });

    if (
      !deposit ||
      deposit.status !== 'awaiting_payment'
    ) {
      return;
    }

    if (!callback.ok) {
      await Tx.updateOne(
        {
          _id: deposit._id,
          status: 'awaiting_payment'
        },
        {
          $set: { status: 'failed' }
        }
      );

      return;
    }

    await verifyAndCreditDeposit(
      deposit,
      deposit.externalReference,
      callback
    );

  } catch (error) {
    console.error(
      'TinyPesa webhook processing:',
      error.message
    );
  }
});

/* ── TINYPESA CREDENTIAL TEST (open in a browser, protected by your callback secret) ── */

async function tinyProbe() {
  const out = [];

  for (const v of TP_VARIANTS) {
    try {
      const r = await fetch(tinyUrl(v, 'status', 'VNTCHECK'), {
        headers: { Accept: 'application/json', ApiKey: TINYPESA.KEY }
      });

      const text = await r.text();
      const isHtml = /text\/html/i.test(r.headers.get('content-type') || '');

      out.push({
        method: v.label,
        http: r.status,
        gaveApiReply: !isHtml,
        accepted: !tinyRefused(r),
        reply: isHtml
          ? '(a web page, not an API reply)'
          : text.slice(0, 140)
      });
    } catch (error) {
      out.push({ method: v.label, accepted: false, error: error.message });
    }
  }

  return out;
}

app.get('/tinypesa-test/:secret', h(async (req, res) => {
  const secret = (process.env.MPESA_CB_SECRET || '').trim();

  if (!secret || req.params.secret !== secret) {
    return res.status(403).json({ message: 'Wrong secret' });
  }

  if (!TINYPESA.KEY) {
    return res.json({
      keyLength: 0,
      verdict: 'TINYPESA_API_KEY is not set on this service'
    });
  }

  const results = await tinyProbe();
  const ok = results.some(r => r.accepted);

  res.json({
    keyLength: TINYPESA.KEY.length,
    usernameUsed: TINYPESA.SLUG,
    results,
    verdict: ok
      ? 'At least one method got a real API answer that is not a rejection. STK push should work.'
      : 'TinyPesa refused every method. If a line says "invalid Apikey or username", the key or the username is wrong: re-copy the API key from your TinyPesa dashboard (API / Developer page) and set TINYPESA_USERNAME to your TinyPesa account username.'
  });
}));

/* ── ADMIN HELPER ── */

const adminAuth = async (req, res, next) => {
  try {
    const user = await User.findById(req.uid);

    if (!isAdminUser(user)) {
      return res.status(403).json({ message: 'Admins only' });
    }

    next();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* ── ADMIN: CHECK TINYPESA CREDENTIALS (sends no money request) ── */

app.get('/admin/tinypesa-check', auth, adminAuth, h(async (req, res) => {
  const out = {
    slugInUse: TINYPESA.SLUG,
    apiKeyLength: TINYPESA.KEY.length,
    callbackSecretSet: !!(process.env.MPESA_CB_SECRET || '').trim()
  };

  if (!TINYPESA.KEY) {
    out.verdict = 'TINYPESA_API_KEY is missing on Render';
    return res.json(out);
  }

  try {
    const { response, variant } =
      await tinyRequest('status', 'VNTCHECK');

    out.httpStatus = response.status;
    out.reply = (await response.text()).slice(0, 160);
    out.method = variant >= 0 ? TP_VARIANTS[variant].label : 'none accepted';

    out.verdict = variant === -1
      ? 'TinyPesa rejected the API key (both ways). Re-copy the API key from your TinyPesa dashboard into TINYPESA_API_KEY, with no spaces or quotes.'
      : 'Credentials accepted by TinyPesa.';
  } catch (error) {
    out.verdict = 'Could not reach TinyPesa: ' + error.message;
  }

  res.json(out);
}));

/* ── WITHDRAWALS ── */

app.post('/withdrawals', auth, h(async (req, res) => {
  const method = req.body.method;
  const amount = r2(+req.body.amount);
  let address = (req.body.address || '').trim();

  const flat = {
    usdt: 1,
    btc: 2,
    eth: 1.5,
    mpesa: 1
  };

  if (!flat[method] && method !== 'card') {
    return res.status(400).json({
      message: 'Pick a payout method'
    });
  }

  if (!(amount >= 10)) {
    return res.status(400).json({
      message: 'Minimum withdrawal is $10.00'
    });
  }

  if (method === 'mpesa') {
    const phone = normPhone(address);

    if (!/^254(7|1)\d{8}$/.test(phone)) {
      return res.status(400).json({
        message: 'Enter a valid Safaricom number, e.g. 0712 345 678'
      });
    }

    address = phone;
  }

  const fee = method === 'card'
    ? r2(amount * 0.015)
    : flat[method];

  const total = r2(amount + fee);

  if (method !== 'mpesa') {
    const checks = {
      usdt: value =>
        value.length >= 26 &&
        value.length <= 40 &&
        value[0] === 'T',

      btc: value =>
        value.length >= 26 &&
        value.length <= 62,

      eth: value =>
        /^0x[a-fA-F0-9]{40}$/.test(value),

      card: value =>
        /^\d{12,19}$/.test(value.replace(/\s/g, ''))
    };

    if (!checks[method](address)) {
      return res.status(400).json({
        message: 'That ' + method.toUpperCase() +
          ' address doesn’t look right'
      });
    }
  }

  const user = await User.findById(req.uid);

  if (!user) {
    return res.status(401).json({
      message: 'Session expired'
    });
  }

  if (total > user.wallets.real) {
    return res.status(400).json({
      message: 'Amount + fee exceeds your real balance'
    });
  }

  user.wallets.real = r2(
    user.wallets.real - total
  );

  await user.save();

  const withdrawal = await Tx.create({
    user: req.uid,
    type: 'withdrawal',
    method,
    amount,
    fee,
    total,
    address,
    status: 'pending',
    time: Date.now(),

    instructions: method === 'mpesa'
      ? {
          kesAmount: Math.ceil(amount * KES_PER_USD),
          note: 'Simulated payout — provider B2C needed for real sends'
        }
      : {}
  });

  setTimeout(async () => {
    try {
      const current = await Tx.findById(withdrawal._id);

      if (!current || current.status !== 'pending') {
        return;
      }

      current.status = 'processed';
      current.confirmedAt = Date.now();

      await current.save();

    } catch (error) {
      console.error(
        'Withdrawal status update:',
        error.message
      );
    }
  }, 8000);

  res.json(pub(withdrawal));
}));

/* ── TRANSACTIONS ── */

app.get('/transactions', auth, h(async (req, res) => {
  const transactions = await Tx.find({
    user: req.uid
  })
    .sort({ time: -1 })
    .limit(120);

  res.json(transactions.map(pub));
}));

/* ── ERROR HANDLER ── */

app.use((error, req, res, next) => {
  console.error('Unhandled request error:', error.message);

  res.status(400).json({
    message: 'Bad request'
  });
});

/* ── START SERVER ── */

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    if (JWT_SECRET === 'change-me') {
      console.warn('WARNING: set JWT_SECRET to a long random value');
    }

    if (!TINYPESA.KEY) {
      console.warn('WARNING: TINYPESA_API_KEY missing - deposits disabled');

      const seen = Object.keys(process.env)
        .filter(k => /tiny|pesa|mpesa|api.?key/i.test(k))
        .map(k => JSON.stringify(k));

      console.warn(
        'Related variable names this service can see: ' +
        (seen.length ? seen.join(', ') : '(none)') +
        ' - add TINYPESA_API_KEY under Render > Environment on THIS service, then redeploy.'
      );
    } else {
      console.log(
        'TinyPesa: username "' + TINYPESA.SLUG + '", key length ' +
        TINYPESA.KEY.length
      );
    }

    if (!(process.env.MPESA_CB_SECRET || '').trim()) {
      console.warn('WARNING: MPESA_CB_SECRET missing - webhook disabled');
    }

    app.listen(
      process.env.PORT || 3000,
      () => console.log('API up · version ' + VERSION)
    );
  })
  .catch(error => {
    console.error('Mongo failed:', error.message);
    process.exit(1);
  });
