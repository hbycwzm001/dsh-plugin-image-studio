/**
 * dsh-plugin-image-studio — host 侧
 *
 * 职责：
 *  1. 存「供应商通讯录」（地址 / Key / 协议），落在 ~/.dsh/image-studio/config.json（0600）
 *  2. 代理生图请求（openai-images 兼容协议 / gemini 原生），把结果存成本地文件
 *  3. 给浏览器端暴露同源 HTTP 路由 /api/image-studio/*
 *
 * 界面在 client.js（会话顶栏「生图」标签 + 设置页区块）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-plugin-image-studio';
export const inject = [];

export const Config = z.object({
  videoTab: z.boolean().default(true).description('在会话顶栏显示「视频画布」标签（默认显示）'),
  floatButton: z.boolean().default(false).description('在任意界面显示悬浮「生图」按钮（DS Bot 等视图看不到顶栏标签时用这个）'),
  showTab: z.boolean().default(true).description('在会话顶栏显示「生图」标签（默认显示，方便先看界面；关掉只隐藏入口，生图能力仍在）'),
  homeDir: z.string().default('').description('数据目录，留空则用 ~/.dsh/image-studio'),
  outputDir: z.string().default('').description('出图保存目录，留空则自动用「桌面/HSDGPTimg2.5」'),
  timeoutMs: z.number().default(600000).description('单次生图请求超时（毫秒）'),
  defaultProvider: z.string().default('1route').description('默认供应商 id'),
});

/** 预置一套 1route 的地址，Key 留空 —— 让界面「API 填哪里」一眼可见 */
const PRESET_PROVIDER = {
  id: '1route',
  label: '1route.dev（预置）',
  baseUrl: 'https://api.1route.dev/v1',
  protocol: 'openai',
  editMode: 'auto',
  key: '',
  models: ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.6', 'gemini-3.1-flash-image'],
};

const IMAGE_HINT = /image|imagen|dall|flux|seedream|nano-?banana|grok-imagine|qwen-image|kolors|recraft|ideogram|sd3|sdxl/i;
const MAX_BODY_LIMIT_HINT = 50 * 1024 * 1024;

/**
 * 价目表（人民币 / 张）。来自 1route 2026-11-15 的价格页，只作估算：
 * 接口本身不返回价钱，拿不到账单就以这张表为准，界面会标「估算」。
 */
const PRICE_PRESET = {
  '1route': {
    currency: 'CNY',
    models: {
      'gpt-image-2': { '1K': 0.02, '2K': 0.1, '4K': 0.15 },
      'gpt-image-2.5': { '1K': 0.02, '2K': 0.1, '4K': 0.2 },
      'gpt-image-2.5-flare': { '1K': 0.02, '2K': 0.1, '4K': 0.2 },
      'gpt-image-2.5-sunburst': { '1K': 0.02, '2K': 0.1, '4K': 0.2 },
      'gpt-image-2.6': { '1K': 0.02, '2K': 0.1, '4K': 0.2 },
      'gpt-image-2.6-flare': { '1K': 0.02, '2K': 0.1, '4K': 0.2 },
      'gpt-image-2.6-sunburst': { '1K': 0.02, '2K': 0.1, '4K': 0.2 },
      'gemini-3.1-flash-image': { flat: 0.08 },
      'seedream-5-lite': { flat: 0.06 },
      'seedream-5-pro': { flat: 0.08 },
    },
  },
};

function sizeKey(size) {
  const s = String(size || '').trim();
  const m = s.match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
  if (m) {
    const long = Math.max(Number(m[1]), Number(m[2]));
    if (long >= 3000) return '4K';
    if (long >= 1800) return '2K';
    return '1K';
  }
  const k = s.toUpperCase().replace(/\s+/g, '');
  if (k === '4K' || k === '2K' || k === '1K') return k;
  return '1K'; // auto 按 1K 保守计
}

function estimateCost(provider, model, size, count) {
  const table = (provider && provider.prices) || (PRICE_PRESET[provider && provider.id] || null);
  if (!table || !table.models) return { known: false, count, currency: (table && table.currency) || 'CNY' };
  const row = Object.keys(table.models).find((k) => k.toLowerCase() === String(model || '').toLowerCase());
  const prices = row ? table.models[row] : null;
  if (!prices) return { known: false, model, count, currency: table.currency || 'CNY' };
  const key = sizeKey(size);
  const unit = typeof prices === 'number' ? prices : (prices[key] != null ? prices[key] : prices.flat);
  if (unit == null) return { known: false, model, count, currency: table.currency || 'CNY' };
  const amount = Math.round(unit * count * 10000) / 10000;
  return { known: true, unit, amount, count, currency: table.currency || 'CNY', basis: 'pricelist' };
}


