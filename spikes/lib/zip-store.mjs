const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

export function createStoreZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("ZIPには1件以上のentryが必要です。");
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    if (name.length === 0 || name.length > 0xffff)
      throw new Error("ZIP entry名の長さが不正です。");
    if (data.length > 0xffffffff)
      throw new Error("ZIP64が必要なサイズには対応していません。");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
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
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
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

export function readStoreZip(input) {
  const zip = Buffer.from(input);
  if (zip.length < 22 || zip.readUInt32LE(zip.length - 22) !== END_SIGNATURE) {
    throw new Error("ZIP end of central directoryが見つかりません。");
  }
  const endOffset = zip.length - 22;
  const count = zip.readUInt16LE(endOffset + 10);
  const centralOffset = zip.readUInt32LE(endOffset + 16);
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(cursor) !== CENTRAL_SIGNATURE)
      throw new Error("ZIP central directoryが不正です。");
    const method = zip.readUInt16LE(cursor + 10);
    const expectedCrc = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    if (method !== 0) throw new Error("store-only ZIP以外は読み取れません。");
    if (zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE)
      throw new Error("ZIP local headerが不正です。");
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(dataOffset, dataOffset + size);
    if (data.length !== size || crc32(data) !== expectedCrc)
      throw new Error(`ZIP entry ${name} のCRCが一致しません。`);
    entries.push({ name, data: Buffer.from(data), crc32: expectedCrc });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function crc32(input) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
