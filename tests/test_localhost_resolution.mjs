/**
 * Does Node's net.connect({ host: 'localhost' }) reach an IPv4-only listener?
 * The chat relay uses exactly this. Node >=17 resolves 'localhost' verbatim,
 * returning ::1 first on Windows — an IPv4-only bind then refuses.
 *
 *   node tests/test_localhost_resolution.mjs
 */
import net from 'node:net';
import dns from 'node:dns';

const port = 2244;

console.log('dns.lookup("localhost", {all:true}):');
const all = await new Promise((res) => dns.lookup('localhost', { all: true }, (e, a) => res(e ? [] : a)));
console.log(' ', JSON.stringify(all));
console.log('dns default order result:', JSON.stringify(await new Promise((res) => dns.lookup('localhost', (e, a) => res(e ? String(e) : a)))));

function probe(host, label) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r) => { try { s.destroy(); } catch {} resolve(`${label}: ${r}`); };
    s.setTimeout(4000);
    s.on('connect', () => done('CONNECTED'));
    s.on('error', (e) => done(`ERROR ${e.code || e.message}`));
    s.on('timeout', () => done('TIMEOUT'));
  });
}

console.log(await probe('localhost', "net.connect({host:'localhost'})"));
console.log(await probe('127.0.0.1', "net.connect({host:'127.0.0.1'})"));
console.log(await probe('::1', "net.connect({host:'::1'})"));
