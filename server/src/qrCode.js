/*
 * QR encoding and PNG rendering adapted from @juit/qrcode 1.0.104.
 * Copyright Juit Developers. Licensed under Apache-2.0.
 * The full license is stored at ./vendor/juit-qrcode/LICENSE.md.
 */

// encode.ts
var ALPHANUM = (function(s) {
  const res = {};
  for (let i = 0; i < s.length; i++) {
    res[s[i]] = i;
  }
  return res;
})("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:");
function pushBits(arr, n, value) {
  for (let bit = 1 << n - 1; bit; bit = bit >>> 1) {
    arr.push(!!(bit & value));
  }
  return arr;
}
function binaryEncode(data) {
  const len = data.length;
  const bits = [];
  for (let i = 0; i < len; i++) {
    pushBits(bits, 8, data[i]);
  }
  const d = pushBits([false, true, false, false], 16, len);
  const res = {
    data27: d.concat(bits)
  };
  res.data10 = res.data27;
  if (len < 256) {
    const d2 = pushBits([false, true, false, false], 8, len);
    res.data1 = d2.concat(bits);
  }
  return res;
}
function alphanumEncode(str) {
  const len = str.length;
  const bits = [];
  for (let i = 0; i < len; i += 2) {
    let b = 6;
    let n = ALPHANUM[str[i]];
    if (str[i + 1]) {
      b = 11;
      n = n * 45 + ALPHANUM[str[i + 1]];
    }
    pushBits(bits, b, n);
  }
  const d = pushBits([false, false, true, false], 13, len);
  const res = {
    data27: d.concat(bits)
  };
  if (len < 2048) {
    const d2 = pushBits([false, false, true, false], 11, len);
    res.data10 = d2.concat(bits);
  }
  if (len < 512) {
    const d2 = pushBits([false, false, true, false], 9, len);
    res.data1 = d2.concat(bits);
  }
  return res;
}
function numericEncode(str) {
  const len = str.length;
  const bits = [];
  for (let i = 0; i < len; i += 3) {
    const s = str.substring(i, i + 3);
    const b = Math.ceil(s.length * 10 / 3);
    pushBits(bits, b, parseInt(s, 10));
  }
  const d = pushBits([false, false, false, true], 14, len);
  const res = {
    data27: d.concat(bits)
  };
  if (len < 4096) {
    const d2 = pushBits([false, false, false, true], 12, len);
    res.data10 = d2.concat(bits);
  }
  if (len < 1024) {
    const d2 = pushBits([false, false, false, true], 10, len);
    res.data1 = d2.concat(bits);
  }
  return res;
}
function urlEncode(str) {
  const slash = str.indexOf("/", 8) + 1 || str.length;
  const res = encodeQrCodeMessage(str.slice(0, slash).toUpperCase(), false);
  if (slash >= str.length) return res;
  const path = encodeQrCodeMessage(str.slice(slash), false);
  res.data27 = res.data27.concat(path.data27);
  if (res.data10 && path.data10) {
    res.data10 = res.data10.concat(path.data10);
  }
  if (res.data1 && path.data1) {
    res.data1 = res.data1.concat(path.data1);
  }
  return res;
}
function encodeQrCodeMessage(message, url) {
  let data;
  if (typeof message === "string") {
    data = new TextEncoder().encode(message);
    if (/^[0-9]+$/.test(message)) {
      if (data.length > 7089) throw new Error(`Too much numeric data (len=${data.length})`);
      return numericEncode(message);
    }
    if (/^[0-9A-Z $%*+./:-]+$/.test(message)) {
      if (data.length > 4296) throw new Error(`Too much alphanumeric data (len=${data.length})`);
      return alphanumEncode(message);
    }
    if (url && /^https?:/i.test(message)) {
      return urlEncode(message);
    }
  } else {
    data = message;
  }
  if (data.length > 2953) throw new Error(`Too much binary data (len=${data.length})`);
  return binaryEncode(data);
}

