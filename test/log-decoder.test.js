const assert = require("node:assert/strict");
const test = require("node:test");
const {
  alignTailToLine,
  completeLineByteLength,
  decodeLogBuffer
} = require("../server/log-decoder");

test("project log decoder handles UTF-8 and GB18030 lines in one buffer", () => {
  const utf8 = Buffer.from("服务已启动\r\n", "utf8");
  const gb18030 = Buffer.from("d6d5d6b9c5fab4a6c0edb2d9d7f7c2f028592f4e293f200d0a", "hex");
  const content = decodeLogBuffer(Buffer.concat([
    Buffer.from("^C", "ascii"),
    utf8,
    gb18030,
    Buffer.from("exit=-1073741510\r\n", "ascii")
  ]));

  assert.equal(content, "^C服务已启动\r\n终止批处理操作吗(Y/N)? \r\nexit=-1073741510\r\n");
  assert.doesNotMatch(content, /�/);
});

test("project log decoder preserves ASCII and incomplete fallback data", () => {
  assert.equal(decodeLogBuffer(Buffer.from("server ready\n", "ascii")), "server ready\n");
  assert.doesNotThrow(() => decodeLogBuffer(Buffer.from([0xff, 0xfe, 0xfd])));
});

test("log synchronization advances only through complete lines until final flush", () => {
  const buffer = Buffer.from("first\npartial", "utf8");
  assert.equal(completeLineByteLength(buffer, false), 6);
  assert.equal(completeLineByteLength(buffer, true), buffer.length);
  assert.equal(completeLineByteLength(Buffer.from("partial"), false), 0);
});

test("raw log tail alignment discards only its first partial line", () => {
  const buffer = Buffer.from("partial\ncomplete\n", "ascii");
  assert.equal(alignTailToLine(buffer).toString("ascii"), "complete\n");
  assert.equal(alignTailToLine(Buffer.from("single", "ascii")).toString("ascii"), "single");
});
