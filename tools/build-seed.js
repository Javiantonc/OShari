// Genera seed.json (los restaurantes y cartas que carga api.php) a partir de seed.js.
// Uso, desde la carpeta del proyecto:  node tools/build-seed.js
// Después borra la carpeta data/ para que la app cargue los datos nuevos.

const fs = require('fs');
const path = require('path');

const seed = require('./seed');
const out = path.join(__dirname, '..', 'seed.json');
fs.writeFileSync(out, JSON.stringify(seed, null, 2));
console.log(`seed.json generado: ${seed.restaurants.length} restaurantes`);
