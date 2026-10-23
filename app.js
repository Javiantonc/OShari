// SHARI — app del cliente (SPA con rutas en el hash).

const $app = document.getElementById('app');
let config = null;

const STATUS = {
  pending_payment: 'Pendiente de pago',
  confirmed: 'Confirmada',
  attended: 'Completada',
  no_show: 'No asististe · señal perdida',
  cancelled_refunded: 'Cancelada · señal devuelta',
  cancelled_late: 'Cancelada tarde · señal perdida',
  expired: 'Caducada (no se pagó)',
};

// ---------- Utilidades ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch(`api.php${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Algo ha fallado');
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

const euro = (n) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const prettyDate = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });

// Reservas hechas en este móvil (el servidor no pide cuenta de usuario).
const myIds = {
  get() { try { return JSON.parse(localStorage.getItem('shari.reservas') || '[]'); } catch { return []; } },
  add(id) { try { localStorage.setItem('shari.reservas', JSON.stringify([id, ...this.get().filter((x) => x !== id)])); } catch {} },
};
const lastContact = {
  get() { try { return JSON.parse(localStorage.getItem('shari.contacto') || '{}'); } catch { return {}; } },
  set(v) { try { localStorage.setItem('shari.contacto', JSON.stringify(v)); } catch {} },
};

function policyHtml() {
  const c = config;
  return `
    <div class="policy">
      <strong>Señal de ${euro(c.deposit)} para confirmar la mesa</strong>
      <ul>
        <li>Si acudes, se descuenta de tu cuenta en el restaurante.</li>
        <li>Si cancelas con más de ${c.freeCancelHours} h de antelación, te la devolvemos.</li>
        <li>Si cancelas con menos de ${c.freeCancelHours} h o <b>no te presentas</b>, la señal se pierde.</li>
      </ul>
    </div>`;
}

// ---------- Pantallas ----------

async function viewList() {
  const list = await api('/restaurants');
  $app.innerHTML = `
    <h1>Reserva tu sushi</h1>
    <p class="sub">Elige restaurante, mira la carta y asegura tu mesa.</p>
    <input class="search" type="search" placeholder="Buscar por nombre, barrio o estilo" aria-label="Buscar">
    <div id="list"></div>`;
  const $list = document.getElementById('list');
  const render = (q = '') => {
    const f = q.trim().toLowerCase();
    const items = list.filter((r) => !f || `${r.name} ${r.area} ${r.cuisine}`.toLowerCase().includes(f));
    $list.innerHTML = items.length
      ? items.map((r) => `
        <a class="card" href="#/r/${esc(r.id)}">
          <div class="banner" style="background:${esc(r.color)}">
            <span class="initial">${esc(r.name[0])}</span><h3>${esc(r.name)}</h3>
          </div>
          <div class="body">
            <div class="meta">
              ${r.rating ? `<span class="rating">★ ${r.rating.toFixed(1)}</span>` : ''}
              <span>${esc(r.cuisine)}</span>
              <span>${'€'.repeat(r.priceLevel)}</span>
              <span>${esc(r.area)}</span>
            </div>
          </div>
        </a>`).join('')
      : '<p class="empty">No hay resultados.</p>';
  };
  render();
  $app.querySelector('.search').addEventListener('input', (e) => render(e.target.value));
}

