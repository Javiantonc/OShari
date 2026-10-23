<?php
// SHARI — API de reservas en PHP, para XAMPP (Apache + PHP 8).
// Misma API que server.js: las rutas van detrás de api.php, p. ej. api.php/restaurants.
//
// Pagos: si existe la variable de entorno STRIPE_SECRET_KEY se cobra la señal con
// Stripe Checkout. Sin ella, la app funciona en "modo demo" y el pago se simula.

declare(strict_types=1);

const DEPOSIT_EUR = 10;
const FREE_CANCEL_HOURS = 24; // cancelar con más antelación => se devuelve la señal
const HOLD_MINUTES = 15;      // tiempo para pagar antes de liberar la mesa
const MAX_PEOPLE = 10;

$ADMIN_PIN = getenv('ADMIN_PIN') ?: '1234';
$STRIPE_KEY = getenv('STRIPE_SECRET_KEY') ?: '';

date_default_timezone_set('Europe/Madrid');

$DATA_DIR = __DIR__ . '/data';
$DB_FILE = $DATA_DIR . '/db.json';

// ---------- Base de datos (archivo JSON con bloqueo) ----------

$lock = null;
$db = null;

function openDb(): void {
    global $DATA_DIR, $DB_FILE, $lock, $db;
    if (!is_dir($DATA_DIR)) mkdir($DATA_DIR, 0775, true);
    $lock = fopen($DATA_DIR . '/.lock', 'c');
    flock($lock, LOCK_EX);
    if (!file_exists($DB_FILE)) {
        copy(__DIR__ . '/seed.json', $DB_FILE);
    }
    $db = json_decode(file_get_contents($DB_FILE), true);
}

