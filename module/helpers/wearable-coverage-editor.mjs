/**
 * Визуализатор анатомии для предмета Wearable: круги частей тела, клик переключает «покрыто/не покрыто».
 * Не редактирует структуру анатомии — только выбор зон покрытия.
 */
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

/**
 * @param {HTMLElement} container
 * @param {Object} options
 * @param {{ bodyParts: Object, grid?: { width?: number, height?: number } }} options.anatomyData
 * @param {Object} options.armorByPart - { [partId]: { value: number } }
 * @param {(armorByPart: Object) => void} options.onChange - вызывается после переключения покрытия части
 * @param {boolean} [options.showOnlyCovered] - если true, показывать только выбранные (покрытые) части без голубой пометки и без клика
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
    for (const [partId, part] of Object.entries(bodyParts)) {
      const x = Number(part.x ?? 0);
      const y = Number(part.y ?? 0);
      partsById[partId] = { ...part, id: partId, x, y };
    }

    const partIdsToShow = this.showOnlyCovered
      ? Object.keys(this.armorByPart).filter((id) => partsById[id])
      : partIds;

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

    for (const partId of partIdsToShow) {
      const part = partsById[partId];
      if (!part) continue;
      const px = toPx(part.x, part.y, wrapW, wrapH, centerX, centerY, cellSize, circleRadius);
      const node = document.createElement("div");
      node.className = "anatomy-editor-part anatomy-editor-part-circle";
      if (!this.showOnlyCovered) {
        const covered = Object.prototype.hasOwnProperty.call(this.armorByPart, partId);
        if (covered) node.classList.add("wearable-coverage-part--covered");
      }
      node.dataset.partId = partId;
      node.style.left = `${px.left}px`;
      node.style.top = `${px.top}px`;
      node.style.width = `${circleRadius * 2}px`;
      node.style.height = `${circleRadius * 2}px`;
      node.title = part.name || partId;
      inner.appendChild(node);

      if (!this.showOnlyCovered) {
        node.addEventListener("click", (e) => {
          e.stopPropagation();
          const next = { ...this.armorByPart };
          if (Object.prototype.hasOwnProperty.call(next, partId)) {
            delete next[partId];
          } else {
            next[partId] = { value: next[partId]?.value ?? 0 };
          }
          this.armorByPart = next;
          this.onChange(next);
        });
      }
    }
  }
}
