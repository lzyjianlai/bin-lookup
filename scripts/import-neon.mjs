// 将开源 binlist-data CSV 导入 Neon Postgres。
// 用法:DATABASE_URL='postgres://...' node scripts/import-neon.mjs
import { neon } from '@neondatabase/serverless';

const CSV_URL =
  'https://raw.githubusercontent.com/venelinkochev/bin-list-data/master/bin-list-data.csv';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('缺少 DATABASE_URL 环境变量');
  process.exit(1);
}

// 简易 CSV 解析(处理带引号字段)
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

console.log('下载 CSV…');
const res = await fetch(CSV_URL);
if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
const text = await res.text();
const lines = text.split(/\r?\n/).filter((l) => l.trim());

const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
const idx = (name) => header.indexOf(name);
const iBin = idx('bin');
const iBrand = idx('brand');
const iType = idx('type');
const iCategory = idx('category');
const iIssuer = idx('issuer');
const iCountry = idx('countryname');
const iA2 = idx('isocode2');
console.log('表头:', header.join(', '));

// 去重(按 bin,后出现的覆盖先出现的)
const map = new Map();
for (let i = 1; i < lines.length; i++) {
  const f = parseCsvLine(lines[i]);
  const bin = (f[iBin] || '').trim();
  if (!/^\d{6,8}$/.test(bin)) continue;
  map.set(bin, {
    bin,
    brand: (f[iBrand] || '').trim() || null,
    type: (f[iType] || '').trim() || null,
    category: (f[iCategory] || '').trim() || null,
    bank: (f[iIssuer] || '').trim() || null,
    country_name: (f[iCountry] || '').trim() || null,
    country_code: (f[iA2] || '').trim() || null,
  });
}
const rows = [...map.values()];
console.log(`解析完成:${lines.length - 1} 行,去重后 ${rows.length} 条`);

const sql = neon(DATABASE_URL);

console.log('建表…');
await sql`CREATE TABLE IF NOT EXISTS bins (
  bin TEXT PRIMARY KEY,
  brand TEXT,
  type TEXT,
  category TEXT,
  bank TEXT,
  country_name TEXT,
  country_code TEXT
)`;

console.log('批量写入…');
const BATCH = 1000;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const values = [];
  const params = [];
  chunk.forEach((r, j) => {
    const base = j * 7;
    values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`);
    params.push(r.bin, r.brand, r.type, r.category, r.bank, r.country_name, r.country_code);
  });
  await sql(
    `INSERT INTO bins (bin, brand, type, category, bank, country_name, country_code)
     VALUES ${values.join(',')}
     ON CONFLICT (bin) DO UPDATE SET
       brand = EXCLUDED.brand, type = EXCLUDED.type, category = EXCLUDED.category,
       bank = EXCLUDED.bank, country_name = EXCLUDED.country_name, country_code = EXCLUDED.country_code`,
    params
  );
  process.stdout.write(`\r已写入 ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
}
console.log('\n完成。');

const [{ count }] = await sql`SELECT count(*)::int AS count FROM bins`;
console.log(`表内总计 ${count} 条 BIN`);
