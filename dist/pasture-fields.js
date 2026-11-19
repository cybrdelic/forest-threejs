// Field coordinates are metres. The stream lines, their tributary and the
// benches are shared by the terrain, herbage and woody succession.
const saturate = x => Math.max(0, Math.min(1, x));
const bell = (x, width) => Math.exp(-((x / width) ** 2));
function ramp(start, end, x) {
  const t = saturate((x - start) / (end - start));
  return t * t * (3 - 2 * t);
}

export function mainSwaleX(z) {
  const run = -z - 370;
  return 47 + .33 * run + 12 * Math.sin(run / 77) + 4 * Math.sin(run / 31);
}
function tributaryX(z) {
  const run = -z - 487;
  return mainSwaleX(-487) + .85 * run + 14 * Math.sin(run / 64);
}
function benchZ(x) {
  return -461 - .36 * x + 16 * Math.sin((x + 29) / 62) + 7 * Math.sin(x / 131);
}
function opposite(x,z) {
  return ramp(-185,-85,x) * (1-ramp(810,995,x))
    * ramp(-1005,-820,z+.17*x) * (1-ramp(-362,-263,z+.17*x));
}

export function pastureRelief(x,z) {
  if (x < -185 || x > 995 || z > -220 || z < -1200) return 0;
  const envelope = opposite(x,z);
  if (!envelope) return 0;
  const draw = x - mainSwaleX(z), branch = x - tributaryX(z);
  const branching = ramp(478,549,-z);
  const channel = -4.6 * bell(draw,22) - 2.9 * bell(draw,51)
    - branching * (3.6 * bell(branch,21) + 2.1 * bell(branch,46));
  const banks = 2.1 * bell(draw+35,23) + branching*1.7*bell(branch-31,18);
  const bench = (z - benchZ(x)) * .94;
  const track = -.85 * bell(bench,4.1) + .75 * bell(bench+7,7);
  const rolls = 7.8*bell(x+9+.22*(z+575),64)*bell(z+590,102)
    + 5.3*bell(x-187+.19*(z+554),45)*bell(z+555,72)
    + 3.7*bell(x-320-.32*(z+741),66)*bell(z+741,110);
  return envelope * (channel + banks + rolls + track*bell(x-57,205));
}

// Moisture, defoliation and dryness change over a field, independently of
// the current observer. Growth gaps and hoof wear at metre scales are added
// on top of these interpolated values by the plant and ground materials.
export function pastureHabitat(x,z) {
  const nearWet = .50 + .16*Math.sin(x*.026 + z*.008) + .11*Math.sin(z*.045 - x*.009);
  const nearGraze = .25 + .14*Math.sin(z*.035 - x*.015);
  const envelope = (x >= -185 && x<=995 && z<=-220 && z>=-1200) ? opposite(x,z) : 0;
  if (!envelope) return [nearWet, nearGraze, .48 - .42*nearWet];
  const draw = x - mainSwaleX(z), branch = x - tributaryX(z);
  const water = Math.max(bell(draw,24),ramp(478,549,-z)*bell(branch,19));
  const bench = (z - benchZ(x)) * .94;
  const toe = bell(bench,10)*bell(x-57,205);
  const upland = Math.max(bell(x+9+.22*(z+575),63)*bell(z+590,125),
    bell(x-187+.19*(z+554),51)*bell(z+555,93));
  const moist = saturate(.26 + .69*water + .16*nearWet - .20*upland);
  const graze = saturate(.19 + .57*upland + .49*toe + .22*bell(z+386,99)
    + .17*Math.sin(x*.024 + z*.021 + 2*Math.sin(z*.018)) - .31*water);
  const dry = saturate(.36 + .55*upland + .20*toe - .35*water + .09*Math.sin(z*.037 + x*.012));
  return [nearWet + envelope * (moist-nearWet), nearGraze + envelope * (graze-nearGraze),
    .48-.42*nearWet + envelope * (dry - (.48-.42*nearWet))];
}
