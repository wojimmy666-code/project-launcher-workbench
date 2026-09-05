const { TextDecoder } = require("node:util");

function decodeLogBuffer(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || "");
  if (!buffer.length) return "";

  const parts = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    parts.push(decodeLogLine(buffer.subarray(start, index + 1)));
    start = index + 1;
  }
  if (start < buffer.length) {
    parts.push(decodeLogLine(buffer.subarray(start)));
  }
  return parts.join("");
}

function decodeLogLine(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("gb18030", { fatal: true }).decode(buffer);
    } catch {
      return buffer.toString("utf8");
    }
  }
}

function completeLineByteLength(buffer, flush = false) {
  if (flush || !buffer.length) return buffer.length;
  const lastNewline = buffer.lastIndexOf(0x0a);
  return lastNewline === -1 ? 0 : lastNewline + 1;
}

function alignTailToLine(buffer) {
  if (!buffer.length) return buffer;
  const firstNewline = buffer.indexOf(0x0a);
  return firstNewline === -1 ? buffer : buffer.subarray(firstNewline + 1);
}

module.exports = {
  alignTailToLine,
  completeLineByteLength,
  decodeLogBuffer
};
