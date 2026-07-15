with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

r_start = html.index('function resolveExt')
r_end = html.index('// ===== 动态数量探测：指数搜索 + 二分查找，不预设数量 =====')
new_code = """function resolveExt(id, srcFn) {
    if (state.extCache[id]) return Promise.resolve(state.extCache[id]);
    return new Promise((res) => {
      let settled = false;
      let pending = CONFIG.EXTENSIONS.length;
      const exts = CONFIG.EXTENSIONS.slice();
      const neighbor = state.extCache[id - 1] || state.extCache[id + 1];
      if (neighbor) exts.sort((a) => a === neighbor ? -1 : 1);
      for (const ext of exts) {
        const url = urlOf(id, ext);
        fetch(url, { method: 'HEAD', cache: 'force-cache', signal: AbortSignal.timeout(5000) })
          .then((r) => {
            if (settled) return;
            if (r.ok) { settled = true; state.extCache[id] = ext; res(ext); }
            else if (--pending <= 0) res(null);
          })
          .catch(() => { if (--pending <= 0 && !settled) { settled = true; res(null); } });
      }
    });
  }

  function detectCI(anchorId, anchorExt) {
    return fetch(urlOf(anchorId, anchorExt) + CONFIG.CI_PROBE, { method: 'HEAD' })
      .then((r) => r.ok)
      .catch(() => false);
  }

  // ===== 动态数量探测：指数搜索 + 二分查找，不预设数量 ====="""

html = html[:r_start] + new_code + html[r_end:]

d_start = html.index('async function detectMax()')
d_end = html.index('// ===== 单图加载')
new_detect = """async function detectMax() {
    try {
      const raw = localStorage.getItem('jrrp_max');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.ts < 3600000) {
          if (parsed.exts) {
            for (const k of Object.keys(parsed.exts)) state.extCache[parseInt(k)] = parsed.exts[k];
          }
          return parsed.max;
        }
      }
    } catch (_) {}

    const promises = [];
    for (let id = 1; id <= 16; id++) {
      promises.push(resolveExt(id).then((ext) => ext ? { id, ext } : null));
    }
    const results = await Promise.all(promises);
    let anchor = null;
    for (const r of results) { if (r) { anchor = r; break; } }
    if (!anchor) return 0;

    state.ci = await detectCI(anchor.id, anchor.ext);

    let lo = anchor.id, hi = anchor.id * 2;
    while (hi <= CONFIG.EXP_CAP) {
      if (await resolveExt(hi)) { lo = hi; hi *= 2; }
      else break;
    }
    let a = lo, b = (hi <= CONFIG.EXP_CAP) ? hi - 1 : CONFIG.EXP_CAP;
    while (a < b) {
      const mid = (a + b + 1) >> 1;
      if (await resolveExt(mid)) a = mid; else b = mid - 1;
    }

    try {
      const exts = {};
      for (const k of Object.keys(state.extCache)) exts[k] = state.extCache[k];
      localStorage.setItem('jrrp_max', JSON.stringify({ max: a, exts: exts, ts: Date.now() }));
    } catch (_) {}

    return a;
  }

  // ===== 单图加载"""

html = html[:d_start] + new_detect + html[d_end:]

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(html)
print('Done, size:', len(html))