function saveDb(): void {
    global $DB_FILE, $db;
    $tmp = $DB_FILE . '.tmp';
    file_put_contents($tmp, json_encode($db, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    rename($tmp, $DB_FILE);
}

// ---------- Utilidades ----------

function send(int $status, $body): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(int $status, string $message): void {
    send($status, ['error' => $message]);
}

function readBody(): array {
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return [];
    $data = json_decode($raw, true);
    if (!is_array($data)) fail(400, 'JSON no válido');
    return $data;
}

function slotTime(string $date, string $time): int {
    return strtotime("$date $time:00");
}

function isValidDate($s): bool {
    return is_string($s) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $s) && strtotime($s) !== false;
}

function nowIso(): string {
    return gmdate('Y-m-d\TH:i:s.v\Z');
}

function uuid(): string {
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

function findRestaurant($id): ?array {
    global $db;
    foreach ($db['restaurants'] as $r) if ($r['id'] === $id) return $r;
    return null;
}

function &findReservation($id) {
    global $db;
    $null = null;
    foreach ($db['reservations'] as $i => $r) {
        if ($r['id'] === $id) return $db['reservations'][$i];
    }
    return $null;
}

function setStatus(array &$r, string $status): void {
    $r['status'] = $status;
    $r['history'][] = ['at' => nowIso(), 'status' => $status];
}

// Una reserva sin pagar caduca a los HOLD_MINUTES y deja libre la mesa.
function expireStale(): void {
    global $db;
    $limit = time() - HOLD_MINUTES * 60;
    $changed = false;
    foreach ($db['reservations'] as &$r) {
        if ($r['status'] === 'pending_payment' && strtotime($r['createdAt']) < $limit) {
            $r['status'] = 'expired';
            $changed = true;
        }
    }
    unset($r);
    if ($changed) saveDb();
}

function seatsTaken(string $restaurantId, string $date, string $time): int {
    global $db;
    $sum = 0;
    foreach ($db['reservations'] as $r) {
        if ($r['restaurantId'] === $restaurantId && $r['date'] === $date && $r['time'] === $time
            && in_array($r['status'], ['pending_payment', 'confirmed', 'attended'], true)) {
            $sum += $r['people'];
        }
    }
    return $sum;
}

// Horas reservables de un día: `schedule` (por día de la semana) manda sobre `slots`.
function slotsFor(array $rest, string $date): array {
    $weekday = (int) date('w', strtotime($date));
    if (in_array($weekday, $rest['closedWeekdays'], true)) return [];
    return $rest['schedule'][(string) $weekday] ?? $rest['slots'];
}

function availability(array $rest, string $date): array {
    $times = slotsFor($rest, $date);
    if (!$times) return ['closed' => true, 'slots' => []];
    $slots = [];
    foreach ($times as $time) {
        $free = $rest['seatsPerSlot'] - seatsTaken($rest['id'], $date, $time);
        $past = slotTime($date, $time) < time() + 3600; // mínimo 1 h de antelación
        $slots[] = ['time' => $time, 'free' => $past ? 0 : max(0, $free)];
    }
    return ['closed' => false, 'slots' => $slots];
}

function publicReservation(array $r): array {
    $rest = findRestaurant($r['restaurantId']);
    $hoursLeft = (slotTime($r['date'], $r['time']) - time()) / 3600;
    return [
        'id' => $r['id'],
        'code' => $r['code'],
        'restaurantId' => $r['restaurantId'],
        'restaurantName' => $rest['name'] ?? '',
        'address' => $rest['address'] ?? '',
        'date' => $r['date'],
        'time' => $r['time'],
        'people' => $r['people'],
        'name' => $r['name'],
        'status' => $r['status'],
        'deposit' => DEPOSIT_EUR,
        'createdAt' => $r['createdAt'],
        'freeCancel' => $hoursLeft > FREE_CANCEL_HOURS,
        'canCancel' => $r['status'] === 'confirmed' && $hoursLeft > 0,
    ];
}

// Dirección de la carpeta de la app, p. ej. http://localhost/Oshari
function baseUrl(): string {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    return getenv('PUBLIC_URL') ?: $scheme . '://' . $_SERVER['HTTP_HOST'] . rtrim(dirname($_SERVER['SCRIPT_NAME']), '/\\');
}

// ---------- Stripe (API REST con cURL) ----------

function stripe(string $method, string $endpoint, ?array $params = null): array {
    global $STRIPE_KEY;
    $ch = curl_init("https://api.stripe.com/v1/$endpoint");
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_USERPWD => $STRIPE_KEY . ':',
        CURLOPT_POSTFIELDS => $params ? http_build_query($params) : null,
    ]);
    $json = json_decode((string) curl_exec($ch), true) ?: [];
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code >= 400 || !$json) throw new RuntimeException($json['error']['message'] ?? 'Error de Stripe');
    return $json;
}

function createCheckout(array &$r, array $rest): string {
    $base = baseUrl();
    $session = stripe('POST', 'checkout/sessions', [
        'mode' => 'payment',
        'line_items' => [[
            'quantity' => 1,
            'price_data' => [
                'currency' => 'eur',
                'unit_amount' => DEPOSIT_EUR * 100,
                'product_data' => [
                    'name' => "Señal de reserva · {$rest['name']}",
                    'description' => "{$r['date']} {$r['time']} · {$r['people']} pers. Se descuenta de la cuenta; se pierde si no acudes.",
                ],
            ],
        ]],
        'customer_email' => $r['email'],
        'metadata' => ['reservation_id' => $r['id']],
        'expires_at' => time() + 30 * 60,
        'success_url' => "$base/api.php/stripe/return?id={$r['id']}&session_id={CHECKOUT_SESSION_ID}",
        'cancel_url' => "$base/#/reserva/{$r['id']}",
    ]);
    $r['stripeSessionId'] = $session['id'];
    return $session['url'];
}

function refund(array $r): void {
    global $STRIPE_KEY;
    if ($STRIPE_KEY && !empty($r['paymentIntent'])) {
        stripe('POST', 'refunds', ['payment_intent' => $r['paymentIntent']]);
    }
}

// ---------- Rutas ----------

openDb();
expireStale();

$path = trim($_SERVER['PATH_INFO'] ?? '', '/');
$parts = $path === '' ? [] : explode('/', $path);
$method = $_SERVER['REQUEST_METHOD'];

