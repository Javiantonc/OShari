// SHARI — panel del restaurante: ver reservas del día y marcar asistencia.

const STATUS = {
  pending_payment: 'Pendiente de pago',
  confirmed: 'Confirmada',
  attended: 'Asistió · señal descontada',
  no_show: 'No asistió · señal retenida',
  cancelled_refunded: 'Cancelada · señal devuelta',
  cancelled_late: 'Cancelada tarde · señal retenida',
};

let pin = sessionStorage.getItem('shari.pin') || '';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch(`api.php${path}`, { ...opts, headers: { 'x-admin-pin': pin } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Error'), { status: res.status });
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

const $rest = document.getElementById('rest');
const $date = document.getElementById('date');
const now = new Date();
$date.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

async function start() {
  const rests = await fetch('api.php/restaurants').then((r) => r.json());
  $rest.innerHTML = rests.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  try {
    await load();
    document.getElementById('login').hidden = true;
    document.getElementById('panel').hidden = false;
    sessionStorage.setItem('shari.pin', pin);
  } catch (e) {
    document.getElementById('loginErr').textContent = e.status === 401 ? 'PIN incorrecto' : e.message;
  }
}

async function load() {
  const list = await api(`/admin/reservations?restaurantId=${encodeURIComponent($rest.value)}&date=${$date.value}`);
  const active = list.filter((r) => ['confirmed', 'attended', 'no_show'].includes(r.status));
  const retained = list.filter((r) => ['no_show', 'cancelled_late'].includes(r.status)).reduce((s, r) => s + r.deposit, 0);
  document.getElementById('stats').innerHTML = `
    <div><b>${active.length}</b><small>Reservas</small></div>
    <div><b>${active.reduce((s, r) => s + r.people, 0)}</b><small>Comensales</small></div>
    <div><b>${retained} €</b><small>Señales retenidas</small></div>`;
  document.getElementById('list').innerHTML = list.length
    ? list.map((r) => `
      <div class="card"><div class="body">
        <div class="row">
          <div>
            <strong>${esc(r.time)} · ${esc(r.name)} · ${r.people} pers.</strong>
            <div class="meta"><span>Código ${esc(r.code)}</span><span>${esc(r.phone)}</span><span>${esc(r.email)}</span></div>
            ${r.notes ? `<div class="meta"><span>📝 ${esc(r.notes)}</span></div>` : ''}
          </div>
          ${r.status === 'confirmed'
            ? `<div class="actions">
                 <button class="ok" data-id="${esc(r.id)}" data-a="attended">Asistió</button>
                 <button class="ko" data-id="${esc(r.id)}" data-a="no-show">No vino</button>
               </div>`
            : `<span class="status st-${esc(r.status)}">${esc(STATUS[r.status] || r.status)}</span>`}
        </div>
      </div></div>`).join('')
    : '<p class="empty">No hay reservas este día.</p>';
}

document.getElementById('login').addEventListener('submit', (e) => {
  e.preventDefault();
  pin = document.getElementById('pin').value;
  start();
});
$rest.addEventListener('change', load);
$date.addEventListener('change', load);
document.getElementById('list').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  if (b.dataset.a === 'no-show' && !confirm('¿Marcar como no presentado? La señal de 10 € no se devolverá.')) return;
  try {
    await api(`/admin/reservations/${b.dataset.id}/${b.dataset.a}`, { method: 'POST' });
    toast(b.dataset.a === 'attended' ? 'Marcada: asistió' : 'Marcada: no asistió. Señal retenida.');
    load();
  } catch (err) {
    toast(err.message);
  }
});

if (pin) start();
