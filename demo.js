/**
 * 多协议集群服务器 · 最小可运行 Demo（单文件 / 零依赖 / Node 18+）
 *
 *   保存为 demo.js，然后：
 *     node demo.js test      # 自检（帧编解码 + KCP + CRC）
 *     node demo.js server    # 启动服务端 TCP:9101 UDP:9201 KCP:9401
 *     node demo.js client    # 跑一遍客户端（需先起 server）
 *
 * 本文件是四套实现（Java/Go/Rust/Node）共同的协议基准，
 * 也是整个交付中唯一真实运行验证过的代码。
 */
'use strict';
const net = require('net'), dgram = require('dgram'), zlib = require('zlib');

/* ==================== 帧格式 ====================
 * ┌───────┬────────┬──────┬─────┬─────┬───────┬────────┬──────┐
 * │magic2B│version1│flags1│cmd4B│seq8B│length4│payloadN│crc32 4│
 * └───────┴────────┴──────┴─────┴─────┴───────┴────────┴──────┘
 *              头部固定 20B                        尾部
 * magic=0x4D50, 大端序, crc32 覆盖 [2, 20+len)
 * ============================================================= */
const MAGIC = 0x4D50, HDR = 20, VER = 1, CRC = 4, MAXP = 1 << 20;
const F_RESP = 0x01;
const CMD_PUT = 1, CMD_GET = 2, CMD_ROUTE_SET = 3, CMD_ROUTE_GET = 4, CMD_PING = 5, CMD_STATS = 6;
const OK = 0, BAD = 2;
const CMDS = { 1: 'PUT', 2: 'GET', 3: 'ROUTE_SET', 4: 'ROUTE_GET', 5: 'PING', 6: 'STATS' };
const cname = (c) => CMDS[c] || `CMD${c}`;

