const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

function encodeTimePart(timestamp: number): string {
  let value = Math.max(0, Math.floor(timestamp));
  let output = "";
  for (let idx = 0; idx < TIME_LENGTH; idx += 1) {
    output = ENCODING[value % 32] + output;
    value = Math.floor(value / 32);
  }
  return output;
}

function encodeRandomPart(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let output = "";
  for (let idx = 0; idx < bytes.length; idx += 1) {
    output += ENCODING[bytes[idx] % 32];
  }
  return output;
}

export function createUlid(timestamp = Date.now()): string {
  return `${encodeTimePart(timestamp)}${encodeRandomPart(RANDOM_LENGTH)}`;
}
