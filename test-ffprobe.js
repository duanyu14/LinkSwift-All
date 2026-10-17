const http = require('http');

const token = process.argv[2];
if (!token) { console.error('usage: node test-ffprobe.js <token>'); process.exit(1); }

http.get(`http://127.0.0.1:7789/stream/${token}`, res => {
  console.log('Status:', res.statusCode);
  console.log('Headers:');
  for (const [k, v] of Object.entries(res.headers)) {
    console.log('  ' + k + ': ' + v);
  }
  // 只读一小段
  let n = 0;
  res.on('data', c => { n += c.length; if (n > 1024 * 1024) res.destroy(); });
  res.on('end', () => console.log('done, bytes:', n));
});