/* ------------------------------- 配置存取 ------------------------------- */

function homeDir(config) {
  const raw = String((config && config.homeDir) || '').trim();
  return raw || join(homedir(), '.dsh', 'image-studio');
}

/** 桌面目录：优先系统桌面（含 OneDrive 重定向），找不到就回落到数据目录 */
function desktopDir() {
  const candidates = [
    join(homedir(), 'Desktop'),
    join(homedir(), 'OneDrive', 'Desktop'),
    join(homedir(), 'OneDrive - 个人', 'Desktop'),
  ];
  for (const dir of candidates) {
    try { if (existsSync(dir)) return dir; } catch { /* noop */ }
  }
  return '';
}

/** 出图目录：配置优先；默认「桌面/HSDGPTimg2.5」；都没有就用数据目录下的 outputs */
function outputsDir(config) {
  const raw = String((config && config.outputDir) || '').trim();
  if (raw) return raw.replace(/^~(?=$|\/|\\)/, homedir());
  const desk = desktopDir();
  if (desk) return join(desk, 'HSDGPTimg2.5');
  return join(homeDir(config), 'outputs');
}

function storePath(config) {
  return join(homeDir(config), 'config.json');
}

function defaults(config) {
  return {
    showTab: !!(config && config.showTab),
    videoTab: config && config.videoTab !== false,
    floatButton: !!(config && config.floatButton),
    defaultProvider: String((config && config.defaultProvider) || '1route'),
    providers: [Object.assign({}, PRESET_PROVIDER, {
      baseUrl: PRESET_PROVIDER.baseUrl,
      key: '',
      models: PRESET_PROVIDER.models.slice(),
    })],
  };
}

function readStore(config) {
  const base = defaults(config);
  const path = storePath(config);
  try {
    if (!existsSync(path)) return base;
    const raw = JSON.parse(readFileSync(path, 'utf8') || '{}');
    return {
      showTab: typeof raw.showTab === 'boolean' ? raw.showTab : base.showTab,
      videoTab: typeof raw.videoTab === 'boolean' ? raw.videoTab : base.videoTab,
      floatButton: typeof raw.floatButton === 'boolean' ? raw.floatButton : base.floatButton,
      defaultProvider: String(raw.defaultProvider || base.defaultProvider),
      providers: Array.isArray(raw.providers) && raw.providers.length ? raw.providers : base.providers,
    };
  } catch {
    return base;
  }
}

function writeStore(config, store) {
  const dir = homeDir(config);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  return path;
}

/* ------------------------------- 用量账本 ------------------------------- */

function usagePath(config) {
  return join(homeDir(config), 'usage.jsonl');
}

