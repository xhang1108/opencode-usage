// extension/dashboard/views/neural-layout.js
// Pure geometry for the decorative background graph: 7 columns of drifting
// nodes plus the edges between (and skipping) them. decor.js owns the canvas,
// the animation clock and the highlight spawning; this only builds the layout.
// `rand` is injectable so the layout is deterministic in tests.

export const NEURAL_XS = [0.03, 0.16, 0.3, 0.44, 0.6, 0.78, 0.97];
export const NEURAL_COUNTS = [5, 7, 10, 13, 10, 7, 5];

export function buildNeuralLayout(width, height, rand = Math.random) {
  const layers = NEURAL_XS.map((xf, li) => {
    const n = NEURAL_COUNTS[li];
    const isCenter = li === 3;
    const isEdge = li === 0 || li === 6;
    return Array.from({ length: n }, (_, i) => ({
      x: xf * width,
      baseX: xf * width,
      baseY: ((i + 1) / (n + 1)) * height,
      y: 0,
      phase: rand() * Math.PI * 2,
      driftPhase: rand() * Math.PI * 2,
      driftSpeed: 0.22 + rand() * 0.32,
      driftAmpX: 18 + rand() * 16,
      driftAmpY: 16 + rand() * 16,
      r: isCenter ? 2.6 : isEdge ? 1.4 : 1.9,
    }));
  });

  const edges = [];
  for (let li = 0; li < layers.length - 1; li++) {
    const keepProb = li === 3 ? 0.78 : li === 2 || li === 4 ? 0.68 : 0.52;
    for (let a = 0; a < layers[li].length; a++) {
      for (let b = 0; b < layers[li + 1].length; b++) {
        if (rand() > keepProb) continue;
        edges.push({ li, a, b, skip: false });
      }
    }
  }
  for (let li = 0; li < layers.length - 2; li++) {
    for (let k = 0; k < 2; k++) {
      const a = Math.floor(rand() * layers[li].length);
      const b = Math.floor(rand() * layers[li + 2].length);
      edges.push({ li, a, b, skip: true });
    }
  }

  return { layers, edges };
}