// utils/ecc.ts
var GF256_BASE = 285;
var EXP_TABLE = [1];
var LOG_TABLE = [];
var POLYNOMIALS = [
  [0],
  // a^0 x^0
  [0, 0],
  // a^0 x^1 + a^0 x^0
  [0, 25, 1]
  // a^0 x^2 + a^25 x^1 + a^1 x^0
  // and so on...
];
for (let i = 1; i < 256; i++) {
  let n = EXP_TABLE[i - 1] << 1;
  if (n > 255) n = n ^ GF256_BASE;
  EXP_TABLE[i] = n;
}
for (let i = 0; i < 255; i++) {
  LOG_TABLE[EXP_TABLE[i]] = i;
}
function exp(k) {
  while (k < 0) k += 255;
  while (k > 255) k -= 255;
  return EXP_TABLE[k];
}
function log(k) {
  if (k < 0 || k > 255) throw new Error(`Bad log(${k})`);
  return LOG_TABLE[k];
}
function generatePolynomial(num) {
  const poly = POLYNOMIALS[num];
  if (poly) return poly;
  const prev = generatePolynomial(num - 1);
  const res = [];
  res[0] = prev[0];
  for (let i = 1; i <= num; i++) {
    res[i] = log(exp(prev[i]) ^ exp(prev[i - 1] + num - 1));
  }
  return POLYNOMIALS[num] = res;
}
function calculateEcc(buf, length) {
  const msg = [].slice.call(buf);
  const poly = generatePolynomial(length);
  for (let i = 0; i < length; i++) msg.push(0);
  while (msg.length > length) {
    if (!msg[0]) {
      msg.shift();
      continue;
    }
    const logK = log(msg[0]);
    for (let i = 0; i <= length; i++) {
      msg[i] = msg[i] ^ exp(poly[i] + logK);
    }
    msg.shift();
  }
  return msg;
}

