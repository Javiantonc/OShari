// SHARI — servidor de reservas para restaurantes de sushi.
// Sin dependencias: solo Node.js (v18+). Arranque: `node server.js`.
//
// Pagos: si existe la variable STRIPE_SECRET_KEY se cobra la señal con Stripe Checkout
// (y se devuelve con un reembolso de Stripe). Sin ella, la app funciona en "modo demo"
// y el pago se simula.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';

// Política de la señal
const DEPOSIT_EUR = 10;
const FREE_CANCEL_HOURS = 24; // cancelar con más antelación => se devuelve la señal
const HOLD_MINUTES = 15;      // tiempo para pagar antes de liberar la mesa
const MAX_PEOPLE = 10;

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Base de datos (archivo JSON) ----------

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(require('./seed'), null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

const db = loadDb();

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- Utilidades ----------

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function fail(res, status, message) {
  send(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON no válido')); }
    });
    req.on('error', reject);
  });
}

function slotDate(date, time) {
  return new Date(`${date}T${time}:00`);
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(`${s}T00:00:00`));
}

function findRestaurant(id) {
  return db.restaurants.find((r) => r.id === id);
}

// Una reserva sin pagar caduca a los HOLD_MINUTES y deja libre la mesa.
function expireStale() {
  const limit = Date.now() - HOLD_MINUTES * 60 * 1000;
  let changed = false;
  for (const r of db.reservations) {
    if (r.status === 'pending_payment' && new Date(r.createdAt).getTime() < limit) {
      r.status = 'expired';
      changed = true;
    }
  }
  if (changed) saveDb();
}

const HOLDS_SEAT = ['pending_payment', 'confirmed', 'attended'];

function seatsTaken(restaurantId, date, time) {
  return db.reservations
    .filter((r) => r.restaurantId === restaurantId && r.date === date && r.time === time && HOLDS_SEAT.includes(r.status))
    .reduce((sum, r) => sum + r.people, 0);
}

// Horas reservables de un día: `schedule` (por día de la semana) manda sobre `slots`.
function slotsFor(rest, date) {
  const weekday = new Date(`${date}T00:00:00`).getDay();
  if (rest.closedWeekdays.includes(weekday)) return [];
  return (rest.schedule && rest.schedule[weekday]) || rest.slots;
}

function availability(rest, date) {
  const times = slotsFor(rest, date);
  if (!times.length) return { closed: true, slots: [] };
  const now = Date.now();
  const slots = times.map((time) => {
    const free = rest.seatsPerSlot - seatsTaken(rest.id, date, time);
    const past = slotDate(date, time).getTime() < now + 60 * 60 * 1000; // mínimo 1 h de antelación
    return { time, free: past ? 0 : Math.max(0, free) };
  });
  return { closed: false, slots };
}

function publicReservation(r) {
  const rest = findRestaurant(r.restaurantId);
  const hoursLeft = (slotDate(r.date, r.time).getTime() - Date.now()) / 36e5;
  return {
    id: r.id,
    code: r.code,
    restaurantId: r.restaurantId,
    restaurantName: rest ? rest.name : '',
    address: rest ? rest.address : '',
    date: r.date,
    time: r.time,
    people: r.people,
    name: r.name,
    status: r.status,
    deposit: DEPOSIT_EUR,
    createdAt: r.createdAt,
    freeCancel: hoursLeft > FREE_CANCEL_HOURS,
    canCancel: r.status === 'confirmed' && hoursLeft > 0,
  };
}

function baseUrl(req) {
  return PUBLIC_URL || `http://${req.headers.host}`;
}

// ---------- Stripe (API REST, sin SDK) ----------

async function stripe(method, endpoint, params) {
  const res = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ? json.error.message : 'Error de Stripe');
  return json;
}

async function createCheckout(req, r, rest) {
  const base = baseUrl(req);
  const session = await stripe('POST', 'checkout/sessions', {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'eur',
    'line_items[0][price_data][unit_amount]': String(DEPOSIT_EUR * 100),
    'line_items[0][price_data][product_data][name]': `Señal de reserva · ${rest.name}`,
    'line_items[0][price_data][product_data][description]': `${r.date} ${r.time} · ${r.people} pers. Se descuenta de la cuenta; se pierde si no acudes.`,
    customer_email: r.email,
    'metadata[reservation_id]': r.id,
    expires_at: String(Math.floor(Date.now() / 1000) + 30 * 60),
    success_url: `${base}/api/stripe/return?id=${r.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/#/reserva/${r.id}`,
  });
  r.stripeSessionId = session.id;
  return session.url;
}