function appendUsage(config, entry) {
  try {
    mkdirSync(homeDir(config), { recursive: true });
    appendFileSync(usagePath(config), JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* 账本写失败不影响出图 */ }
}

function readUsage(config, limit) {
  const rows = [];
  try {
    const path = usagePath(config);
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      for (const line of lines.slice(-2000)) {
        try { rows.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
      }
    }
  } catch { /* 忽略 */ }
  const t0 = new Date();
  t0.setHours(0, 0, 0, 0);
  const sum = (arr) => ({
    count: arr.reduce((a, r) => a + (Number(r.n) || 0), 0),
    amount: Math.round(arr.reduce((a, r) => a + (Number(r.amount) || 0), 0) * 10000) / 10000,
  });
  const start = t0.getTime();
  const byProvider = {};
  rows.forEach((r) => {
    const k = String(r.providerId || 'unknown');
    byProvider[k] = byProvider[k] || { count: 0, amount: 0 };
    byProvider[k].count += Number(r.n) || 0;
    byProvider[k].amount += Number(r.amount) || 0;
  });
  Object.keys(byProvider).forEach((k) => { byProvider[k].amount = Math.round(byProvider[k].amount * 10000) / 10000; });
  return {
    today: sum(rows.filter((r) => new Date(r.t).getTime() >= start)),
    month: sum(rows.filter((r) => new Date(r.t).getTime() >= Date.now() - 30 * 86400000)),
    all: sum(rows),
    byProvider,
    recent: rows.slice(-(limit || 20)).reverse(),
  };
}

function publicProvider(p) {
  const key = String(p.key || '');
  return {
    id: p.id,
    label: p.label || p.id,
    baseUrl: p.baseUrl || '',
    protocol: p.protocol === 'gemini' ? 'gemini' : 'openai',
    editMode: p.editMode === 'json' || p.editMode === 'multipart' ? p.editMode : 'auto',
    hasKey: !!key,
    keyHint: key ? key.slice(-4) : '',
    models: Array.isArray(p.models) ? p.models : [],
    currency: p.currency || 'CNY',
    prices: p.prices || PRICE_PRESET[p.id] || null,
    pricesFromPreset: !p.prices && !!PRICE_PRESET[p.id],
  };
}

/** 价目表两种写法都收：{models:{...}} 或直接 {model:{...}} */
function normalisePrices(input, prev) {
  if (input === null || input === undefined) return prev;
  const src = typeof input !== 'object' ? null : (input.models ? input : { models: input });
  if (!src) return prev;
  const models = {};
  Object.entries(src.models || {}).forEach(([k, v]) => {
    const name = String(k || '').trim();
    if (!name) return;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) { models[name] = { flat: n }; return; }
    if (v && typeof v === 'object') {
      const row = {};
      Object.entries(v).forEach(([sk, sv]) => {
        const num = Number(sv);
        if (Number.isFinite(num) && num >= 0) row[String(sk)] = num;
      });
      if (Object.keys(row).length) models[name] = row;
    }
  });
  return { currency: String(src.currency || (prev && prev.currency) || 'CNY').slice(0, 8), models };
}

/* ------------------------------- 小工具 ------------------------------- */