// qrcode.ts
var EC_LEVELS = ["L", "M", "Q", "H"];
var CODEWORDS = [
  [-1, -1, -1, -1, -1, -1, -1, -1, -1],
  // there is no version 0
  [26, 7, 1, 10, 1, 13, 1, 17, 1],
  [44, 10, 1, 16, 1, 22, 1, 28, 1],
  [70, 15, 1, 26, 1, 36, 2, 44, 2],
  [100, 20, 1, 36, 2, 52, 2, 64, 4],
  [134, 26, 1, 48, 2, 72, 4, 88, 4],
  // 5
  [172, 36, 2, 64, 4, 96, 4, 112, 4],
  [196, 40, 2, 72, 4, 108, 6, 130, 5],
  [242, 48, 2, 88, 4, 132, 6, 156, 6],
  [292, 60, 2, 110, 5, 160, 8, 192, 8],
  [346, 72, 4, 130, 5, 192, 8, 224, 8],
  // 10
  [404, 80, 4, 150, 5, 224, 8, 264, 11],
  [466, 96, 4, 176, 8, 260, 10, 308, 11],
  [532, 104, 4, 198, 9, 288, 12, 352, 16],
  [581, 120, 4, 216, 9, 320, 16, 384, 16],
  [655, 132, 6, 240, 10, 360, 12, 432, 18],
  // 15
  [733, 144, 6, 280, 10, 408, 17, 480, 16],
  [815, 168, 6, 308, 11, 448, 16, 532, 19],
  [901, 180, 6, 338, 13, 504, 18, 588, 21],
  [991, 196, 7, 364, 14, 546, 21, 650, 25],
  [1085, 224, 8, 416, 16, 600, 20, 700, 25],
  // 20
  [1156, 224, 8, 442, 17, 644, 23, 750, 25],
  [1258, 252, 9, 476, 17, 690, 23, 816, 34],
  [1364, 270, 9, 504, 18, 750, 25, 900, 30],
  [1474, 300, 10, 560, 20, 810, 27, 960, 32],
  [1588, 312, 12, 588, 21, 870, 29, 1050, 35],
  // 25
  [1706, 336, 12, 644, 23, 952, 34, 1110, 37],
  [1828, 360, 12, 700, 25, 1020, 34, 1200, 40],
  [1921, 390, 13, 728, 26, 1050, 35, 1260, 42],
  [2051, 420, 14, 784, 28, 1140, 38, 1350, 45],
  [2185, 450, 15, 812, 29, 1200, 40, 1440, 48],
  // 30
  [2323, 480, 16, 868, 31, 1290, 43, 1530, 51],
  [2465, 510, 17, 924, 33, 1350, 45, 1620, 54],
  [2611, 540, 18, 980, 35, 1440, 48, 1710, 57],
  [2761, 570, 19, 1036, 37, 1530, 51, 1800, 60],
  [2876, 570, 19, 1064, 38, 1590, 53, 1890, 63],
  // 35
  [3034, 600, 20, 1120, 40, 1680, 56, 1980, 66],
  [3196, 630, 21, 1204, 43, 1770, 59, 2100, 70],
  [3362, 660, 22, 1260, 45, 1860, 62, 2220, 74],
  [3532, 720, 24, 1316, 47, 1950, 65, 2310, 77],
  [3706, 750, 25, 1372, 49, 2040, 68, 2430, 81]
  // 40
];
var VERSIONS = CODEWORDS.map((v, index) => {
  if (!index) return null;
  const res = {};
  for (let i = 1; i < 8; i += 2) {
    const length = v[0] - v[i];
    const template = v[i + 1];
    const ecLevel = EC_LEVELS[i / 2 | 0];
    const blocks = [];
    for (let k = template, n = length; k > 0; k--) {
      const block = n / k | 0;
      blocks.push(block);
      n -= block;
    }
    res[ecLevel] = {
      version: index,
      ecLevel,
      dataLen: length,
      ecLen: v[i] / template,
      blockLengths: blocks
    };
  }
  return res;
});
function getTemplate(message, ecLevel) {
  let len = NaN;
  let i = 1;
  if (message.data1) {
    len = Math.ceil(message.data1.length / 8);
  } else {
    i = 10;
  }
  for (; i < 10; i++) {
    const version = VERSIONS[i][ecLevel];
    if (version.dataLen >= len) {
      return structuredClone(version);
    }
  }
  if (message.data10) {
    len = Math.ceil(message.data10.length / 8);
  } else {
    i = 27;
  }
  for (; i < 27; i++) {
    const version = VERSIONS[i][ecLevel];
    if (version.dataLen >= len) {
      return structuredClone(version);
    }
  }
  len = Math.ceil(message.data27.length / 8);
  for (; i < 41; i++) {
    const version = VERSIONS[i][ecLevel];
    if (version.dataLen >= len) {
      return structuredClone(version);
    }
  }
  throw new Error("Too much data to encode in QR code");
}
function fillTemplate(encoded, template) {
  const blocks = new Array(template.dataLen).fill(0);
  let message;
  if (template.version < 10) {
    message = encoded.data1;
  } else if (template.version < 27) {
    message = encoded.data10;
  } else {
    message = encoded.data27;
  }
  const len = message.length;
  for (let i = 0; i < len; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = b << 1 | (message[i + j] ? 1 : 0);
    }
    blocks[i / 8] = b;
  }
  let pad = 236;
  for (let i = Math.ceil((len + 4) / 8); i < blocks.length; i++) {
    blocks[i] = pad;
    pad = pad == 236 ? 17 : 236;
  }
  let offset = 0;
  const ecData = [];
  const blockData = template.blockLengths.map((n) => {
    const b = blocks.slice(offset, offset + n);
    offset += n;
    ecData.push(calculateEcc(b, template.ecLen));
    return b;
  });
  return {
    version: template.version,
    ecLevel: template.ecLevel,
    ecData,
    blockData
  };
}
function generateQrCodeData(data, ecLevel) {
  return fillTemplate(data, getTemplate(data, ecLevel));
}

