/* ============================================================================
 * 确定性随机与噪声
 * 同一颗种子永远生成同一张地图 —— 方便复现 bug、也方便分享地图种子。
 * ==========================================================================*/
var RNG = (function () {
  'use strict';

  /* mulberry32：小巧、分布均匀、可复现 */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash2(x, y, seed) {
    var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /* 平滑插值，避免噪声出现方格感 */
  function smooth(t) { return t * t * (3 - 2 * t); }

  function valueNoise(x, y, seed) {
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = smooth(x - x0), fy = smooth(y - y0);
    var v00 = hash2(x0, y0, seed), v10 = hash2(x0 + 1, y0, seed);
    var v01 = hash2(x0, y0 + 1, seed), v11 = hash2(x0 + 1, y0 + 1, seed);
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
  }

  /* 多倍频叠加，得到更自然的团块分布 */
  function fbm(x, y, seed, octaves) {
    var sum = 0, amp = 0.5, freq = 1, norm = 0;
    octaves = octaves || 3;
    for (var i = 0; i < octaves; i++) {
      sum += valueNoise(x * freq, y * freq, seed + i * 1013) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  return { makeRng: makeRng, hash2: hash2, valueNoise: valueNoise, fbm: fbm };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = RNG; }
else { window.MYC = window.MYC || {}; window.MYC.RNG = RNG; }
