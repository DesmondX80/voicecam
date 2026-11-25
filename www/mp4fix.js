'use strict';
/*
 * Muuntaa MediaRecorderin tuottaman pilkotun MP4:n (fragmented MP4: moov + moof/mdat-parit,
 * kesto 0) tavalliseksi MP4:ksi, jossa on oikea kesto ja hakutaulukot (stts/stsz/stco...).
 * Ilman tätä toistimet eivät tiedä videon pituutta, ja toisto takkuaa lopussa.
 * Ääni- ja videoraidat säilyvät, näytteiden data kopioidaan sellaisenaan (ei uudelleenpakkausta).
 *
 * opts.audio (valinnainen): erikseen nauhoitettu AAC-ääni, joka lisätään omaksi raidaksi:
 *   { asc: Uint8Array, frames: Uint8Array[], sampleRate, channels, bitrate, offsetMs }
 *   offsetMs = kuinka paljon aiemmin ääni alkoi kuin video (alusta pudotetaan vastaava määrä).
 *
 * opts.trim (valinnainen): { startMs, endMs } videon alusta. Näytteet ennen edeltävää avainkuvaa ja
 *   lopun jälkeen poistetaan; tarkka alku- ja loppukohta merkitään edit listiin (edts/elst),
 *   joten uudelleenpakkausta ei tarvita.
 */