// matrix.ts
function init(version) {
  const n = version * 4 + 17;
  const matrix = new Array(n);
  for (let i = 0; i < n; i++) {
    matrix[i] = new Array(n).fill(0);
  }
  return matrix;
}
function fillFinders(matrix) {
  const n = matrix.length;
  for (let i = -3; i <= 3; i++) {
    for (let j = -3; j <= 3; j++) {
      const max = Math.max(i, j);
      const min = Math.min(i, j);
      const pixel = max == 2 && min >= -2 || min == -2 && max <= 2 ? 128 : 129;
      matrix[3 + i][3 + j] = pixel;
      matrix[3 + i][n - 4 + j] = pixel;
      matrix[n - 4 + i][3 + j] = pixel;
    }
  }
  for (let i = 0; i < 8; i++) {
    matrix[7][i] = matrix[i][7] = matrix[7][n - i - 1] = matrix[i][n - 8] = matrix[n - 8][i] = matrix[n - 1 - i][7] = 128;
  }
}
function fillAlignAndTiming(matrix) {
  const n = matrix.length;
  if (n > 21) {
    const len = n - 13;
    let delta = Math.round(len / Math.ceil(len / 28));
    if (delta % 2) delta++;
    const res = [];
    for (let p = len + 6; p > 10; p -= delta) {
      res.unshift(p);
    }
    res.unshift(6);
    for (let i = 0; i < res.length; i++) {
      for (let j = 0; j < res.length; j++) {
        const x = res[i];
        const y = res[j];
        if (matrix[x][y]) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            const max = Math.max(r, c);
            const min = Math.min(r, c);
            const pixel = max == 1 && min >= -1 || min == -1 && max <= 1 ? 128 : 129;
            matrix[x + r][y + c] = pixel;
          }
        }
      }
    }
  }
  for (let i = 8; i < n - 8; i++) {
    matrix[6][i] = matrix[i][6] = i % 2 ? 128 : 129;
  }
}
function fillStub(matrix) {
  const n = matrix.length;
  for (let i = 0; i < 8; i++) {
    if (i != 6) {
      matrix[8][i] = matrix[i][8] = 128;
    }
    matrix[8][n - 1 - i] = 128;
    matrix[n - 1 - i][8] = 128;
  }
  matrix[8][8] = 128;
  matrix[n - 8][8] = 129;
  if (n < 45) return;
  for (let i = n - 11; i < n - 8; i++) {
    for (let j = 0; j < 6; j++) {
      matrix[i][j] = matrix[j][i] = 128;
    }
  }
}
var fillReserved = (() => {
  const FORMATS = new Array(32);
  const VERSIONS = new Array(40);
  const gf15 = 1335;
  const gf18 = 7973;
  const formatsMask = 21522;
  for (let format = 0; format < 32; format++) {
    let res = format << 10;
    for (let i = 5; i > 0; i--) {
      if (res >>> 9 + i) {
        res = res ^ gf15 << i - 1;
      }
    }
    FORMATS[format] = (res | format << 10) ^ formatsMask;
  }
  for (let version = 7; version <= 40; version++) {
    let res = version << 12;
    for (let i = 6; i > 0; i--) {
      if (res >>> 11 + i) {
        res = res ^ gf18 << i - 1;
      }
    }
    VERSIONS[version] = res | version << 12;
  }
  const EC_LEVELS = { L: 1, M: 0, Q: 3, H: 2 };
  return function fillReserved2(matrix, ecLevel, mask) {
    const N = matrix.length;
    const format = FORMATS[EC_LEVELS[ecLevel] << 3 | mask];
    function _f(k) {
      return format >> k & 1 ? 129 : 128;
    }
    for (let i = 0; i < 8; i++) {
      matrix[8][N - 1 - i] = _f(i);
      if (i < 6) matrix[i][8] = _f(i);
    }
    for (let i = 8; i < 15; i++) {
      matrix[N - 15 + i][8] = _f(i);
      if (i > 8) matrix[8][14 - i] = _f(i);
    }
    matrix[7][8] = _f(6);
    matrix[8][8] = _f(7);
    matrix[8][7] = _f(8);
    const version = VERSIONS[(N - 17) / 4];
    if (!version) return;
    function _v(k) {
      return version >> k & 1 ? 129 : 128;
    }
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        matrix[N - 11 + j][i] = matrix[i][N - 11 + j] = _v(i * 3 + j);
      }
    }
  };
})();
var fillData = /* @__PURE__ */ (() => {
  const MASK_FUNCTIONS = [
    function(i, j) {
      return (i + j) % 2 == 0;
    },
    function(i, j) {
      void j;
      return i % 2 == 0;
    },
    function(i, j) {
      void i;
      return j % 3 == 0;
    },
    function(i, j) {
      return (i + j) % 3 == 0;
    },
    function(i, j) {
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0;
    },
    function(i, j) {
      return i * j % 2 + i * j % 3 == 0;
    },
    function(i, j) {
      return (i * j % 2 + i * j % 3) % 2 == 0;
    },
    function(i, j) {
      return (i * j % 3 + (i + j) % 2) % 2 == 0;
    }
  ];
  return function fillData2(matrix, data, mask) {
    const N = matrix.length;
    let row;
    let col;
    let dir = -1;
    row = col = N - 1;
    const maskFn = MASK_FUNCTIONS[mask];
    let len = data.blockData[data.blockData.length - 1].length;
    for (let i = 0; i < len; i++) {
      for (let b = 0; b < data.blockData.length; b++) {
        if (data.blockData[b].length <= i) continue;
        put(data.blockData[b][i]);
      }
    }
    len = data.ecData[0].length;
    for (let i = 0; i < len; i++) {
      for (let b = 0; b < data.ecData.length; b++) {
        put(data.ecData[b][i]);
      }
    }
    if (col > -1) {
      do {
        matrix[row][col] = maskFn(row, col) ? 1 : 0;
      } while (next());
    }
    function put(byte) {
      for (let mask2 = 128; mask2; mask2 = mask2 >> 1) {
        let pixel = !!(mask2 & byte);
        if (maskFn(row, col)) pixel = !pixel;
        matrix[row][col] = pixel ? 1 : 0;
        next();
      }
    }
    function next() {
      do {
        if (col % 2 ^ (col < 6 ? 1 : 0)) {
          if (dir < 0 && row == 0 || dir > 0 && row == N - 1) {
            col--;
            dir = -dir;
          } else {
            col++;
            row += dir;
          }
        } else {
          col--;
        }
        if (col == 6) {
          col--;
        }
        if (col < 0) {
          return false;
        }
      } while (matrix[row][col] & 240);
      return true;
    }
  };
})();
function calculatePenalty(matrix) {
  const N = matrix.length;
  let penalty = 0;
  for (let i2 = 0; i2 < N; i2++) {
    let pixel = matrix[i2][0] & 1;
    let len = 1;
    for (let j2 = 1; j2 < N; j2++) {
      const p = matrix[i2][j2] & 1;
      if (p == pixel) {
        len++;
        continue;
      }
      if (len >= 5) {
        penalty += len - 2;
      }
      pixel = p;
      len = 1;
    }
    if (len >= 5) {
      penalty += len - 2;
    }
  }
  for (let j2 = 0; j2 < N; j2++) {
    let pixel = matrix[0][j2] & 1;
    let len = 1;
    for (let i2 = 1; i2 < N; i2++) {
      const p = matrix[i2][j2] & 1;
      if (p == pixel) {
        len++;
        continue;
      }
      if (len >= 5) {
        penalty += len - 2;
      }
      pixel = p;
      len = 1;
    }
    if (len >= 5) {
      penalty += len - 2;
    }
  }
  for (let i2 = 0; i2 < N - 1; i2++) {
    for (let j2 = 0; j2 < N - 1; j2++) {
      const s = matrix[i2][j2] + matrix[i2][j2 + 1] + matrix[i2 + 1][j2] + matrix[i2 + 1][j2 + 1] & 7;
      if (s == 0 || s == 4) {
        penalty += 3;
      }
    }
  }
  let i;
  let j;
  function _i(k) {
    return matrix[i][j + k] & 1;
  }
  function _j(k) {
    return matrix[i + k][j] & 1;
  }
  for (i = 0; i < N; i++) {
    for (j = 0; j < N; j++) {
      if (j < N - 6 && _i(0) && !_i(1) && _i(2) && _i(3) && _i(4) && !_i(5) && _i(6)) {
        if (j >= 4 && !(_i(-4) || _i(-3) || _i(-2) || _i(-1))) {
          penalty += 40;
        }
        if (j < N - 10 && !(_i(7) || _i(8) || _i(9) || _i(10))) {
          penalty += 40;
        }
      }
      if (i < N - 6 && _j(0) && !_j(1) && _j(2) && _j(3) && _j(4) && !_j(5) && _j(6)) {
        if (i >= 4 && !(_j(-4) || _j(-3) || _j(-2) || _j(-1))) {
          penalty += 40;
        }
        if (i < N - 10 && !(_j(7) || _j(8) || _j(9) || _j(10))) {
          penalty += 40;
        }
      }
    }
  }
  let numDark = 0;
  for (let i2 = 0; i2 < N; i2++) {
    for (let j2 = 0; j2 < N; j2++) {
      if (matrix[i2][j2] & 1) numDark++;
    }
  }
  penalty += 10 * Math.floor(Math.abs(10 - 20 * numDark / (N * N)));
  return penalty;
}
function generateQrCodeMatrix(code) {
  const matrix = init(code.version);
  fillFinders(matrix);
  fillAlignAndTiming(matrix);
  fillStub(matrix);
  let penalty = Infinity;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    fillData(matrix, code, mask);
    fillReserved(matrix, code.ecLevel, mask);
    const p = calculatePenalty(matrix);
    if (p < penalty) {
      penalty = p;
      bestMask = mask;
    }
  }
  fillData(matrix, code, bestMask);
  fillReserved(matrix, code.ecLevel, bestMask);
  return matrix.map((row) => {
    return row.map((cell) => {
      return !!(cell & 1);
    });
  });
}