async function viewRestaurant(id) {
  const r = await api(`/restaurants/${encodeURIComponent(id)}`);
  const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  $app.innerHTML = `
    <div class="hero" style="background:${esc(r.color)}">
      <h1>${esc(r.name)}</h1>
      <p>${r.rating ? `★ ${r.rating.toFixed(1)} · ` : ''}${esc(r.cuisine)} · ${'€'.repeat(r.priceLevel)}</p>
    </div>
    <div class="tabs" role="tablist">
      <button class="on" data-t="carta">Carta</button>
      <button data-t="info">Información</button>
    </div>
    <div id="tab"></div>
    <div class="sticky-cta"><a class="btn" href="#/r/${esc(r.id)}/reservar">Reservar mesa · señal ${euro(config.deposit)}</a></div>`;

  const note = r.menuNote ? `<p class="sub">${esc(r.menuNote)}</p>` : '';
  const carta = note + r.menu.map((s) => `
    <section class="menu-section">
      <h2>${esc(s.section)}</h2>
      <div class="card"><div class="body">
        ${s.items.map((d) => `
          <div class="dish">
            <div><strong>${esc(d.name)}</strong><small>${esc(d.desc)}</small></div>
            ${d.price != null ? `<span class="price">${euro(d.price)}</span>` : ''}
          </div>`).join('')}
      </div></div>
    </section>`).join('');
  const info = `
    <div class="card"><div class="body">
      <p>${esc(r.description)}</p>
      <dl class="summary">
        <dt>Dirección</dt><dd>${esc(r.address)}</dd>
        ${r.phone ? `<dt>Teléfono</dt><dd><a href="tel:${esc(r.phone.replace(/\s/g, ''))}">${esc(r.phone)}</a></dd>` : ''}
        ${r.website ? `<dt>Web</dt><dd><a href="${esc(r.website)}" target="_blank" rel="noopener">${esc(new URL(r.website).hostname.replace(/^www\./, ''))}</a></dd>` : ''}
        ${r.hours ? `<dt>Horario</dt><dd>${esc(r.hours)}</dd>` : `<dt>Reservas</dt><dd>${esc(r.slots[0])} – ${esc(r.slots[r.slots.length - 1])}</dd>`}
        ${r.rating && r.ratingCount ? `<dt>Valoración</dt><dd>★ ${r.rating.toLocaleString('es-ES')} en Tripadvisor (${r.ratingCount.toLocaleString('es-ES')} opiniones)</dd>` : ''}
        <dt>Cierra</dt><dd>${r.closedWeekdays.length ? r.closedWeekdays.map((d) => days[d]).join(', ') : 'Abierto todos los días'}</dd>
      </dl>
    </div></div>
    ${policyHtml()}`;

  const $tab = document.getElementById('tab');
  const show = (t) => {
    $tab.innerHTML = t === 'carta' ? carta : info;
    $app.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  };
  $app.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.t)));
  show('carta');
}

async function viewBooking(id) {
  const r = await api(`/restaurants/${encodeURIComponent(id)}`);
  const state = { date: null, time: null, people: 2 };
  const contact = lastContact.get();

  const today = new Date();
  const dayButtons = Array.from({ length: 21 }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const closed = r.closedWeekdays.includes(d.getDay());
    return `<button type="button" data-d="${isoDate(d)}" ${closed ? 'disabled title="Cerrado"' : ''}>
      <small>${i === 0 ? 'hoy' : d.toLocaleDateString('es-ES', { weekday: 'short' })}</small>
      <b>${d.getDate()}</b></button>`;
  }).join('');

  $app.innerHTML = `
    <a href="#/r/${esc(r.id)}" class="sub">← ${esc(r.name)}</a>
    <h1>Reservar mesa</h1>
    <h2>¿Cuántos sois?</h2>
    <div class="stepper">
      <button type="button" data-p="-1" aria-label="Menos personas">−</button>
      <output id="people">2</output> personas
      <button type="button" data-p="1" aria-label="Más personas">+</button>
    </div>
    <h2>Día</h2>
    <div class="days">${dayButtons}</div>
    <h2>Hora</h2>
    <div id="slots"><p class="sub">Elige primero un día.</p></div>
    <form id="form" hidden>
      <h2>Tus datos</h2>
      <div class="field"><label for="name">Nombre</label><input id="name" required autocomplete="name" value="${esc(contact.name)}"></div>
      <div class="field"><label for="phone">Teléfono</label><input id="phone" required type="tel" autocomplete="tel" value="${esc(contact.phone)}"></div>
      <div class="field"><label for="email">Email</label><input id="email" required type="email" autocomplete="email" value="${esc(contact.email)}"></div>
      <div class="field"><label for="notes">Alergias o peticiones (opcional)</label><textarea id="notes" rows="2"></textarea></div>
      ${policyHtml()}
      <label class="check"><input type="checkbox" id="accept" required>
        <span>Acepto pagar una señal de ${euro(config.deposit)} y entiendo que la pierdo si no me presento o cancelo con menos de ${config.freeCancelHours} h.</span></label>
      <p class="error" id="err"></p>
      <button class="btn" id="submit">Pagar señal de ${euro(config.deposit)}</button>
    </form>`;

  const $slots = document.getElementById('slots');
  const $form = document.getElementById('form');

  async function loadSlots() {
    if (!state.date) return;
    state.time = null;
    $form.hidden = true;
    $slots.innerHTML = '<p class="sub">Cargando horas…</p>';
    const av = await api(`/restaurants/${encodeURIComponent(r.id)}/availability?date=${state.date}`);
    if (av.closed) { $slots.innerHTML = '<p class="sub">Cerrado ese día.</p>'; return; }
    $slots.innerHTML = `<div class="slots">${av.slots.map((s) =>
      `<button type="button" data-t="${s.time}" ${s.free < state.people ? 'disabled' : ''}>${s.time}</button>`).join('')}</div>`;
    if (!av.slots.some((s) => s.free >= state.people)) $slots.insertAdjacentHTML('beforeend', '<p class="sub">No queda sitio para ese número de personas. Prueba otro día.</p>');
  }

  $app.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => {
    state.people = Math.min(config.maxPeople, Math.max(1, state.people + Number(b.dataset.p)));
    document.getElementById('people').textContent = state.people;
    loadSlots();
  }));
  $app.querySelector('.days').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-d]');
    if (!b || b.disabled) return;
    $app.querySelectorAll('.days button').forEach((x) => x.classList.toggle('on', x === b));
    state.date = b.dataset.d;
    loadSlots();
  });
  $slots.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-t]');
    if (!b || b.disabled) return;
    $slots.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    state.time = b.dataset.t;
    $form.hidden = false;
    $form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('submit');
    const body = {
      restaurantId: r.id,
      date: state.date,
      time: state.time,
      people: state.people,
      name: document.getElementById('name').value,
      phone: document.getElementById('phone').value,
      email: document.getElementById('email').value,
      notes: document.getElementById('notes').value,
      acceptPolicy: document.getElementById('accept').checked,
    };
    btn.disabled = true;
    document.getElementById('err').textContent = '';
    try {
      const { reservation, checkoutUrl } = await api('/reservations', { method: 'POST', body });
      myIds.add(reservation.id);
      lastContact.set({ name: body.name, phone: body.phone, email: body.email });
      location.href = checkoutUrl; // Stripe Checkout o la pantalla de pago demo
    } catch (err) {
      document.getElementById('err').textContent = err.message;
      btn.disabled = false;
      if (/sitio/.test(err.message)) loadSlots();
    }
  });
}

