// 临时自测脚本：验证 stream-proxy.js 核心路径（测完可删）
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PROXY_PORT = 7789;
const ORIGIN_PORT = 7790;
const FILE = Buffer.alloc(3 * 1024 * 1024 + 1234, 7); // 3MB+1234B 测试数据

// --- 假源站：/range 支持 Range；/flat 不支持 Range ---
const origin = http.createServer((req, res) => {
  if (req.url === '/range') {
    const m = (req.headers.range || '').match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const s = parseInt(m[1], 10);
      const e = m[2] ? parseInt(m[2], 10) : FILE.length - 1;
      res.writeHead(206, {
        'Content-Type': 'video/x-matroska', // 故意非 mp4，验证透传
        'Content-Range': `bytes ${s}-${e}/${FILE.length}`
      });
      res.end(FILE.subarray(s, e + 1));
    } else {
      res.writeHead(200, { 'Content-Type': 'video/x-matroska' });
      res.end(FILE);
    }
  } else if (req.url === '/flat') {
    res.writeHead(200, { 'Content-Type': 'video/ogg', 'Content-Length': FILE.length });
    let i = 0;
    const t = setInterval(() => {
      res.write(FILE.subarray(i, i + 65536));
      i += 65536;
      if (i >= FILE.length) { clearInterval(t); res.end(); }
    }, 1);
  } else if (req.url === '/redir1') {
    res.writeHead(302, { Location: '/redir2' }); res.end(); // 模拟直链中间跳转
  } else if (req.url === '/redir2') {
    res.writeHead(302, { Location: '/range' }); res.end();
  } else if (req.url === '/loop') {
    res.writeHead(302, { Location: '/loop' }); res.end();  // 模拟无限重定向
  } else {
    res.writeHead(404); res.end('not found'); // 模拟上游错误状态
  }
});

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PROXY_PORT, method, path, headers }, (res) => {
      const bufs = [];
      res.on('data', d => bufs.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(bufs) }));
      res.on('error', reject);
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}

