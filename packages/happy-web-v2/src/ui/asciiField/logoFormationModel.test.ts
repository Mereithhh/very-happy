import { describe, expect, it } from 'vitest';
import { markMask } from '@/ui/veryHappyMarkGeometry';
import { FACE_END, FORMATION_TOTAL, GATHER_END, buildParticles, formationGrid, particleAt, svgOpacityAt } from './logoFormationModel';

const grid = formationGrid(120, 4, 8);
const mask = markMask(grid.cols, grid.rows, 3);
const spread = { x: -400, y: -200, w: 1400, h: 800 };
const particles = buildParticles(mask, 4, 8, spread);

describe('B-720 × B-724 logo formation', () => {
  it('finishes within 2.5 s and every particle has landed by the end of the gather phase', () => {
    expect(FORMATION_TOTAL).toBeLessThanOrEqual(2.5);
    for (const p of particles) expect(p.delay + p.duration).toBeLessThanOrEqual(GATHER_END + 1e-9);
  });

  it('one particle per block cell; ^_^ cells are marked to clear', () => {
    const blockCells = [...mask.block].filter((v) => v >= 0.35).length;
    expect(particles).toHaveLength(blockCells);
    expect(particles.some((p) => p.face)).toBe(true);
    expect(particles.filter((p) => !p.face).length).toBeGreaterThan(particles.filter((p) => p.face).length);
  });

  it('starts scattered and blurred, ends sharp on its cell', () => {
    const p = particles[0];
    const first = particleAt(p, 0)!;
    expect(first.blur).toBeGreaterThan(0 + (p.depth > 0.75 ? -1 : 0));
    const landed = particleAt(p, GATHER_END)!;
    expect(landed.x).toBeCloseTo(p.tx, 5);
    expect(landed.y).toBeCloseTo(p.ty, 5);
    expect(landed.blur).toBe(0);
    expect(landed.glyph).toBe(p.glyph);
  });

  it('face cells are gone after the face phase while the block remains until the hand-off', () => {
    const face = particles.find((p) => p.face)!;
    const body = particles.find((p) => !p.face)!;
    expect(particleAt(face, FACE_END + 0.01)).toBeNull();
    expect(particleAt(body, FACE_END + 0.01)).not.toBeNull();
    expect(particleAt(body, FORMATION_TOTAL)).toBeNull();
  });

  it('the static SVG is a ghost while forming and fully visible at the end (and always after)', () => {
    expect(svgOpacityAt(0)).toBeLessThan(0.2);
    expect(svgOpacityAt(1)).toBeLessThan(0.2);
    expect(svgOpacityAt(FORMATION_TOTAL)).toBe(1);
    expect(svgOpacityAt(99)).toBe(1);
  });

  it('grid is square in pixels', () => {
    const g = formationGrid(120, 4, 8);
    expect(g.cols * 4).toBeCloseTo(g.rows * 8, -1);
  });
});