// Pantalla de pago simulado: solo se usa si el servidor no tiene clave de Stripe.
async function viewDemoPay(id) {
  const r = await api(`/reservations/${encodeURIComponent(id)}`);
  if (r.status !== 'pending_payment') { location.hash = `#/reserva/${id}`; return; }
  $app.innerHTML = `
    <div class="card"><div class="paybox">
      <p class="sub">Señal para ${esc(r.restaurantName)}</p>
      <div class="amount">${euro(r.deposit)}</div>
      <p>${esc(prettyDate(r.date))} · ${esc(r.time)} · ${r.people} pers.</p>
      <button class="btn dark" id="pay">Pagar ${euro(r.deposit)}</button>
      <p class="demo-note">Modo demo: no se cobra nada. Con una clave de Stripe aquí se abre la pasarela de pago real.</p>
      <p class="error" id="err"></p>
    </div></div>
    <p class="sub">Tienes ${config.holdMinutes} minutos para pagar; después la mesa queda libre.</p>`;
  document.getElementById('pay').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api(`/reservations/${encodeURIComponent(id)}/pay-demo`, { method: 'POST' });
      location.hash = `#/reserva/${id}`;
      toast('¡Reserva confirmada!');
    } catch (err) {
      document.getElementById('err').textContent = err.message;
    }
  });
}

