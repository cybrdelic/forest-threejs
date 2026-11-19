import { mainSwaleX, pastureHabitat, pastureRelief } from './pasture-fields.js';
import { meadowSoilGap } from './meadow-gaps.js';
import { packCanopyHorizon } from './aggregate-canopy.js';
import { measuredRidge } from './assets/outer-ridges.js';
import { setStandPopulation } from './stand-envelope.js';
// A deterministic 16 km² forest domain, surrounded by a larger mountain horizon.
// Positions are in metres. Mesh vertices use the renderer's twelve-float layout.
export const WORLD_SIZE = 4000;

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, value) => {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function hash(x, z) {
  let n = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function noise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  return mix(mix(hash(ix, iz), hash(ix + 1, iz), u),
    mix(hash(ix, iz + 1), hash(ix + 1, iz + 1), u), v);
}

function fbm(x, z) {
  return noise(x, z) * 0.56 + noise(x * 2.03 + 41, z * 2.03 - 15) * 0.27
    + noise(x * 4.17 - 19, z * 4.17 + 83) * 0.12
    + noise(x * 8.21 + 73, z * 8.21 + 5) * 0.05;
}

function makeRandom(seed) {
  return () => {
    seed += 0x6D2B79F5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(value, width) {
  return Math.exp(-((value / width) ** 2));
}

// A compact ridge spine has a narrow cross section and a long, unequal tail.
// Offsetting the spines exposes the gaps between successive wooded valleys.
function ridgeSpine(x, z, cx, cz, angle, length, width, height, seed) {
  const cs = Math.cos(angle), sn = Math.sin(angle);
  const dx = x - cx, dz = z - cz;
  const along = dx * cs + dz * sn;
  const cross = -dx * sn + dz * cs;
  const warp = (noise(along / 310 + seed, seed * 0.37) - 0.5) * width * 0.45;
  const profile = Math.exp(-(((cross + warp) / width) ** 2));
  const tail = Math.exp(-Math.pow(along / length, 4));
  const crests = 0.81 + fbm(along / 210 + seed, cross / 280 - seed) * 0.35;
  return profile * tail * crests * height;
}

export function terrainHeight(x, z) {
  const distanceFromMeadow = Math.hypot(x + 170, z - 210);
  // Retain the authored slopes that support grazed clearings and edge groves.
  // Measured relief supplies continuous drainage basins in the outer range.
  if (distanceFromMeadow >= 2420) return measuredRidge(x,z);
  const broadWarp = (fbm(x / 1000 + 13.2, z / 1000 - 9.1) - 0.5) * 170;
  const regional = (fbm((x + broadWarp) / 860, (z - broadWarp * 0.3) / 860) - 0.5) * 46;
  // A pasture shoulder rolls away across the near hillside. Its maximum
  // lies forty metres from the observer, leaving the camera's ground datum
  // intact while the far grass edge curves against the valley.
  const acrossMeadow = (x + 170) * 0.97365 + (z - 210) * 0.22806;
  const downMeadow = (x + 170) * 0.22806 - (z - 210) * 0.97365;
  const nearShoulder = 3.25 * gaussian(downMeadow - 47, 46)
    * gaussian(acrossMeadow + 28, 36) * smoothstep(4,20,downMeadow);
  const drainageBreak = -2.45 * gaussian(downMeadow - 62,52)
    * gaussian(acrossMeadow - 32,32) * smoothstep(6,30,downMeadow);
  // The sun-facing spur carries the grazed field above the valley hedges.
  // Two shallow converging draws divide the rise; the central specimen
  // stands on its own convex knoll instead of sinking into the near hedge.
  const fieldShoulder = (14 + 0.046 * Math.max(-190, Math.min(630, x)))
    * gaussian(x - 245, 640) * gaussian(z + 575 + 0.24*x, 312)
    + 6.2 * gaussian(x - 3, 99) * gaussian(z + 465, 77);
  const fieldDraws = -7.8 * gaussian(x - 240 + (z + 660) * 0.42, 100) * gaussian(z + 670, 254)
    - 4.1 * gaussian(x - 507 + (z + 600) * 0.75, 76) * gaussian(z + 656, 197);
  const foreground = 106 * gaussian(x + 240, 620) * gaussian(z - 410, 520);
  const leftShoulder = 20 * gaussian(x + 295, 190) * gaussian(z - 90, 255);
  const drainageX = 120 + (noise(z / 650 + 24, 17) - 0.5) * 240;
  const slopeBreak = 13 * Math.tanh((z - 210) / 155) * gaussian(x + 160, 330) * gaussian(z - 120, 440);
  const drainage = -43 * gaussian(x - drainageX, 455) * gaussian(z + 860, 1160);
  const westSpur = ridgeSpine(x, z, -690, -810, -0.42, 1040, 330, 150, 17);
  const eastSpur = ridgeSpine(x, z, 1030, -1120, 0.39, 1150, 410, 204, 43);
  const innerSpur = ridgeSpine(x, z, -650, -1780, -0.20, 1330, 430, 170, 67);
  const middleRange = ridgeSpine(x, z, 400, -2780, 0.16, 1870, 520, 284, 91);
  const westMassif = ridgeSpine(x, z, -1420, -4180, -0.09, 1810, 780, 570, 113);
  const eastMassif = ridgeSpine(x, z, 2090, -4660, 0.27, 2210, 1050, 520, 137);
  // Narrow summits punctuate the far-left skyline; they are separate forms,
  // rather than high frequency noise painted on one continuous ridge.
  const peaks = 164 * gaussian(x + 1780, 220) * gaussian(z + 4330, 330)
    + 139 * gaussian(x + 1285, 185) * gaussian(z + 4590, 300)
    + 183 * gaussian(x + 790, 240) * gaussian(z + 4680, 330)
    + 105 * gaussian(x - 1240, 410) * gaussian(z + 4970, 450);
  const flanks = 156 * gaussian(Math.abs(x) - 4070, 1560)
    * (0.60 + fbm(x / 940 + 8, z / 940 + 58) * 0.45);
  // In the forested mountains narrow tributaries incise adjoining spurs.
  // Their convergence gives the view real drainage breaks and facing slopes.
  const mountain = smoothstep(560, 1850, -z);
  const valleyAxis = x + 235 + 0.29 * (z + 1050) + 94 * Math.sin(z / 300 + 1.2);
  const channels = -mountain * (48 * gaussian(valleyAxis, 140) +
    36 * gaussian(x - 590 + 0.46 * (z + 1680) - 62 * Math.sin(z / 245), 118) +
    25 * gaussian(x + 1150 - 0.38 * (z + 2500), 163));
  // The pasture sits in front of a lower wooded saddle. Its north slope
  // falls away to reveal the smaller crowns on the next distant ridge.
  const northFace = smoothstep(670, 1090, -z);
  const leeSaddle = -northFace * (0.23 * westSpur + 0.30 * eastSpur);
  const continental = smoothstep(1400, 4050, -z);
  const folded = (fbm(x / 320 + z / 1800 + 31, z / 224 - 84) - 0.5) * 86 * continental;
  const relief = (fbm(x / 155 + 7, z / 155 - 11) - 0.5) * 16
    + (noise(x / 8.7, z / 8.7) - 0.5) * 0.36;
  const land = 161 + regional + foreground + nearShoulder + drainageBreak + fieldShoulder + fieldDraws + pastureRelief(x,z) + slopeBreak + leftShoulder + channels + folded + leeSaddle + drainage + westSpur
    + eastSpur + innerSpur + middleRange + westMassif + eastMassif + peaks + flanks + relief;
  if (distanceFromMeadow <= 1560) return land;
  return mix(land, measuredRidge(x,z),smoothstep(1560,2420,distanceFromMeadow));
}

export function terrainNormal(x, z) {
  const epsilon = 1.2;
  const nx = terrainHeight(x - epsilon, z) - terrainHeight(x + epsilon, z);
  const nz = terrainHeight(x, z - epsilon) - terrainHeight(x, z + epsilon);
  const inverseLength = 1 / Math.hypot(nx, 2 * epsilon, nz);
  return [nx * inverseLength, 2 * epsilon * inverseLength, nz * inverseLength];
}

// The near meadow wraps around the initial hillside. A second clearing across
// the valley makes the terrain readable between overlapping forest ridges.
export function meadowAmount(x, z) {
  const along = (x + 170) * 0.23 - (z - 210) * 0.97;
  const across = (x + 170) * 0.97 + (z - 210) * 0.23;
  const edge = (fbm(x / 56 + 32, z / 56 - 8) - 0.5) * 24;
  const center = 9 + along * 0.12 + (noise(along / 135 + 17, 31) - 0.5) * 23;
  const width = mix(100, 56, smoothstep(20, 235, along))
    + (noise(along / 160 - 8, 14) - 0.5) * 20;
  const foreground = (1 - smoothstep(0.71, 1.04, Math.abs(across - center + edge) / width))
    * smoothstep(-300, -180, along) * (1 - smoothstep(150, 270, along));
  // One long, slanted pasture lies on the opposite sunny shoulder. The
  // intervening drainage stays wooded, giving the two meadows real depth.
  // The grazed shoulder follows the contour up and across the east spur.
  // Its upper hedge bends around the drainage; its lower margin runs behind
  // the groups of mature trees at the near side of the valley.
  const pastureEdge = (fbm(x / 78 - 21, z / 78 + 46) - 0.5) * 0.13;
  const hedgeIndent = 21 * gaussian(x - 110,70) + 33 * gaussian(x - 470,85)
    - 28 * gaussian(x - 650,85);
  const northHedge = -717 - 0.50 * x + 36 * Math.sin(x / 175) + 45 * gaussian(x - 650,145) - 24 * gaussian(x - 240,80) + hedgeIndent;
  const southHedge = -305 - 0.10 * x + 40 * Math.sin(x / 195) - 15 * gaussian(x - 560,100);
  // The woodland wraps the uphill tip and fingers into the grazing along
  // small draws. A rounded point keeps the field from ending in two
  // hard edges meeting at a rectangular corner across the valley.
  const westHedge = -119 + 0.00092 * (z + 626) ** 2 - 0.22 * (z + 650)
    + 24 * gaussian(z + 523, 49) - 16 * gaussian(z + 682, 66);
  const eastHedge = 1100 - 0.00057 * (z + 675) ** 2;
  const westMargin = x - westHedge, northMargin = z - northHedge;
  const corner = Math.max(0, 85 - Math.abs(westMargin - northMargin));
  const upperMargin = Math.min(westMargin, northMargin) - corner * corner / 340;
  const margin = Math.min(upperMargin, eastHedge - x, southHedge - z);
  const valleyField = smoothstep(-12, 19, margin + pastureEdge * 140);
  const distantField = 1 - smoothstep(0.78, 1.03,
    Math.hypot((x + 1060) / 155, (z + 1510) / 77) + pastureEdge);
  // A narrow grassy slip follows the fall line past the far hedge. Tree
  // recruitment tapers toward its exposed spine; mature crowns can still
  // overhang the margins. It breaks the solid tree mass across the spur.
  const slipZ = z + 1188, slipX = x - 645 + slipZ * 0.57 + 11 * Math.sin(slipZ / 57);
  const slip = 1 - smoothstep(0.50, 1.14, Math.hypot(slipX / 30, slipZ / 133) + pastureEdge);
  return Math.max(foreground, valleyField, distantField, slip);
}

function pathAmount(x, z) {
  const pathX = -118 + 35 * Math.sin((z - 30) / 110) + (z - 150) * 0.18;
  const width = 0.65 + noise(z / 9, 17) * 0.4;
  const distance = Math.abs(x - pathX);
  return (1 - smoothstep(width, width + 0.65, distance))
    * smoothstep(-120, -40, z) * (1 - smoothstep(480, 610, z));
}

const cameraX = -170;
const cameraZ = 210;
export const CAMERA_START = {
  position: [cameraX, terrainHeight(cameraX, cameraZ) + 1.7, cameraZ],
  target: [90, terrainHeight(cameraX, cameraZ) + 1.0, -900]
};

function forestCover(x, z) {
  const meadow = meadowAmount(x, z);
  const pockets = smoothstep(0.22, 0.63, fbm(x / 240 + 53, z / 240 - 21));
  return clamp((1 - meadow) * (0.84 + pockets * 0.16), 0, 1);
}

function makeCoordinates() {
  // Keep at most eight metres between vertices on the visible pasture, so
  // the two converging swales change its profile and its lighting on screen.
  const positive = [];
  for (let i=0;i<=480;i+=4) positive.push(i);
  for (let i=488;i<=928;i+=8) positive.push(i);
  for (let i=942;i<=1222;i+=14) positive.push(i);
  // Match the interior interval at the join, then grow smoothly to the DEM.
  const span = 6500 - 1222, steps = 62, linear = 14;
  for (let i=1;i<=steps;i++) positive.push(1222 + linear*i + (span-linear*steps)*(i/steps)**2);
  return positive.slice(1).reverse().map(p=>-p).concat(positive);
}

// Ground-cover roots use the same piecewise planar surface that is actually
// drawn. The analytic height can lie below a rendered four-metre triangle,
// which is significant for five-centimetre clover and low meadow leaves.
let surfaceGrid;
function getSurfaceGrid() {
  if (!surfaceGrid) {
    const coordinates = makeCoordinates();
    surfaceGrid = { coordinates, heights: new Float64Array(coordinates.length ** 2).fill(NaN) };
  }
  return surfaceGrid;
}
function surfaceInterval(coordinates, value) {
  let low = 0, high = coordinates.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (coordinates[middle] <= value) low = middle;
    else high = middle;
  }
  return low;
}
export function terrainSurfaceHeight(x, z) {
  const { coordinates, heights } = getSurfaceGrid();
  const size = coordinates.length;
  if (x < coordinates[0] || z < coordinates[0] || x > coordinates[size - 1] || z > coordinates[size - 1]) {
    return terrainHeight(x, z);
  }
  const ix = surfaceInterval(coordinates, x), iz = surfaceInterval(coordinates, z);
  const u = (x - coordinates[ix]) / (coordinates[ix + 1] - coordinates[ix]);
  const v = (z - coordinates[iz]) / (coordinates[iz + 1] - coordinates[iz]);
  function sample(dx, dz) {
    const id = (iz + dz) * size + ix + dx;
    if (Number.isNaN(heights[id])) heights[id] = terrainHeight(coordinates[ix + dx], coordinates[iz + dz]);
    return heights[id];
  }
  if (u + v <= 1) {
    const a = sample(0, 0);
    return a + (sample(1, 0) - a) * u + (sample(0, 1) - a) * v;
  }
  const d = sample(1, 1);
  return d + (sample(0, 1) - d) * (1 - u) + (sample(1, 0) - d) * (1 - v);
}

export function terrainSurfaceGradient(x, z) {
  const { coordinates, heights } = getSurfaceGrid();
  const size = coordinates.length;
  if (x < coordinates[0] || z < coordinates[0] || x > coordinates[size - 1] || z > coordinates[size - 1]) {
    const epsilon = 0.05;
    return [(terrainHeight(x + epsilon, z) - terrainHeight(x - epsilon, z)) / (2 * epsilon),
      (terrainHeight(x, z + epsilon) - terrainHeight(x, z - epsilon)) / (2 * epsilon)];
  }
  const ix = surfaceInterval(coordinates, x), iz = surfaceInterval(coordinates, z);
  const dx = coordinates[ix + 1] - coordinates[ix], dz = coordinates[iz + 1] - coordinates[iz];
  const u = (x - coordinates[ix]) / dx, v = (z - coordinates[iz]) / dz;
  function sample(ox, oz) {
    const id = (iz + oz) * size + ix + ox;
    if (Number.isNaN(heights[id])) heights[id] = terrainHeight(coordinates[ix + ox], coordinates[iz + oz]);
    return heights[id];
  }
  if (u + v <= 1) {
    const a = sample(0, 0);
    return [(sample(1, 0) - a) / dx, (sample(0, 1) - a) / dz];
  }
  const d = sample(1, 1);
  return [(d - sample(0, 1)) / dx, (d - sample(1, 0)) / dz];
}

export function createLandscape() {
  const { coordinates, heights } = getSurfaceGrid();
  const size = coordinates.length;
  const vertices = new Float32Array(size * size * 12);
  const indices = new Uint32Array((size - 1) * (size - 1) * 6);
  let offset = 0;
  for (let iz = 0; iz < size; iz++) {
    const z = coordinates[iz];
    for (let ix = 0; ix < size; ix++) {
      const x = coordinates[ix];
      const gridIndex = iz * size + ix;
      if (Number.isNaN(heights[gridIndex])) heights[gridIndex] = terrainHeight(x, z);
      const y = heights[gridIndex];
      const normal = terrainNormal(x, z);
      const habitat = pastureHabitat(x,z);
      vertices.set([x, y, z, ...normal, ...habitat, 0, forestCover(x, z), meadowAmount(x, z)], offset);
      offset += 12;
    }
  }
  offset = 0;
  for (let z = 0; z < size - 1; z++) {
    for (let x = 0; x < size - 1; x++) {
      const a = z * size + x;
      const b = a + 1;
      const c = a + size;
      const d = c + 1;
      indices.set([a, c, b, b, c, d], offset);
      offset += 6;
    }
  }
  return { vertices, indices };
}

function forestWeight(x, z) {
  const meadow = meadowAmount(x, z);
  const edge = smoothstep(0.77, 0.10, meadow);
  const groves = fbm(x / 115 + 14, z / 115 + 6);
  const fineClumps = noise(x / 48 - 19, z / 48 + 37);
  const clustering = 0.60 + smoothstep(0.25, 0.68, groves) * 0.72
    + smoothstep(0.50, 0.86, fineClumps) * 0.27;
  const distance = Math.hypot(x - cameraX, z - cameraZ);
  const foregroundDensity = 0.90 + 0.66 * Math.exp(-distance / 930);
  return edge * clustering * foregroundDensity;
}

function forestCells(jacaranda) {
  const side = 112, cellSize = WORLD_SIZE / side;
  const cells = [];
  let sum = 0;
  for (let z = 0; z < side; z++) {
    for (let x = 0; x < side; x++) {
      const px = -WORLD_SIZE / 2 + (x + 0.5) * cellSize;
      const pz = -WORLD_SIZE / 2 + (z + 0.5) * cellSize;
      const weight = forestWeight(px, pz);
      if (weight < 0.10) continue;
      const habitat = fbm(px / 156 + 77.4, pz / 156 - 35.6);
      const speciesWeight = 0.40 + (jacaranda ? habitat : 1 - habitat) * 1.2;
      sum += weight * speciesWeight;
      cells.push({ x: px, z: pz, cumulative: sum, used: 0,
        jitterX: hash(x + (jacaranda ? 93 : 17), z + 377),
        jitterZ: hash(x + 539, z + (jacaranda ? 29 : 71)) });
    }
  }
  return { cells, sum, cellSize, assigned: 0 };
}

export function createTreeInstances(count) {
  const treeCount = Math.max(0, Math.floor(count));
  const instances = new Float32Array(treeCount * 8);
  const random = makeRandom(83725);
  const banks = [forestCells(false), forestCells(true)];
  for (let i = 0; i < treeCount; i++) {
    const jacaranda = i % 5 < 2;
    const bank = banks[+jacaranda];
    // A low-discrepancy selection distributes the assigned trees across
    // each occupied stand; local age and competing species vary by habitat.
    const selection = ((bank.assigned++ * 0.618033988749895 + (jacaranda ? 0.13 : 0.61)) % 1) * bank.sum;
    let low = 0, high = bank.cells.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (bank.cells[middle].cumulative < selection) low = middle + 1;
      else high = middle;
    }
    const cell = bank.cells[low], localIndex = ++cell.used;
    const qx = (localIndex * 0.754877666246693 + cell.jitterX + random() * 0.07) % 1;
    const qz = (localIndex * 0.569840290998053 + cell.jitterZ + random() * 0.07) % 1;
    let x = cell.x + (qx - 0.5) * bank.cellSize;
    let z = cell.z + (qz - 0.5) * bank.cellSize;
    if (forestWeight(x, z) < 0.08) {
      x = 0.85 * cell.x + 0.15 * x;
      z = 0.85 * cell.z + 0.15 * z;
    }
    // A small opening at the woodland inspection point lets the camera
    // stand at human height without spawning inside branches at high density.
    const dx = x + 345, dz = z + 75;
    const glade = Math.hypot(dx / 13.0, dz / 10.5);
    if (glade < 1.0) {
      const angle = Math.atan2(dz / 10.5, dx / 13.0) + (random() - 0.5) * 0.24;
      const edge = 1.0 + random() * 0.49;
      x = -345 + 13.0 * edge * Math.cos(angle);
      z = -75 + 10.5 * edge * Math.sin(angle);
    }
    const localAge = fbm(x / 109 + 13, z / 109 - 27);
    const scale = (0.65 + random() * 0.56 + localAge * 0.43) *
      (1 - 0.19 * smoothstep(0.10, 0.65, meadowAmount(x, z)));
    const phenotype = clamp(0.76 * fbm(x / 124 + 142, z / 124 - 9) + 0.24 * random(), 0, 1);
    instances.set([x, terrainSurfaceHeight(x, z) - 0.10, z, scale,
      random() * TAU, phenotype, random(), random()], i * 8);
  }

  const edgeRandom = makeRandom(719320);
  // Individually placed specimen trees along the grazed edge and opposite
  // shoulder; their trunks keep metre-scale clearance around the viewpoint.
  // The two nearest groves have staggered crown depths. The wider, open
  // compound-leaf specimens overlap dense broadleaf crowns at the pasture
  // edge, with clear sightlines through the centre into the opposite field.
  const specimens = [
    [-122, 157, 1.28, 0.83], [13, -467, 1.10, 0.94],
    [-184, 114, 1.23, 0.68], [-189, 133, 1.37, 0.91], [-188, 116, 1.49, 0.83],
    [-195, 135, 0.99, 0.67], [-109, 74, 0.87, 0.62], [-120, 152, 1.58, 0.81],
    [-172, 106, 1.61, 0.89], [176, -465, 0.63, 0.78],
    [-104, 142, 1.20, 0.72], [-165, 72, 0.76, 0.45], [-190, 144, 1.08, 0.70],
    [-131, 165, 1.45, 0.82], [-177, 116, 1.19, 0.71],
    // Interlocking young and mature canopies along different depths of the
    // near boundary, with a gap left above the isolated pasture tree.
    [-152, 82, 0.87, 0.66], [-112, 90, 1.04, 0.87], [-117, 96, 1.45, 0.94],
    [-111, 87, 1.18, 0.97], [-103, 73, 1.07, 0.88],
    [-97, 88, 1.11, 0.88], [-75, 63, 0.89, 0.64], [-145, 91, 0.92, 0.73],
    [-163, 103, 1.19, 0.87], [-165, 117, 1.30, 0.90],
  ];
  let planted = 0;
  for (const [x, z, scale, width] of specimens) {
    if (planted >= treeCount) break;
    instances.set([x, terrainSurfaceHeight(x, z) - 0.10, z, scale,
      edgeRandom() * TAU, 0.39 + edgeRandom() * 0.23, width, edgeRandom()], planted++ * 8);
  }
  const edgeGroves = [
    [-263, 95, 27, 14, 1.00], [-282, 14, 28, 11, 1.05],
    [-320, -88, 34, 10, 1.06], [-79, 73, 20, 8, 0.75],
    [-36, 21, 28, 8, 0.83], [115, -214, 35, 9, 0.94],
    [-40, -155, 45, 14, 1.20], [55, -290, 55, 20, 1.18],
    [240, -320, 70, 18, 1.10],
  ];
  for (const [cx, cz, radius, number, age] of edgeGroves) {
    for (let j = 0; j < number && planted < treeCount; j++, planted++) {
      const angle = edgeRandom() * TAU, reach = Math.sqrt(edgeRandom()) * radius;
      let x = cx + Math.cos(angle) * reach, z = cz + Math.sin(angle) * reach;
      // Apply the same camera clearing to authored edge groves. Their
      // placement can reach the inspection glade from outside its boundary.
      const gladeRadius = Math.hypot((x + 345) / 13.0, (z + 75) / 10.5);
      if (gladeRadius < 1.0) {
        const outward = 1.18 / Math.max(0.0001, gladeRadius);
        x = -345 + (x + 345) * outward;
        z = -75 + (z + 75) * outward;
      }
      const scale = j % 5 === 0 ? 0.32 + edgeRandom() * 0.22 : age * (0.83 + edgeRandom() * 0.43);
      instances.set([x, terrainSurfaceHeight(x, z) - 0.10, z, scale,
        edgeRandom() * TAU, edgeRandom(), edgeRandom(), edgeRandom()], planted * 8);
    }
  }
  // Coppice is multi-stemmed at the hedge foot. Each clump has a shared
  // age, a dominant stem and younger outward suckers. These use the same
  // measured leaf and branch geometry and the same shadow/LOD paths as the
  // surrounding trees, giving the field margin understory at several scales.
  const coppices = [
    [-167, 143, 5.5, .29, 7], [-156, 143, 3.4, .18, 6],
    [-151, 149, 4.2, .21, 7], [-122, 103, 9.6, .42, 10],
    [-119, 93, 7.9, .38, 8], [-100, 77, 9.8, .51, 8],
    [-91, 96, 5.3, .29, 8], [-184, 131, 7.4, .41, 9],
    [-177, 128, 4.5, .23, 7], [-142, 118, 5.8, .29, 8],
  ];
  for (const [cx, cz, radius, adultScale, stems] of coppices) {
    for (let j = 0; j < stems && planted < treeCount; j++, planted++) {
      const reach = j ? Math.sqrt(edgeRandom()) : 0;
      const angle = edgeRandom() * TAU;
      const x = cx + reach * radius * Math.cos(angle), z = cz + reach * radius * 0.74 * Math.sin(angle);
      const scale = adultScale * (1 - reach * 0.58) * (0.84 + 0.31 * edgeRandom());
      instances.set([x, terrainSurfaceHeight(x, z) - 0.10, z, scale,
        edgeRandom() * TAU, 0.34 + edgeRandom() * 0.36, 0.66 + 0.34 * edgeRandom(), edgeRandom()], planted * 8);
    }
  }
  setStandPopulation(instances, terrainSurfaceHeight);
  return instances;
}

export function createGrassInstances(count = 60000, centerX = cameraX, centerZ = cameraZ, spacing = 0.4) {
  const grassCount = Math.max(0, Math.floor(count));
  const instances = new Float32Array(grassCount * 8);
  if (grassCount === 0) return instances;

  // Every tuft belongs to a fixed world cell. Moving the streamed window keeps
  // the overlapping cells byte-identical, including their wind phase and tint.
  const side = Math.ceil(Math.sqrt(grassCount));
  const firstX = Math.floor(centerX / spacing / 8) * 8 - Math.floor(side / 2);
  const firstZ = Math.floor(centerZ / spacing / 8) * 8 - Math.floor(side / 2);
  for (let i = 0; i < grassCount; i++) {
    const cellX = firstX + i % side;
    const cellZ = firstZ + Math.floor(i / side);
    const seed = hash(cellX + 4921, cellZ - 3187);
    const x = (cellX + 0.06 + hash(cellX, cellZ) * 0.88) * spacing;
    const z = (cellZ + 0.06 + hash(cellX + 137, cellZ - 91) * 0.88) * spacing;
    const sizeVariation = hash(cellX + 773, cellZ - 1129);
    const [soilMoisture,grazing,dryness]=pastureHabitat(x,z);
    const wet = .73*noise(x / 10.3 + 94, z / 10.3 - 51) + .27*soilMoisture;
    const stand = noise((x + z * 0.26) / 3.6 + 211, (z - x * 0.23) / 5.8 - 129);
    const standEdge = noise((x - z * .38) / 1.39 + 17, (z + x * .38) / 2.57 + 4);
    const patch = smoothstep(.29,.74,.41*wet+.43*stand+.16*standEdge);
    const gap = Math.max(meadowSoilGap(x,z), pathAmount(x,z));
    // Reproductive stems cluster where multiple neighbouring crowns flower
    // together. Dry heads assemble on the shorter, open margins.
    const flowers = (.018 + .56 * patch ** 2.4) * (1-gap);
    const grain = (.010 + .12 * (1-patch) ** 2.8 + .032*dryness) * (1-gap);
    const herbs = .10 + .34 * smoothstep(.25,.73,wet*.44+standEdge*.56);
    const variant = seed < flowers ? 2 : seed < flowers + grain ? 3
      : seed < flowers + grain + herbs * (1 - flowers - grain) ? 1 : 0;
    const survivingCrown=hash(cellX+713,cellZ-981)<.18;
    const openness = Math.max(0,1-gap*(survivingCrown?.53:.89+.24*sizeVariation));
    const scale = (.74 + sizeVariation * .49) * (.62 + wet*.35 + stand*.55 - grazing*.25) * openness;
    // Culms laid in the same direction form swaths with upright fringes.
    // The orientation and four-bit lodging value share one float. Eight
    // radians leave a guard interval around the complete yaw range.
    const lodging = smoothstep(.53,.85,.56*stand+.30*standEdge+.14*wet);
    const drift = .75 + (wet-.5)*1.20;
    const freeYaw = (wet*1.62+stand*.58)*TAU
      + (hash(cellX-353,cellZ+613)-.5)*(2.30+2.20*stand);
    const yaw = Math.atan2((1-lodging)*Math.sin(freeYaw)+lodging*Math.sin(drift),
      (1-lodging)*Math.cos(freeYaw)+lodging*Math.cos(drift));
    const direction = (yaw+TAU)%TAU + 8*Math.round(15*lodging);
    const pigment = .04 + .92 * (wet*.25 + stand*.46 + sizeVariation*.18 + standEdge*.11);
    const phenotype = (variant + pigment) * .25;
    const gradient = terrainSurfaceGradient(x, z);
    const gradientX = clamp(gradient[0], -1.4, 1.4), gradientZ = clamp(gradient[1], -1.4, 1.4);
    // Plant meshes retain their authored height. The two former tint fields
    // carry the rendered triangle's tangent plane; +4 tags the farther bank.
    instances.set([x, terrainSurfaceHeight(x, z), z, scale,
      direction,
      gradientX, gradientZ + (spacing > 1 ? 4 : 0), phenotype], i * 8);
  }
  return instances;
}

/** A height field of interlocking crown groups carries wooded ridges past
 * the explicit populations. The macro surface follows the exact terrain,
 * so distant triangles do not intermittently cut through these crowns. */
export function createCanopyProxy() {
  const positive = [];
  for (let p = 0; p <= 3600; p += 18) positive.push(p);
  for (let p = 3627; p < 6500; p += 27) positive.push(p);
  positive.push(6500);
  const axis = positive.slice(1).reverse().map(x => -x).concat(positive);
  const side = axis.length;
  const vertices = [], indices = [];
  const lookup = new Int32Array(side * side).fill(-1);
  const crowns = new Float32Array(side * side);
  const heights = new Float32Array(side * side);
  const shades = new Float32Array(side * side);
  function crownGroup(x, z) {
    const dx = 20 * (noise(x / 85 + 63, z / 85 - 51) - 0.5);
    const dz = 20 * (noise(x / 73 - 16, z / 73 + 96) - 0.5);
    const gx = (x + dx) / 36, gz = (z + dz) / 36;
    const ix = Math.floor(gx), iz = Math.floor(gz);
    let top = 0, tone = 0;
    for (let cz = iz - 1; cz <= iz + 1; cz++) for (let cx = ix - 1; cx <= ix + 1; cx++) {
      const fx = gx - cx - 0.16 - 0.68 * hash(cx + 18, cz + 63);
      const fz = gz - cz - 0.16 - 0.68 * hash(cx - 92, cz + 27);
      const vigor = hash(cx - 33, cz - 78);
      const ellipse = Math.max(0, 1 - (fx * fx * 1.35 + fz * fz) / (0.48 + vigor * 0.42));
      const dome = Math.sqrt(ellipse) * (6.5 + 12.7 * vigor);
      if (dome > top) { top = dome; tone = vigor; }
    }
    return [top, tone];
  }

  for (let iz = 0; iz < side; iz++) for (let ix = 0; ix < side; ix++) {
    const x = axis[ix], z = axis[iz], i = iz * side + ix;
    if (Math.max(Math.abs(x), Math.abs(z)) < WORLD_SIZE * 0.5 - 44) continue;
    const base = terrainSurfaceHeight(x, z);
    const [dome, vigor] = crownGroup(x, z);
    crowns[i] = dome;
    shades[i] = vigor;
    heights[i] = base + 6 + 3 * fbm(x / 95 + 9, z / 95 + 15) + dome;
    lookup[i] = 0;
  }
  for (let iz = 0; iz < side; iz++) for (let ix = 0; ix < side; ix++) {
    const i = iz * side + ix;
    if (lookup[i] < 0) continue;
    const x = axis[ix], z = axis[iz], y = heights[i];
    const ax = ix > 0 && lookup[i - 1] >= 0 ? ix - 1 : ix;
    const bx = ix < side - 1 && lookup[i + 1] >= 0 ? ix + 1 : ix;
    const az = iz > 0 && lookup[i - side] >= 0 ? iz - 1 : iz;
    const bz = iz < side - 1 && lookup[i + side] >= 0 ? iz + 1 : iz;
    const nx = (heights[iz * side + ax] - heights[iz * side + bx]) / Math.max(1, axis[bx] - axis[ax]);
    const nz = (heights[az * side + ix] - heights[bz * side + ix]) / Math.max(1, axis[bz] - axis[az]);
    const inv = 1 / Math.hypot(nx, 1, nz);
    const stand = fbm(x / 125 - 15, z / 125 + 23), vigor = shades[i];
    const variation = 0.71 + 0.37 * stand + 0.15 * vigor;
    const horizons = packCanopyHorizon(axis, heights, lookup, ix, iz, crowns[i]);
    lookup[i] = vertices.length / 12;
    vertices.push(x, y, z, nx * inv, inv, nz * inv,
      (0.042 + 0.014 * vigor) * variation,
      (0.081 + 0.016 * vigor) * variation,
      (0.036 + 0.009 * (1 - vigor)) * variation, 2, horizons[0], horizons[1]);
  }
  for (let iz = 0; iz < side - 1; iz++) for (let ix = 0; ix < side - 1; ix++) {
    const i = iz * side + ix, a = lookup[i], b = lookup[i + 1], c = lookup[i + side], d = lookup[i + side + 1];
    if (a >= 0 && b >= 0 && c >= 0) indices.push(a, c, b);
    if (b >= 0 && c >= 0 && d >= 0) indices.push(b, c, d);
  }
  // Lower, partly open coppice connects the floor between mature crowns.
  // The terrain shader sinks this representation into the real ground when
  // an observer approaches it and the individual trees resolve.
  const step = 12, n = 333;
  const under = new Int32Array(n * n).fill(-1);
  const underY = new Float32Array(n * n), above = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const i = iz * n + ix, x = (ix - (n - 1) * 0.5) * step, z = (iz - (n - 1) * 0.5) * step;
    const field = meadowAmount(x, z);
    if (field > 0.49) continue;
    const stand = fbm(x / 109 - 13, z / 109 + 77);
    const copse = noise(x / 17.5 + 9.4, z / 17.5 - 34.3);
    // Young woodland is low and irregular and breaks up along the hedge.
    const crownHeight = (2.0 + 4.6 * copse + 2.9 * stand) * (1.0 - smoothstep(0.12,0.62,field));
    above[i] = crownHeight;
    underY[i] = terrainSurfaceHeight(x, z) + crownHeight;
    under[i] = 0;
  }
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const i = iz * n + ix;
    if (under[i] < 0) continue;
    const x = (ix - (n - 1) * 0.5) * step, z = (iz - (n - 1) * 0.5) * step;
    const ax = ix > 0 && under[i-1] >= 0 ? ix - 1 : ix;
    const bx = ix < n-1 && under[i+1] >= 0 ? ix + 1 : ix;
    const az = iz > 0 && under[i-n] >= 0 ? iz - 1 : iz;
    const bz = iz < n-1 && under[i+n] >= 0 ? iz + 1 : iz;
    const nx = (underY[iz*n+ax] - underY[iz*n+bx]) / Math.max(1,(bx-ax)*step);
    const nz = (underY[az*n+ix] - underY[bz*n+ix]) / Math.max(1,(bz-az)*step);
    const inv = 1 / Math.hypot(nx,1,nz), vigor = noise(x / 37 - 81, z / 37 + 22);
    under[i] = vertices.length / 12;
    vertices.push(x,underY[i],z,nx*inv,inv,nz*inv,
      0.051+0.018*vigor,0.085+0.033*vigor,0.043+0.009*vigor,2,-2,above[i]);
  }
  for (let iz = 0; iz < n-1; iz++) for (let ix = 0; ix < n-1; ix++) {
    const i = iz*n+ix, a = under[i], b = under[i+1], c = under[i+n], d = under[i+n+1];
    if (a >= 0 && b >= 0 && c >= 0) indices.push(a,c,b);
    if (b >= 0 && c >= 0 && d >= 0) indices.push(b,c,d);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}
