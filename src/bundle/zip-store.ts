const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;

export interface StoreZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface ReadStoreZipEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly crc32: number;
}

export class StoreZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreZipError";
  }
}

/** Store-only ZIP with fixed zero DOS timestamps and caller-defined entry order. */
export function createStoreZip(entries: readonly StoreZipEntry[]): Buffer {
  if (entries.length === 0) {
    throw new StoreZipError("ZIP requires at least one entry");
  }
  if (entries.length > 0xffff) {
    throw new StoreZipError("ZIP64 entry counts are not supported");
  }
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const names = new Set<string>();
  let offset = 0;

  for (const entry of entries) {
    if (names.has(entry.name)) {
      throw new StoreZipError(`duplicate ZIP entry '${entry.name}'`);
    }
    names.add(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    if (name.length === 0 || name.length > 0xffff || name.includes(0)) {
      throw new StoreZipError("ZIP entry name length is invalid");
    }
    if (data.length > 0xffffffff) {
      throw new StoreZipError("ZIP64 entry sizes are not supported");
    }
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
    if (offset > 0xffffffff) {
      throw new StoreZipError("ZIP64 archive sizes are not supported");
    }
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function readStoreZip(input: Uint8Array): readonly ReadStoreZipEntry[] {
  const zip = Buffer.from(input);
  if (zip.length < 22 || zip.readUInt32LE(zip.length - 22) !== END_SIGNATURE) {
    throw new StoreZipError("ZIP end of central directory was not found");
  }
  const endOffset = zip.length - 22;
  const diskNumber = zip.readUInt16LE(endOffset + 4);
  const centralDisk = zip.readUInt16LE(endOffset + 6);
  const diskCount = zip.readUInt16LE(endOffset + 8);
  const count = zip.readUInt16LE(endOffset + 10);
  const centralSize = zip.readUInt32LE(endOffset + 12);
  const centralOffset = zip.readUInt32LE(endOffset + 16);
  const commentLength = zip.readUInt16LE(endOffset + 20);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskCount !== count ||
    commentLength !== 0 ||
    centralOffset + centralSize !== endOffset
  ) {
    throw new StoreZipError("unsupported or malformed ZIP directory");
  }

  const entries: ReadStoreZipEntry[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    assertRange(zip, cursor, 46, "ZIP central directory");
    if (zip.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new StoreZipError("ZIP central directory signature is invalid");
    }
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const expectedCrc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const entryCommentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const centralEntryLength =
      46 + nameLength + extraLength + entryCommentLength;
    assertRange(zip, cursor, centralEntryLength, "ZIP central entry");
    const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString("utf8");
    if (method !== 0 || compressedSize !== size || flags !== UTF8_FLAG) {
      throw new StoreZipError(
        "only deterministic UTF-8 store-only ZIP is supported",
      );
    }
    if (names.has(name))
      throw new StoreZipError(`duplicate ZIP entry '${name}'`);
    names.add(name);

    assertRange(zip, localOffset, 30, "ZIP local header");
    if (zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new StoreZipError("ZIP local header signature is invalid");
    }
    const localFlags = zip.readUInt16LE(localOffset + 6);
    const localMethod = zip.readUInt16LE(localOffset + 8);
    const localCrc = zip.readUInt32LE(localOffset + 14);
    const localCompressedSize = zip.readUInt32LE(localOffset + 18);
    const localSize = zip.readUInt32LE(localOffset + 22);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const localNameOffset = localOffset + 30;
    const dataOffset = localNameOffset + localNameLength + localExtraLength;
    assertRange(zip, localNameOffset, localNameLength, "ZIP local entry name");
    assertRange(zip, dataOffset, size, "ZIP entry data");
    const localName = zip.subarray(
      localNameOffset,
      localNameOffset + localNameLength,
    );
    if (
      !localName.equals(nameBytes) ||
      localFlags !== flags ||
      localMethod !== method ||
      localCrc !== expectedCrc ||
      localCompressedSize !== compressedSize ||
      localSize !== size
    ) {
      throw new StoreZipError(`ZIP entry '${name}' headers do not agree`);
    }
    const data = zip.subarray(dataOffset, dataOffset + size);
    if (crc32(data) !== expectedCrc) {
      throw new StoreZipError(`ZIP entry '${name}' CRC does not match`);
    }
    entries.push({ name, data: Buffer.from(data), crc32: expectedCrc });
    cursor += centralEntryLength;
  }
  if (cursor !== endOffset) {
    throw new StoreZipError("ZIP central directory length does not match");
  }
  return entries;
}

export function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertRange(
  buffer: Buffer,
  offset: number,
  length: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new StoreZipError(`${label} is out of bounds`);
  }
}
