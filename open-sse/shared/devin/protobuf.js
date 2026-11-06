import { DEVIN } from "../../config/devin.js";

function varint(value) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid protobuf integer");
  let n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error("Protobuf uint64 overflow");
  const bytes = [];
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Buffer.from(bytes);
}
function tag(number, wireType) {
  if (!Number.isInteger(number) || number < 1 || number > 0x1fffffff) throw new Error("Invalid protobuf field number");
  return varint(BigInt(number) * 8n + BigInt(wireType));
}
export function encodeVarintField(number, value) {
  return Buffer.concat([tag(number, 0), varint(value)]);
}
export function encodeBytesField(number, value) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return Buffer.concat([tag(number, 2), varint(bytes.length), bytes]);
}
export function encodeDoubleField(number, value) {
  if (!Number.isFinite(value)) throw new Error("Invalid protobuf double");
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value);
  return Buffer.concat([tag(number, 1), bytes]);
}

/** Bounded, nonrecursive wire decoder. Bytes/fixed values are Buffer slices;
 * varints are BigInt (no silent uint64 precision loss). Groups are rejected. */
export function decodeProtobuf(input, { maxBytes = DEVIN.maxDecompressedBytes, maxFields = DEVIN.maxProtobufFields } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > maxBytes) throw new Error("Protobuf message exceeds size limit");
  let offset = 0;
  const fields = [];
  const readVarint = () => {
    let n = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new Error("Truncated protobuf varint");
      const b = bytes[offset++];
      if (i === 9 && b > 1) throw new Error("Protobuf varint overflow");
      n |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) return n;
    }
    throw new Error("Protobuf varint overflow");
  };
  while (offset < bytes.length) {
    if (fields.length >= maxFields) throw new Error("Protobuf field count exceeds limit");
    const key = readVarint();
    const number = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (number < 1 || number > 0x1fffffff) throw new Error("Invalid protobuf field number");
    let value;
    if (wireType === 0) value = readVarint();
    else {
      let size;
      if (wireType === 1) size = 8;
      else if (wireType === 5) size = 4;
      else if (wireType === 2) {
        const length = readVarint();
        if (length > BigInt(bytes.length - offset)) throw new Error("Truncated protobuf bytes");
        size = Number(length);
      } else throw new Error(`Unsupported protobuf wire type ${wireType}`);
      if (size > bytes.length - offset) throw new Error("Truncated protobuf fixed field");
      value = bytes.subarray(offset, offset + size);
      offset += size;
    }
    fields.push({ number, wireType, value });
  }
  return fields;
}

export function protobufNumber(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Protobuf number exceeds safe integer range");
  return Number(value);
}