(function (root) {
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts', 'dinf']);

  function readBoxes(dv, start, end) {
    const list = [];
    let off = start;
    while (off + 8 <= end) {
      let size = dv.getUint32(off);
      const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(off + 8)); hdr = 16; }
      if (size === 0) size = end - off;
      if (size < hdr || off + size > end) break; // katkennut loppu
      const box = { type, start: off, size, hdr, body: off + hdr, end: off + size };
      if (CONTAINERS.has(type)) box.children = readBoxes(dv, box.body, box.end);
      list.push(box);
      off += size;
    }
    return list;
  }
  const find = (boxes, type) => boxes && boxes.find((b) => b.type === type);
  const findAll = (boxes, type) => (boxes ? boxes.filter((b) => b.type === type) : []);

  // ---------- kirjoitus ----------
  function u8(...n) { return Uint8Array.from(n); }
  function u32(n) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n >>> 0); return a; }
  function i32(n) { const a = new Uint8Array(4); new DataView(a.buffer).setInt32(0, n); return a; }
  function u64(n) { const a = new Uint8Array(8); new DataView(a.buffer).setBigUint64(0, BigInt(n)); return a; }
  function concat(parts) {
    const len = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function box(type, ...parts) {
    const body = concat(parts);
    const t = new Uint8Array(4);
    for (let i = 0; i < 4; i++) t[i] = type.charCodeAt(i);
    return concat([u32(body.length + 8), t, body]);
  }
  const fullBox = (type, version, flags, ...parts) =>
    box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);

  const ascii = (str) => u8(...[...str].map((c) => c.charCodeAt(0)));
  function desc(tag, ...parts) {
    const body = concat(parts);
    if (body.length > 127) throw new Error('descriptor too long');
    return concat([u8(tag, body.length), body]);
  }

  // AAC-ääniraita (mp4a/esds) erikseen nauhoitetuista kehyksistä
  // Edit list: esitetään mediasta kohta [mediaTime, mediaTime + duration]
  const edtsBox = (e) => box('edts', fullBox('elst', 1, 0, u32(1), u64(e.duration), u64(e.mediaTime), u8(0, 1, 0, 0)));

  function audioTrak(x, chunkOffset, movieScale) {
    const n = x.frames.length;
    const dur = n * 1024;
    const tDur = x.edit ? x.edit.duration : Math.round(dur * movieScale / x.sampleRate);
    const matrix = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
    const tkhd = fullBox('tkhd', 0, 7, u32(0), u32(0), u32(x.id), u32(0), u32(tDur), u32(0), u32(0),
      u8(0, 0, 0, 0), u8(1, 0, 0, 0), ...matrix.map(u32), u32(0), u32(0));
    const esds = fullBox('esds', 0, 0, desc(0x03, u8(0, 0, 0),
      desc(0x04, u8(0x40, 0x15, 0, 0, 0), u32(x.bitrate), u32(x.bitrate), desc(0x05, x.asc)),
      desc(0x06, u8(0x02))));
    const mp4a = box('mp4a', u8(0, 0, 0, 0, 0, 0), u8(0, 1), u32(0), u32(0),
      u8(0, x.channels), u8(0, 16), u8(0, 0), u8(0, 0), u32(x.sampleRate * 65536), esds);
    const stbl = box('stbl',
      fullBox('stsd', 0, 0, u32(1), mp4a),
      fullBox('stts', 0, 0, u32(1), u32(n), u32(1024)),
      fullBox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
      fullBox('stsz', 0, 0, u32(0), u32(n), ...x.frames.map((f) => u32(f.length))),
      fullBox('co64', 0, 0, u32(1), u64(chunkOffset)));
    const minf = box('minf', fullBox('smhd', 0, 0, u8(0, 0, 0, 0)),
      box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))), stbl);
    const mdia = box('mdia',
      fullBox('mdhd', 0, 0, u32(0), u32(0), u32(x.sampleRate), u32(dur), u8(0x55, 0xc4, 0, 0)),
      fullBox('hdlr', 0, 0, u32(0), ascii('soun'), u32(0), u32(0), u32(0), ascii('SoundHandler\0')),
      minf);
    return x.edit ? box('trak', tkhd, edtsBox(x.edit), mdia) : box('trak', tkhd, mdia);
  }

  function fixMp4(input, opts = {}) {
    // Tavallinen Uint8Array-näkymä (myös Node.js:n Buffer), jotta kopiot ovat aitoja kopioita.
    const buf = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const top = readBoxes(dv, 0, buf.length);
    const moov = find(top, 'moov');
    if (!moov || !find(top, 'moof')) return null; // ei pilkottu MP4 – ei muutettavaa
    const raw = (b) => buf.subarray(b.start, b.end);

    // trex-oletukset
    const trex = {};
    for (const t of findAll(find(moov.children, 'mvex')?.children, 'trex')) {
      const id = dv.getUint32(t.body + 4);
      trex[id] = {
        dur: dv.getUint32(t.body + 12), size: dv.getUint32(t.body + 16), flags: dv.getUint32(t.body + 20),
      };
    }

    // raidat
    const tracks = {};
    for (const trak of findAll(moov.children, 'trak')) {
      const tkhd = find(trak.children, 'tkhd');
      const id = dv.getUint32(tkhd.body + (dv.getUint8(tkhd.body) === 1 ? 20 : 12));
      const mdia = find(trak.children, 'mdia');
      const mdhd = find(mdia.children, 'mdhd');
      const timescale = dv.getUint32(mdhd.body + (dv.getUint8(mdhd.body) === 1 ? 20 : 12));
      const hdlr = find(mdia.children, 'hdlr');
      const handler = String.fromCharCode(...buf.subarray(hdlr.body + 8, hdlr.body + 12));
      const minf = find(mdia.children, 'minf');
      const stbl = find(minf.children, 'stbl');
      tracks[id] = {
        id, trak, tkhd, mdia, mdhd, hdlr, minf, timescale, handler,
        stsd: find(stbl.children, 'stsd'),
        samples: [], chunks: [], // chunk = [ensimmäinen näyte, näytemäärä]
        time: 0, defaults: trex[id] || { dur: 0, size: 0, flags: 0 },
      };
    }

    // fragmentit tiedostojärjestyksessä
    let order = []; // raidat chunkkien kirjoitusjärjestyksessä
    for (const moof of findAll(top, 'moof')) {
      for (const traf of findAll(moof.children, 'traf')) {
        const tfhd = find(traf.children, 'tfhd');
        const tf = dv.getUint32(tfhd.body) & 0xffffff;
        const tr = tracks[dv.getUint32(tfhd.body + 4)];
        if (!tr) continue;
        let p = tfhd.body + 8;
        let base = moof.start;
        if (tf & 0x1) { base = Number(dv.getBigUint64(p)); p += 8; }
        if (tf & 0x2) p += 4;
        const defDur = tf & 0x8 ? dv.getUint32((p += 4) - 4) : tr.defaults.dur;
        const defSize = tf & 0x10 ? dv.getUint32((p += 4) - 4) : tr.defaults.size;
        const defFlags = tf & 0x20 ? dv.getUint32((p += 4) - 4) : tr.defaults.flags;

        const tfdt = find(traf.children, 'tfdt');
        if (tfdt) {
          const t = dv.getUint8(tfdt.body) === 1 ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4);
          // Aukko tai päällekkäisyys: korjataan edellisen näytteen kesto vastaamaan aikajanaa.
          const last = tr.samples[tr.samples.length - 1];
          if (last && t !== tr.time) {
            const fixed = last.dur + (t - tr.time);
            if (fixed > 0) { last.dur = fixed; tr.time = t; }
          } else if (!last) tr.time = t;
        }

        let dataPos = base;
        for (const trun of findAll(traf.children, 'trun')) {
          const ver = dv.getUint8(trun.body);
          const rf = dv.getUint32(trun.body) & 0xffffff;
          const count = dv.getUint32(trun.body + 4);
          let q = trun.body + 8;
          if (rf & 0x1) { dataPos = base + dv.getInt32(q); q += 4; }
          let firstFlags = null;
          if (rf & 0x4) { firstFlags = dv.getUint32(q); q += 4; }
          const first = tr.samples.length;
          for (let i = 0; i < count; i++) {
            let dur = defDur, size = defSize, flags = i === 0 && firstFlags !== null ? firstFlags : defFlags, cto = 0;
            if (rf & 0x100) { dur = dv.getUint32(q); q += 4; }
            if (rf & 0x200) { size = dv.getUint32(q); q += 4; }
            if (rf & 0x400) { const f = dv.getUint32(q); q += 4; if (!(i === 0 && firstFlags !== null)) flags = f; }
            if (rf & 0x800) { cto = ver === 1 ? dv.getInt32(q) : dv.getUint32(q); q += 4; }
            if (dataPos + size > buf.length) break; // katkennut loppu
            tr.samples.push({ pos: dataPos, size, dur, cto, sync: !((flags >> 16) & 1) });
            dataPos += size;
            tr.time += dur;
          }
          const n = tr.samples.length - first;
          if (n > 0) { tr.chunks.push([first, n]); order.push(tr); }
        }
      }
    }

    const list = Object.values(tracks).filter((t) => t.samples.length);
    if (!list.length) return null;

    // Erikseen nauhoitettu ääni (vain jos videossa ei jo ole ääniraitaa)
    let extra = null;
    const a = opts.audio;
    if (a && a.asc && a.asc.length && a.frames && a.frames.length && !list.some((t) => t.handler === 'soun')) {
      const skip = Math.max(0, Math.round(((a.offsetMs || 0) / 1000) * a.sampleRate / 1024));
      const frames = a.frames.slice(skip);
      if (frames.length) {
        extra = {
          id: Math.max(...Object.keys(tracks).map(Number)) + 1, frames,
          sampleRate: a.sampleRate, channels: a.channels || 1, asc: a.asc, bitrate: a.bitrate || 128000,
        };
      }
    }

    // ---------- uusi moov ----------
    const mvhd = find(moov.children, 'mvhd');
    const mvVer = dv.getUint8(mvhd.body);
    const movieScale = dv.getUint32(mvhd.body + (mvVer === 1 ? 20 : 12));
    const trackDur = (t) => t.samples.reduce((s, x) => s + x.dur, 0);

    // ---------- leikkaus ----------
    const trim = opts.trim;
    if (trim && trim.endMs > trim.startMs) {
      const cut = (samples, timescale, isVideo) => {
        let time = 0;
        const times = samples.map((x) => { const tt = time; time += x.dur; return tt; });
        const start = (trim.startMs / 1000) * timescale;
        const end = (trim.endMs / 1000) * timescale;
        // Video voi alkaa vain avainkuvasta: aloitetaan alkukohtaa edeltävästä avainkuvasta.
        let first = 0;
        for (let i = 0; i < samples.length && times[i] <= start; i++) if (!isVideo || samples[i].sync) first = i;
        let last = samples.length - 1;
        while (last > first && times[last] >= end) last--;
        const availEnd = Math.min(end, time);
        const durMs = Math.max(0, (availEnd - Math.max(start, times[first])) * 1000 / timescale);
        return {
          kept: samples.slice(first, last + 1),
          edit: { mediaTime: Math.max(0, Math.round(start - times[first])), duration: Math.round(durMs * movieScale / 1000) },
        };
      };
      for (const t of list) {
        const r = cut(t.samples, t.timescale, t.handler === 'vide');
        t.samples = r.kept;
        t.chunks = [[0, t.samples.length]];
        t.edit = r.edit;
      }
      order = list.slice();
      if (extra) {
        const r = cut(extra.frames.map((f) => ({ f, dur: 1024, sync: true })), extra.sampleRate, false);
        extra.frames = r.kept.map((x) => x.f);
        extra.edit = r.edit;
        if (!extra.frames.length) extra = null;
      }
    }

    const tDurOf = (t) => (t.edit ? t.edit.duration : Math.round(trackDur(t) * movieScale / t.timescale));
    const movieDur = Math.max(...list.map(tDurOf),
      extra ? (extra.edit ? extra.edit.duration : Math.round(extra.frames.length * 1024 * movieScale / extra.sampleRate)) : 0);

    function patched(b, offV0, offV1, value) {
      const copy = new Uint8Array(raw(b)); // aito kopio
      const v = copy[b.hdr];
      const cdv = new DataView(copy.buffer);
      if (v === 1) cdv.setBigUint64(b.hdr + offV1, BigInt(value)); else cdv.setUint32(b.hdr + offV0, value);
      return copy;
    }

    function stbl(t, chunkOffsets) {
      const s = t.samples;
      // stts (ajoitus, ajonpituuskoodattu)
      const stts = [];
      for (const x of s) {
        const l = stts[stts.length - 1];
        if (l && l[1] === x.dur) l[0]++; else stts.push([1, x.dur]);
      }
      const parts = [
        raw(t.stsd),
        fullBox('stts', 0, 0, u32(stts.length), ...stts.flatMap(([c, d]) => [u32(c), u32(d)])),
      ];
      if (s.some((x) => x.cto !== 0)) {
        const ctts = [];
        for (const x of s) {
          const l = ctts[ctts.length - 1];
          if (l && l[1] === x.cto) l[0]++; else ctts.push([1, x.cto]);
        }
        parts.push(fullBox('ctts', 1, 0, u32(ctts.length), ...ctts.flatMap(([c, o]) => [u32(c), i32(o)])));
      }
      if (t.handler === 'vide' && s.some((x) => !x.sync)) {
        const sync = [];
        s.forEach((x, i) => { if (x.sync) sync.push(i + 1); });
        parts.push(fullBox('stss', 0, 0, u32(sync.length), ...sync.map(u32)));
      }
      const stsc = [];
      t.chunks.forEach(([, n], i) => {
        if (!stsc.length || stsc[stsc.length - 1][1] !== n) stsc.push([i + 1, n]);
      });
      parts.push(fullBox('stsc', 0, 0, u32(stsc.length), ...stsc.flatMap(([c, n]) => [u32(c), u32(n), u32(1)])));
      parts.push(fullBox('stsz', 0, 0, u32(0), u32(s.length), ...s.map((x) => u32(x.size))));
      parts.push(fullBox('co64', 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map(u64)));
      return box('stbl', ...parts);
    }

    function buildMoov(offsetsByTrack, audioOffset) {
      const traks = list.map((t) => {
        const minfParts = t.minf.children.filter((c) => c.type !== 'stbl').map(raw);
        const mdia = box('mdia',
          patched(t.mdhd, 16, 24, trackDur(t)),
          raw(t.hdlr),
          box('minf', ...minfParts, stbl(t, offsetsByTrack[t.id])));
        const tkhd = patched(t.tkhd, 20, 28, tDurOf(t));
        return t.edit ? box('trak', tkhd, edtsBox(t.edit), mdia) : box('trak', tkhd, mdia);
      });
      const mv = patched(mvhd, 16, 24, movieDur);
      if (extra) {
        new DataView(mv.buffer).setUint32(mv.length - 4, extra.id + 1); // next_track_ID
        traks.push(audioTrak(extra, audioOffset, movieScale));
      }
      return box('moov', mv, ...traks);
    }

    // Lasketaan moovin koko nollaoffseteilla (co64 = kiinteä koko), sitten oikeat offsetit.
    const zero = {};
    for (const t of list) zero[t.id] = t.chunks.map(() => 0);
    const ftyp = box('ftyp', u8(0x69, 0x73, 0x6f, 0x6d), u32(0x200),
      ...['isom', 'iso2', 'avc1', 'mp41'].map((s) => u8(...[...s].map((c) => c.charCodeAt(0)))));
    const moovSize = buildMoov(zero, 0).length;
    const extraBytes = extra ? extra.frames.reduce((s, f) => s + f.length, 0) : 0;
    const mdatPayload = list.reduce((s, t) => s + t.samples.reduce((acc, x) => acc + x.size, 0), 0) + extraBytes;
    const bigMdat = mdatPayload + 8 > 0xffffffff;
    const mdatHdr = bigMdat ? 16 : 8;

    const offsets = {};
    for (const t of list) offsets[t.id] = [];
    const chunkIdx = {};
    let pos = ftyp.length + moovSize + mdatHdr;
    for (const t of order) {
      const k = (chunkIdx[t.id] = (chunkIdx[t.id] || 0));
      const [first, n] = t.chunks[k];
      offsets[t.id].push(pos);
      for (let i = first; i < first + n; i++) pos += t.samples[i].size;
      chunkIdx[t.id] = k + 1;
    }

    const audioOffset = pos; // ääni yhtenä palana videodatan perään
    pos += extraBytes;

    const out = new Uint8Array(pos);
    out.set(ftyp, 0);
    out.set(buildMoov(offsets, audioOffset), ftyp.length);
    let w = ftyp.length + moovSize;
    const odv = new DataView(out.buffer);
    if (bigMdat) {
      odv.setUint32(w, 1); out.set([0x6d, 0x64, 0x61, 0x74], w + 4); odv.setBigUint64(w + 8, BigInt(mdatPayload + 16));
    } else {
      odv.setUint32(w, mdatPayload + 8); out.set([0x6d, 0x64, 0x61, 0x74], w + 4);
    }
    w += mdatHdr;
    for (const k in chunkIdx) chunkIdx[k] = 0;
    for (const t of order) {
      const [first, n] = t.chunks[chunkIdx[t.id]++];
      for (let i = first; i < first + n; i++) {
        const x = t.samples[i];
        out.set(buf.subarray(x.pos, x.pos + x.size), w);
        w += x.size;
      }
    }
    if (extra) for (const f of extra.frames) { out.set(f, w); w += f.length; }
    return out;
  }

  root.fixMp4 = fixMp4;
  if (typeof module !== 'undefined') module.exports = { fixMp4 };
})(typeof window !== 'undefined' ? window : globalThis);