function b64ToBuffer(b64) {
  return Buffer.from(String(b64 || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
}

function mimeOf(dataUrl) {
  const m = /^data:([^;]+);/.exec(String(dataUrl || ''));
  return m ? m[1] : 'image/png';
}

function toBlob(dataUrl) {
  return new Blob([b64ToBuffer(dataUrl)], { type: mimeOf(dataUrl) });
}

function baseName(provider) {
  return String(provider.baseUrl || '').replace(/\/+$/, '');
}

function authHeaders(provider) {
  if (provider.protocol === 'gemini') return { 'x-goog-api-key': String(provider.key || '') };
  return { authorization: `Bearer ${String(provider.key || '')}` };
}

async function jsonFetch(url, init, timeoutMs) {
  const res = await fetch(url, Object.assign({}, init, {
    signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 600000)),
  }));
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 800) }; }
  if (!res.ok) {
    const msg = (body && (body.error && (body.error.message || body.error) || body.message)) || text.slice(0, 300) || `HTTP ${res.status}`;
    const err = new Error(`${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* ------------------------------ 生图协议 ------------------------------ */

/* ------------------------------ 视频协议 ------------------------------ */

const VIDEO_MODELS = [
  'seedance-2.5-flex-720p',
  'seedance-2.5-full-720p',
  'seedance-2.5-full-1080p',
  'seedance-2.5-30s-720p',
  'seedance-2.5-stable-a2-720p',
  'seedance-2.5-stable-a-720p',
];

const VIDEO_PRICE = {
  'seedance-2.5-full-720p': 6.15,
  'seedance-2.5-full-1080p': 8.05,
  'seedance-2.5-flex-720p': 7,
  'seedance-2.5-30s-720p': 12.4,
  'seedance-2.5-30s-stable-720p': 12.7,
};

const VIDEO_PER_SECOND = {
  'seedance-2.5-stable-a2-720p': 0.48,
  'seedance-2.5-stable-a-720p': 0.6,
  'seedance-2.5-stable-b-720p': 1.25,
  'seedance-2.5-stable-b2-720p': 1.02,
  'seedance-2.5-stable-b3-720p': 1.176,
  'seedance-2.5-stable-b2-1080p': 1.188,
  'seedance-2.5-stable-b-480p': 0.72,
  'seedance-2.5-stable-b3-480p': 0.78,
};

function videoDir(config) {
  const custom = String(config.videoDir || '').trim();
  if (custom) return custom.startsWith('~') ? join(homedir(), custom.slice(1)) : custom;
  const desk = desktopDir();
  return desk ? join(desk, 'HSDvideo') : join(homeDir(config), 'videos');
}

function estimateVideoCost(model, seconds) {
  if (VIDEO_PRICE[model]) return { known: true, amount: VIDEO_PRICE[model], basis: 'per-clip', currency: 'CNY' };
  if (VIDEO_PER_SECOND[model]) return { known: true, amount: Number((VIDEO_PER_SECOND[model] * (Number(seconds) || 5)).toFixed(3)), basis: 'per-second', currency: 'CNY' };
  return { known: false };
}

function pickVideoUrl(body) {
  if (!body) return '';
  const d = body.data || body.result || body.output || body;
  const cands = [
    d.video_url, d.url, d.output, d.file_url, d.download_url,
    d.video && d.video.url, d.video && d.video.video_url,
    Array.isArray(d.videos) && d.videos[0] && (d.videos[0].url || d.videos[0].video_url),
  ];
  for (const c of cands) if (typeof c === 'string' && /^https?:\/\//.test(c)) return c;
  return '';
}

function videoStatus(body) {
  const d = (body && (body.data || body)) || {};
  const s = String(d.status || d.state || body.status || '').toLowerCase();
  if (['completed', 'succeeded', 'success', 'done', 'finished'].includes(s)) return 'done';
  if (['failed', 'error', 'canceled', 'cancelled'].includes(s)) return 'failed';
  return 'pending';
}

async function saveVideoFile(config, url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`下载视频失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = videoDir(config);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const path = join(dir, `vid-${stamp}-${Math.random().toString(36).slice(2, 6)}.mp4`);
  writeFileSync(path, buf);
  return { path, bytes: buf.length };
}

async function runVideo(config, input) {
  const store = readStore(config);
  const providerId = String(input.providerId || store.defaultProvider || '');
  const provider = store.providers.find((p) => p.id === providerId) || store.providers[0];
  if (!provider) throw new Error('还没有配置供应商');
  if (!String(provider.key || '').trim()) throw new Error('这个供应商还没有填 API Key');
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('提示词不能为空');
  const model = String(input.model || VIDEO_MODELS[0]);
  const seconds = Math.min(30, Math.max(4, Math.round(Number(input.seconds) || 5)));
  const resolution = String(input.resolution || '720p');
  const images = Array.isArray(input.images) ? input.images.filter(Boolean).slice(0, 10) : [];
  const base = baseName(provider);
  const headers = Object.assign({ 'content-type': 'application/json' }, authHeaders(provider));
  const started = Date.now();
  const payload = { model, prompt, seconds, resolution };
  if (images.length) payload.images = images;
  const created = await jsonFetch(`${base}/videos`, { method: 'POST', headers, body: JSON.stringify(payload) }, 180000);
  const id = created && (created.id || (created.data && created.data.id) || created.task_id || (created.data && created.data.task_id));
  if (!id) throw new Error('接口没有返回任务 id：' + JSON.stringify(created).slice(0, 300));
  const deadline = Date.now() + Math.max(60000, Number(config.timeoutMs) || 900000);
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    last = await jsonFetch(`${base}/videos/${id}`, { method: 'GET', headers: authHeaders(provider) }, 120000);
    const st = videoStatus(last);
    if (st === 'failed') throw new Error('生成失败：' + JSON.stringify(last).slice(0, 300));
    if (st === 'done') {
      const url = pickVideoUrl(last);
      if (!url) throw new Error('任务完成但没有视频地址：' + JSON.stringify(last).slice(0, 300));
      const file = await saveVideoFile(config, url);
      const cost = estimateVideoCost(model, seconds);
      if (cost.known) appendUsage(config, { t: new Date().toISOString(), providerId: provider.id, model, size: resolution, mode: 'video', n: 1, unit: cost.amount, amount: cost.amount, currency: 'CNY', ms: Date.now() - started });
      return { ok: true, providerId: provider.id, model, taskId: id, path: file.path, bytes: file.bytes, ms: Date.now() - started, cost, remoteUrl: url };
    }
  }
  throw new Error('等待超时，任务仍在跑：id=' + id);
}