async function refund(r) {
  if (STRIPE_KEY && r.paymentIntent) {
    await stripe('POST', 'refunds', { payment_intent: r.paymentIntent });
  }
}

// ---------- Rutas de la API ----------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // sin "api"
  const method = req.method;
  expireStale();

  // Configuración pública
  if (method === 'GET' && parts[0] === 'config') {
    return send(res, 200, {
      deposit: DEPOSIT_EUR,
      freeCancelHours: FREE_CANCEL_HOURS,
      holdMinutes: HOLD_MINUTES,
      maxPeople: MAX_PEOPLE,
      paymentMode: STRIPE_KEY ? 'stripe' : 'demo',
    });
  }

  // Restaurantes
  if (method === 'GET' && parts[0] === 'restaurants' && parts.length === 1) {
    return send(res, 200, db.restaurants.map(({ menu, ...r }) => r));
  }
  if (method === 'GET' && parts[0] === 'restaurants' && parts.length === 2) {
    const rest = findRestaurant(parts[1]);
    return rest ? send(res, 200, rest) : fail(res, 404, 'Restaurante no encontrado');
  }
  if (method === 'GET' && parts[0] === 'restaurants' && parts[2] === 'availability') {
    const rest = findRestaurant(parts[1]);
    const date = url.searchParams.get('date');
    if (!rest) return fail(res, 404, 'Restaurante no encontrado');
    if (!isValidDate(date)) return fail(res, 400, 'Fecha no válida');
    return send(res, 200, availability(rest, date));
  }

  // Crear reserva (queda pendiente de pagar la señal)
  if (method === 'POST' && parts[0] === 'reservations' && parts.length === 1) {
    const b = await readBody(req);
    const rest = findRestaurant(b.restaurantId);
    const people = Number(b.people);
    if (!rest) return fail(res, 400, 'Restaurante no válido');
    if (!isValidDate(b.date) || !slotsFor(rest, b.date).includes(b.time)) return fail(res, 400, 'Fecha u hora no válida');
    if (!Number.isInteger(people) || people < 1 || people > MAX_PEOPLE) return fail(res, 400, `Entre 1 y ${MAX_PEOPLE} personas`);
    const name = String(b.name || '').trim().slice(0, 80);
    const phone = String(b.phone || '').trim().slice(0, 30);
    const email = String(b.email || '').trim().slice(0, 120);
    if (!name || !phone || !/^\S+@\S+\.\S+$/.test(email)) return fail(res, 400, 'Rellena nombre, teléfono y un email válido');
    if (b.acceptPolicy !== true) return fail(res, 400, 'Debes aceptar la política de la señal');

    const slot = availability(rest, b.date).slots.find((s) => s.time === b.time);
    if (!slot || slot.free < people) return fail(res, 409, 'Ya no hay sitio a esa hora. Elige otra.');

    const r = {
      id: crypto.randomUUID(),
      code: crypto.randomBytes(3).toString('hex').toUpperCase(),
      restaurantId: rest.id,
      date: b.date,
      time: b.time,
      people,
      name,
      phone,
      email,
      notes: String(b.notes || '').trim().slice(0, 300),
      status: 'pending_payment',
      createdAt: new Date().toISOString(),
      history: [{ at: new Date().toISOString(), status: 'pending_payment' }],
    };
    db.reservations.push(r);

    let checkoutUrl = `/#/pago/${r.id}`;
    if (STRIPE_KEY) {
      try {
        checkoutUrl = await createCheckout(req, r, rest);
      } catch (e) {
        db.reservations.pop();
        return fail(res, 502, `No se pudo iniciar el pago: ${e.message}`);
      }
    }
    saveDb();
    return send(res, 201, { reservation: publicReservation(r), checkoutUrl });
  }

  // Consultar una reserva (el id es un UUID difícil de adivinar)
  const r = parts[0] === 'reservations' && parts[1] ? db.reservations.find((x) => x.id === parts[1]) : null;
  if (parts[0] === 'reservations' && parts[1] && !r) return fail(res, 404, 'Reserva no encontrada');

  if (method === 'GET' && r && parts.length === 2) {
    return send(res, 200, publicReservation(r));
  }

  // Pago simulado (solo en modo demo)
  if (method === 'POST' && r && parts[2] === 'pay-demo') {
    if (STRIPE_KEY) return fail(res, 400, 'El pago se hace con Stripe');
    if (r.status === 'expired') return fail(res, 409, 'El tiempo para pagar ha caducado. Haz una reserva nueva.');
    if (r.status !== 'pending_payment') return fail(res, 409, 'Esta reserva ya no está pendiente de pago');
    setStatus(r, 'confirmed');
    r.paidAt = new Date().toISOString();
    saveDb();
    return send(res, 200, publicReservation(r));
  }

  // Cancelar por parte del cliente
  if (method === 'POST' && r && parts[2] === 'cancel') {
    const pub = publicReservation(r);
    if (!pub.canCancel) return fail(res, 409, 'Esta reserva ya no se puede cancelar');
    if (pub.freeCancel) {
      try { await refund(r); } catch (e) { return fail(res, 502, `No se pudo devolver la señal: ${e.message}`); }
      setStatus(r, 'cancelled_refunded');
    } else {
      setStatus(r, 'cancelled_late');
    }
    saveDb();
    return send(res, 200, publicReservation(r));
  }

  // Panel del restaurante
  if (parts[0] === 'admin') {
    if (req.headers['x-admin-pin'] !== ADMIN_PIN) return fail(res, 401, 'PIN incorrecto');

    if (method === 'GET' && parts[1] === 'reservations') {
      const restaurantId = url.searchParams.get('restaurantId');
      const date = url.searchParams.get('date');
      const list = db.reservations
        .filter((x) => x.restaurantId === restaurantId && (!date || x.date === date) && x.status !== 'expired')
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .map((x) => ({ ...publicReservation(x), phone: x.phone, email: x.email, notes: x.notes }));
      return send(res, 200, list);
    }

    if (method === 'POST' && parts[1] === 'reservations' && parts[3]) {
      const target = db.reservations.find((x) => x.id === parts[2]);
      if (!target) return fail(res, 404, 'Reserva no encontrada');
      if (target.status !== 'confirmed') return fail(res, 409, 'Solo se pueden marcar reservas confirmadas');
      if (parts[3] === 'attended') setStatus(target, 'attended');
      else if (parts[3] === 'no-show') {
        if (slotDate(target.date, target.time).getTime() > Date.now()) return fail(res, 409, 'Aún no ha llegado la hora de la reserva');
        setStatus(target, 'no_show');
      } else return fail(res, 404, 'Acción no válida');
      saveDb();
      return send(res, 200, publicReservation(target));
    }
  }

  return fail(res, 404, 'Ruta no encontrada');
}

