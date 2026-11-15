// Builds the Chrome version from src/ (the Firefox source):
//   dist/chrome/                              unpacked, for chrome://extensions
//   dist/remote-for-deezer-chrome-<version>.zip  for the Chrome Web Store
// No dependencies: Node.js 20+ only.

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const overrides = join(root, "platform", "chrome");
const dist = join(root, "dist");
const out = join(dist, "chrome");

const PNG_ICONS = { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" };
// Chrome allows at most 4 commands with a default shortcut: the volume ones
// are left for the user to set in chrome://extensions/shortcuts.
const NO_DEFAULT_SHORTCUT = ["volume-up", "volume-down"];
// Firefox-only permissions, and Firefox names of Chrome ones.
const DROPPED_PERMISSIONS = new Set(["tabHide"]);
const RENAMED_PERMISSIONS = { menus: "contextMenus" };

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

function chromeManifest(manifest) {
  const m = structuredClone(manifest);
  delete m.browser_specific_settings;
  m.minimum_chrome_version = "120";
  m.icons = PNG_ICONS;
  m.action.default_icon = PNG_ICONS;
  m.background = { service_worker: manifest.background.scripts[0], type: "module" };
  m.permissions = m.permissions
    .filter((p) => !DROPPED_PERMISSIONS.has(p))
    .map((p) => RENAMED_PERMISSIONS[p] ?? p);
  for (const name of NO_DEFAULT_SHORTCUT) delete m.commands[name]?.suggested_key;
  return m;
}

function build() {
  rmSync(out, { recursive: true, force: true });
  cpSync(src, out, { recursive: true });
  // Chrome doesn't use SVG icons.
  rmSync(join(out, "icons", "icon.svg"), { force: true });

  writeJson(join(out, "manifest.json"), chromeManifest(readJson(join(src, "manifest.json"))));

  // Chrome wording ("Chrome" instead of "Firefox", no hidden tab…): only the
  // overridden keys, the rest comes from src/_locales.
  const localesDir = join(overrides, "_locales");
  for (const lang of readdirSync(localesDir)) {
    const target = join(out, "_locales", lang, "messages.json");
    if (!existsSync(target)) continue;
    writeJson(target, { ...readJson(target), ...readJson(join(localesDir, lang, "messages.json")) });
  }
}

// Minimal ZIP writer (deflate), enough for the Chrome Web Store.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function zip(dir, zipPath) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of listFiles(dir).sort()) {
    const name = Buffer.from(relative(dir, file).split(sep).join("/"));
    const data = readFileSync(file);
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0, 10); // time
    header.writeUInt16LE(0x21, 12); // date: 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    locals.push(header, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    header.copy(central, 8, 6, 30); // flags … name length
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += header.length + name.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(zipPath, Buffer.concat([...locals, ...centrals, end]));
}

build();
const { version } = readJson(join(out, "manifest.json"));
mkdirSync(dist, { recursive: true });
const zipPath = join(dist, `remote-for-deezer-chrome-${version}.zip`);
zip(out, zipPath);
console.log(`Chrome build: ${relative(root, out)}/ and ${relative(root, zipPath)}`);
