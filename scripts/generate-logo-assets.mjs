import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");
const source = join(root, "public", "logo.svg");
const output = join(root, "logo.ico");
const buildDirectory = join(root, ".icon-build");
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const chromeCandidates = [
  join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
];
const chrome = chromeCandidates.find((candidate) => candidate && existsSync(candidate));
const ffmpegCandidates = [
  "D:\\Tools\\ffmpeg-8.1.1\\bin\\ffmpeg.exe",
  "ffmpeg.exe",
];
const ffmpeg = ffmpegCandidates.find((candidate) => {
  try {
    execFileSync(candidate, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

if (!chrome) {
  throw new Error("Google Chrome was not found.");
}
if (!ffmpeg) {
  throw new Error("FFmpeg was not found.");
}
if (!existsSync(source)) {
  throw new Error(`Missing SVG source: ${source}`);
}

rmSync(buildDirectory, { recursive: true, force: true });
mkdirSync(buildDirectory, { recursive: true });

const htmlPath = join(buildDirectory, "render.html");
const sourcePng = join(buildDirectory, "logo-source.png");
const svg = readFileSync(source, "utf8");
writeFileSync(
  htmlPath,
  `<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`,
  "utf8",
);

try {
  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-extensions",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--force-device-scale-factor=1",
      "--default-background-color=00000000",
      `--user-data-dir=${join(buildDirectory, "profile")}`,
      "--window-size=1024,1024",
      `--screenshot=${sourcePng}`,
      pathToFileURL(htmlPath).href,
    ],
    { stdio: "ignore" },
  );

  const sourceBytes = readFileSync(sourcePng);
  if (sourceBytes.readUInt32BE(16) !== 1024 || sourceBytes.readUInt32BE(20) !== 1024 || sourceBytes.length < 10000) {
    throw new Error("Chrome did not render a valid 1024px source image.");
  }

  const images = sizes.map((size) => {
    const pngPath = join(buildDirectory, `logo-${size}.png`);
    execFileSync(
      ffmpeg,
      ["-y", "-i", sourcePng, "-vf", `scale=${size}:${size}:flags=lanczos`, "-frames:v", "1", pngPath],
      { stdio: "ignore" },
    );

    const bytes = readFileSync(pngPath);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width !== size || height !== size) {
      throw new Error(`Chrome rendered ${width}x${height}; expected ${size}x${size}.`);
    }
    return { size, bytes };
  });

  const directorySize = 6 + images.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = directorySize;
  images.forEach(({ size, bytes }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });

  writeFileSync(output, Buffer.concat([header, ...images.map(({ bytes }) => bytes)]));
  console.log(`Generated ${output} (${sizes.join(", ")} px)`);
} finally {
  rmSync(buildDirectory, { recursive: true, force: true });
}
