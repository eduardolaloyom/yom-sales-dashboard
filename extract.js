// ============================================================
// YOM Sales Dashboard — Extract Script
// Uso: mongosh "<MONGO_URI>" --quiet --file extract.js > data.js
// ============================================================

// Últimos 12 meses
const date12ago = new Date();
date12ago.setMonth(date12ago.getMonth() - 12);

const CLIENTS = [
  // Soprole usa 'pending' como status activo (su flujo no pasa a 'processing')
  { domain: 'soprole.youorder.me',         name: 'Soprole',         currency: 'CLP', statuses: ['pending'] },
  { domain: 'codelpa.youorder.me',          name: 'Codelpa',         currency: 'CLP' },
  { domain: 'codelpa-peru.youorder.me',     name: 'Codelpa Perú',    currency: 'CLP' },
  { domain: 'softys-cencocal.youorder.me',  name: 'Softys-Cencocal', currency: 'CLP' },
  { domain: 'softys-dimak.youorder.me',     name: 'Dimak',           currency: 'CLP' },
  { domain: 'surtiventas.youorder.me',      name: 'Surtiventas',     currency: 'CLP' },
  { domain: 'elmuneco.youorder.me',         name: 'El Muñeco',       currency: 'CLP' },
  { domain: 'marleycoffee.youorder.me',     name: 'Marley Coffee',   currency: 'CLP' },
  { domain: 'prisa.youorder.me',            name: 'Prisa',           currency: 'CLP' },
  { domain: 'caren.youorder.me',            name: 'Caren',           currency: 'CLP' },
  { domain: 'coexito.youorder.me',          name: 'CoÉxito',         currency: 'CLP', fxRate: 0.25 },  // COP→CLP ÷4
  { domain: 'bastien.youorder.me',          name: 'Bastien',         currency: 'CLP' },
  { domain: 'sonrie.youorder.me',           name: 'Sonrie',          currency: 'CLP' },
  { domain: 'expressdent.youorder.me',      name: 'ExpressDent',     currency: 'CLP' },
  { domain: 'prisur.youorder.me',           name: 'Prisur',          currency: 'CLP' },
];

const data = {
  extractedAt: new Date().toISOString(),
  clients: []
};

for (const client of CLIENTS) {
  const { domain, name, currency, fxRate = 1, statuses = ['processing'] } = client;
  const statusFilter = statuses.length === 1 ? statuses[0] : { $in: statuses };

  // ── Totales all-time ─────────────────────────────────────
  const totales = db.orders.aggregate([
    { $match: { domain, status: statusFilter } },
    { $group: {
      _id: null,
      ordenes:     { $sum: 1 },
      ventaSinIVA: { $sum: '$pricing.discountedTotalPrice' },
      primeraOrden: { $min: { $toDate: '$createdAt' } },
      ultimaOrden:  { $max: { $toDate: '$createdAt' } }
    }}
  ]).toArray()[0];

  if (!totales) {
    data.clients.push({
      domain, name, currency, sinDatos: true,
      ordenes: 0, comercios: 0, comerciosRegistrados: 0,
      ventaSinIVA: 0,
      primeraOrden: null, ultimaOrden: null, mensual: []
    });
    continue;
  }

  // ── Comercios distintos con orden (all-time) ──────────────
  const comercios = db.orders.distinct('commerceId', { domain, status: statusFilter }).length;

  // ── Comercios registrados (activos en collection) ─────────
  const comerciosRegistrados = db.commerces.countDocuments({ domain, active: true });

  // ── Vendedores distintos con orden (all-time) ─────────────
  const vendedoresRaw = db.orders.distinct('sellerId', { domain, status: statusFilter });
  const vendedores = [...new Set(vendedoresRaw.flat().filter(v => v))].length;

  // ── Pipeline 1: métricas mensuales (últimos 12 meses) ─────
  // Usar $expr para soportar createdAt tanto ISODate como string
  const metricasMes = db.orders.aggregate([
    { $match: { domain, status: statusFilter, createdAt: { $ne: null },
        $expr: { $gte: [ { $toDate: '$createdAt' }, date12ago ] } } },
    { $group: {
      _id: {
        year:  { $year:  { $toDate: '$createdAt' } },
        month: { $month: { $toDate: '$createdAt' } }
      },
      ordenes:     { $sum: 1 },
      ventaSinIVA: { $sum: '$pricing.discountedTotalPrice' }
    }},
    { $sort: { '_id.year': 1, '_id.month': 1 } }
  ]).toArray();

  // ── Pipeline 2: comercios activos por mes (double-group) ──
  const comerciosMes = db.orders.aggregate([
    { $match: { domain, status: statusFilter, createdAt: { $ne: null }, commerceId: { $ne: null },
      $expr: { $gte: [ { $toDate: '$createdAt' }, date12ago ] } } },
    { $group: { _id: {
      year:       { $year:  { $toDate: '$createdAt' } },
      month:      { $month: { $toDate: '$createdAt' } },
      commerceId: '$commerceId'
    }}},
    { $group: {
      _id: { year: '$_id.year', month: '$_id.month' },
      comerciosActivos: { $sum: 1 }
    }}
  ]).toArray();

  // ── Pipeline 3: vendedores activos por mes (double-group) ──
  const vendedoresMes = db.orders.aggregate([
    { $match: { domain, status: statusFilter, createdAt: { $ne: null },
      sellerId: { $exists: true, $ne: null, $not: { $size: 0 } },
      $expr: { $gte: [ { $toDate: '$createdAt' }, date12ago ] } } },
    { $unwind: '$sellerId' },
    { $match: { sellerId: { $ne: null, $ne: '' } } },
    { $group: { _id: {
      year:     { $year:  { $toDate: '$createdAt' } },
      month:    { $month: { $toDate: '$createdAt' } },
      sellerId: '$sellerId'
    }}},
    { $group: {
      _id: { year: '$_id.year', month: '$_id.month' },
      vendedoresActivos: { $sum: 1 }
    }}
  ]).toArray();

  // Merge de los tres pipelines por year+month
  const comerciosMesMap = {};
  comerciosMes.forEach(c => {
    comerciosMesMap[`${c._id.year}-${c._id.month}`] = c.comerciosActivos;
  });
  const vendedoresMesMap = {};
  vendedoresMes.forEach(v => {
    vendedoresMesMap[`${v._id.year}-${v._id.month}`] = v.vendedoresActivos;
  });

  const mensual = metricasMes.map(m => ({
    year:             m._id.year,
    month:            m._id.month,
    ordenes:          m.ordenes,
    ventaSinIVA:      Math.round(m.ventaSinIVA * fxRate),
    comerciosActivos:   comerciosMesMap[`${m._id.year}-${m._id.month}`]   || 0,
    vendedoresActivos:  vendedoresMesMap[`${m._id.year}-${m._id.month}`]  || 0
  }));

  data.clients.push({
    domain, name, currency, sinDatos: false,
    ordenes:              totales.ordenes,
    comercios,
    comerciosRegistrados,
    vendedores,
    ventaSinIVA:          Math.round(totales.ventaSinIVA * fxRate),
    primeraOrden:         totales.primeraOrden,
    ultimaOrden:          totales.ultimaOrden,
    mensual
  });
}

print('// Auto-generated by extract.js — ' + new Date().toISOString());
print('const YOM_DATA = ' + JSON.stringify(data, null, 2) + ';');