const TAB = (() => { const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = TAB[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0; };

class Short extends Error {}
class BadFrame extends Error {}

function encode(f) {
  const p = f.payload ? Buffer.from(f.payload) : Buffer.alloc(0);
  if (p.length > MAXP) throw new Error('payload 超限');
  const b = Buffer.alloc(HDR + p.length + CRC);
  b.writeUInt16BE(MAGIC, 0); b.writeUInt8(VER, 2); b.writeUInt8(f.flags | 0, 3);
  b.writeInt32BE(f.cmd, 4); b.writeBigInt64BE(BigInt(f.seq), 8);
  b.writeUInt32BE(p.length, 16); p.copy(b, HDR);
  b.writeUInt32BE(crc32(b.subarray(2, HDR + p.length)), HDR + p.length);
  return b;
}
function tryDecode(buf) {
  if (buf.length < HDR) throw new Short();
  if (buf.readUInt16BE(0) !== MAGIC) throw new BadFrame('magic 错');
  const len = buf.readUInt32BE(16);
  if (len > MAXP) throw new BadFrame('length 非法');
  const tot = HDR + len + CRC;
  if (buf.length < tot) throw new Short();
  const want = buf.readUInt32BE(HDR + len);
  const got = crc32(buf.subarray(2, HDR + len));
  if (want !== got) throw new BadFrame('CRC 错');
  return { frame: { flags: buf.readUInt8(3), cmd: buf.readInt32BE(4),
    seq: Number(buf.readBigInt64BE(8)), payload: Buffer.from(buf.subarray(HDR, HDR + len)) },
    consumed: tot };
}

/* ==================== KCP（可靠 UDP / ARQ）====================
 * 24B 头部，小端序：conv4 cmd1 frg1 wnd2 ts4 sn4 una4 len4
 * 用 10~20% 带宽换 30~40% 延迟降低；必须周期性 update 才有重传
 * ============================================================= */
const K_CMD_PUSH = 81, K_CMD_ACK = 82, K_CMD_WASK = 83, K_CMD_WINS = 84;
const K_OVR = 24, K_MTU = 1400, K_WNDR = 128, K_WNDS = 32;
const K_RTO_MIN = 30, K_RTO = 200, K_INT = 100, K_FAST = 3, K_MAXFRG = 255;
const u32 = (v) => v >>> 0;
const idiff = (a, b) => u32(a - b) | 0;

class Kcp {
  constructor(conv) {
    this.conv = conv >>> 0; this.mss = K_MTU - K_OVR;
    this.sndUna = this.sndNxt = this.rcvNxt = 0;
    this.rto = K_RTO; this.srtt = 0; this.rttval = 0; this.minRto = K_RTO_MIN;
    this.rmtWnd = K_WNDR; this.cwnd = 0; this.rcvWnd = K_WNDR;
    this.current = 0; this.tsFlush = 0; this.state = 0;
    this.sndBuf = []; this.rcvBuf = []; this.sndQ = []; this.rcvQ = []; this.acks = [];
    this.fastResend = K_FAST; this.deadLink = 20;
  }
  win() { const a = this.rcvWnd - this.rcvQ.length; return a < 0 ? 0 : a > 65535 ? 65535 : a; }
  input(d) {
    const oldUna = this.sndUna; let o = 0;
    while (d.length - o >= K_OVR) {
      const conv = d.readUInt32LE(o);
      if (conv !== this.conv) throw new Error('conv 不匹配');
      const cmd = d.readUInt8(o + 4), frg = d.readUInt8(o + 5);
      const wnd = d.readUInt16LE(o + 6), ts = d.readUInt32LE(o + 8);
      const sn = d.readUInt32LE(o + 12), una = d.readUInt32LE(o + 16);
      const len = d.readUInt32LE(o + 20);
      o += K_OVR;
      const data = Buffer.from(d.subarray(o, o + len)); o += len;
      this.rmtWnd = wnd;
      this.sndBuf = this.sndBuf.filter((s) => idiff(s.sn, una) >= 0);
      this.sndUna = una;
      if (cmd === K_CMD_PUSH) {
        if (idiff(sn, u32(this.rcvNxt + this.rcvWnd)) < 0) this.acks.push([sn, ts]);
        if (idiff(sn, this.rcvNxt) >= 0 && !this.rcvBuf.some((s) => s.sn === sn))
          this.rcvBuf.push({ sn, frg, ts, data });
      } else if (cmd === K_CMD_ACK) {
        if (idiff(sn, this.sndUna) < 0 || idiff(sn, this.sndNxt) >= 0) continue;
        const i = this.sndBuf.findIndex((s) => s.sn === sn);
        if (i >= 0) this.sndBuf.splice(i, 1);
        const rtt = idiff(this.current, ts);
        if (this.srtt === 0) { this.srtt = rtt; this.rttval = rtt >> 1; }
        else { const dd = Math.abs(rtt - this.srtt);
          this.rttval = (3 * this.rttval + dd) >> 2; this.srtt = (7 * this.srtt + rtt) >> 3; }
        this.rto = Math.max(this.minRto, this.srtt + Math.max(K_INT, 4 * this.rttval));
        this.sndUna = this.sndBuf.length ? this.sndBuf[0].sn : this.sndNxt;
      } else if (cmd === K_CMD_WASK) this.probe = 1;
      else if (cmd === K_CMD_WINS) this.rmtWnd = wnd;
      else throw new Error('未知命令 ' + cmd);
      this.rcvBuf.sort((a, b) => idiff(a.sn, b.sn));
      while (this.rcvBuf.length && this.rcvBuf[0].sn === this.rcvNxt
             && this.rcvQ.length < this.rcvWnd) {
        this.rcvQ.push(this.rcvBuf.shift()); this.rcvNxt = u32(this.rcvNxt + 1);
      }
    }
    if (idiff(this.sndUna, oldUna) > 0 && this.cwnd < this.rmtWnd) this.cwnd++;
    this.tsFlush = this.current;
  }
  recv() {
    if (this.rcvQ.length === 0) return null;
    let n = 0, ok = false;
    for (const s of this.rcvQ) { n++; if (s.frg === 0) { ok = true; break; } }
    if (!ok) return null;
    const out = Buffer.concat(this.rcvQ.slice(0, n).map((s) => s.data));
    this.rcvQ.splice(0, n); return out;
  }
  send(d) {
    let c = d.length === 0 ? 1 : Math.ceil(d.length / this.mss);
    if (c > K_MAXFRG) throw new Error('消息过大，分片 ' + c + ' > ' + K_MAXFRG);
    let o = 0;
    for (let i = 0; i < c; i++) {
      const sz = Math.min(this.mss, d.length - o);
      this.sndQ.push({ frg: c - 1 - i, data: Buffer.from(d.subarray(o, o + sz)) }); o += sz;
    }
  }
  seg(cmd, frg, wnd, ts, sn, una, data) {
    const b = Buffer.alloc(K_OVR + data.length);
    b.writeUInt32LE(this.conv, 0); b.writeUInt8(cmd, 4); b.writeUInt8(frg, 5);
    b.writeUInt16LE(wnd, 6); b.writeUInt32LE(ts >>> 0, 8);
    b.writeUInt32LE(sn >>> 0, 12); b.writeUInt32LE(una >>> 0, 16);
    b.writeUInt32LE(data.length, 20); data.copy(b, K_OVR); return b;
  }
  flush() {
    if (this.state) return Buffer.alloc(0);
    const cur = this.current, out = [];
    for (const [sn, ts] of this.acks)
      out.push(this.seg(K_CMD_ACK, 0, this.win(), ts, sn, this.rcvNxt, Buffer.alloc(0)));
    this.acks.length = 0;
    if (this.probe) { out.push(this.seg(K_CMD_WASK, 0, this.win(), 0, 0, this.rcvNxt, Buffer.alloc(0))); this.probe = 0; }
    let cw = this.cwnd === 0 ? u32(this.sndUna + 1) : u32(this.sndUna + this.cwnd);
    if (this.rmtWnd > 0 && idiff(u32(this.sndUna + this.rmtWnd), cw) < 0) cw = u32(this.sndUna + this.rmtWnd);
    while (this.sndQ.length && idiff(this.sndNxt, cw) < 0) {
      const s = this.sndQ.shift();
      s.cmd = K_CMD_PUSH; s.sn = this.sndNxt; this.sndNxt = u32(this.sndNxt + 1);
      s.una = this.rcvNxt; s.wnd = this.win(); s.ts = cur;
      s.rto = this.rto; s.resend = u32(cur + this.rto); s.fast = 0; s.xmit = 0;
      this.sndBuf.push(s);
    }
    for (const s of this.sndBuf) {
      let need = false;
      if (s.xmit === 0) { need = true; s.resend = u32(cur + s.rto); }
      else if (idiff(cur, s.resend) >= 0) { need = true;
        s.rto = Math.min(60000, s.rto + (s.rto >> 1)); s.resend = u32(cur + s.rto); }
      else if (s.fast >= this.fastResend) { need = true; s.fast = 0; s.resend = u32(cur + s.rto); }
      if (need) {
        s.ts = cur; s.wnd = this.win(); s.una = this.rcvNxt; s.xmit++;
        if (s.xmit >= this.deadLink) this.state = 1;
        out.push(this.seg(K_CMD_PUSH, s.frg, s.wnd, s.ts, s.sn, s.una, s.data));
      }
    }
    return out.length ? Buffer.concat(out) : Buffer.alloc(0);
  }
  update(ms) {
    this.current = u32(ms);
    if (this.tsFlush === 0) this.tsFlush = this.current;
    if (idiff(this.current, this.tsFlush) >= 0) { this.tsFlush = u32(this.current + K_INT); return this.flush(); }
    return Buffer.alloc(0);
  }
}

/* ==================== 状态机 ==================== */
const kv = new Map(), routes = new Map();
let nreq = 0;
function apply(cmd, s) {
  switch (cmd) {
    case CMD_PUT: { const i = s.indexOf('=');
      if (i < 0) return [BAD, 'PUT 需要 key=value'];
      kv.set(s.slice(0, i), s.slice(i + 1)); return [OK, 'stored ' + s.slice(0, i)]; }
    case CMD_GET: { const v = kv.get(s);
      return v === undefined ? [BAD, 'not found: ' + s] : [OK, v]; }
    case CMD_ROUTE_SET: { const i = s.indexOf('=');
      if (i < 0) return [BAD, 'ROUTE_SET 需要 shard=node'];
      routes.set(s.slice(0, i), s.slice(i + 1)); return [OK, `route ${s.slice(0, i)} -> ${s.slice(i + 1)}`]; }
    case CMD_ROUTE_GET: { const v = routes.get(s);
      return v === undefined ? [BAD, 'no route for ' + s] : [OK, v]; }
    case CMD_PING: return [OK, 'PONG'];
    case CMD_STATS: return [OK, `kv=${kv.size} routes=${routes.size} requests=${nreq}`];
    default: return [BAD, 'unknown cmd ' + cmd];
  }
}
function handle(f) {
  nreq++;
  const [code, body] = apply(f.cmd, f.payload ? f.payload.toString() : '');
  return { flags: 0, cmd: f.cmd, seq: f.seq,
    payload: Buffer.from((code === OK ? 'OK' : 'ERR') + (body ? '|' + body : '')) };
}
let seq = 0;
const mk = (cmd, payload) => ({ flags: F_RESP, cmd, seq: ++seq, payload: Buffer.from(payload || '') });

/* ==================== 服务端 ==================== */
function startTcp(port) {
  const s = net.createServer((sock) => {
    let acc = Buffer.alloc(0);
    sock.on('data', (c) => {
      acc = Buffer.concat([acc, c]);
      for (;;) {
        let r;
        try { r = tryDecode(acc); } catch (e) {
          if (e instanceof Short) break;
          console.error('[TCP] 协议错误', e.message); return sock.destroy();
        }
        acc = acc.subarray(r.consumed);
        if (r.frame.flags & F_RESP) sock.write(encode(handle(r.frame)));
      }
    });
    sock.on('error', () => {});
  });
  s.listen(port, () => console.log('[TCP] 监听 ' + port));
  return s;
}
function startUdp(port, tag) {
  const s = dgram.createSocket('udp4');
  s.on('message', (m, r) => {
    try { const { frame } = tryDecode(m);
      if (frame.flags & F_RESP) s.send(encode(handle(frame)), r.port, r.address);
    } catch (e) { console.error('[' + tag + ']', e.message); }
  });
  s.bind(port, () => console.log('[' + tag + '] 监听 ' + port));
  return s;
}
function startKcp(port) {
  const sock = dgram.createSocket('udp4');
  const sess = new Map();
  const tk = setInterval(() => {
    for (const [k, s] of sess) {
      const o = s.kcp.update(Date.now() - s.t0);
      if (o.length) { const i = k.lastIndexOf(':');
        sock.send(o, +k.slice(i + 1), k.slice(0, i)); }
    }
  }, 10);
  sock.on('message', (m, r) => {
    const k = r.address + ':' + r.port;
    if (m.length < K_OVR) return;
    let s = sess.get(k);
    if (!s) { s = { kcp: new Kcp(m.readUInt32LE(0)), t0: Date.now() }; sess.set(k, s); }
    try { s.kcp.input(m); } catch { return; }
    let msg;
    while ((msg = s.kcp.recv()) !== null) {
      try { const { frame } = tryDecode(msg);
        if (frame.flags & F_RESP) s.kcp.send(encode(handle(frame)));
      } catch {}
    }
    const p = s.kcp.flush();
    if (p.length) sock.send(p, r.port, r.address);
  });
  sock.bind(port, () => console.log('[KCP] 监听 ' + port));
  return { sock, tk };
}

/* ==================== 自检 ==================== */
let P = 0, F = 0;
const t = (n, fn) => { try { fn(); P++; console.log('  ok   ' + n); }
  catch (e) { F++; console.log('  FAIL ' + n + ' :: ' + e.message); } };
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' 期望 ' + b + ' 实际 ' + a); };