// utils/crc32.ts
var CRC_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) {
        c = 3988292384 ^ c >>> 1;
      } else {
        c = c >>> 1;
      }
    }
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(array, offset = 0, length) {
  let crc = -1;
  const end = length === void 0 ? array.length : length > 0 ? offset + length : array.length + length;
  for (let i = offset; i < end; i++) {
    crc = CRC_TABLE[(crc ^ array[i]) & 255] ^ crc >>> 8;
  }
  return (crc ^ -1) >>> 0;
}

// utils/deflate.ts
function deflate(data) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const writer = new WritableStream({
      write: (chunk) => void chunks.push(chunk)
    });
    return new Blob([data]).stream().pipeThrough(new CompressionStream("deflate")).pipeTo(writer).then(() => new Blob(chunks).arrayBuffer()).then((buffer) => new Uint8Array(buffer)).then(resolve, reject);
  });
}

// images/png.ts
var PNG_HEAD = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
var PNG_IHDR = new Uint8Array([0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0]);
var PNG_IDAT = new Uint8Array([0, 0, 0, 0, 73, 68, 65, 84]);
var PNG_IEND = new Uint8Array([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
async function png(bitmap2) {
  const chunks = [];
  chunks.push(PNG_HEAD);
  const imageHeader = new Uint8Array(PNG_IHDR);
  const imageHeaderView = new DataView(imageHeader.buffer);
  imageHeaderView.setUint32(8, bitmap2.size, false);
  imageHeaderView.setUint32(12, bitmap2.size, false);
  imageHeaderView.setUint32(21, crc32(imageHeader, 4, -4), false);
  chunks.push(imageHeader);
  const data = await deflate(bitmap2.data);
  const imageData = new Uint8Array(PNG_IDAT.length + data.length + 4);
  const imageDataView = new DataView(imageData.buffer);
  imageData.set(PNG_IDAT, 0);
  imageData.set(data, PNG_IDAT.length);
  imageDataView.setUint32(0, imageData.length - 12, false);
  imageDataView.setUint32(imageData.length - 4, crc32(imageData, 4, -4), false);
  chunks.push(imageData);
  chunks.push(PNG_IEND);
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}
function bitmap(matrix, scale, margin) {
  const n = matrix.length;
  const x = (n + 2 * margin) * scale;
  const data = new Uint8Array((x + 1) * x).fill(255);
  for (let i = 0; i < x; i++) {
    data[i * (x + 1)] = 0;
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (matrix[i][j]) {
        const offset = ((margin + i) * (x + 1) + (margin + j)) * scale + 1;
        data.fill(0, offset, offset + scale);
        for (let c = 1; c < scale; c++) {
          const chunk = data.subarray(offset, offset + scale);
          data.set(chunk, offset + c * (x + 1));
        }
      }
    }
  }
  return {
    data,
    size: x
  };
}
async function generatePng(code, options) {
  const { margin = 4, scale = 1 } = { ...options };
  const result = bitmap(code.matrix, scale, margin);
  const image = await png(result);
  return image;
}

export async function createQrPng(text, options = {}) {
  const value = String(text || '');
  if (!value) throw new Error('QR Code sem conteudo.');
  const { errorCorrectionLevel = 'M', scale = 8, margin = 4 } = options;
  const encoded = encodeQrCodeMessage(value, true);
  const data = generateQrCodeData(encoded, errorCorrectionLevel);
  const matrix = generateQrCodeMatrix(data);
  const image = await generatePng({ matrix }, { scale, margin });
  return Buffer.from(image);
}