async function viewReservation(id) {
  const r = await api(`/reservations/${encodeURIComponent(id)}`);
  myIds.add(r.id);
  const head = {
    confirmed: ['¡Mesa reservada!', `Enseña este código al llegar. La señal de ${euro(r.deposit)} se descuenta de tu cuenta.`],
    pending_payment: ['Falta pagar la señal', 'Tu mesa no está confirmada hasta que pagues.'],
  }[r.status] || ['Tu reserva', ''];

  $app.innerHTML = `
    <h1>${head[0]}</h1>
    <p class="sub">${head[1]}</p>
    <div class="card"><div class="body">
      <p><span class="status st-${esc(r.status)}">${esc(STATUS[r.status] || r.status)}</span></p>
      ${r.status === 'confirmed' ? `<p class="code">${esc(r.code)}</p>` : ''}
      <dl class="summary">
        <dt>Restaurante</dt><dd>${esc(r.restaurantName)}</dd>
        <dt>Día</dt><dd>${esc(prettyDate(r.date))}</dd>
        <dt>Hora</dt><dd>${esc(r.time)}</dd>
        <dt>Personas</dt><dd>${r.people}</dd>
        <dt>A nombre de</dt><dd>${esc(r.name)}</dd>
        <dt>Dirección</dt><dd>${esc(r.address)}</dd>
      </dl>
    </div></div>
    ${r.status === 'pending_payment' && config.paymentMode === 'demo' ? `<a class="btn" href="#/pago/${esc(r.id)}">Pagar señal</a>` : ''}
    ${r.canCancel ? `
      <p class="sub">${r.freeCancel
        ? `Si cancelas ahora te devolvemos los ${euro(r.deposit)}.`
        : `Quedan menos de ${config.freeCancelHours} h: si cancelas ahora pierdes la señal.`}</p>
      <button class="btn secondary" id="cancel">Cancelar reserva</button>` : ''}
    <p style="margin-top:16px"><a href="#/mis-reservas">Ver todas mis reservas</a></p>`;

  const $cancel = document.getElementById('cancel');
  if ($cancel) $cancel.addEventListener('click', async () => {
    const msg = r.freeCancel
      ? '¿Cancelar la reserva? Te devolveremos la señal.'
      : `¿Cancelar la reserva? Faltan menos de ${config.freeCancelHours} h y perderás los ${euro(r.deposit)}.`;
    if (!confirm(msg)) return;
    $cancel.disabled = true;
    try {
      const updated = await api(`/reservations/${encodeURIComponent(r.id)}/cancel`, { method: 'POST' });
      toast(updated.status === 'cancelled_refunded' ? 'Cancelada. Te devolvemos la señal.' : 'Cancelada. La señal no se devuelve.');
      viewReservation(r.id);
    } catch (err) {
      toast(err.message);
      $cancel.disabled = false;
    }
  });
}

async function viewMine() {
  const ids = myIds.get();
  $app.innerHTML = '<h1>Mis reservas</h1><div id="list"><p class="sub">Cargando…</p></div>';
  const list = (await Promise.all(ids.map((id) => api(`/reservations/${encodeURIComponent(id)}`).catch(() => null))))
    .filter(Boolean)
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  document.getElementById('list').innerHTML = list.length
    ? list.map((r) => `
      <a class="card" href="#/reserva/${esc(r.id)}"><div class="body">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
          <strong>${esc(r.restaurantName)}</strong>
          <span class="status st-${esc(r.status)}">${esc(STATUS[r.status] || r.status)}</span>
        </div>
        <div class="meta"><span>${esc(prettyDate(r.date))}</span><span>${esc(r.time)}</span><span>${r.people} pers.</span></div>
      </div></a>`).join('')
    : `<p class="empty">Aún no tienes reservas.</p><a class="btn" href="#/">Buscar restaurante</a>`;
}

// ---------- Router ----------

const routes = [
  [/^#?\/?$/, viewList, 'explorar'],
  [/^#\/r\/([^/]+)$/, viewRestaurant, 'explorar'],
  [/^#\/r\/([^/]+)\/reservar$/, viewBooking, 'explorar'],
  [/^#\/pago\/([^/]+)$/, viewDemoPay, 'reservas'],
  [/^#\/reserva\/([^/]+)$/, viewReservation, 'reservas'],
  [/^#\/mis-reservas$/, viewMine, 'reservas'],
];

async function router() {
  const hash = location.hash || '#/';
  const match = routes.find(([re]) => re.test(hash));
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', match && a.dataset.tab === match[2]));
  window.scrollTo(0, 0);
  try {
    if (!config) config = await api('/config');
    if (!match) { $app.innerHTML = '<p class="empty">Página no encontrada.</p>'; return; }
    await match[1](...hash.match(match[0]).slice(1).map(decodeURIComponent));
  } catch (err) {
    $app.innerHTML = `<p class="empty">${esc(err.message)}</p><a class="btn secondary" href="#/">Volver al inicio</a>`;
  }
}

window.addEventListener('hashchange', router);
router();
