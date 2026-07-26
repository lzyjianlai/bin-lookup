import { neon } from '@neondatabase/serverless';

// ---------- 工具 ----------

function countryFlag(a2) {
  if (!a2 || !/^[A-Za-z]{2}$/.test(a2)) return '';
  const cc = a2.toUpperCase();
  return String.fromCodePoint(127397 + cc.charCodeAt(0), 127397 + cc.charCodeAt(1));
}

function titleCase(s) {
  if (!s) return s;
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

// 统一三个数据源的结构。
// prepaid 判定:显式布尔优先;否则在 type/category/brand/tier 里扫 "prepaid" 字样。
function normalize({ source, scheme, type, tier, bank, countryName, countryCode, category, brand, prepaidExplicit }, bin) {
  let prepaid;
  if (typeof prepaidExplicit === 'boolean') {
    prepaid = prepaidExplicit;
  } else {
    const haystack = [type, category, brand, tier].filter(Boolean).join(' ');
    prepaid = /prepaid/i.test(haystack);
  }
  return {
    bin,
    scheme: scheme ? titleCase(String(scheme)) : null,
    type: type ? titleCase(String(type)) : null,
    tier: tier || brand || null,
    prepaid,
    bank: bank || null,
    country: {
      name: countryName || null,
      code: countryCode ? countryCode.toUpperCase() : null,
      flag: countryFlag(countryCode),
    },
    source,
  };
}

// ---------- 三级数据源 ----------

async function fromHandyApi(bin, env) {
  if (!env.HANDY_API_KEY) return null;
  const res = await fetch(`https://data.handyapi.com/bin/${bin}`, {
    headers: { 'x-api-key': env.HANDY_API_KEY },
  });
  // 429(限流)/402(欠费)/403(无权限)或其它错误 → 回退下一级
  if (!res.ok) return null;
  const d = await res.json();
  if (!d || d.Status !== 'SUCCESS') return null;
  return normalize({
    source: 'HandyAPI 商业库',
    scheme: d.Scheme,
    type: d.Type,
    tier: d.CardTier,
    bank: d.Issuer,
    countryName: d.Country && d.Country.Name,
    countryCode: d.Country && d.Country.A2,
  }, bin);
}

async function fromBinlist(bin) {
  const res = await fetch(`https://lookup.binlist.net/${bin}`, {
    headers: { 'Accept-Version': '3' },
  });
  if (!res.ok) return null;
  const d = await res.json();
  if (!d || (!d.scheme && !d.bank && !d.country)) return null;
  return normalize({
    source: 'binlist.net',
    scheme: d.scheme,
    type: d.type,
    brand: d.brand,
    bank: d.bank && d.bank.name,
    countryName: d.country && d.country.name,
    countryCode: d.country && d.country.alpha2,
    prepaidExplicit: typeof d.prepaid === 'boolean' ? d.prepaid : undefined,
  }, bin);
}

async function fromNeon(bin, env) {
  if (!env.DATABASE_URL) return null;
  const sql = neon(env.DATABASE_URL);
  // 按 8 → 7 → 6 位前缀依次匹配(一次查询,取最长命中)
  const prefixes = [bin.slice(0, 8), bin.slice(0, 7), bin.slice(0, 6)]
    .filter((p, i, a) => p.length >= 6 && a.indexOf(p) === i);
  const rows = await sql`
    SELECT bin, brand, type, category, bank, country_name, country_code
    FROM bins WHERE bin = ANY(${prefixes})
    ORDER BY length(bin) DESC LIMIT 1`;
  if (!rows.length) return null;
  const r = rows[0];
  return normalize({
    source: '离线库 (binlist-data @ Neon)',
    scheme: r.brand,
    type: r.type,
    category: r.category,
    tier: r.category,
    bank: r.bank,
    countryName: r.country_name,
    countryCode: r.country_code,
  }, bin);
}

// ---------- API ----------

async function handleLookup(request, env, ctx) {
  const url = new URL(request.url);
  const bin = (url.searchParams.get('bin') || '').trim();
  if (!/^\d{6,8}$/.test(bin)) {
    return json({ error: '请输入 6-8 位数字 BIN' }, 400);
  }

  // 边缘缓存:同一 BIN 直接命中缓存
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/api/lookup?bin=${bin}`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let result = null;
  try { result = await fromHandyApi(bin, env); } catch { /* 回退 */ }
  if (!result) { try { result = await fromBinlist(bin); } catch { /* 回退 */ } }
  if (!result) { try { result = await fromNeon(bin, env); } catch { /* 回退 */ } }

  if (!result) {
    return json({ error: '三级数据源均未找到该 BIN' }, 404);
  }

  const res = json(result, 200, { 'Cache-Control': 'public, s-maxage=86400' });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

// ---------- 页面 ----------

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BIN 查询</title>
<style>
  :root {
    --card-bg: #ffffff;
    --text: #1a1a2e;
    --muted: #6b7280;
    --border: #e5e7eb;
    --accent: #6366f1;
    --danger: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --card-bg: #1e1e2f;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --border: #374151;
      --danger: #f87171;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #6b21a8 100%);
  }
  .card {
    width: 100%;
    max-width: 460px;
    background: var(--card-bg);
    color: var(--text);
    border-radius: 16px;
    box-shadow: 0 20px 60px rgba(0,0,0,.3);
    padding: 32px;
  }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; line-height: 1.5; }
  .row-input { display: flex; gap: 10px; }
  input {
    flex: 1;
    font-size: 18px;
    letter-spacing: 2px;
    padding: 12px 14px;
    border: 1.5px solid var(--border);
    border-radius: 10px;
    background: transparent;
    color: var(--text);
    outline: none;
  }
  input:focus { border-color: var(--accent); }
  button {
    padding: 12px 22px;
    font-size: 16px;
    border: none;
    border-radius: 10px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }
  button:disabled { opacity: .6; cursor: wait; }
  #result { margin-top: 22px; }
  .kv { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 15px; }
  .kv:last-child { border-bottom: none; }
  .kv .k { color: var(--muted); flex-shrink: 0; }
  .kv .v { text-align: right; word-break: break-word; }
  .prepaid { color: var(--danger); font-weight: 700; }
  .err { color: var(--danger); font-size: 14px; margin-top: 16px; }
  .note { margin-top: 18px; font-size: 12px; color: var(--muted); line-height: 1.6; }
</style>
</head>
<body>
<div class="card">
  <h1>💳 BIN 查询</h1>
  <p class="sub">输入卡号前 6-8 位(BIN)查询卡片信息</p>
  <div class="row-input">
    <input id="bin" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="如 455673">
    <button id="go">查询</button>
  </div>
  <div id="result"></div>
  <p class="note">🔒 隐私说明:输入框只保留前 8 位数字,输入或粘贴的多余数字会被立即丢弃,完整卡号绝不会进入页面或被发送到任何服务器。</p>
</div>
<script>
(function () {
  var input = document.getElementById('bin');
  var btn = document.getElementById('go');
  var box = document.getElementById('result');

  // 输入/粘贴一律实时清洗:去非数字并截断为前 8 位,多余内容直接丢弃
  input.addEventListener('input', function () {
    input.value = input.value.replace(/\\D/g, '').slice(0, 8);
  });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function row(k, v, cls) {
    return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v ' + (cls || '') + '">' + v + '</span></div>';
  }

  function lookup() {
    var bin = input.value;
    if (!/^\\d{6,8}$/.test(bin)) {
      box.innerHTML = '<p class="err">请输入 6-8 位数字</p>';
      return;
    }
    btn.disabled = true;
    box.innerHTML = '<p class="sub">查询中…</p>';
    fetch('/api/lookup?bin=' + bin)
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        btn.disabled = false;
        if (!res.ok) {
          box.innerHTML = '<p class="err">' + esc(res.d.error || '查询失败') + '</p>';
          return;
        }
        var d = res.d;
        var typeCell = d.prepaid
          ? '<span class="prepaid">预付</span>'
          : esc(d.type || '未知');
        var countryCell = d.country && d.country.name
          ? esc(d.country.flag ? d.country.flag + ' ' + d.country.name : d.country.name)
          : '未知';
        box.innerHTML =
          row('BIN', esc(d.bin)) +
          row('卡组织', esc(d.scheme || '未知')) +
          row('预付/借贷', typeCell) +
          row('卡等级', esc(d.tier || '未知')) +
          row('发卡行', esc(d.bank || '未知')) +
          row('国家', countryCell) +
          row('数据来源', esc(d.source));
      })
      .catch(function () {
        btn.disabled = false;
        box.innerHTML = '<p class="err">网络错误,请重试</p>';
      });
  }

  btn.addEventListener('click', lookup);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') lookup(); });
})();
</script>
</body>
</html>`;

// ---------- 入口 ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/lookup') {
      return handleLookup(request, env, ctx);
    }
    if (url.pathname === '/') {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    return new Response('Not Found', { status: 404 });
  },
};