function setStatus(r, status) {
  r.status = status;
  r.history.push({ at: new Date().toISOString(), status });
}

// Vuelta desde Stripe Checkout: se comprueba el pago con Stripe antes de confirmar.
async function handleStripeReturn(req, res, url) {
  const r = db.reservations.find((x) => x.id === url.searchParams.get('id'));
  const sessionId = url.searchParams.get('session_id');
  if (r && sessionId && r.stripeSessionId === sessionId && r.status !== 'confirmed') {
    try {
      const s = await stripe('GET', `checkout/sessions/${encodeURIComponent(sessionId)}`);
      if (s.payment_status === 'paid' && s.metadata.reservation_id === r.id) {
        r.paymentIntent = s.payment_intent;
        r.paidAt = new Date().toISOString();
        setStatus(r, 'confirmed');
        saveDb();
      }
    } catch (e) {
      console.error('Stripe:', e.message);
    }
  }
  res.writeHead(302, { Location: `/#/reserva/${r ? r.id : ''}` });
  res.end();
}

// ---------- Archivos estáticos ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No encontrado');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------- Servidor ----------

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/stripe/return') return await handleStripeReturn(req, res, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      serveStatic(req, res, url);
    } catch (e) {
      console.error(e);
      fail(res, 500, e.message || 'Error interno');
    }
  })
  .listen(PORT, () => {
    console.log(`SHARI en http://localhost:${PORT}  (panel: /admin, pagos: ${STRIPE_KEY ? 'Stripe' : 'modo demo'})`);
  });
