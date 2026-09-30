'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  peHeader, certificate, peChecksum, withoutSignature, setSubsystem, IMAGE_SUBSYSTEM_WINDOWS_GUI, IMAGE_SUBSYSTEM_WINDOWS_CUI,
} = require('../scripts/build-exe');

// The header work scripts/build-exe.js does to node.exe -- taking its signature off, making it a
// Windows GUI program, making its checksum right -- on made-up PE files, built here byte by byte
// as Microsoft's "PE Format" lays them out, so it is tried on any system and needs no node.exe.
// Requiring the script builds nothing: it only builds when run.

const PE_AT = 0x80;

/**
 * A made-up PE file: a DOS header pointing at "PE\0\0", a COFF header, an optional header of
 * `magic` (0x20b PE32+, 0x10b PE32) for a console program, 16 data directories, and `body` bytes
 * after them; with `cert`, a certificate table of that many bytes at the very end, as Authenticode
 * puts one.
 */
function pe({ magic = 0x20b, body = 1024, cert = 0, subsystem = IMAGE_SUBSYSTEM_WINDOWS_CUI } = {}) {
  const plus = magic === 0x20b;
  const opt = PE_AT + 24;
  const dirs = opt + (plus ? 112 : 96);
  const headers = dirs + 16 * 8;
  const buf = Buffer.alloc(headers + body + cert);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(PE_AT, 0x3c);
  buf.write('PE\0\0', PE_AT, 'latin1');
  buf.writeUInt16LE(plus ? 0x8664 : 0x14c, PE_AT + 4); // Machine
  buf.writeUInt16LE(dirs + 16 * 8 - opt, PE_AT + 20); // SizeOfOptionalHeader
  buf.writeUInt16LE(magic, opt);
  buf.writeUInt32LE(0x12345678, opt + 64); // a CheckSum left over from before
  buf.writeUInt16LE(subsystem, opt + 68);
  buf.writeUInt32LE(16, opt + (plus ? 108 : 92)); // NumberOfRvaAndSizes
  for (let i = 0; i < body; i++) buf[headers + i] = (i * 7 + 3) & 0xff; // made-up code and data
  if (cert) {
    buf.writeUInt32LE(headers + body, dirs + 4 * 8);
    buf.writeUInt32LE(cert, dirs + 4 * 8 + 4);
    buf.fill(0xa5, headers + body);
  }
  return buf;
}

/**
 * The checksum the way Microsoft's reference code adds it up: a 16-bit word at a time, folding
 * the carry back in at every step, the CheckSum field left out, and the file's length added.
 */
function referenceChecksum(buf, checksumAt) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    const word = i === checksumAt || i === checksumAt + 2 ? 0 : buf[i] | ((i + 1 < buf.length ? buf[i + 1] : 0) << 8);
    sum += word;
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return (sum + buf.length) >>> 0;
}

test('reads the fields it changes from a PE32+ and a PE32 header', () => {
  const opt = PE_AT + 24;
  assert.deepStrictEqual(peHeader(pe()), { checksumAt: opt + 64, subsystemAt: opt + 68, subsystem: 3, certAt: opt + 112 + 32 });
  assert.deepStrictEqual(peHeader(pe({ magic: 0x10b, subsystem: 2 })), { checksumAt: opt + 64, subsystemAt: opt + 68, subsystem: 2, certAt: opt + 96 + 32 });
  assert.deepStrictEqual(certificate(pe()), { at: 0, size: 0 });
  const signed = pe({ cert: 400 });
  assert.deepStrictEqual(certificate(signed), { at: signed.length - 400, size: 400 });
  // Fewer than five data directories: there is no certificate table to name.
  const few = pe();
  few.writeUInt32LE(4, opt + 108);
  assert.strictEqual(peHeader(few).certAt, -1);
  assert.deepStrictEqual(certificate(few), { at: 0, size: 0 });
});

test('refuses what is not a PE file', () => {
  const bad = /not a Windows program/;
  assert.throws(() => peHeader(Buffer.alloc(10)), bad);
  assert.throws(() => peHeader(Buffer.from('#!/bin/sh\n'.padEnd(600, ' '))), bad, 'no MZ');
  const noPe = pe();
  noPe.write('NE', PE_AT, 'latin1');
  assert.throws(() => peHeader(noPe), bad, 'no PE signature');
  const past = pe();
  past.writeUInt32LE(past.length, 0x3c);
  assert.throws(() => peHeader(past), bad, 'e_lfanew past the end');
  const rom = pe();
  rom.writeUInt16LE(0x107, PE_AT + 24);
  assert.throws(() => peHeader(rom), bad, 'a ROM image, neither PE32 nor PE32+');
});

