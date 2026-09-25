const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function midpoint(a, b) {
  const zero = DIGITS[0];
  if (b !== null && a >= b) {
    throw new Error(`midpoint: ${a} >= ${b}`);
  }
  if (a.endsWith(zero) || (b && b.endsWith(zero))) {
    throw new Error('midpoint: trailing zero');
  }
  if (b) {
    let n = 0;
    while ((a[n] || zero) === (b[n] || zero)) n += 1;
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
    }
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) {
    return DIGITS[Math.floor((digitA + digitB) / 2)];
  }
  const head = a.length > 0 ? a[0] : zero;
  return head + midpoint(a.slice(1), null);
}

export function generateKeyBetween(a, b) {
  if (a != null && b != null && a >= b) {
    throw new Error(`generateKeyBetween: ${a} >= ${b}`);
  }
  if (a == null) {
    return b == null ? midpoint('', null) : midpoint('', b);
  }
  return b == null ? midpoint(a, null) : midpoint(a, b);
}