function pickImages(body) {
  const out = [];
  const data = body && (body.data || body.images);
  if (!Array.isArray(data)) return out;
  for (const item of data) {
    if (typeof item === 'string') { out.push({ url: item }); continue; }
    if (!item) continue;
    if (item.b64_json) out.push({ b64: item.b64_json });
    else if (item.url) out.push({ url: item.url });
    else if (item.image_url) out.push({ url: item.image_url });
  }
  return out;
}

async function saveImages(config, provider, images, prompt) {
  const dir = outputsDir(config);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const out = [];
  for (let i = 0; i < images.length; i += 1) {
    const img = images[i];
    let buf = null;
    let mime = 'image/png';
    if (img.b64) {
      buf = b64ToBuffer(img.b64);
    } else if (img.url) {
      try {
        const r = await fetch(img.url, { signal: AbortSignal.timeout(120000) });
        if (!r.ok) throw new Error(`下载图片失败 HTTP ${r.status}`);
        mime = r.headers.get('content-type') || mime;
        buf = Buffer.from(await r.arrayBuffer());
      } catch (e) {
        out.push({ savedPath: '', dataUrl: img.url, error: String(e && e.message || e), remote: true });
        continue;
      }
    }
    if (!buf || !buf.length) {
      out.push({ savedPath: '', dataUrl: img.url || '', error: '空图片数据', remote: !!img.url });
      continue;
    }
    const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
    const file = join(dir, `img-${stamp}-${i + 1}.${ext}`);
    writeFileSync(file, buf);
    const dataUrl = buf.length <= 12 * 1024 * 1024 ? `data:${mime};base64,${buf.toString('base64')}` : '';
    out.push({ savedPath: file, dataUrl, bytes: buf.length, remote: false });
  }
  return out;
}

async function openaiGenerate(config, provider, opts) {
  const url = `${baseName(provider)}/images/generations`;
  const payload = { model: opts.model, prompt: opts.prompt, n: opts.n || 1, response_format: 'b64_json' };
  if (opts.size && opts.size !== 'auto') payload.size = opts.size;
  if (opts.quality && opts.quality !== 'auto') payload.quality = opts.quality;
  if (opts.transparent) payload.background = 'transparent';
  try {
    return await jsonFetch(url, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, authHeaders(provider)),
      body: JSON.stringify(payload),
    }, config.timeoutMs);
  } catch (e) {
    // 有些中转不支持 response_format，去掉再试一次
    if (e.status && e.status >= 400 && e.status < 500 && /response_format|unrecognized|unknown/i.test(String(e.message))) {
      delete payload.response_format;
      return jsonFetch(url, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, authHeaders(provider)),
        body: JSON.stringify(payload),
      }, config.timeoutMs);
    }
    throw e;
  }
}

async function openaiEdit(config, provider, opts) {
  const base = baseName(provider);
  const mode = provider.editMode === 'json' || provider.editMode === 'multipart' ? provider.editMode : 'auto';
  const attemptMultipart = mode !== 'json';
  if (attemptMultipart) {
    try {
      const fd = new FormData();
      fd.append('model', String(opts.model));
      fd.append('prompt', String(opts.prompt));
      fd.append('n', String(opts.n || 1));
      fd.append('response_format', 'b64_json');
      if (opts.size && opts.size !== 'auto') fd.append('size', String(opts.size));
      if (opts.quality && opts.quality !== 'auto') fd.append('quality', String(opts.quality));
      (opts.images || []).forEach((d, i) => fd.append('image[]', toBlob(d), `image-${i + 1}.png`));
      if (opts.mask) fd.append('mask', toBlob(opts.mask), 'mask.png');
      return await jsonFetch(`${base}/images/edits`, {
        method: 'POST',
        headers: authHeaders(provider),
        body: fd,
      }, config.timeoutMs);
    } catch (e) {
      if (mode === 'multipart') throw e;
      if (!e.status || e.status >= 500) throw e;
      // 落到 JSON 分支
    }
  }
  const payload = {
    model: opts.model,
    prompt: opts.prompt,
    n: opts.n || 1,
    response_format: 'b64_json',
    images: (opts.images || []).map((image_url) => ({ image_url })),
  };
  if (opts.size && opts.size !== 'auto') payload.size = opts.size;
  if (opts.quality && opts.quality !== 'auto') payload.quality = opts.quality;
  if (opts.mask) payload.mask = { image_url: opts.mask };
  return jsonFetch(`${base}/images/edits`, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, authHeaders(provider)),
    body: JSON.stringify(payload),
  }, config.timeoutMs);
}

