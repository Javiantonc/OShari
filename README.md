# SHARI · Reserva sushi

App para reservar mesa en restaurantes de sushi: ver la carta, reservar y pagar una señal de 10 € que se pierde si el cliente no se presenta.

## Arrancar con XAMPP

1. Copia esta carpeta en `C:\xampp\htdocs\Oshari` (o clónala ahí con git).
2. Abre el **XAMPP Control Panel** y pulsa **Start** en **Apache**.
3. Entra en:
   - App del cliente: http://localhost/Oshari/
   - Panel del restaurante: http://localhost/Oshari/admin.html (PIN por defecto `1234`)

No hace falta MySQL: las reservas se guardan en `data/db.json`, que se crea solo la primera vez.

## Cómo funciona la señal

| Situación | Qué pasa con los 10 € |
|---|---|
| El cliente acude | El restaurante marca **Asistió** y se descuenta de la cuenta |
| Cancela con más de 24 h | Se le devuelve (reembolso automático con Stripe) |
| Cancela con menos de 24 h | Se pierde |
| No se presenta | El restaurante marca **No vino** y se pierde |
| No paga en 15 min | La reserva caduca y la mesa queda libre |

Las cifras están al principio de `api.php` (`DEPOSIT_EUR`, `FREE_CANCEL_HOURS`, `HOLD_MINUTES`).

## Pagos reales con Stripe

Sin configurar nada, la app funciona en **modo demo** y el pago se simula. Para cobrar de verdad, define la variable de entorno `STRIPE_SECRET_KEY` (por ejemplo `sk_test_...`) en Apache. En XAMPP se puede añadir al final de `C:\xampp\apache\conf\httpd.conf`:

```
SetEnv STRIPE_SECRET_KEY sk_test_xxx
SetEnv ADMIN_PIN tu-pin
```

y reiniciar Apache. El cliente paga en Stripe Checkout (tarjeta, Apple Pay, Google Pay) y vuelve a la app con la reserva confirmada.

## Cambiar restaurantes o cartas

Los datos están en `tools/seed.js` y `tools/seed-tripadvisor.js`. Después de editarlos:

```
node tools/build-seed.js
```

y borra la carpeta `data/` para que la app cargue los datos nuevos (también borra las reservas).

## Archivos

- `index.html`, `app.js`, `styles.css`: app del cliente
- `admin.html`, `admin.js`: panel del restaurante
- `api.php`: API de reservas, reglas de la señal y pagos
- `seed.json`: restaurantes y cartas que carga la API
- `tools/`: datos de origen y script que genera `seed.json`
- `brand/`: logo y favicon de SHARI
- `.htaccess`: impide descargar `data/` y `tools/` desde el navegador

## Pendiente para producción

- Cuentas de cliente (ahora "Mis reservas" se guarda en el propio móvil) y acceso propio para cada restaurante
- Una base de datos de verdad (MySQL, que ya viene con XAMPP) en lugar del archivo JSON
- Emails o SMS de confirmación y recordatorio
- Webhook de Stripe, por si el cliente cierra el navegador justo después de pagar
- Marcar automáticamente como "No vino" las reservas que el restaurante no marque
- Textos legales: condiciones de la señal y política de privacidad (RGPD)
