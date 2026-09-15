import { randomInt } from 'crypto';

const BASE62_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function generatePublicId(length = 11): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += BASE62_ALPHABET[randomInt(BASE62_ALPHABET.length)];
  }
  return result;
}
