/**
 * LinkSwift 统一流媒体代理
 * 用途：监听 127.0.0.1:7789，流式代理网盘直链（百度/阿里/夸克/UC/迅雷/123/移动/天翼），供 PotPlayer 或浏览器 <video> 播放。
 * 启动：node stream-proxy.js
 * 环境变量：POTPLAYER 指定播放器路径（默认 D:\Pure Codec\x64\PotPlayerMini64.exe）。
 * 接口：POST /register → {token}；GET /launch?t= 拉起 PotPlayer；POST /play 兼容旧接口；GET /play?t= 网页播放；GET /stream/<token> 分段流；GET /health 健康检查。
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ============ 常量配置 ============
const PORT = 7789;
const HOST = '127.0.0.1';
const PLAYER_PATH = process.env.POTPLAYER || 'D:\\Pure Codec\\x64\\PotPlayerMini64.exe';

const CHUNK_SIZE = 4 * 1024 * 1024;   // 分块 4MB
const CONCURRENCY = 8;                 // 并发连接数
const CHUNK_TIMEOUT = 15000;           // 每块 15 秒超时
const MAX_RETRY = 3;                   // 每块最多尝试 3 次
const MAX_REDIRECTS = 3;               // 探测阶段最多跟随 3 跳上游重定向（百度 dlink 等常为中间跳转地址）
const TOKEN_TTL = 10 * 60 * 1000;      // token 有效期 10 分钟
const CLEAN_INTERVAL = 5 * 60 * 1000;  // 每 5 分钟清理过期 token

// keep-alive Agent：复用 socket，降低频繁建连开销与被 CDN 风控的概率
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });
// rejectUnauthorized 只在本 agent 关闭（网盘 CDN 证书链兼容），不再全局设置 NODE_TLS_REJECT_UNAUTHORIZED
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, rejectUnauthorized: false });

// ============ 统一日志（ISO 时间戳） ============
const log = (...args) => console.log(new Date().toISOString(), ...args);
const logErr = (...args) => console.error(new Date().toISOString(), ...args);

// ============ 全局兜底：打日志但不崩溃 ============
process.on('uncaughtException', (err) => logErr('全局捕获异常:', err.stack || err.message));
process.on('unhandledRejection', (reason) => logErr('未处理的 Promise 拒绝:', reason));

// ============ token 存储与过期清理 ============
const store = new Map(); // token -> { url, headers, filename, expires }

setInterval(() => {
  const now = Date.now();
  let n = 0;
  for (const [k, v] of store) {
    if (v.expires < now) { store.delete(k); n++; }
  }
  if (n) log(`清理过期 token ${n} 个，剩余 ${store.size} 个`);
}, CLEAN_INTERVAL).unref();

function registerItem({ url, headers, filename }) {
  if (!url) throw new Error('missing url');
  // new URL 做真正的合法性校验，比正则可靠
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('invalid url'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('unsupported url protocol');
  if (parsed.username || parsed.password) throw new Error('inline auth not allowed'); // 拒绝 http://user:pass@host 内联认证
  const token = crypto.randomBytes(8).toString('hex'); // 16 位十六进制随机 token
  store.set(token, { url, headers: headers || {}, filename: filename || '', expires: Date.now() + TOKEN_TTL });
  return token;
}

// ============ CORS：仅白名单来源可用 ============
// 允许 localhost / 127.0.0.1 / 各网盘域名；无 Origin 头（PotPlayer、curl 等本地进程）直接放行
const ALLOWED_ORIGIN = new RegExp(
  '^https?://' +
  '(' +
  '(localhost|127\\.0\\.0\\.1)(:\\d+)?' +
  '|([\\w-]+\\.)*' +
  '(baidu\\.com|alipan\\.com|aliyundrive\\.com|quark\\.cn|uc\\.cn|xunlei\\.com' +
  '|123pan\\.cn|123(pan|684|865|952|912)\\.com|139\\.com|189\\.cn)' +
  '(:\\d+)?' +
  ')$', 'i');

// 返回 false 表示来源不合法（已就地响应 403）
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!ALLOWED_ORIGIN.test(origin)) {
    logErr(`拒绝非法来源: ${origin} -> ${req.method} ${req.url}`);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden origin');
    return false;
  }
  res.setHeader('Access-Control-Allow-Origin', origin); // 回显具体 origin，不用 *
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return true;
}

// ============ 工具函数 ============

// 带 HTTP 状态码的错误，路由层统一用 e.status 回应
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 读取请求 JSON body（限制 1MB，防止滥用；超限只静默丢弃不再 destroy，保证还能正常回 413）
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      body += c;
      if (body.length > 1024 * 1024) tooLarge = true;
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'body too large'));
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
    // 客户端在 end 前提前断开：以 400 结束等待，避免 Promise 永久挂起
    req.on('close', () => {
      if (!req.complete) reject(new HttpError(400, 'request aborted'));
    });
  });
}

// HTML 转义：filename 来自 /register 请求体，防止注入播放页
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function text(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

// 拉起 PotPlayer 播放本地流地址
function launchPlayer(token, res) {
  if (!fs.existsSync(PLAYER_PATH)) {
    // 播放器不在：不 500，302 到网页播放器兜底
    log('播放器路径不存在，302 到网页播放页: ' + PLAYER_PATH);
    res.writeHead(302, { Location: `/play?t=${token}` });
    res.end();
    return;
  }
  const playUrl = `http://${HOST}:${PORT}/stream/${token}`;
  try {
    const child = spawn(PLAYER_PATH, ['/new', playUrl], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', (e) => {
      logErr('拉起播放器失败:', e.message);
      if (!res.headersSent) json(res, 500, { ok: false, error: String(e.message) });
    });
    child.once('spawn', () => {
      child.unref();
      log(`[launch] PotPlayer <- ${playUrl}`);
      if (!res.headersSent) json(res, 200, { ok: true, url: playUrl });
    });
  } catch (e) {
    json(res, 500, { ok: false, error: String(e) });
  }
}

// ============ 网页播放页 ============
function playPage(token, filename, res) {
  const page = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escHtml(filename) || 'LinkSwift 播放器'}</title>
<style>html,body{margin:0;height:100%;background:#000}video{width:100vw;height:100vh;display:block}
.msg{color:#fff;font-family:sans-serif;padding:20px}</style>
</head><body>
${token
  ? '<video id="v" controls autoplay playsinline></video>'
  : '<div class="msg">缺少 token 参数，请先调用 /register 注册直链</div>'}
<script>
  const t = ${JSON.stringify(token)};
  if (t) {
    const v = document.getElementById('v');
    v.src = '/stream/' + t;
    v.addEventListener('error', () => {
      document.body.innerHTML = '<div class="msg">播放失败：直链可能已过期（token 有效期 10 分钟）或请求头不正确。<br>请回到原页面重新点击播放获取新链接。</div>';
    });
  }
</script>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(page) });
  res.end(page);
}

// ============ 分块并发流式代理 ============

// 带超时与重试的单块下载：失败重试最多 MAX_RETRY 次
// activeReqs：本次响应私有的在途上游请求集合，客户端中断时统一 destroy，避免拖拽后旧请求继续占带宽
function fetchChunk(client, baseOpts, cs, ce, activeReqs) {
  const attempt = () => new Promise((resolve, reject) => {
    const r = client.request({ ...baseOpts, headers: { ...baseOpts.headers, Range: `bytes=${cs}-${ce}` }, timeout: CHUNK_TIMEOUT },
      (up) => {
        if (up.statusCode !== 206) {
          up.resume(); // 丢弃错误响应体，释放 socket
          reject(new Error(`块 ${cs}-${ce} 上游返回 ${up.statusCode}`));
          return;
        }
        const bufs = [];
        up.on('data', (d) => bufs.push(d));
        up.on('end', () => {
          const buf = Buffer.concat(bufs);
          // 校验块长度：上游截断（提前 EOF）时按错误重试，避免按序写出永久等待
          if (buf.length !== ce - cs + 1) reject(new Error(`块 ${cs}-${ce} 数据截断 ${buf.length}/${ce - cs + 1}`));
          else resolve(buf);
        });
        up.on('error', reject);
      });
    activeReqs.add(r);
    r.on('close', () => activeReqs.delete(r)); // 成功/失败/销毁都会触发 close
    r.on('timeout', () => r.destroy(new Error(`块 ${cs}-${ce} 超时 ${CHUNK_TIMEOUT}ms`)));
    r.on('error', reject);
    r.end();
  });

  return (async () => {
    let lastErr;
    for (let i = 1; i <= MAX_RETRY; i++) {
      try { return await attempt(); }
      catch (e) {
        lastErr = e;
        log(`块 ${cs}-${ce} 下载失败 (${e.message})，第 ${i}/${MAX_RETRY} 次`);
        if (i < MAX_RETRY) await new Promise((r) => setTimeout(r, 1000 * i)); // 线性退避
      }
    }
    throw lastErr;
  })();
}

async function handleStream(req, res, item, token) {
  item.expires = Date.now() + TOKEN_TTL; // 命中即续期：长视频播一半后拖拽进度条不会因 token 过期 404
  const baseHeaders = { ...item.headers };
  const clientFor = (t) => t.protocol === 'https:' ? https : http;
  const optsFor = (t) => ({
    method: 'GET',
    hostname: t.hostname,
    port: t.port || (t.protocol === 'https:' ? 443 : 80),
    path: t.pathname + t.search,
    headers: baseHeaders,
    agent: t.protocol === 'https:' ? httpsAgent : httpAgent,
    timeout: CHUNK_TIMEOUT
  });
  let target = new URL(item.url);

  // 1. 探测：GET Range:0-0，拿总长度 + content-type + 是否支持 Range；上游 3xx 最多跟随 MAX_REDIRECTS 跳
  //    （百度 dlink 等直链常为中间跳转地址，Node client 默认不跟随重定向，需在此显式处理）
  let probe = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      probe = await new Promise((resolve, reject) => {
        const r = clientFor(target).request({ ...optsFor(target), headers: { ...baseHeaders, Range: 'bytes=0-0' } }, resolve);
        r.on('timeout', () => r.destroy(new Error('探测超时')));
        r.on('error', reject);
        r.end();
      });
    } catch (e) {
      logErr(`[stream ${token}] 探测失败:`, e.message);
      json(res, 502, { ok: false, error: 'upstream probe failed: ' + e.message });
      return;
    }
    const loc = probe.headers.location;
    if (probe.statusCode >= 300 && probe.statusCode < 400 && loc) {
      probe.resume(); // 消费重定向响应体
      if (hop === MAX_REDIRECTS) {
        // 超过跳数上限：body 带最终 location，避免黑盒失败，也便于脚本提示刷新直链
        logErr(`[stream ${token}] 上游重定向超过 ${MAX_REDIRECTS} 跳`);
        json(res, 502, { ok: false, reason: 'upstream_redirect', error: `upstream ${probe.statusCode} redirect exceeds ${MAX_REDIRECTS} hops`, location: new URL(loc, target.href).href });
        return;
      }
      try {
        target = new URL(loc, target.href);
      } catch {
        json(res, 502, { ok: false, error: 'bad redirect location' });
        return;
      }
      log(`[stream ${token}] 跟随上游重定向 ${hop + 1} -> ${target.href.slice(0, 100)}`);
      continue;
    }
    break;
  }
  const client = clientFor(target);
  const baseOpts = optsFor(target); // 后续分块一律用重定向后的最终地址

  const contentType = probe.headers['content-type'] || 'application/octet-stream';
  const cr = probe.headers['content-range']; // 形如 bytes 0-0/12345678
  const total = cr ? parseInt(cr.split('/')[1], 10) : NaN;
  const rangeOk = probe.statusCode === 206 && Number.isFinite(total) && total > 0;

  // 2. 上游错误状态（>=400）或非 200/206 的意外响应：直接 502，不透传错误 body
  if (!rangeOk && probe.statusCode !== 200) {
    logErr(`[stream ${token}] 上游返回 ${probe.statusCode}`);
    probe.resume(); // 消费掉错误响应体，socket 归还 keep-alive 池
    json(res, 502, { ok: false, error: `upstream ${probe.statusCode}` });
    return;
  }

  // 3. 不支持 Range（200）：整段透传，不再分块
  if (!rangeOk) {
    log(`[stream ${token}] 上游不支持 Range，回退 200 整段透传`);
    const len = probe.headers['content-length'];
    res.writeHead(200, {
      'Content-Type': contentType,
      ...(len ? { 'Content-Length': len } : {}),
      'Accept-Ranges': 'none'
    });
    probe.on('error', () => { if (!res.writableEnded && !res.destroyed) res.destroy(); });
    probe.pipe(res);
    // req 'aborted' 在 Node 17+ 已废弃。这里只看 writableEnded：客户端中断时 res 会被 socket 关闭连带销毁，
    // destroyed 守卫会漏判；pipe 正常完成时 end() 自动置 writableEnded，可正确跳过
    req.once('close', () => {
      if (!res.writableEnded) probe.destroy();
    });
    return;
  }

  // 消费探测到的 1 字节 body，让 socket 自然归还 keep-alive 池供后续分块复用
  probe.on('error', () => {});
  probe.resume();

  // 4. 解析客户端请求区间
  const m = (req.headers.range || '').match(/bytes=(\d+)-(\d*)/);
  const start = m ? parseInt(m[1], 10) : 0;
  let end = (m && m[2]) ? parseInt(m[2], 10) : total - 1;
  // RFC 7233：开区间上界超出总长时截断到 total-1，仍返回 206；仅起点越界或截断后 start>end 才 416
  if (end >= total) end = total - 1;
  if (start >= total || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    res.end();
    return;
  }

  res.writeHead(206, {
    'Content-Type': contentType, // 取源站 content-type，而非写死 video/mp4
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Accept-Ranges': 'bytes'
  });

  // 5. 多连接并发分块 + 按序写出
  const state = { stopped: false };
  const inflight = new Map(); // chunkStart -> Promise<Buffer>
  const activeReqs = new Set(); // 本次响应私有的在途上游请求（不影响其他并发流）
  let alloc = start; // 已分配的偏移

  // 客户端中断（拖拽进度条/关闭播放器）：取消全部在途分块，释放带宽并避免 CDN 频控
  // 不能用 res.destroyed 做守卫：客户端断开时 socket 关闭会先销毁 res，close 回调里 destroyed 恒为 true，中断会被漏判。
  // writableEnded 区分正常完成；state.stopped 区分 catch 分支已主动销毁响应的情况（避免重复日志）
  req.once('close', () => {
    if (res.writableEnded || state.stopped) return;
    state.stopped = true;
    const n = activeReqs.size;
    inflight.clear();
    for (const r of activeReqs) r.destroy(new Error('client aborted'));
    activeReqs.clear();
    log(`[stream ${token}] 客户端中断，已取消 ${n} 个在途上游请求`);
  });

  try {
    while (alloc <= end && !state.stopped) {
      const cs = alloc;
      const ce = Math.min(alloc + CHUNK_SIZE - 1, end);
      alloc = ce + 1;
      // 预取下一个块（并发上限 CONCURRENCY）：inflight 按插入序即偏移序，最小 key 即队头
      inflight.set(cs, fetchChunk(client, baseOpts, cs, ce, activeReqs));
      if (inflight.size >= CONCURRENCY) {
        const minStart = Math.min(...inflight.keys());
        const buf = await inflight.get(minStart);
        inflight.delete(minStart);
        if (state.stopped) break;
        if (res.writable && !res.write(buf)) {
          await new Promise((r) => {
            const done = () => { res.off('drain', done); res.off('close', done); r(); };
            res.on('drain', done);
            res.on('close', done);
          });
        }
      }
    }
    // 排空剩余在途块
    const keys = [...inflight.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      if (state.stopped) break;
      const buf = await inflight.get(k);
      inflight.delete(k);
      if (res.writable && !res.write(buf)) {
        await new Promise((r) => {
          const done = () => { res.off('drain', done); res.off('close', done); r(); };
          res.on('drain', done);
          res.on('close', done);
        });
      }
    }
    if (!state.stopped && !res.writableEnded) res.end();
  } catch (e) {
    if (state.stopped) return; // 客户端中断引发的取消错误，属预期
    // 重试仍失败：中断响应
    logErr(`[stream ${token}] 分块彻底失败，中断响应:`, e.message);
    state.stopped = true;
    inflight.clear();
    for (const r of activeReqs) r.destroy(new Error('give up'));
    activeReqs.clear();
    res.destroy();
  }
}

// ============ HTTP 服务 ============
async function route(req, res) {
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || HOST}`);
  } catch {
    text(res, 400, 'bad request');
    return;
  }

  if (!applyCors(req, res)) return;
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 健康检查
  if (u.pathname === '/health' && req.method === 'GET') {
    json(res, 200, { ok: true });
    return;
  }

  // 新接口：注册直链 → token
  if (u.pathname === '/register' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const token = registerItem(body);
      log(`[register] ${token} <- ${String(body.url).slice(0, 80)}`);
      json(res, 200, { token });
    } catch (e) {
      text(res, e.status || 400, String(e.message || e));
    }
    return;
  }

  // 兼容接口：POST /play = 注册 + 拉起播放器。
  // 调用方是 GM_xmlhttpRequest（会自动跟随 302），播放器缺失时必须返回 JSON 而非 302，否则脚本误判结果
  if (u.pathname === '/play' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const token = registerItem(body);
      log(`[play] ${token} <- ${String(body.url).slice(0, 80)}`);
      if (!fs.existsSync(PLAYER_PATH)) {
        logErr(`播放器路径不存在: ${PLAYER_PATH}，返回 player_missing 供脚本改用网页播放`);
        json(res, 200, { ok: false, reason: 'player_missing', playUrl: `http://${HOST}:${PORT}/play?t=${token}` });
        return;
      }
      launchPlayer(token, res);
    } catch (e) {
      json(res, e.status || 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  // 拉起播放器（浏览器直接导航，302 到网页播放页是合理兜底）
  if (u.pathname === '/launch' && req.method === 'GET') {
    const t = u.searchParams.get('t') || '';
    const item = store.get(t);
    if (!item) { text(res, 404, 'token 不存在或已过期'); return; }
    item.expires = Date.now() + TOKEN_TTL; // 与 /stream 同步续期，避免拉起后拖拽 404
    launchPlayer(t, res);
    return;
  }

  // 网页播放页
  if (u.pathname === '/play' && req.method === 'GET') {
    const t = u.searchParams.get('t') || '';
    const item = t ? store.get(t) : null;
    if (t && !item) { text(res, 404, 'token 不存在或已过期'); return; }
    playPage(t, item && item.filename, res);
    return;
  }

  // 流式代理
  if (u.pathname.startsWith('/stream/')) {
    const token = u.pathname.slice('/stream/'.length);
    const item = store.get(token);
    if (!item) { text(res, 404, 'token 不存在或已过期'); return; }
    if (res.socket) res.socket.setNoDelay(true);
    await handleStream(req, res, item, token);
    return;
  }

  text(res, 404, '404');
}

// 顶层兜底：handleStream 之前的任何异常（如 new URL(item.url) 抛错）都要有响应，不能让客户端挂起
const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    logErr('请求处理异常:', e.stack || e.message);
    if (!res.headersSent) text(res, 500, 'internal error');
    else { try { res.destroy(); } catch {} }
  });
});

server.listen(PORT, HOST, () => {
  log(`LinkSwift 统一代理已启动: http://${HOST}:${PORT}（播放器: ${PLAYER_PATH}）`);
});

server.on('error', (e) => {
  logErr('监听失败:', e.message);
  if (e.code === 'EADDRINUSE') process.exit(1); // 端口占用不假装成功
});