try {
    // Vuelta desde Stripe Checkout: se comprueba el pago con Stripe antes de confirmar.
    if ($path === 'stripe/return') {
        $r = &findReservation($_GET['id'] ?? '');
        $sessionId = $_GET['session_id'] ?? '';
        if ($r && $sessionId && ($r['stripeSessionId'] ?? '') === $sessionId && $r['status'] !== 'confirmed') {
            try {
                $s = stripe('GET', 'checkout/sessions/' . rawurlencode($sessionId));
                if ($s['payment_status'] === 'paid' && ($s['metadata']['reservation_id'] ?? '') === $r['id']) {
                    $r['paymentIntent'] = $s['payment_intent'];
                    $r['paidAt'] = nowIso();
                    setStatus($r, 'confirmed');
                    saveDb();
                }
            } catch (RuntimeException $e) {
                error_log('Stripe: ' . $e->getMessage());
            }
        }
        header('Location: ' . baseUrl() . '/#/reserva/' . ($r['id'] ?? ''), true, 302);
        exit;
    }

    // Configuración pública
    if ($method === 'GET' && $path === 'config') {
        send(200, [
            'deposit' => DEPOSIT_EUR,
            'freeCancelHours' => FREE_CANCEL_HOURS,
            'holdMinutes' => HOLD_MINUTES,
            'maxPeople' => MAX_PEOPLE,
            'paymentMode' => $STRIPE_KEY ? 'stripe' : 'demo',
        ]);
    }

    // Restaurantes
    if ($method === 'GET' && ($parts[0] ?? '') === 'restaurants') {
        if (count($parts) === 1) {
            send(200, array_map(function ($r) { unset($r['menu']); return $r; }, $db['restaurants']));
        }
        $rest = findRestaurant($parts[1]);
        if (!$rest) fail(404, 'Restaurante no encontrado');
        if (count($parts) === 2) send(200, $rest);
        if (($parts[2] ?? '') === 'availability') {
            $date = $_GET['date'] ?? '';
            if (!isValidDate($date)) fail(400, 'Fecha no válida');
            send(200, availability($rest, $date));
        }
    }

    // Crear reserva (queda pendiente de pagar la señal)
    if ($method === 'POST' && $path === 'reservations') {
        $b = readBody();
        $rest = findRestaurant($b['restaurantId'] ?? '');
        $people = $b['people'] ?? null;
        if (!$rest) fail(400, 'Restaurante no válido');
        if (!isValidDate($b['date'] ?? null) || !in_array($b['time'] ?? '', slotsFor($rest, $b['date']), true)) fail(400, 'Fecha u hora no válida');
        if (!is_int($people) || $people < 1 || $people > MAX_PEOPLE) fail(400, 'Entre 1 y ' . MAX_PEOPLE . ' personas');
        $name = mb_substr(trim((string) ($b['name'] ?? '')), 0, 80);
        $phone = mb_substr(trim((string) ($b['phone'] ?? '')), 0, 30);
        $email = mb_substr(trim((string) ($b['email'] ?? '')), 0, 120);
        if ($name === '' || $phone === '' || !preg_match('/^\S+@\S+\.\S+$/', $email)) fail(400, 'Rellena nombre, teléfono y un email válido');
        if (($b['acceptPolicy'] ?? null) !== true) fail(400, 'Debes aceptar la política de la señal');

        $slot = null;
        foreach (availability($rest, $b['date'])['slots'] as $s) if ($s['time'] === $b['time']) $slot = $s;
        if (!$slot || $slot['free'] < $people) fail(409, 'Ya no hay sitio a esa hora. Elige otra.');

        $r = [
            'id' => uuid(),
            'code' => strtoupper(bin2hex(random_bytes(3))),
            'restaurantId' => $rest['id'],
            'date' => $b['date'],
            'time' => $b['time'],
            'people' => $people,
            'name' => $name,
            'phone' => $phone,
            'email' => $email,
            'notes' => mb_substr(trim((string) ($b['notes'] ?? '')), 0, 300),
            'status' => 'pending_payment',
            'createdAt' => nowIso(),
            'history' => [['at' => nowIso(), 'status' => 'pending_payment']],
        ];

        $checkoutUrl = "#/pago/{$r['id']}";
        if ($STRIPE_KEY) {
            try {
                $checkoutUrl = createCheckout($r, $rest);
            } catch (RuntimeException $e) {
                fail(502, 'No se pudo iniciar el pago: ' . $e->getMessage());
            }
        }
        $db['reservations'][] = $r;
        saveDb();
        send(201, ['reservation' => publicReservation($r), 'checkoutUrl' => $checkoutUrl]);
    }

    // Consultar y gestionar una reserva (el id es un UUID difícil de adivinar)
    if (($parts[0] ?? '') === 'reservations' && isset($parts[1])) {
        $r = &findReservation($parts[1]);
        if (!$r) fail(404, 'Reserva no encontrada');
        $action = $parts[2] ?? '';

        if ($method === 'GET' && $action === '') send(200, publicReservation($r));

        // Pago simulado (solo en modo demo)
        if ($method === 'POST' && $action === 'pay-demo') {
            if ($STRIPE_KEY) fail(400, 'El pago se hace con Stripe');
            if ($r['status'] === 'expired') fail(409, 'El tiempo para pagar ha caducado. Haz una reserva nueva.');
            if ($r['status'] !== 'pending_payment') fail(409, 'Esta reserva ya no está pendiente de pago');
            setStatus($r, 'confirmed');
            $r['paidAt'] = nowIso();
            saveDb();
            send(200, publicReservation($r));
        }

        // Cancelar por parte del cliente
        if ($method === 'POST' && $action === 'cancel') {
            $pub = publicReservation($r);
            if (!$pub['canCancel']) fail(409, 'Esta reserva ya no se puede cancelar');
            if ($pub['freeCancel']) {
                try { refund($r); } catch (RuntimeException $e) { fail(502, 'No se pudo devolver la señal: ' . $e->getMessage()); }
                setStatus($r, 'cancelled_refunded');
            } else {
                setStatus($r, 'cancelled_late');
            }
            saveDb();
            send(200, publicReservation($r));
        }
    }

    // Panel del restaurante
    if (($parts[0] ?? '') === 'admin') {
        if (($_SERVER['HTTP_X_ADMIN_PIN'] ?? '') !== $ADMIN_PIN) fail(401, 'PIN incorrecto');

        if ($method === 'GET' && ($parts[1] ?? '') === 'reservations' && count($parts) === 2) {
            $restaurantId = $_GET['restaurantId'] ?? '';
            $date = $_GET['date'] ?? '';
            $list = array_values(array_filter($db['reservations'], fn ($x) =>
                $x['restaurantId'] === $restaurantId && ($date === '' || $x['date'] === $date) && $x['status'] !== 'expired'));
            usort($list, fn ($a, $b) => strcmp($a['date'] . $a['time'], $b['date'] . $b['time']));
            send(200, array_map(fn ($x) => publicReservation($x) + [
                'phone' => $x['phone'], 'email' => $x['email'], 'notes' => $x['notes'],
            ], $list));
        }

        if ($method === 'POST' && ($parts[1] ?? '') === 'reservations' && isset($parts[3])) {
            $target = &findReservation($parts[2]);
            if (!$target) fail(404, 'Reserva no encontrada');
            if ($target['status'] !== 'confirmed') fail(409, 'Solo se pueden marcar reservas confirmadas');
            if ($parts[3] === 'attended') {
                setStatus($target, 'attended');
            } elseif ($parts[3] === 'no-show') {
                if (slotTime($target['date'], $target['time']) > time()) fail(409, 'Aún no ha llegado la hora de la reserva');
                setStatus($target, 'no_show');
            } else {
                fail(404, 'Acción no válida');
            }
            saveDb();
            send(200, publicReservation($target));
        }
    }

    fail(404, 'Ruta no encontrada');
} catch (Throwable $e) {
    error_log((string) $e);
    fail(500, 'Error interno');
}
