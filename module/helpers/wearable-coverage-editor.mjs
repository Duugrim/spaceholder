/**
 * Визуализатор анатомии для предмета Wearable: круги частей тела, клик переключает покрытие по стороне.
 * Не редактирует структуру анатомии — только выбор зон покрытия.
 */
import { coerceAnatomyGridCoord } from "../anatomy-manager.mjs";
import { sanitizeFaces } from "./anatomy-groups.mjs";
import { coverageKey, parseCoverageKey } from "./body-part-coverage.mjs";

const DEFAULT_CELL_SIZE = 42;
const DEFAULT_CIRCLE_RADIUS = 15;
const FIXED_DISPLAY_WIDTH = 378;
const FIXED_DISPLAY_HEIGHT = 420;

function toPx(x, y, wrapW, wrapH, centerX, centerY, cellSize, circleRadius) {
  const centerPxX = wrapW / 2 + (x - centerX) * cellSize;
  const centerPxY = wrapH / 2 + (y - centerY) * cellSize;
  return {
    left: centerPxX - circleRadius,
    top: centerPxY - circleRadius,
    centerX: centerPxX,
    centerY: centerPxY
  };
}

function facesCoveredForPart(armorByPart, partId) {
  const out = [];
  for (const key of Object.keys(armorByPart ?? {})) {
    const parsed = parseCoverageKey(key);
    if (parsed.slotRef === partId) out.push(parsed.face);
  }
  return out;
}

/**
 * @param {HTMLElement} container
 * @param {Object} options
 * @param {{ bodyParts: Object, grid?: { width?: number, height?: number } }} options.anatomyData
 * @param {Object} options.armorByPart - { [`${slotRef}::${face}`]: { face, layers? } }
 * @param {(armorByPart: Object) => void} options.onChange
 * @param {boolean} [options.showOnlyCovered]
 */
export class WearableCoverageEditor {
  constructor(container, options = {}) {
    this.container = container;
    this.anatomyData = options.anatomyData ?? { bodyParts: {}, grid: {} };
    this.armorByPart = foundry.utils.deepClone(options.armorByPart ?? {});
    this.onChange = options.onChange ?? (() => {});
    this.showOnlyCovered = !!options.showOnlyCovered;
  }

  setArmorByPart(armorByPart) {
    this.armorByPart = foundry.utils.deepClone(armorByPart ?? {});
  }

  render() {
    if (!this.container) return;
    const bodyParts = this.anatomyData.bodyParts ?? {};
    const partIds = Object.keys(bodyParts);
    this.container.innerHTML = "";
    this.container.classList.add("spaceholder-anatomy-editor", "wearable-coverage-editor");
    if (this.showOnlyCovered) this.container.classList.add("wearable-coverage-editor--summary");

    const partsById = {};
    for (const [slotRef, part] of Object.entries(bodyParts)) {
      const x = coerceAnatomyGridCoord(part.x ?? 0);
      const y = coerceAnatomyGridCoord(part.y ?? 0);
      partsById[slotRef] = { ...part, id: slotRef, x, y, faces: sanitizeFaces(part.faces) };
    }

    const coveredPartIds = [...new Set(
      Object.keys(this.armorByPart).map((k) => parseCoverageKey(k).slotRef).filter((id) => partsById[id])
    )];
    const partIdsToShow = this.showOnlyCovered ? coveredPartIds : partIds;

    if (partIdsToShow.length === 0) {
      const empty = document.createElement("div");
      empty.className = "anatomy-editor-empty";
      empty.textContent = this.showOnlyCovered
        ? (typeof game !== "undefined" && game.i18n?.localize?.("SPACEHOLDER.Wearable.CoverageNoParts") || "Нет выбранных частей тела")
        : (typeof game !== "undefined" && game.i18n?.localize?.("SPACEHOLDER.Wearable.AnatomyNotLoaded") || "Анатомия не загружена");
      this.container.appendChild(empty);
      return;
    }

    const grid = this.anatomyData.grid ?? {};
    const gridWidth = Math.max(1, parseInt(grid.width ?? 9, 10) || 9);
    const gridHeight = Math.max(1, parseInt(grid.height ?? 10, 10) || 10);
    const centerX = (gridWidth - 1) / 2;
    const centerY = (gridHeight - 1) / 2;

    const wrapW = FIXED_DISPLAY_WIDTH;
    const wrapH = FIXED_DISPLAY_HEIGHT;
    const cellSize = Math.min(wrapW / gridWidth, wrapH / gridHeight);
    const circleRadius = DEFAULT_CIRCLE_RADIUS * (cellSize / DEFAULT_CELL_SIZE);

    const wrap = document.createElement("div");
    wrap.className = "anatomy-editor-grid-wrap";
    wrap.style.width = `${wrapW}px`;
    wrap.style.height = `${wrapH}px`;
    wrap.style.position = "relative";
    wrap.style.overflow = "hidden";
    this.container.appendChild(wrap);

    const inner = document.createElement("div");
    inner.className = "anatomy-editor-grid-inner";
    inner.style.width = `${wrapW}px`;
    inner.style.height = `${wrapH}px`;
    wrap.appendChild(inner);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "anatomy-editor-links");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.position = "absolute";
    svg.style.left = "0";
    svg.style.top = "0";
    svg.style.pointerEvents = "none";
    const svgG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(svgG);