origin.listen(ORIGIN_PORT, '127.0.0.1', () => {
  const proxy = spawn(process.execPath, [path.join(__dirname, 'stream-proxy.js')], {
    env: { ...process.env, POTPLAYER: 'C:\\nonexistent\\potplayer.exe' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  proxy.stderr.on('data', d => console.error('[proxy-err]', String(d)));

  setTimeout(async () => {
    try {
      // 1. health
      const h = await req('GET', '/health');
      check('health', h.status === 200 && JSON.parse(h.buf).ok === true);

      // 2. CORS 拒绝
      const bad = await req('GET', '/health', { headers: { Origin: 'http://evil.example.com' } });
      check('CORS 403', bad.status === 403);
      const good = await req('GET', '/health', { headers: { Origin: 'https://pan.baidu.com' } });
      check('CORS 网盘放行', good.status === 200);

      // 3. register + Range 流（分块并发）
      const reg = await req('POST', '/register', {
        headers: { 'Content-Type': 'application/json', Origin: 'https://pan.quark.cn' },
        body: JSON.stringify({ url: `http://127.0.0.1:${ORIGIN_PORT}/range`, headers: { 'X-Test': 'cookie=abc' }, filename: 'a.mkv' })
      });
      check('register token', reg.status === 200 && /^[0-9a-f]{16}$/.test(JSON.parse(reg.buf).token));
      const token = JSON.parse(reg.buf).token;

      const full = await req('GET', `/stream/${token}`, { headers: { Range: 'bytes=1000-' } });
      check('206 status', full.status === 206, String(full.status));
      check('content-type 透传', full.headers['content-type'] === 'video/x-matroska', full.headers['content-type']);
      check('content-range', full.headers['content-range'] === `bytes 1000-${FILE.length - 1}/${FILE.length}`, full.headers['content-range']);
      check('数据完整且按序', full.buf.equals(FILE.subarray(1000)), `len=${full.buf.length}`);

      // 4. 416 越界
      const oob = await req('GET', `/stream/${token}`, { headers: { Range: `bytes=${FILE.length + 100}-` } });
      check('416 越界', oob.status === 416, String(oob.status));

      // 5. 不支持 Range 回退 200 透传
      const reg2 = await req('POST', '/register', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `http://127.0.0.1:${ORIGIN_PORT}/flat`, headers: {} })
      });
      const t2 = JSON.parse(reg2.buf).token;
      const flat = await req('GET', `/stream/${t2}`);
      check('回退 200', flat.status === 200, String(flat.status));
      check('Accept-Ranges none', flat.headers['accept-ranges'] === 'none', flat.headers['accept-ranges']);
      check('回退 content-type', flat.headers['content-type'] === 'video/ogg', flat.headers['content-type']);
      check('回退数据完整', flat.buf.equals(FILE));

      // 6. POST /play 兼容接口：播放器缺失 → JSON player_missing（不能 302，XHR 会自动跟随导致误判）
      const play = await req('POST', '/play', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `http://127.0.0.1:${ORIGIN_PORT}/range`, headers: {}, filename: 'b.mkv' })
      });
      const playJson = JSON.parse(play.buf.toString());
      check('POST /play player_missing', play.status === 200 && playJson.ok === false && playJson.reason === 'player_missing' && /^http:\/\/127\.0\.0\.1:7789\/play\?t=[0-9a-f]{16}$/.test(playJson.playUrl), String(play.status) + ' ' + play.buf.toString());

      // 6b. GET /launch：浏览器导航场景，播放器缺失仍 302 到网页播放页
      const launch = await req('GET', `/launch?t=${token}`);
      check('GET /launch 302', launch.status === 302 && /\/play\?t=[0-9a-f]{16}$/.test(launch.headers.location), String(launch.status) + ' ' + launch.headers.location);

      // 6c. filename XSS：需被 HTML 转义
      const regXss = await req('POST', '/register', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `http://127.0.0.1:${ORIGIN_PORT}/range`, headers: {}, filename: '</title><script>alert(1)</script>' })
      });
      const tXss = JSON.parse(regXss.buf).token;
      const xssPage = await req('GET', `/play?t=${tXss}`);
      check('filename XSS 转义', xssPage.buf.includes('&lt;script&gt;') && !xssPage.buf.includes('</title><script>alert'), xssPage.buf.slice(0, 200));

      // 6d. 请求体超限 413（不 destroy socket，保证能正常回响应）
      const big = await req('POST', '/register', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://x/', headers: {}, pad: 'a'.repeat(2 * 1024 * 1024) })
      });
      check('body 超限 413', big.status === 413, String(big.status));

      // 6e. 123pan.cn 等新域名 Origin 应放行（油猴 @match 覆盖的页面域）
      const o123 = await req('GET', '/health', { headers: { Origin: 'https://www.123pan.cn' } });
      const o912 = await req('GET', '/health', { headers: { Origin: 'https://pan.123912.com' } });
      check('123pan.cn 放行', o123.status === 200 && o912.status === 200, String(o123.status) + '/' + String(o912.status));

      // 6f. 上游错误状态（404）→ 代理 502，不透传错误 body
      const reg404 = await req('POST', '/register', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `http://127.0.0.1:${ORIGIN_PORT}/missing`, headers: {} })
      });
      const t404 = JSON.parse(reg404.buf).token;
      const badUp = await req('GET', `/stream/${t404}`);
      check('上游 404 → 代理 502', badUp.status === 502 && !badUp.buf.includes('not found'), String(badUp.status) + ' ' + badUp.buf.toString());

      // 6g. 上游 3xx：探测跟随重定向（2 跳后到 /range），分块用最终地址
      const regRd = await req('POST', '/register', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `http://127.0.0.1:${ORIGIN_PORT}/redir1`, headers: {} })
      });
      const tRd = JSON.parse(regRd.buf).token;
      const rd = await req('GET', `/stream/${tRd}`, { headers: { Range: 'bytes=0-1023' } });
      check('3xx 跟随后正常 206', rd.status === 206 && rd.buf.equals(FILE.subarray(0, 1024)), String(rd.status) + ' len=' + rd.buf.length);

      // 6h. 无限重定向：超过 3 跳 → 502 + reason=upstream_redirect + location
      const regLoop = await req('POST', '/register', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `http://127.0.0.1:${ORIGIN_PORT}/loop`, headers: {} })
      });
      const tLoop = JSON.parse(regLoop.buf).token;
      const loop = await req('GET', `/stream/${tLoop}`);
      const loopJson = JSON.parse(loop.buf.toString());
      check('重定向超限 502+location', loop.status === 502 && loopJson.reason === 'upstream_redirect' && /\/loop$/.test(loopJson.location || ''), String(loop.status) + ' ' + loop.buf.toString());

      // 6i. 内联认证 URL 拒绝
      const authReg = await req('POST', '/register', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://user:pass@127.0.0.1:7790/range', headers: {} })
      });
      check('inline auth 拒绝', authReg.status === 400 && authReg.buf.includes('inline auth'), String(authReg.status) + ' ' + authReg.buf.toString());

      // 7. GET /play 网页
      const page = await req('GET', `/play?t=${token}`);
      check('播放页含 video', page.status === 200 && page.buf.includes('<video') && page.buf.includes(`"${token}"`), page.buf.slice(0, 120));

      // 8. 过期/无效 token
      const none = await req('GET', '/stream/deadbeefdeadbeef');
      check('无效 token 404', none.status === 404);

      // 9. OPTIONS 预检
      const pre = await new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port: PROXY_PORT, method: 'OPTIONS', path: '/register', headers: { Origin: 'https://www.alipan.com' } }, res => { res.resume(); res.on('end', () => resolve(res)); });
        r.on('error', reject); r.end();
      });
      check('OPTIONS 204', pre.statusCode === 204, String(pre.statusCode));
    } catch (e) {
      fail++; console.log('EXCEPTION', e);
    }
    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
    proxy.kill();
    origin.close();
    process.exit(fail ? 1 : 0);
  }, 800);
});
