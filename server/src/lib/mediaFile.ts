import fs from "node:fs";

/**
 * Structural media validation that does NOT spawn ffmpeg/ffprobe.
 *
 * Catches the failure mode that actually bites in production: a truncated MP4
 * (an interrupted generation leaves a file with ftyp+mdat but no moov — ffmpeg
 * then dies with "moov atom not found") or a non-media file that a bare size
 * check would happily serve to the renderer.
 *
 * - MP4/MOV/M4V: walk the ISO-BMFF top-level box table until `moov` is found.
 * - WebM/MKV: check the EBML magic number.
 * - Unknown extensions: stay optimistic (never brick files we don't know).
 */
export function isReadableMediaFile(filePath: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return false; // missing / unreadable
  }
  if (!st.isFile() || st.size < 1024) return false;

  const ext = (filePath.toLowerCase().split(".").pop() ?? "");
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");

    if (ext === "webm" || ext === "mkv") {
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      return buf.readUInt32BE(0) === 0x1a45dfa3; // EBML magic
    }

    if (ext === "mp4" || ext === "mov" || ext === "m4v") {
      return walkBoxesForMoov(fd, st.size);
    }

    return true; // unknown container — don't reject what we can't judge
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function readU32(fd: number, pos: number): number | null {
  const buf = Buffer.alloc(4);
  const read = fs.readSync(fd, buf, 0, 4, pos);
  return read === 4 ? buf.readUInt32BE(0) : null;
}

function readType(fd: number, pos: number): string | null {
  const buf = Buffer.alloc(4);
  const read = fs.readSync(fd, buf, 0, 4, pos);
  return read === 4 ? buf.toString("latin1", 0, 4) : null;
}

/**
 * Walk top-level ISO-BMFF boxes. Returns true only when a well-formed `moov`
 * box (the index ffmpeg needs) is reachable within the file's actual size —
 * i.e. the file is structurally complete. Any box claiming to extend past EOF
 * means the file was truncated mid-write.
 */
function walkBoxesForMoov(fd: number, fileSize: number): boolean {
  let offset = 0;
  let guard = 0;

  while (offset + 8 <= fileSize && guard++ < 4096) {
    const size32 = readU32(fd, offset);
    const type = readType(fd, offset + 4);
    if (size32 === null || type === null) return false;

    let headerLen = 8;
    let boxSize: number;

    if (size32 === 1) {
      // 64-bit largesize — bytes 8..15 of the header.
      const buf = Buffer.alloc(8);
      if (fs.readSync(fd, buf, 0, 8, offset + 8) !== 8) return false;
      const big = buf.readBigUInt64BE(0);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      boxSize = Number(big);
      headerLen = 16;
    } else if (size32 === 0) {
      boxSize = fileSize - offset; // box extends to EOF
    } else {
      boxSize = size32;
    }

    if (boxSize < headerLen) return false; // corrupt size field

    if (type === "moov") {
      // A moov that claims to extend past the end of the file is a truncated
      // moov — exactly the "moov atom not found" case.
      return offset + boxSize <= fileSize;
    }

    if (offset + boxSize > fileSize) return false; // truncated before any moov
    offset += boxSize;
  }

  return false; // walked the whole file without finding moov
}
