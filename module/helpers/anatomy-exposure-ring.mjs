/**
 * SVG-кольцо экспозиции части тела: 4 квадранта снаружи основного круга (перед=верх, право, зад=низ, лево).
 * Без экспозиции возвращает null (обводка только CSS на узле — без «двойного круга»).
 *
 * Толщина сегмента по радиусу (в единицах viewBox 0…100, те же пропорции что и в px):
 *   maxBand = Ro - rBody - gap   — доступная полоса между внешним ободом (Ro) и краем тела (rBody).
 *   depth_i = (w_i / maxW) * maxDepthRatio * maxBand
 *   толщина кольца в квадранте i = Ro - R_i = depth_i (пока Ri не упирается в minRi).
 * w_i — вес экспозиции в этом направлении, maxW — максимум из четырёх; у доминирующего направления
 * толщина доходит до maxDepthRatio * maxBand.
 */
const NS = "http://www.w3.org/2000/svg";

/** Углы в градусах: 0° — вправо, по часовой (ось Y вниз, как в SVG). */
const QUADRANTS = [
  { start: 225, end: 315 },
  { start: 315, end: 405 },
  { start: 45, end: 135 },
  { start: 135, end: 225 }
];

function pt(cx, cy, r, deg) {
  const φ = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(φ), cy + r * Math.sin(φ)];
}

/**
 * @param {number} outerDiameterPx — размер SVG (больше тела, дуги снаружи диска)
 * @param {{ front: number, right: number, back: number, left: number }} planar4
 * @param {object} options
 * @param {number} options.innerDiameterPx — диаметр основного круга части (как у узла сетки)
 * @param {'default'|'selected'|'neighbor'} [options.variant]
 * @param {number} [options.maxDepthRatio] — доля maxBand при w_i === maxW (по умолчанию ~0.84)
 * @returns {SVGSVGElement|null}
 */
export function createExposureRingSvg(outerDiameterPx, planar4, options = {}) {
  const {
    innerDiameterPx = outerDiameterPx,
    variant = "default",
    maxDepthRatio = 0.84
  } = options;

  const wArr = [planar4.front, planar4.right, planar4.back, planar4.left];
  const maxW = Math.max(...wArr, 1e-9);
  const hasAny = wArr.some((x) => x > 0);
  if (!hasAny) return null;

  const viewBoxSize = 100;
  const cx = 50;
  const cy = 50;
  const Ro = 49;
  const inner = Math.max(innerDiameterPx, 1);
  const outer = Math.max(outerDiameterPx, inner);
  /** Радиус края тела в координатах viewBox (центр SVG совпадает с центром узла). */
  const rBody = 50 * (inner / outer);
  const gap = 1.35;
  const minRi = rBody + gap;
  const maxBand = Math.max(0.5, Ro - minRi);
  const depthScale = maxDepthRatio * maxBand;

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", `anatomy-exposure-ring anatomy-exposure-ring--${variant}`);
  svg.setAttribute("viewBox", `0 0 ${viewBoxSize} ${viewBoxSize}`);
  svg.setAttribute("width", String(outerDiameterPx));
  svg.setAttribute("height", String(outerDiameterPx));
  svg.setAttribute("aria-hidden", "true");
  svg.style.display = "block";

  for (let i = 0; i < 4; i++) {
    const wi = wArr[i];
    if (wi <= 0) continue;
    const { start, end } = QUADRANTS[i];
    const depth = (wi / maxW) * depthScale;
    const Ri = Math.max(minRi, Ro - depth);
    const [ox1, oy1] = pt(cx, cy, Ro, start);
    const [ox2, oy2] = pt(cx, cy, Ro, end);
    const [ix1, iy1] = pt(cx, cy, Ri, start);
    const [ix2, iy2] = pt(cx, cy, Ri, end);
    const dAttr = `M ${ox1} ${oy1} A ${Ro} ${Ro} 0 0 1 ${ox2} ${oy2} L ${ix2} ${iy2} A ${Ri} ${Ri} 0 0 0 ${ix1} ${iy1} Z`;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", dAttr);
    path.setAttribute("class", "anatomy-exposure-ring__segment");
    svg.appendChild(path);
  }

  return svg;
}