function selfTest() {
  console.log('\n--- 帧编解码 ---');
  t('CRC32 标准值 123456789 = 0xCBF43926',
    () => eq(crc32(Buffer.from('123456789')), 0xCBF43926));
  t('CRC32 与 zlib 一致（20 组）', () => {
    for (let i = 0; i < 20; i++) {
      const b = Buffer.alloc(i * 7 + 1);
      for (let j = 0; j < b.length; j++) b[j] = (i * 31 + j * 17) & 255;
      eq(crc32(b), zlib.crc32(b), 'len=' + b.length);
    }
  });
  t('编解码往返（含中文）', () => {
    const p = Buffer.from('user:1=张三');
    const f = { flags: F_RESP, cmd: CMD_PUT, seq: 7, payload: p };
    const b = tryDecode(encode(f)).frame;
    eq(b.cmd, CMD_PUT); eq(b.seq, 7);
    if (!b.payload.equals(p)) throw new Error('payload 不符');
  });
  t('长度 = 20 + N + 4', () =>
    eq(encode(mk(CMD_PING, 'hi')).length, 26));
  t('半包抛 Short', () => {
    const b = encode(mk(CMD_PING, 'x'.repeat(100)));
    try { tryDecode(b.subarray(0, 30)); throw new Error('应抛异常'); }
    catch (e) { if (!(e instanceof Short)) throw e; }
  });
  t('粘包可逐帧切出', () => {
    const m = Buffer.concat([encode(mk(CMD_PING, 'aaa')), encode(mk(CMD_STATS, 'bb'))]);
    let o = 0;
    const r1 = tryDecode(m.subarray(o)); o += r1.consumed;
    eq(r1.frame.payload.toString(), 'aaa');
    const r2 = tryDecode(m.subarray(o)); o += r2.consumed;
    eq(r2.frame.payload.toString(), 'bb'); eq(o, m.length);
  });
  t('CRC 损坏被拒绝', () => {
    const b = encode(mk(CMD_PING, 'x')); b[b.length - 1] ^= 255;
    try { tryDecode(b); throw new Error('应抛异常'); }
    catch (e) { if (!(e instanceof BadFrame)) throw e; }
  });

  console.log('\n--- KCP ---');
  const pump = (a, b, want, rounds, drop = 0) => {
    let got = Buffer.alloc(0);
    for (let r = 0; r < rounds; r++) {
      const now = r * K_INT;
      const o = a.update(now); if (o.length && r >= drop) b.input(o);
      const bk = b.update(now); if (bk.length && r >= drop) a.input(bk);
      let m; while ((m = b.recv()) !== null) got = Buffer.concat([got, m]);
      if (got.length >= want) break;
    }
    return got;
  };
  t('基本收发', () => {
    const a = new Kcp(1), b = new Kcp(1);
    a.send(Buffer.from('hello kcp'));
    b.input(a.update(0));
    if (!b.recv().equals(Buffer.from('hello kcp'))) throw new Error('内容不符');
  });
  t('5000 字节分片重组', () => {
    const a = new Kcp(2), b = new Kcp(2), m = Buffer.alloc(5000);
    for (let i = 0; i < m.length; i++) m[i] = i % 251;
    a.send(m);
    const g = pump(a, b, m.length, 60);
    eq(g.length, m.length);
    if (!g.equals(m)) throw new Error('内容不符');
  });
  t('连续丢包 3 轮后重传恢复', () => {
    const a = new Kcp(3), b = new Kcp(3), m = Buffer.alloc(3000);
    for (let i = 0; i < m.length; i++) m[i] = i % 251;
    a.send(m);
    if (!pump(a, b, m.length, 120, 3).equals(m)) throw new Error('重传未恢复');
  });
  t('conv 不匹配被拒绝', () => {
    const a = new Kcp(10), b = new Kcp(11);
    a.send(Buffer.from('x'));
    try { b.input(a.update(0)); throw new Error('应抛异常'); }
    catch (e) { if (!/conv/.test(e.message)) throw e; }
  });
  t('段格式小端序 24B 头', () => {
    const a = new Kcp(0x11223344); a.send(Buffer.from('ab'));
    const o = a.update(0);
    eq(o[0], 0x44); eq(o[1], 0x33); eq(o[2], 0x22); eq(o[3], 0x11);
    eq(o[4], K_CMD_PUSH); eq(o.readUInt32LE(20), 2);
  });
  t('32 位回绕 idiff 正确', () => {
    if (!(idiff(5, 3) > 0 && idiff(3, 5) < 0 && idiff(2, 0xFFFFFFFF) > 0))
      throw new Error('回绕处理错误');
  });
  console.log(`\n=== 自检: ${P} 通过, ${F} 失败 ===`);
  return F;
}