async function geminiGenerate(config, provider, opts) {
  const base = baseName(provider);
  const parts = [{ text: String(opts.prompt || '') }];
  for (const d of opts.images || []) {
    parts.push({ inline_data: { mime_type: mimeOf(d), data: String(d).replace(/^data:[^;]+;base64,/, '') } });
  }
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };
  const out = await jsonFetch(`${base}/models/${encodeURIComponent(opts.model)}:generateContent`, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, authHeaders(provider)),
    body: JSON.stringify(body),
  }, config.timeoutMs);
  const images = [];
  const cands = (out && out.candidates) || [];
  for (const c of cands) {
    const ps = (c && c.content && c.content.parts) || [];
    for (const p of ps) {
      const inline = p.inlineData || p.inline_data;
      if (inline && inline.data) images.push({ b64: inline.data });
    }
  }
  return { data: images.map((i) => ({ b64_json: i.b64 })), _gemini: true };
}

/* ------------------------------- 主流程 ------------------------------- */

async function runGenerate(config, input) {
  const store = readStore(config);
  const providerId = String(input.providerId || store.defaultProvider || '');
  const provider = store.providers.find((p) => p.id === providerId) || store.providers[0];
  if (!provider) throw new Error('还没有配置供应商：请到「生图 → 接口设置」添加地址与 Key');
  if (!String(provider.key || '').trim()) throw new Error('这个供应商还没有填 API Key（设置页 → 生图 → 填 Key）');
  if (!provider.baseUrl) throw new Error('这个供应商还没有填接口地址');
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('提示词不能为空');
  const model = String(input.model || '').trim() || 'gpt-image-2';
  const images = Array.isArray(input.images) ? input.images.filter(Boolean) : [];
  const mask = input.mask || null;
  if (images.some((d) => String(d).length > MAX_BODY_LIMIT_HINT)) throw new Error('参考图太大（单张上限 50MB）');
  const opts = { model, prompt, size: input.size || 'auto', quality: input.quality || 'auto', n: Math.min(4, Math.max(1, Number(input.n) || 1)), images, mask, transparent: !!input.transparent };
  const started = Date.now();
  const raw = provider.protocol === 'gemini'
    ? await geminiGenerate(config, provider, opts)
    : (images.length ? await openaiEdit(config, provider, opts) : await openaiGenerate(config, provider, opts));
  const picked = pickImages(raw);
  if (!picked.length) {
    const hint = raw && raw.raw ? String(raw.raw).slice(0, 300) : JSON.stringify(raw || {}).slice(0, 300);
    throw new Error(`接口没返回图片：${hint}`);
  }
  const files = await saveImages(config, provider, picked, prompt);
  const ms = Date.now() - started;
  const cost = estimateCost(provider, model, opts.size, files.length);
  if (cost.known) {
    appendUsage(config, {
      t: new Date().toISOString(),
      providerId: provider.id,
      model,
      size: opts.size,
      mode: images.length ? 'edit' : 'generate',
      n: files.length,
      unit: cost.unit,
      amount: cost.amount,
      currency: cost.currency,
      ms,
    });
  }
  return {
    ok: true,
    providerId: provider.id,
    model,
    mode: images.length ? 'edit' : 'generate',
    ms,
    images: files,
    cost,
  };
}

async function listModels(config, input) {
  const store = readStore(config);
  const provider = store.providers.find((p) => p.id === String(input.providerId || '')) || store.providers[0];
  if (!provider) throw new Error('还没有配置供应商');
  const out = await jsonFetch(`${baseName(provider)}/models`, { method: 'GET', headers: authHeaders(provider) }, Math.min(60000, config.timeoutMs || 60000));
  const ids = Array.isArray(out && out.data) ? out.data.map((m) => m.id || m.name).filter(Boolean) : [];
  const imageModels = ids.filter((id) => IMAGE_HINT.test(id));
  return { ok: true, total: ids.length, models: imageModels.length ? imageModels : ids.slice(0, 80) };
}

/* ------------------------------- 插件入口 ------------------------------- */