    const partIdsSet = new Set(partIdsToShow);
    const linkSet = new Set();
    for (const partId of partIdsToShow) {
      const part = partsById[partId];
      if (!part) continue;
      const links = Array.isArray(part.links) ? part.links : [];
      const from = part;
      for (const toId of links) {
        if (!partIdsSet.has(toId)) continue;
        const to = partsById[toId];
        if (!to) continue;
        const key = [partId, toId].sort().join("--");
        if (linkSet.has(key)) continue;
        linkSet.add(key);
        const fromPx = toPx(from.x, from.y, wrapW, wrapH, centerX, centerY, cellSize, circleRadius);
        const toPxResult = toPx(to.x, to.y, wrapW, wrapH, centerX, centerY, cellSize, circleRadius);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", fromPx.centerX);
        line.setAttribute("y1", fromPx.centerY);
        line.setAttribute("x2", toPxResult.centerX);
        line.setAttribute("y2", toPxResult.centerY);
        line.setAttribute("class", "anatomy-editor-link");
        svgG.appendChild(line);
      }
    }
    inner.appendChild(svg);

    const L = (k, fallback) => (typeof game !== "undefined" && game.i18n?.localize?.(k)) || fallback;

    for (const partId of partIdsToShow) {
      const part = partsById[partId];
      if (!part) continue;
      const px = toPx(part.x, part.y, wrapW, wrapH, centerX, centerY, cellSize, circleRadius);
      const node = document.createElement("div");
      node.className = "anatomy-editor-part anatomy-editor-part-circle";
      const coveredFaces = facesCoveredForPart(this.armorByPart, partId);
      if (coveredFaces.length) node.classList.add("wearable-coverage-part--covered");
      node.dataset.partId = partId;
      node.style.left = `${px.left}px`;
      node.style.top = `${px.top}px`;
      node.style.width = `${circleRadius * 2}px`;
      node.style.height = `${circleRadius * 2}px`;
      const faceHint = coveredFaces.length
        ? ` [${coveredFaces.join(", ")}]`
        : "";
      node.title = `${part.displayName || part.name || partId}${faceHint}`;
      inner.appendChild(node);

      if (!this.showOnlyCovered) {
        node.addEventListener("click", (e) => {
          e.stopPropagation();
          const faces = sanitizeFaces(part.faces);
          const next = { ...this.armorByPart };
          const currently = facesCoveredForPart(next, partId);
          if (faces.length <= 1) {
            const face = faces[0] || "front";
            const key = coverageKey(partId, face);
            if (Object.prototype.hasOwnProperty.call(next, key)) delete next[key];
            else next[key] = { face };
          } else if (currently.length >= faces.length) {
            for (const face of faces) delete next[coverageKey(partId, face)];
          } else {
            const missing = faces.find((f) => !currently.includes(f));
            if (missing) next[coverageKey(partId, missing)] = { face: missing };
          }
          this.armorByPart = next;
          this.onChange(next);
        });
      }
    }
  }
}
