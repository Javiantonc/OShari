# SHARI · Reserva sushi

App para reservar mesa en restaurantes de sushi: ver la carta, reservar y pagar una señal de 10 € que se pierde si el cliente no se presenta.

## Arrancar

Solo hace falta Node.js 18 o superior, sin instalar nada más.

```bash
node server.js
```

- App del cliente: http://localhost:3000 (pensada para el móvil; se puede añadir a la pantalla de inicio)
- Panel del restaurante: http://localhost:3000/admin (PIN por defecto `1234`)

## Cómo funciona la señal

| Situación | Qué pasa con los 10 € |
|---|---|
| El cliente acude | El restaurante marca **Asistió** y se descuenta de la cuenta |
| Cancela con más de 24 h | Se le devuelve (reembolso automático con Stripe) |
| Cancela con menos de 24 h | Se pierde |
| No se presenta | El restaurante marca **No vino** y se pierde |
| No paga en 15 min | La reserva caduca y la mesa queda libre |

Las cifras están al principio de `server.js` (`DEPOSIT_EUR`, `FREE_CANCEL_HOURS`, `HOLD_MINUTES`).

## Pagos reales con Stripe

Sin configurar nada, la app funciona en **modo demo** y el pago se simula. Para cobrar de verdad:

1. Crea una cuenta en stripe.com y copia la clave secreta (empieza por `sk_test_` para pruebas).
2. Arranca con:

```bash
STRIPE_SECRET_KEY=sk_test_xxx PUBLIC_URL=https://tu-dominio.com node server.js
```

El cliente paga en Stripe Checkout (tarjeta, Apple Pay, Google Pay) y vuelve a la app con la reserva confirmada.

## Variables de entorno

| Variable | Para qué |
|---|---|
| `PORT` | Puerto (3000 por defecto) |
| `ADMIN_PIN` | PIN del panel del restaurante. **Cámbialo** antes de publicar |
| `STRIPE_SECRET_KEY` | Activa los pagos reales |
| `PUBLIC_URL` | Dirección pública, para que Stripe sepa dónde volver |

## Archivos

- `server.js`: API, reglas de la señal y pagos
- `seed.js` y `seed-tripadvisor.js`: los 14 restaurantes de Madrid con sus cartas (se copian a `data/db.json` la primera vez; borra `data/` para recargarlos)
- `brand/`: logo y favicon de SHARI
- `public/`: app del cliente (`index.html`, `app.js`) y panel (`admin.html`, `admin.js`)

## Pendiente para producción

- Cuentas de cliente (ahora "Mis reservas" se guarda en el propio móvil) y acceso propio para cada restaurante
- Una base de datos de verdad (PostgreSQL) en lugar del archivo JSON
- Emails o SMS de confirmación y recordatorio
- Webhook de Stripe, por si el cliente cierra el navegador justo después de pagar
- Marcar automáticamente como "No vino" las reservas que el restaurante no marque
- Textos legales: condiciones de la señal y política de privacidad (RGPD)