/* ==================== 客户端 ==================== */
function runClient(port, proto) {
  const cases = [[CMD_PING, 'hi'], [CMD_PUT, 'user:1=alice'], [CMD_GET, 'user:1'],
    [CMD_ROUTE_SET, '7=node-3'], [CMD_ROUTE_GET, '7'], [CMD_STATS, '']];
  let i = 0;
  const show = (buf) => {
    const { frame } = tryDecode(buf);
    console.log('  ' + cname(frame.cmd).padEnd(10) + ' -> ' + frame.payload.toString());
    next();
  };
  const next = () => {
    if (i >= cases.length) { console.log('完成'); return; }
    const [c, p] = cases[i++];
    if (proto === 'tcp') {
      const s = net.connect(port, '127.0.0.1', () => s.write(encode(mk(c, p))));
      let acc = Buffer.alloc(0);
      s.on('data', (d) => {
        acc = Buffer.concat([acc, d]);
        try { const r = tryDecode(acc); s.end(); show(encode(r.frame)); }
        catch (e) { if (!(e instanceof Short)) { s.end(); next(); } }
      });
      s.on('error', () => next());
    } else if (proto === 'udp') {
      const s = dgram.createSocket('udp4');
      let done = false;
      s.on('message', (m) => { if (done) return; done = true; s.close(); show(m); });
      s.bind(0, () => s.send(encode(mk(c, p)), port, '127.0.0.1'));
      setTimeout(() => { if (!done) { done = true; try { s.close(); } catch {} next(); } }, 3000);
    } else {
      const s = dgram.createSocket('udp4'), k = new Kcp(0x11223344), t0 = Date.now();
      const of = k.flush.bind(k);
      k.flush = () => { const o = of(); if (o.length) s.send(o, port, '127.0.0.1'); return o; };
      let done = false;
      const tk = setInterval(() => k.update(Date.now() - t0), 10);
      s.on('message', (m) => {
        try { k.input(m); } catch { return; }
        let msg; while ((msg = k.recv()) !== null) {
          if (done) return; done = true; clearInterval(tk); s.close(); show(msg);
        }
      });
      s.bind(0, () => { k.send(encode(mk(c, p))); k.flush(); });
      setTimeout(() => { if (!done) { done = true; clearInterval(tk); try { s.close(); } catch {} next(); } }, 5000);
    }
  };
  next();
}

