'use strict';
/*
 * Golf swing -tunnistus liikedatasta.
 *
 * Syöte: [{ t: ms videon alusta, m: liike 0..1 (muuttuneiden pikselien osuus) }]
 * Kamera on jalustalla, joten liike tulee lähes kokonaan lyöjästä.
 *
 * 1. Suurin liikepiikki = alaswing / osuma.
 * 2. Piikistä taaksepäin: liike jatkuu (minStillMs:ää lyhyemmät tauot, esim. backswingin yläkohta,
 *    ohitetaan), kunnes löytyy vähintään minStillMs pitkä paikallaanolo = aloitusasento.
 *    Lyönnin alku = hetki, jolloin liike lähtee aloitusasennosta.
 * 3. Piikistä eteenpäin: liike jatkuu, kunnes loppuasento pysyy paikallaan finishStillMs.
 * 4. Leike: [alku - preRollMs, loppu + postMs], rajattuna välille [0, endLimitMs].
 */
(function (root) {
  function smooth(values, radius) {
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      let s = 0, n = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) { s += values[j]; n++; }
      out[i] = s / n;
    }
    return out;
  }

  function analyzeSwing(samples, opts = {}) {
    const {
      preRollMs = 1000,     // aloitusasentoa näkyviin ennen lyönnin alkua
      postMs = 1000,        // loppuasentoa näkyviin lyönnin jälkeen
      minStillMs = 500,     // aloitusasennon vähimmäiskesto
      finishStillMs = 400,  // loppuasennon pysähtymisen vähimmäiskesto
      peakLimitMs = Infinity, // piikkiä ei etsitä tämän jälkeen (esim. käveltiin puhelimelle)
      endLimitMs = Infinity,  // leike ei jatku tämän yli (lopeta-komento)
    } = opts;

    const result = { found: false, startMs: 0, endMs: endLimitMs };
    if (!samples || samples.length < 10) return { ...result, reason: 'liian vähän dataa' };

    const t = samples.map((s) => s.t);
    const m = smooth(samples.map((s) => s.m), 2);

    let n = t.findIndex((x) => x > Math.min(peakLimitMs, endLimitMs));
    if (n === -1) n = t.length;
    if (n < 10) return { ...result, reason: 'liian vähän dataa' };

    const sorted = m.slice(0, n).sort((a, b) => a - b);
    const noise = sorted[Math.floor(n * 0.2)];
    let p = 0;
    for (let i = 1; i < n; i++) if (m[i] > m[p]) p = i;
    const peak = m[p];
    // Piikin pitää erottua selvästi kohinasta (vähintään 2 % kuvasta liikkuu)
    if (peak - noise < 0.02 || peak < noise * 4) {
      return { ...result, reason: 'lyöntiä ei tunnistettu', noise, peak };
    }
    const low = noise + 0.08 * (peak - noise);

    // Taaksepäin: etsitään aloitusasento
    let swingStart = 0;
    let addressFound = false;
    let stillEnd = -1; // paikallaanolojakson loppu (indeksi), kun kuljetaan taaksepäin
    for (let i = p; i >= 0; i--) {
      if (m[i] < low) {
        if (stillEnd === -1) stillEnd = i;
        if (t[stillEnd] - t[i] >= minStillMs) { swingStart = stillEnd + 1; addressFound = true; break; }
      } else {
        stillEnd = -1; // tauko oli liian lyhyt aloitusasennoksi
      }
    }
    if (!addressFound) swingStart = 0;

    // Eteenpäin: etsitään loppuasento
    let swingEnd = t.length - 1;
    let stillStart = -1;
    for (let i = p; i < t.length; i++) {
      if (m[i] < low) {
        if (stillStart === -1) stillStart = i;
        if (t[i] - t[stillStart] >= finishStillMs) { swingEnd = stillStart; break; }
      } else {
        stillStart = -1;
      }
    }

    const startMs = Math.max(0, t[swingStart] - preRollMs);
    const endMs = Math.min(t[swingEnd] + postMs, endLimitMs);
    if (endMs - startMs < 500) return { ...result, reason: 'leike liian lyhyt', noise, peak };

    return {
      found: true, addressFound, startMs, endMs,
      swingStartMs: t[swingStart], impactMs: t[p], swingEndMs: t[swingEnd], noise, peak, low,
    };
  }

  root.analyzeSwing = analyzeSwing;
  if (typeof module !== 'undefined') module.exports = { analyzeSwing };
})(typeof window !== 'undefined' ? window : globalThis);
