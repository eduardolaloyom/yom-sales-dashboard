// ============================================================
// YOM Sales Dashboard — Extract Script
// Uso: mongosh "<MONGO_URI>" --quiet --file extract.js > data.js
// Con tasas explícitas (local):
//   CLP_TO_USD=0.00105 COP_TO_USD=0.00024 mongosh "<URI>" --quiet --file extract.js > data.js
// ============================================================

// Tasas de cambio a USD (inyectadas por GH Actions, fallback para uso local)
const CLP_TO_USD = parseFloat(process.env.CLP_TO_USD || '0.00105');
const COP_TO_USD = parseFloat(process.env.COP_TO_USD || '0.00024');

// Últimos 12 meses
const date12ago = new Date();
date12ago.setMonth(date12ago.getMonth() - 12);

const CLIENTS = [
  // Soprole usa 'pending' como status activo (su flujo no pasa a 'processing')
  { domain: 'soprole.youorder.me',         name: 'Soprole',         currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP', statuses: ['pending'] },
  { domain: 'codelpa.youorder.me',          name: 'Codelpa',         currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP' },
  { domain: 'codelpa-peru.youorder.me',     name: 'Codelpa Perú',    currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP' },
  { domain: 'softys-cencocal.youorder.me',  name: 'Softys-Cencocal', currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP' },
  { domain: 'softys-dimak.youorder.me',     name: 'Dimak',           currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP' },
  { domain: 'surtiventas.youorder.me',      name: 'Surtiventas',     currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP' },
  { domain: 'elmuneco.youorder.me',         name: 'El Muñeco',       currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP' },
  { domain: 'marleycoffee.youorder.me',     name: 'Marley Coffee',   currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP' },
  { domain: 'prisa.youorder.me',            name: 'Prisa',           currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP' },
  { domain: 'caren.youorder.me',            name: 'Caren',           currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP' },
  { domain: 'coexito.youorder.me',          name: 'CoÉxito',         currency: 'USD', fxRate: COP_TO_USD, nativeCurrency: 'COP' },
  { domain: 'bastien.youorder.me',          name: 'Bastien',         currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP' },
  { domain: 'sonrie.youorder.me',           name: 'Sonrie',          currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP' },
  { domain: 'expressdent.youorder.me',      name: 'ExpressDent',     currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP' },
  { domain: 'prisur.youorder.me',           name: 'Prisur',          currency: 'USD', fxRate: CLP_TO_USD, nativeCurrency: 'CLP' },
];

const data = {
  extractedAt: new Date().toISOString(),
  fxRates: { CLP_TO_USD, COP_TO_USD },
  clients: []
};

for (const client of CLIENTS) {
  const { domain, name, currency, fxRate = 1, nativeCurrency = 'CLP', statuses = ['processing'] } = client;
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
      domain, name, currency, nativeCurrency, sinDatos: true,
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

  // ── Cuentas de vendedor creadas (lo que YOM factura) ──────
  const cuentasVendedor = db.sellers.countDocuments({ domain });

  // ── Vendedores activos all-time + exclusión de cuentas YOM internas ───────
  const vendedoresRaw = db.orders.distinct('sellerId', { domain, status: statusFilter });
  const allVendFlat = [...new Set(vendedoresRaw.flat().filter(v => v))];
  const yomUsers = db.users.find(
    { _id: { $in: allVendFlat.map(id => { try { return ObjectId(id); } catch(e) { return null; } }).filter(v => v) },
      email: { $regex: 'youorder\\.me|yom\\.ai' } },
    { _id: 1 }
  ).toArray();
  const yomSellerIds = yomUsers.map(u => u._id.toString());
  const yomSellerIdSet = new Set(yomSellerIds);
  const vendedores = allVendFlat.filter(id => !yomSellerIdSet.has(id)).length;

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
    { $match: { sellerId: { $ne: null, $ne: '', $nin: yomSellerIds } } },
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
    comerciosActivos: comerciosMesMap[`${m._id.year}-${m._id.month}`]  || 0,
    vendedoresActivos: vendedoresMesMap[`${m._id.year}-${m._id.month}`] || 0,
  }));

  data.clients.push({
    domain, name, currency, nativeCurrency, sinDatos: false,
    ordenes:          totales.ordenes,
    comercios,
    comerciosRegistrados,
    vendedores,
    vendedoresYOM:    yomSellerIds.length,
    cuentasVendedor,
    ventaSinIVA:      Math.round(totales.ventaSinIVA * fxRate),
    primeraOrden:     totales.primeraOrden,
    ultimaOrden:      totales.ultimaOrden,
    mensual
  });
}

print('// Auto-generated by extract.js — ' + new Date().toISOString());
print('const YOM_DATA = ' + JSON.stringify(data, null, 2) + ';');
