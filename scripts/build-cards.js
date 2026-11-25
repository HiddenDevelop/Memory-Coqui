'use strict';

// Turns the source art in public/coqui-images into small web card images.
// - Crops each image to its clean rounded card (dropping the ragged transparent edge)
// - Resizes to 400px wide WebP in public/cards/
// - Writes src/cards.json with { id, name } for every card, which the server deals from.
// Run with: npm run build:cards

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'coqui-images');
const OUT = path.join(ROOT, 'public', 'cards');
const MANIFEST = path.join(ROOT, 'src', 'cards.json');
const WIDTH = 400;
const INSET = 14; // px inside the detected card edge, to skip the soft border

// Card names as printed on the art, where the filename doesn't say it.
const NAME_OVERRIDES = {
  'Golden-Brown Frog on Leaf': 'Coquí de Juan Rivero',
  'Hedrick’s Coquí Frog Card': 'Coquí de Hedrick',
};

function nameFromFile(base) {
  if (NAME_OVERRIDES[base]) return NAME_OVERRIDES[base];
  return base
    .replace(/\s+(on|en)\s+.*$/i, '')
    .replace(/\s+(Frog\s+)?(Flashcard|Card|Field Guide)$/i, '')
    .trim();
}

function slug(name) {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^coqui\s+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Find the card's bounding box: the first run of solid, light pixels from each side.
async function findCard(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const isCard = (x, y) => {
    const i = (y * W + x) * C;
    return data[i + 3] > 250 && data[i] > 200 && data[i + 1] > 180 && data[i + 2] > 160;
  };
  const scan = (len, dir, test) => {
    for (let i = dir > 0 ? 0 : len - 1; i >= 0 && i < len; i += dir) {
      let ok = true;
      for (let k = 0; k < 20 && ok; k++) {
        const j = i + dir * k;
        ok = j >= 0 && j < len && test(j);
      }
      if (ok) return i;
    }
    throw new Error(`Could not find card edge in ${path.basename(file)}`);
  };
  const row = Math.round(H * 0.15);
  const col = Math.round(W * 0.3);
  const left = scan(W, 1, (x) => isCard(x, row));
  const right = scan(W, -1, (x) => isCard(x, row));
  const top = scan(H, 1, (y) => isCard(col, y));
  const bottom = scan(H, -1, (y) => isCard(col, y));
  return {
    left: left + INSET,
    top: top + INSET,
    width: right - left - INSET * 2,
    height: bottom - top - INSET * 2,
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, f));

  const files = fs.readdirSync(SRC).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  const cards = [];
  for (const file of files) {
    const base = file.replace(/\.[^.]+$/, '');
    const name = nameFromFile(base);
    const id = slug(name);
    if (cards.some((c) => c.id === id)) throw new Error(`Duplicate card id "${id}" from ${file}`);
    const src = path.join(SRC, file);
    const box = await findCard(src);
    await sharp(src)
      .extract(box)
      .resize({ width: WIDTH })
      .flatten({ background: '#f6dfd2' })
      .webp({ quality: 82 })
      .toFile(path.join(OUT, `${id}.webp`));
    cards.push({ id, name });
    console.log(`${id.padEnd(16)} ${name}`);
  }
  fs.writeFileSync(MANIFEST, `${JSON.stringify(cards, null, 2)}\n`);
  console.log(`\n${cards.length} cards written to public/cards and src/cards.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