/* ==================== main ==================== */
/* ==================== 端到端（同进程，真实 socket）==================== */
function e2e() {
  const ports = { tcp: 19101, udp: 19201, kcp: 19401 };
  const tcp = startTcp(ports.tcp);
  const udp = startUdp(ports.udp, 'UDP');
  const kcp = startKcp(ports.kcp);
  let ep = 0, ef = 0;
  const cases = [[CMD_PING, 'hi', 'PONG'], [CMD_PUT, 'u:1=alice', 'stored u:1'],
    [CMD_GET, 'u:1', 'alice'], [CMD_ROUTE_SET, '7=n3', 'route 7 -> n3'],
    [CMD_ROUTE_GET, '7', 'n3']];

  function runTcp(i, done) {
    const s = net.connect(ports.tcp, '127.0.0.1', () => s.write(encode(mk(cases[i][0], cases[i][1]))));
    let acc = Buffer.alloc(0);
    s.on('data', (d) => {
      acc = Buffer.concat([acc, d]);
      let r;
      try { r = tryDecode(acc); } catch (e) { return; }
      const body = r.frame.payload.toString();
      const want = 'OK|' + cases[i][2];
      console.log(`  [TCP] ${cname(cases[i][0]).padEnd(10)} -> ${body}`);
      if (body === want) ep++; else { ef++; console.log('        期望 ' + want); }
      s.end();
      if (i + 1 < cases.length) runTcp(i + 1, done); else done();
    });
    s.on('error', (e) => { ef++; console.log('  [TCP] 错误 ' + e.message); done(); });
  }
  function runUdp(i, done) {
    const s = dgram.createSocket('udp4');
    let fin = false;
    s.on('message', (msg) => {
      if (fin) return; fin = true;
      const { frame } = tryDecode(msg);
      const body = frame.payload.toString(), want = 'OK|' + cases[i][2];
      console.log(`  [UDP] ${cname(cases[i][0]).padEnd(10)} -> ${body}`);
      if (body === want) ep++; else { ef++; console.log('        期望 ' + want); }
      s.close();
      if (i + 1 < cases.length) runUdp(i + 1, done); else done();
    });
    s.bind(0, () => s.send(encode(mk(cases[i][0], cases[i][1])), ports.udp, '127.0.0.1'));
    setTimeout(() => { if (!fin) { fin = true; ef++; s.close(); done(); } }, 3000);
  }
  function runKcp(i, done) {
    const s = dgram.createSocket('udp4'), k = new Kcp(0x11223344), t0 = Date.now();
    const of = k.flush.bind(k);
    k.flush = () => { const o = of(); if (o.length) s.send(o, ports.kcp, '127.0.0.1'); return o; };
    let fin = false;
    const tk = setInterval(() => k.update(Date.now() - t0), 10);
    s.on('message', (m) => {
      try { k.input(m); } catch { return; }
      let msg;
      while ((msg = k.recv()) !== null) {
        if (fin) return; fin = true;
        clearInterval(tk); s.close();
        const { frame } = tryDecode(msg);
        const body = frame.payload.toString(), want = 'OK|' + cases[i][2];
        console.log(`  [KCP] ${cname(cases[i][0]).padEnd(10)} -> ${body}`);
        if (body === want) ep++; else { ef++; console.log('        期望 ' + want); }
        if (i + 1 < cases.length) runKcp(i + 1, done); else done();
      }
    });
    s.bind(0, () => { k.send(encode(mk(cases[i][0], cases[i][1]))); k.flush(); });
    setTimeout(() => { if (!fin) { fin = true; clearInterval(tk); ef++; try { s.close(); } catch {} done(); } }, 5000);
  }

  console.log('\n=== 端到端（同进程真实 socket）===');
  runTcp(0, () => runUdp(0, () => runKcp(0, () => {
    console.log(`\n=== 端到端: ${ep} 通过, ${ef} 失败 ===`);
    tcp.close(); udp.close(); clearInterval(kcp.tk); kcp.sock.close();
    process.exit(ef ? 1 : 0);
  })));
}

const mode = process.argv[2] || 'test';
if (mode === 'test') process.exit(selfTest() ? 1 : 0);
else if (mode === 'e2e') e2e();
else if (mode === 'server') {
  console.log('多协议集群服务器 · 最小 Demo');
  startTcp(9101); startUdp(9201, 'UDP'); startUdp(9301, 'CUSTOM'); startKcp(9401);
  console.log('就绪 TCP=9101 UDP=9201 CUSTOM=9301 KCP=9401');
} else if (mode === 'client') {
  const i = process.argv.indexOf('--proto');
  const proto = i > 0 ? process.argv[i + 1] : 'tcp';
  const j = process.argv.indexOf('--port');
  const port = j > 0 ? +process.argv[j + 1] : (proto === 'kcp' ? 9401 : proto === 'udp' ? 9201 : 9101);
  console.log(proto.toUpperCase() + ' 客户端 -> 127.0.0.1:' + port);
  runClient(port, proto);
} else console.log('用法: node demo.js <test|e2e|server|client> [--proto tcp|udp|kcp] [--port N]');