export function apply(ctx, config) {
  const reply = (obj) => Response.json(obj);

  const handle = (fn) => async (request) => {
    try {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      return reply(await fn(body || {}));
    } catch (e) {
      return reply({ ok: false, error: String((e && e.message) || e) });
    }
  };

  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/image-studio/state',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handle(async () => {
        const store = readStore(config);
        return {
          ok: true,
          showTab: store.showTab,
          videoTab: !!store.videoTab,
          floatButton: !!store.floatButton,
          defaultProvider: store.defaultProvider,
          providers: store.providers.map(publicProvider),
          outputDir: outputsDir(config),
        };
      }),
    }), 'image-studio:state');

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/image-studio/usage',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handle(async (body) => Object.assign({ ok: true }, readUsage(config, Number(body && body.limit) || 20))),
    }), 'image-studio:usage');

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/image-studio/prefs',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handle(async (body) => {
        const store = readStore(config);
        if (typeof body.showTab === 'boolean') store.showTab = body.showTab;
        if (typeof body.videoTab === 'boolean') store.videoTab = body.videoTab;
        if (typeof body.floatButton === 'boolean') store.floatButton = body.floatButton;
        if (typeof body.defaultProvider === 'string' && body.defaultProvider) store.defaultProvider = body.defaultProvider;
        writeStore(config, store);
        return { ok: true, showTab: store.showTab, videoTab: store.videoTab, floatButton: store.floatButton, defaultProvider: store.defaultProvider };
      }),
    }), 'image-studio:prefs');

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/image-studio/provider/save',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handle(async (body) => {
        const store = readStore(config);
        const input = body.provider || {};
        const id = String(input.id || '').trim() || `p${Date.now().toString(36)}`;
        const idx = store.providers.findIndex((p) => p.id === id);
        const prev = idx >= 0 ? store.providers[idx] : { key: '', models: [] };
        const key = typeof input.key === 'string' && input.key.trim() ? input.key.trim() : prev.key;
        const next = {
          id,
          label: String(input.label || prev.label || id),
          baseUrl: String(input.baseUrl || prev.baseUrl || ''),
          protocol: input.protocol === 'gemini' ? 'gemini' : 'openai',
          editMode: input.editMode === 'json' || input.editMode === 'multipart' ? input.editMode : 'auto',
          key,
          models: Array.isArray(input.models) ? input.models : (prev.models || []),
          prices: normalisePrices(input.prices, prev.prices),
          currency: String(input.currency || prev.currency || 'CNY').slice(0, 8),
        };
        if (idx >= 0) store.providers[idx] = next; else store.providers.push(next);
        if (!store.defaultProvider || body.makeDefault) store.defaultProvider = id;
        writeStore(config, store);
        return { ok: true, provider: publicProvider(next), defaultProvider: store.defaultProvider };
      }),
    }), 'image-studio:provider-save');

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/image-studio/provider/remove',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handle(async (body) => {
        const store = readStore(config);
        const id = String(body.id || '');
        store.providers = store.providers.filter((p) => p.id !== id);
        if (!store.providers.length) store.providers = [Object.assign({}, PRESET_PROVIDER)];
        if (!store.providers.some((p) => p.id === store.defaultProvider)) store.defaultProvider = store.providers[0].id;
        writeStore(config, store);
        return { ok: true, providers: store.providers.map(publicProvider), defaultProvider: store.defaultProvider };
      }),
    }), 'image-studio:provider-remove');

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/image-studio/models',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handle((body) => listModels(config, body)),
    }), 'image-studio:models');

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/image-studio/generate',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handle((body) => runGenerate(config, body)),
    }), 'image-studio:generate');

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/image-studio/video/run',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handle((body) => runVideo(config, body)),
    }), 'image-studio:video-run');

    // 画布用的前端依赖（React Flow，已本地打包，不走 CDN）
    const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), 'vendor');
    const TYPES = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    for (const name of ['xyflow.global.js', 'xyflow.css']) {
      scope.effect(() => scope.connection.fetch.register({
        path: `/api/image-studio/vendor/${name}`,
        methods: ['GET'],
        fetch: async () => {
          const file = join(VENDOR_DIR, name);
          if (!existsSync(file)) return new Response('not bundled', { status: 404 });
          return new Response(readFileSync(file), {
            headers: { 'content-type': TYPES[name.slice(name.lastIndexOf('.'))] || 'application/octet-stream', 'cache-control': 'public, max-age=86400' },
          });
        },
      }), `image-studio:vendor-${name}`);
    }
  });
}
