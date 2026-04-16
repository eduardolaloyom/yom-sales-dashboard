# YOM Sales Dashboard

Dashboard de ventas B2B para clientes YOM. Muestra métricas mensuales por cliente: GMV, pedidos, comercios activos, vendedores activos, cuentas registradas y ratios de productividad. Se actualiza automáticamente cada día vía GitHub Actions y se sirve como página estática en GitHub Pages.

## Arquitectura

```
MongoDB Legacy (yom-production)
        │
   extract.js        ← script mongosh que consulta la DB
        │
     data.js          ← archivo JS generado (NO editar manualmente)
        │
  dashboard.html      ← dashboard autocontenido, lee data.js como <script src>
        │
  GitHub Pages        ← sirve ambos archivos estáticamente
        │
  GitHub Actions      ← corre extract.js diariamente a las 07:00 Chile
```

## Archivos

| Archivo | Descripción |
|---------|-------------|
| `extract.js` | Script mongosh — extrae datos de MongoDB y genera `data.js` |
| `dashboard.html` | Dashboard HTML/JS sin dependencias de build ni servidor |
| `data.js` | Datos generados automáticamente. **No editar a mano** |
| `.github/workflows/update-data.yml` | GitHub Action para actualización diaria |

## Actualizar datos manualmente

```bash
mongosh "<MONGO_LEGACY_URI>" --quiet --file extract.js > data.js
```

La URI está disponible en:
- GitHub: Settings → Secrets → Actions → `MONGO_LEGACY_URI`
- Local: `/Users/lalojimenez/qa/.env` → variable `MONGO_LEGACY_URI`

## GitHub Actions

- Corre automáticamente cada día a las **10:00 UTC (07:00 Chile)**
- También se puede disparar manualmente: Actions → "Update Sales Data" → Run workflow
- Genera `data.js`, hace commit y push a `main` automáticamente

## Agregar un cliente nuevo

1. Agregar una entrada al array `CLIENTS` en `extract.js`:

```js
{ domain: 'nuevocliente.youorder.me', name: 'Nombre', currency: 'CLP' }
```

2. Correr el extract manualmente para verificar que tiene datos:

```bash
mongosh "<URI>" --quiet --file extract.js > data.js
node -e "eval(require('fs').readFileSync('data.js','utf8').replace('const ','var ')); console.log(YOM_DATA.clients.find(c=>c.name==='Nombre'))"
```

3. Commit y push — GitHub Actions lo incluirá desde el próximo ciclo diario.

**Campos opcionales por cliente:**

| Campo | Default | Descripción |
|-------|---------|-------------|
| `statuses` | `['processing']` | Status de órdenes activas. Soprole usa `['pending']` |
| `fxRate` | `1` | Factor de conversión a CLP. CoÉxito usa `0.25` (COP ÷ 4) |

## Métricas — definiciones

| Métrica | Fuente en MongoDB | Definición |
|---------|-------------------|------------|
| **Ventas** | `orders.pricing.discountedTotalPrice` | GMV sin IVA. Precio con descuento aplicado |
| **Pedidos** | `orders` count | Total órdenes con status activo |
| **Vendedores activos** | `orders.sellerId` | Distinct ObjectIds de usuarios YOM que crearon órdenes ese mes |
| **Cuentas vendedor** | `sellers` count | Total cuentas registradas por cliente — base facturable YOM |
| **% Act. vendedores** | activos / cuentas | Proporción de cuentas que vendió ≥1 vez (capeada a 100%) |
| **Comercios activos** | `orders.commerceId` | Distinct comercios con ≥1 pedido ese mes |
| **% Activación** | activos / registrados | Comercios activos vs total registrados en colección `commerces` |
| **Ticket promedio** | ventas / pedidos | GMV promedio por orden |
| **Venta / vendedor** | ventas / vendedores prom. | Productividad GMV por vendedor activo |
| **Pedidos / vendedor** | pedidos / vendedores prom. | Pedidos promedio por vendedor activo |
| **Pedidos / comercio** | pedidos / comercios prom. | Frecuencia de recompra promedio |

## Decisiones técnicas y gotchas

### `sellerId` vs `externalSellerIds`

- **`sellerId`** = ObjectId del usuario YOM que creó la orden → fuente correcta para contar personas únicas
- **`externalSellerIds`** = array de códigos externos del cliente (rutas/territorios) → **no usar para contar vendedores**. Un mismo vendedor puede tener múltiples códigos externos, y una orden puede listar varios a la vez

### Colección `sellers` — base facturable

La colección `sellers` en `yom-production` es el catálogo de cuentas de vendedor creadas para cada cliente. Campos clave:

```
customerId      → ObjectId del usuario YOM (= sellerId en orders)
domain          → dominio del cliente
externalSellerId → código externo asignado por el cliente
email / name    → datos del vendedor
lastSyncDate    → última vez que usó la app móvil
```

`db.sellers.countDocuments({ domain })` es el denominador correcto para la tasa de activación: representa lo que YOM factura al cliente. Algunos clientes tienen cuentas creadas en bulk que nunca fueron activadas (ej. Codelpa importó 661 cuentas en mayo 2025 que no han usado la app).

### `createdAt` mixto

El campo `createdAt` en `orders` puede ser `ISODate` o `string` según la antigüedad del documento. El extract usa `$expr + $toDate` para normalizar ambos formatos en los pipelines de agregación.

### CoÉxito — moneda COP

Opera en pesos colombianos. El extract aplica `fxRate: 0.25` para convertir a CLP (÷4). Todos los montos en el dashboard se muestran en CLP.

### Soprole — status `pending`

El flujo de Soprole no hace transición de órdenes a `processing`. Sus órdenes activas tienen status `pending`. Todos los demás clientes usan `processing`.

## Colecciones MongoDB usadas

Todas en `yom-production` (cluster legacy `legacy-production-v6.dmjt9.mongodb.net`):

| Colección | Uso |
|-----------|-----|
| `orders` | Órdenes de compra — fuente principal de métricas |
| `commerces` | Puntos de venta registrados — denominador de activación de comercios |
| `sellers` | Cuentas de vendedor por cliente — denominador de activación de vendedores |
