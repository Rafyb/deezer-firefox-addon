// Extracts two colors from a cover (top half, bottom half) for the popup's
// background gradient. Deezer's CDN sends Access-Control-Allow-Origin: *,
// so the canvas isn't tainted.

const SAMPLE_SIZE = 32;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Unreadable cover: ${url}`));
    img.src = url;
  });
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

// Saturation-weighted average: colorful areas count more than greys,
// otherwise a vivid cover on a white background would give a dull gradient.
function averageColor(data, fromRow, toRow) {
  let r = 0, g = 0, b = 0, total = 0;
  for (let y = fromRow; y < toRow; y++) {
    for (let x = 0; x < SAMPLE_SIZE; x++) {
      const i = (y * SAMPLE_SIZE + x) * 4;
      const [pr, pg, pb] = [data[i], data[i + 1], data[i + 2]];
      const saturation = (Math.max(pr, pg, pb) - Math.min(pr, pg, pb)) / 255;
      const weight = 0.15 + saturation;
      r += pr * weight; g += pg * weight; b += pb * weight;
      total += weight;
    }
  }
  return [r / total, g / total, b / total];
}

// Darkens the color so white text stays readable.
function toBackground([r, g, b], maxLightness) {
  const [h, s, l] = rgbToHsl(r, g, b);
  const sat = Math.min(s, 0.7) * 100;
  const light = Math.min(l, maxLightness) * 100;
  return `hsl(${h.toFixed(0)} ${sat.toFixed(0)}% ${light.toFixed(0)}%)`;
}

export async function extractCoverColors(url) {
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const half = SAMPLE_SIZE / 2;
  return {
    top: toBackground(averageColor(data, 0, half), 0.34),
    bottom: toBackground(averageColor(data, half, SAMPLE_SIZE), 0.2),
  };
}