test('the checksum is the one CheckSumMappedFile gives, whatever the field held', () => {
  for (const buf of [pe(), pe({ magic: 0x10b }), pe({ body: 1023 }), pe({ body: 70000, cert: 24 })]) {
    const h = peHeader(buf);
    const want = referenceChecksum(buf, h.checksumAt);
    assert.strictEqual(peChecksum(buf), want, `${buf.length} bytes`);
    const other = Buffer.from(buf);
    other.writeUInt32LE(0xffffffff, h.checksumAt);
    assert.strictEqual(peChecksum(other), want, 'the CheckSum field counts as 0');
  }
  // A known answer, to keep the adding up itself from changing unseen.
  assert.strictEqual(peChecksum(pe()), 0x00003017);
  // Carries that fold more than once: words of 0xffff.
  const ones = pe({ body: 4096 });
  ones.fill(0xff, ones.length - 4096);
  assert.strictEqual(peChecksum(ones), referenceChecksum(ones, peHeader(ones).checksumAt));
});

test('takes off a signature at the end of the file, and only there', () => {
  const signed = pe({ cert: 400 });
  const { data, removed } = withoutSignature(signed);
  assert.strictEqual(removed, 400);
  assert.strictEqual(data.length, signed.length - 400);
  assert.deepStrictEqual(certificate(data), { at: 0, size: 0 });
  assert.strictEqual(data.readUInt32LE(peHeader(data).checksumAt), peChecksum(data));
  assert.strictEqual(signed.length, pe({ cert: 400 }).length, 'the file given is left as it was');
  const plain = withoutSignature(pe());
  assert.deepStrictEqual([plain.removed, plain.data.length], [0, pe().length]);
  assert.strictEqual(plain.data.readUInt32LE(peHeader(plain.data).checksumAt), peChecksum(plain.data));
  // A table that is not the end of the file is not cut off: what follows it would go with it.
  const inside = pe({ cert: 400 });
  inside.writeUInt32LE(inside.length - 800, peHeader(inside).certAt);
  assert.throws(() => withoutSignature(inside), /not at the end of the file/);
});

test('makes a console program a GUI program, changing the Subsystem and the checksum alone', () => {
  assert.deepStrictEqual([IMAGE_SUBSYSTEM_WINDOWS_GUI, IMAGE_SUBSYSTEM_WINDOWS_CUI], [2, 3]);
  for (const magic of [0x20b, 0x10b]) {
    const cui = pe({ magic });
    const before = Buffer.from(cui);
    const gui = setSubsystem(cui, IMAGE_SUBSYSTEM_WINDOWS_GUI);
    const h = peHeader(gui);
    assert.strictEqual(h.subsystem, 2);
    assert.strictEqual(gui.readUInt32LE(h.checksumAt), peChecksum(gui), 'its checksum is right for what it now is');
    assert.notStrictEqual(peChecksum(gui), peChecksum(cui), 'the Subsystem is among what the checksum adds up');
    assert.ok(cui.equals(before), 'the file given is left as it was');
    assert.strictEqual(gui.length, cui.length);
    const changed = [];
    for (let i = 0; i < gui.length; i++) if (gui[i] !== cui[i]) changed.push(i);
    const own = (i) => (i >= h.checksumAt && i < h.checksumAt + 4) || (i >= h.subsystemAt && i < h.subsystemAt + 2);
    assert.ok(changed.length && changed.every(own), `bytes changed outside CheckSum and Subsystem: ${changed.filter((i) => !own(i))}`);
    assert.ok(setSubsystem(gui, IMAGE_SUBSYSTEM_WINDOWS_CUI).equals(setSubsystem(cui, IMAGE_SUBSYSTEM_WINDOWS_CUI)),
      'and back again');
  }
  for (const bad of [0, -1, 1.5, 65536, '2', null]) {
    assert.throws(() => setSubsystem(pe(), bad), RangeError, String(bad));
  }
  assert.throws(() => setSubsystem(Buffer.alloc(100), 2), /not a Windows program/);
});

test('the steps of a build give the same bytes every time: no signature, a GUI program, a right checksum', () => {
  const node = pe({ body: 5000, cert: 256 });
  const make = () => setSubsystem(withoutSignature(node).data, IMAGE_SUBSYSTEM_WINDOWS_GUI);
  const exe = make();
  const h = peHeader(exe);
  assert.deepStrictEqual([h.subsystem, certificate(exe, h).size, exe.length], [2, 0, node.length - 256]);
  assert.strictEqual(exe.readUInt32LE(h.checksumAt), referenceChecksum(exe, h.checksumAt));
  assert.ok(make().equals(exe), 'byte for byte, as a build again must be');
});
