/**
 * Anatomy Editor - визуализация внешней анатомии: круги на сетке, связи (links).
 * Центрирование по bounding box, Drag&Drop позиции в режиме редактирования.
 * Под сеткой — панель выбранной части (органы, импланты) без всплывающих окон.
 */
import { anatomyManager, coerceAnatomyGridCoord } from '../anatomy-manager.mjs';
import {
  sanitizeExposure,
  sanitizeRelation,
  dedupeRelations,
  deriveAdjacentLinksFromRelations,
  enforceSingleParentRelation,
  legacyLinksToAdjacentRelations,
  getExposurePlanar4,
  ANATOMY_EXPOSURE_DIRECTIONS
} from './anatomy-relations.mjs';
import { createExposureRingSvg } from './anatomy-exposure-ring.mjs';

const DEFAULT_CELL_SIZE = 42;
const DEFAULT_CIRCLE_RADIUS = 15;
/** Фиксированный размер блока визуализации (9×10 клеток по умолчанию) */
const FIXED_DISPLAY_WIDTH = 378;
const FIXED_DISPLAY_HEIGHT = 420;
const PADDING = 1;
/** Множитель: SVG экспозиции крупнее тела, дуги снаружи основного круга */
const EXPOSURE_RING_OUTER_SCALE = 1.32;

/** MVP: варианты материала части тела */
const MATERIAL_OPTIONS = [
  { id: "flesh", label: "Плоть", icon: "fa-hand" },
  { id: "cybernetic", label: "Кибернетика", icon: "fa-microchip" },
  { id: "armor", label: "Броня", icon: "fa-shield-halved" },
  { id: "other", label: "Другое", icon: "fa-circle-question" }
];

/** Цвета заливки кругов по материалу */
const MATERIAL_COLORS = {
  flesh: "#c48b6a",
  cybernetic: "#5eb8c4",
  armor: "#94a3b8",
  other: "#b8a3c4"
};

const RELATION_KIND_LABELS = {
  adjacent: "Рядом",
  behind: "За",
  parent: "Родитель"
};

export class AnatomyEditor {
  constructor(container, options = {}) {
    this.container = container;
    this.actor = options.actor ?? null;
    this.editable = options.editable ?? true;
    this.editMode = options.editMode ?? false;
    this.linkMode = options.linkMode ?? false;
    this.selectedPartId = options.selectedPartId ?? null;
    this.selectedPanel = options.selectedPanel ?? null;
    this.fixedDisplayWidth = options.fixedDisplayWidth ?? null;
    this.fixedDisplayHeight = options.fixedDisplayHeight ?? null;
    this._boundRender = this.render.bind(this);
  }

  setActor(actor) {
    this.actor = actor;
    this.render();
  }

  setEditMode(value) {
    this.editMode = !!value;
    this.render();
  }

  setLinkMode(value) {
    this.linkMode = !!value;
    this.render();
  }

  setSelectedPartId(partId) {
    this.selectedPartId = partId || null;
    const partsById = this._getPartsWithCoords();
    this._renderSelectedPanel(partId ? partsById[partId] ?? null : null);
  }

  _getPartsWithCoords() {
    const bodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const partsById = {};
    for (const [partId, part] of Object.entries(bodyParts)) {
      const x = coerceAnatomyGridCoord(part.x ?? 0);
      const y = coerceAnatomyGridCoord(part.y ?? 0);
      partsById[partId] = { ...part, id: partId, x, y };
    }
    return partsById;
  }

  /**
   * @param {object|null} part
   * @returns {object[]}
   */
  _getRelationsForPart(part) {
    if (!part) return [];
    if (Array.isArray(part.relations) && part.relations.length) {
      return part.relations.map(sanitizeRelation).filter(Boolean);
    }
    return legacyLinksToAdjacentRelations(Array.isArray(part.links) ? part.links : []);
  }

  /** Синхронизировать `links` (только adjacent) и нормализовать relations у всех частей. */
  _normalizeAllBodyPartRelations(bodyParts) {
    const bp = bodyParts && typeof bodyParts === "object" ? bodyParts : {};
    for (const p of Object.values(bp)) {
      if (!p || typeof p !== "object") continue;
      if (!Array.isArray(p.relations)) p.relations = [];
      p.relations = p.relations.map(sanitizeRelation).filter(Boolean);
      p.relations = dedupeRelations(enforceSingleParentRelation(p.relations));
      p.links = deriveAdjacentLinksFromRelations(p.relations);
    }
    return bp;
  }

  _scrubRelationsToDeletedPart(bodyParts, deletedId) {
    for (const p of Object.values(bodyParts)) {
      if (!p || !Array.isArray(p.relations)) continue;
      p.relations = p.relations.filter((r) => r && r.target !== deletedId);
      p.relations = dedupeRelations(enforceSingleParentRelation(p.relations));
      p.links = deriveAdjacentLinksFromRelations(p.relations);
    }
  }

  _remapRelationTargetsInAll(bodyParts, oldId, newId) {
    for (const p of Object.values(bodyParts)) {
      if (!p || !Array.isArray(p.relations)) continue;
      for (const r of p.relations) {
        if (r && r.target === oldId) r.target = newId;
      }
      p.relations = dedupeRelations(enforceSingleParentRelation(p.relations));
      p.links = deriveAdjacentLinksFromRelations(p.relations);
    }
  }

  _bbox(partsById) {
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    const list = Object.values(partsById);
    if (list.length === 0) return { minX, maxX, minY, maxY };
    minX = maxX = list[0].x;
    minY = maxY = list[0].y;
    for (const p of list) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, maxX, minY, maxY };
  }

  /** Центр фигуры в координатах сетки; cellSize и circleRadius опциональны (при фиксированном блоке). */
  _toPx(x, y, wrapW, wrapH, centerX, centerY, cellSize = DEFAULT_CELL_SIZE, circleRadius = DEFAULT_CIRCLE_RADIUS) {
    const centerPxX = wrapW / 2 + (x - centerX) * cellSize;
    const centerPxY = wrapH / 2 + (y - centerY) * cellSize;
    return {
      left: centerPxX - circleRadius,
      top: centerPxY - circleRadius,
      centerX: centerPxX,
      centerY: centerPxY
    };
  }

  render() {
    if (!this.container) return;
    const bodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const partIds = Object.keys(bodyParts);

    this.container.innerHTML = "";
    this.container.classList.add("spaceholder-anatomy-editor");
    if (this.editMode) this.container.classList.add("spaceholder-anatomy-editor--editing");
    else this.container.classList.remove("spaceholder-anatomy-editor--editing");

    if (partIds.length === 0) {
      const empty = document.createElement("div");
      empty.className = "anatomy-editor-empty";
      empty.textContent = "Анатомия не загружена";
      this.container.appendChild(empty);
      this._renderSelectedPanel(null);
      return;
    }

    const partsById = this._getPartsWithCoords();
    const grid = this.actor?.system?.health?.anatomyGrid;
    const gridWidth = Math.max(1, parseInt(grid?.width ?? 9, 10) || 9);
    const gridHeight = Math.max(1, parseInt(grid?.height ?? 10, 10) || 10);
    const centerX = (gridWidth - 1) / 2;
    const centerY = (gridHeight - 1) / 2;

    const useFixedSize = this.fixedDisplayWidth != null && this.fixedDisplayHeight != null;
    const wrapW = useFixedSize ? this.fixedDisplayWidth : gridWidth * DEFAULT_CELL_SIZE;
    const wrapH = useFixedSize ? this.fixedDisplayHeight : gridHeight * DEFAULT_CELL_SIZE;
    const cellSize = useFixedSize
      ? Math.min(wrapW / gridWidth, wrapH / gridHeight)
      : DEFAULT_CELL_SIZE;
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
    if (this.editMode && this.editable) {
      inner.style.backgroundSize = `${cellSize}px ${cellSize}px`;
      const gridPxW = gridWidth * cellSize;
      const gridPxH = gridHeight * cellSize;
      inner.style.backgroundPosition = `${(wrapW - gridPxW) / 2}px ${(wrapH - gridPxH) / 2}px`;
    }
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

    const undirectedSeen = new Set();
    const directedSeen = new Set();
    for (const [partId, part] of Object.entries(bodyParts)) {
      const rels = this._getRelationsForPart(part);
      const from = partsById[partId];
      if (!from) continue;
      for (const rel of rels) {
        const toId = rel.target;
        const to = partsById[toId];
        if (!to) continue;
        const fromPx = this._toPx(from.x, from.y, wrapW, wrapH, centerX, centerY, cellSize, circleRadius);
        const toPx = this._toPx(to.x, to.y, wrapW, wrapH, centerX, centerY, cellSize, circleRadius);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", fromPx.centerX);
        line.setAttribute("y1", fromPx.centerY);
        line.setAttribute("x2", toPx.centerX);
        line.setAttribute("y2", toPx.centerY);
        let lineClass = "anatomy-editor-link";
        if (rel.kind === "behind") {
          lineClass += " anatomy-editor-link--behind";
          line.setAttribute("stroke-dasharray", "6 4");
        } else if (rel.kind === "parent") {
          lineClass += " anatomy-editor-link--parent";
        }
        line.setAttribute("class", lineClass);
        if (rel.kind === "adjacent") {
          const key = [partId, toId].sort().join("--");
          if (undirectedSeen.has(key)) continue;
          undirectedSeen.add(key);
        } else {
          const dkey = `${partId}=>${toId}:${rel.kind}`;
          if (directedSeen.has(dkey)) continue;
          directedSeen.add(dkey);
        }
        if (this.selectedPartId && (partId === this.selectedPartId || toId === this.selectedPartId)) {
          line.setAttribute("data-selected", "true");
        }
        svgG.appendChild(line);
      }
    }
    inner.appendChild(svg);

    const selectedPart = this.selectedPartId ? bodyParts[this.selectedPartId] : null;
    const selectedLinks = selectedPart
      ? deriveAdjacentLinksFromRelations(this._getRelationsForPart(selectedPart))
      : [];
    for (const [partId, part] of Object.entries(partsById)) {
      const px = this._toPx(part.x, part.y, wrapW, wrapH, centerX, centerY, cellSize, circleRadius);
      const node = document.createElement("div");
      node.className = "anatomy-editor-part anatomy-editor-part-circle";
      if (this.selectedPartId === partId) node.classList.add("selected");
      else if (selectedLinks.includes(partId)) node.classList.add("anatomy-editor-part--linked-neighbor");
      const materialId = part.material ?? "";
      node.dataset.material = materialId || "none";
      if (materialId && MATERIAL_COLORS[materialId]) {
        node.style.setProperty("--part-fill", MATERIAL_COLORS[materialId]);
      }
      node.dataset.partId = partId;
      node.style.left = `${px.left}px`;
      node.style.top = `${px.top}px`;
      node.style.width = `${circleRadius * 2}px`;
      node.style.height = `${circleRadius * 2}px`;
      node.title = this.linkMode ? `Связь: перетащите на другую часть (${part.name || partId})` : (part.name || partId);
      node.draggable = this.editMode && this.editable;
      if (this.linkMode) node.classList.add("anatomy-editor-part--link-mode");
      node.classList.add("anatomy-editor-part-circle--exposure-viz");
      const ringVariant =
        this.selectedPartId === partId ? "selected" : selectedLinks.includes(partId) ? "neighbor" : "default";
      const planar = getExposurePlanar4(bodyParts[partId]?.exposure);
      const innerD = circleRadius * 2;
      const outerD = Math.round(innerD * EXPOSURE_RING_OUTER_SCALE);
      const ringSvg = createExposureRingSvg(outerD, planar, {
        innerDiameterPx: innerD,
        variant: ringVariant
      });
      if (ringSvg) node.appendChild(ringSvg);
      inner.appendChild(node);

      node.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectedPartId = this.selectedPartId === partId ? null : partId;
        this.render();
      });

      if (this.editMode && this.editable) {
        node.addEventListener("dragstart", (e) => {
          if (this.linkMode) {
            e.dataTransfer.setData("link-from", partId);
            e.dataTransfer.setData("text/plain", partId);
            e.dataTransfer.effectAllowed = "copy";
          } else {
            e.dataTransfer.setData("text/plain", partId);
            e.dataTransfer.effectAllowed = "move";
          }
        });
        if (this.linkMode) {
          node.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            e.currentTarget.classList.add("anatomy-editor-part--drop-target");
          });
          node.addEventListener("dragleave", (e) => {
            e.currentTarget.classList.remove("anatomy-editor-part--drop-target");
          });
          node.addEventListener("drop", (e) => {
            e.preventDefault();
            e.currentTarget.classList.remove("anatomy-editor-part--drop-target");
            const linkFrom = e.dataTransfer.getData("link-from");
            if (!linkFrom || linkFrom === partId) return;
            this._addAdjacentBidirectional(linkFrom, partId);
          });
        }
      }
    }

    wrap.addEventListener("dragover", (e) => e.preventDefault());
    wrap.addEventListener("drop", (e) => {
      e.preventDefault();
      if (e.dataTransfer.getData("link-from")) return;
      const partId = e.dataTransfer.getData("text/plain");
      if (!partId || !this.actor?.system?.health?.bodyParts?.[partId]) return;
      const innerBox = wrap.querySelector(".anatomy-editor-grid-inner");
      if (!innerBox) return;
      const rect = innerBox.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const gridX = Math.round(centerX + (x - rect.width / 2) / cellSize);
      const gridY = Math.round(centerY + (y - rect.height / 2) / cellSize);
      const bodyPartsCopy = foundry.utils.deepClone(this.actor.system.health.bodyParts);
      bodyPartsCopy[partId].x = gridX;
      bodyPartsCopy[partId].y = gridY;
      this.actor.update({ "system.health.bodyParts": bodyPartsCopy }).then(() => this.render());
    });

    this._renderSelectedPanel(this.selectedPartId ? partsById[this.selectedPartId] : null);
  }

  _renderSelectedPanel(part) {
    const panel = this.selectedPanel;
    if (!panel) return;
    panel.innerHTML = "";
    panel.classList.remove("anatomy-editor-panel-empty");

    if (!part) {
      panel.classList.add("anatomy-editor-panel-empty");
      panel.textContent = "Выберите часть тела (клик по кругу)";
      return;
    }

    const partId = part.id;
    const bodyPart = this.actor?.system?.health?.bodyParts?.[partId];
    if (!bodyPart) return;

    const bodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const rels = this._getRelationsForPart(bodyPart);
    const organs = Array.isArray(bodyPart.organs) ? bodyPart.organs : [];
    const materialId = bodyPart.material ?? "";
    const materialLabel = MATERIAL_OPTIONS.find((m) => m.id === materialId)?.label ?? "—";
    const exposure = sanitizeExposure(bodyPart.exposure);
    const exposureStr = Object.keys(exposure).length
      ? Object.entries(exposure)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")
      : "—";

    const cols = document.createElement("div");
    cols.className = "anatomy-editor-panel-cols";

    const colLeft = document.createElement("div");
    colLeft.className = "anatomy-editor-panel-col anatomy-editor-panel-col--protection";
    colLeft.innerHTML = `<div class="anatomy-editor-panel-section-title">Защита</div><p class="anatomy-editor-panel-placeholder-hint"><em>Защита зоны (скоро)</em></p>`;
    cols.appendChild(colLeft);

    const colCenter = document.createElement("div");
    colCenter.className = "anatomy-editor-panel-col anatomy-editor-panel-col--center";

    const header = document.createElement("div");
    header.className = "anatomy-editor-panel-header";
    const nameEl = document.createElement("div");
    nameEl.className = "anatomy-editor-panel-title";
    const allBodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const typeId = String(bodyPart?.id ?? "").trim();
    const hasDup = !!typeId && Object.values(allBodyParts).filter((p) => String(p?.id ?? "").trim() === typeId).length > 1;
    const baseName = bodyPart.displayName || bodyPart.name || bodyPart.id || partId;
    const m = String(partId).match(/#(\d+)$/);
    const dupIndex = hasDup && m ? Number(m[1]) : null;
    nameEl.textContent = dupIndex ? `${baseName} (${dupIndex})` : baseName;
    header.appendChild(nameEl);
    if (this.editMode && this.editable) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "anatomy-editor-panel-edit-btn";
      editBtn.title = "Редактировать часть тела";
      editBtn.innerHTML = "<i class=\"fas fa-pencil-alt\"></i>";
      editBtn.addEventListener("click", () => this._openEditPartDialog(partId));
      header.appendChild(editBtn);
    }
    colCenter.appendChild(header);

    const props = document.createElement("div");
    props.className = "anatomy-editor-panel-props";
    props.innerHTML = `
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">ID</span><span class="anatomy-editor-panel-value"><code>${partId}</code></span></div>
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">Вес</span><span class="anatomy-editor-panel-value">${bodyPart.weight ?? 0}</span></div>
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">Max HP</span><span class="anatomy-editor-panel-value">${bodyPart.maxHp ?? 0}</span></div>
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">Координаты</span><span class="anatomy-editor-panel-value">(${bodyPart.x ?? 0}, ${bodyPart.y ?? 0})</span></div>
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">Материал</span><span class="anatomy-editor-panel-value">${materialLabel}</span></div>
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">Экспозиция</span><span class="anatomy-editor-panel-value">${exposureStr}</span></div>`;
    colCenter.appendChild(props);

    const relationsSection = document.createElement("div");
    relationsSection.className = "anatomy-editor-panel-block";
    const relationsHead = document.createElement("div");
    relationsHead.className = "anatomy-editor-panel-section-title";
    relationsHead.textContent = "Связи и иерархия";
    relationsSection.appendChild(relationsHead);
    if (this.editMode && this.editable) {
      const relList = document.createElement("div");
      relList.className = "anatomy-editor-panel-links-list";
      rels.forEach((rel, idx) => {
        const other = bodyParts[rel.target];
        const name = other?.displayName || other?.name || rel.target;
        const kindLabel = RELATION_KIND_LABELS[rel.kind] || rel.kind;
        const behindExtra =
          rel.kind === "behind"
            ? `${rel.chance !== undefined ? ` (${rel.chance}%)` : ""}${rel.direction ? ` · ${rel.direction}` : ""}`
            : "";
        const row = document.createElement("div");
        row.className = "anatomy-editor-panel-link-row";
        const nameSpan = document.createElement("span");
        nameSpan.className = "anatomy-editor-panel-link-name";
        nameSpan.textContent = `${kindLabel} → ${name}${behindExtra}`;
        row.appendChild(nameSpan);
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "anatomy-editor-panel-link-remove";
        removeBtn.title = "Удалить";
        removeBtn.innerHTML = "<i class=\"fas fa-minus\"></i>";
        removeBtn.addEventListener("click", () => this._removeRelation(partId, idx));
        row.appendChild(removeBtn);
        relList.appendChild(row);
      });
      relationsSection.appendChild(relList);
      const addRelBtn = document.createElement("button");
      addRelBtn.type = "button";
      addRelBtn.className = "anatomy-editor-panel-add-link";
      addRelBtn.innerHTML = "<i class=\"fas fa-plus\"></i> Добавить связь";
      addRelBtn.addEventListener("click", () => this._openAddRelationDialog(partId));
      relationsSection.appendChild(addRelBtn);
    } else {
      const list = document.createElement("ul");
      list.className = "anatomy-editor-panel-list";
      for (const rel of rels) {
        const other = bodyParts[rel.target];
        const li = document.createElement("li");
        const kindLabel = RELATION_KIND_LABELS[rel.kind] || rel.kind;
        const behindExtra =
          rel.kind === "behind"
            ? `${rel.chance !== undefined ? ` (${rel.chance}%)` : ""}${rel.direction ? ` · ${rel.direction}` : ""}`
            : "";
        li.textContent = `${kindLabel}: ${other?.displayName || other?.name || rel.target}${behindExtra}`;
        list.appendChild(li);
      }
      if (rels.length === 0) list.innerHTML = "<li class=\"anatomy-editor-panel-empty-hint\">—</li>";
      relationsSection.appendChild(list);
    }
    colCenter.appendChild(relationsSection);

    const itemCollection = this.actor?.items;
    const implantItems = itemCollection
      ? Array.from(itemCollection).filter(
          (i) => i.system?.implantReplaceOrgan && String(i.system.implantReplaceOrgan).toLowerCase() === partId.toLowerCase()
        )
      : [];
    if (implantItems.length > 0) {
      const impSection = document.createElement("div");
      impSection.className = "anatomy-editor-panel-block";
      const impHead = document.createElement("div");
      impHead.className = "anatomy-editor-panel-section-title";
      impHead.textContent = "Импланты";
      impSection.appendChild(impHead);
      const ul = document.createElement("ul");
      ul.className = "anatomy-editor-panel-list";
      for (const item of implantItems) {
        const li = document.createElement("li");
        li.textContent = item.name || item.id;
        ul.appendChild(li);
      }
      impSection.appendChild(ul);
      colCenter.appendChild(impSection);
    }

    if (this.editMode && this.editable) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "anatomy-editor-panel-delete";
      delBtn.innerHTML = "<i class=\"fas fa-trash\"></i> Удалить часть";
      delBtn.addEventListener("click", () => this._deletePart(partId));
      colCenter.appendChild(delBtn);
    }

    cols.appendChild(colCenter);

    const colRight = document.createElement("div");
    colRight.className = "anatomy-editor-panel-col anatomy-editor-panel-col--organs";
    const organsSection = document.createElement("div");
    organsSection.className = "anatomy-editor-panel-block";
    const organsHead = document.createElement("div");
    organsHead.className = "anatomy-editor-panel-section-title";
    organsHead.textContent = "Органы / слоты";
    organsSection.appendChild(organsHead);
    if (this.editMode && this.editable) {
      const organsList = document.createElement("div");
      organsList.className = "anatomy-editor-panel-organs-list";
      for (let i = 0; i < organs.length; i++) {
        const o = organs[i];
        const row = document.createElement("div");
        row.className = "anatomy-editor-panel-organ-row";
        const nameSpan = document.createElement("span");
        nameSpan.className = "anatomy-editor-panel-organ-name";
        nameSpan.textContent = o.name || o.slotKey || o.id || "—";
        row.appendChild(nameSpan);
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "anatomy-editor-panel-organ-remove";
        removeBtn.title = "Удалить орган";
        removeBtn.innerHTML = "<i class=\"fas fa-minus\"></i>";
        removeBtn.addEventListener("click", () => this._removeOrgan(partId, i));
        row.appendChild(removeBtn);
        organsList.appendChild(row);
      }
      organsSection.appendChild(organsList);
      const addOrganBtn = document.createElement("button");
      addOrganBtn.type = "button";
      addOrganBtn.className = "anatomy-editor-panel-add-organ";
      addOrganBtn.innerHTML = "<i class=\"fas fa-plus\"></i> Добавить орган";
      addOrganBtn.addEventListener("click", () => this._addOrgan(partId));
      organsSection.appendChild(addOrganBtn);
    } else {
      const list = document.createElement("ul");
      list.className = "anatomy-editor-panel-list";
      for (const o of organs) {
        const li = document.createElement("li");
        li.textContent = o.name || o.slotKey || o.id || "—";
        list.appendChild(li);
      }
      if (organs.length === 0) list.innerHTML = "<li class=\"anatomy-editor-panel-empty-hint\">—</li>";
      organsSection.appendChild(list);
    }
    colRight.appendChild(organsSection);
    cols.appendChild(colRight);

    panel.appendChild(cols);
  }

  async _openEditPartDialog(partId) {
    const bodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const part = bodyParts[partId];
    if (!part) return;
    const exp = sanitizeExposure(part.exposure);
    const expRows = ["front", "back", "left", "right"]
      .map(
        (dir) =>
          `<div class="form-group anatomy-editor-exp-row"><label>${dir}</label><input type="number" id="ep-exp-${dir}" min="0" step="1" value="${exp[dir] ?? ""}" placeholder="—" style="width:100%;"/></div>`
      )
      .join("");
    const materialVal = part.material ?? "";
    const materialOptionsHtml = MATERIAL_OPTIONS.map(
      (m) => `<option value="${m.id}" ${m.id === materialVal ? "selected" : ""}>${m.label}</option>`
    ).join("");
    const content = `
      <div class="anatomy-edit-part-dialog">
        <div class="form-group"><label>ID</label><input type="text" id="ep-id" value="${partId.replace(/"/g, "&quot;")}" placeholder="например leftArm" style="width:100%;"/></div>
        <div class="form-group"><label>Название</label><input type="text" id="ep-name" value="${(part.name || "").replace(/"/g, "&quot;")}" placeholder="Название части" style="width:100%;"/></div>
        <div class="form-group"><label>Вес</label><input type="number" id="ep-weight" value="${part.weight ?? 0}" min="0" style="width:100%;"/></div>
        <div class="form-group"><label>Max HP</label><input type="number" id="ep-maxHp" value="${part.maxHp ?? 0}" min="0" style="width:100%;"/></div>
        <div class="form-group"><label>Материал</label><select id="ep-material" style="width:100%;"><option value="">—</option>${materialOptionsHtml}</select></div>
        <div class="form-group"><label>X</label><input type="number" id="ep-x" value="${part.x ?? 0}" style="width:100%;"/></div>
        <div class="form-group"><label>Y</label><input type="number" id="ep-y" value="${part.y ?? 0}" style="width:100%;"/></div>
        <div class="anatomy-editor-panel-section-title" style="margin-top:8px;">Экспозиция (веса по направлениям)</div>
        ${expRows}
      </div>`;
    await foundry.applications.api.DialogV2.wait({
      window: { title: "Редактировать часть тела", icon: "fa-solid fa-pencil-alt" },
      position: { width: 340 },
      content,
      buttons: [
        {
          action: "save",
          label: "Сохранить",
          icon: "fa-solid fa-check",
          default: true,
          callback: async () => {
            const newId = (document.querySelector("#ep-id")?.value ?? "").trim().replace(/\s+/g, "") || partId;
            const name = (document.querySelector("#ep-name")?.value ?? "").trim() || newId;
            const weight = Math.max(0, parseInt(document.querySelector("#ep-weight")?.value ?? "0", 10));
            const maxHp = Math.max(0, parseInt(document.querySelector("#ep-maxHp")?.value ?? "0", 10));
            const material = (document.querySelector("#ep-material")?.value ?? "").trim() || null;
            const x = parseInt(document.querySelector("#ep-x")?.value ?? "0", 10) || 0;
            const y = parseInt(document.querySelector("#ep-y")?.value ?? "0", 10) || 0;
            /** @type {Record<string, number>} */
            const newExposure = {};
            for (const dir of ["front", "back", "left", "right"]) {
              const raw = document.querySelector(`#ep-exp-${dir}`)?.value;
              if (raw === undefined || String(raw).trim() === "") continue;
              const n = Number(raw);
              if (Number.isFinite(n) && n >= 0) newExposure[dir] = n;
            }

            const updated = foundry.utils.deepClone(bodyParts);
            if (newId !== partId) {
              if (updated[newId]) {
                ui.notifications.warn("Часть с таким ID уже существует");
                return;
              }
              const partData = updated[partId];
              delete updated[partId];
              partData.name = name;
              partData.weight = weight;
              partData.maxHp = maxHp;
              partData.material = material;
              partData.x = x;
              partData.y = y;
              partData.exposure = sanitizeExposure(newExposure);
              partData.slotRef = newId;
              updated[newId] = partData;
              this._remapRelationTargetsInAll(updated, partId, newId);
              this.selectedPartId = newId;
            } else {
              updated[partId].name = name;
              updated[partId].weight = weight;
              updated[partId].maxHp = maxHp;
              updated[partId].material = material;
              updated[partId].x = x;
              updated[partId].y = y;
              updated[partId].exposure = sanitizeExposure(newExposure);
            }
            this._normalizeAllBodyPartRelations(updated);
            await this.actor.update({ "system.health.bodyParts": updated });
            this.render();
          }
        },
        { action: "cancel", label: "Отмена", icon: "fa-solid fa-times" }
      ]
    });
  }

  _addAdjacentBidirectional(fromId, toId) {
    const bodyParts = foundry.utils.deepClone(this.actor?.system?.health?.bodyParts ?? {});
    if (!bodyParts[fromId] || !bodyParts[toId]) return;
    if (!Array.isArray(bodyParts[fromId].relations)) bodyParts[fromId].relations = [];
    if (!Array.isArray(bodyParts[toId].relations)) bodyParts[toId].relations = [];
    const hasA = bodyParts[fromId].relations.some((r) => r.kind === "adjacent" && r.target === toId);
    const hasB = bodyParts[toId].relations.some((r) => r.kind === "adjacent" && r.target === fromId);
    if (!hasA) bodyParts[fromId].relations.push({ kind: "adjacent", target: toId });
    if (!hasB) bodyParts[toId].relations.push({ kind: "adjacent", target: fromId });
    this._normalizeAllBodyPartRelations(bodyParts);
    this.actor.update({ "system.health.bodyParts": bodyParts }).then(() => this.render());
  }

  async _removeRelation(partId, relIndex) {
    const bodyParts = foundry.utils.deepClone(this.actor?.system?.health?.bodyParts ?? {});
    const part = bodyParts[partId];
    if (!part || !Array.isArray(part.relations) || relIndex < 0 || relIndex >= part.relations.length) return;
    const removed = sanitizeRelation(part.relations[relIndex]);
    part.relations.splice(relIndex, 1);
    if (removed?.kind === "adjacent" && removed.target) {
      const other = bodyParts[removed.target];
      if (other && Array.isArray(other.relations)) {
        other.relations = other.relations.filter((r) => !(r.kind === "adjacent" && r.target === partId));
      }
    }
    this._normalizeAllBodyPartRelations(bodyParts);
    await this.actor.update({ "system.health.bodyParts": bodyParts });
    this.render();
  }

  async _openAddRelationDialog(partId) {
    const bodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const otherIds = Object.keys(bodyParts).filter((id) => id !== partId);
    if (otherIds.length === 0) {
      ui.notifications.info("Нет других частей тела");
      return;
    }
    const optionsHtml = otherIds
      .map((id) => {
        const p = bodyParts[id];
        const name = p?.displayName || p?.name || id;
        return `<option value="${id}">${name}</option>`;
      })
      .join("");
    const kindOptions = ["adjacent", "behind", "parent"]
      .map((k) => `<option value="${k}">${RELATION_KIND_LABELS[k] || k}</option>`)
      .join("");
    const dirOptions = ANATOMY_EXPOSURE_DIRECTIONS.map(
      (d) => `<option value="${d}">${d}</option>`
    ).join("");
    const content = `
      <div class="anatomy-add-relation-dialog">
        <div class="form-group"><label>Тип</label><select id="ar-kind" style="width:100%;">${kindOptions}</select></div>
        <div class="form-group"><label>Целевая часть</label><select id="ar-target" style="width:100%;">${optionsHtml}</select></div>
        <div class="form-group"><label>Вероятность для «За» (%)</label><input type="number" id="ar-chance" min="0" max="100" value="70" style="width:100%;"/></div>
        <div class="form-group"><label>Направление для «За»</label><select id="ar-direction" style="width:100%;">${dirOptions}</select><p class="notes">Сторона атаки/прострела, с которой действует связь (только для «За»).</p></div>
      </div>`;
    await foundry.applications.api.DialogV2.wait({
      window: { title: "Добавить связь", icon: "fa-solid fa-link" },
      position: { width: 320 },
      content,
      buttons: [
        {
          action: "add",
          label: "Добавить",
          icon: "fa-solid fa-check",
          default: true,
          callback: async () => {
            const kind = document.querySelector("#ar-kind")?.value;
            const targetId = document.querySelector("#ar-target")?.value;
            if (!kind || !targetId || targetId === partId) return;
            const chanceRaw = document.querySelector("#ar-chance")?.value;
            const directionRaw = document.querySelector("#ar-direction")?.value;
            const updated = foundry.utils.deepClone(bodyParts);
            if (!updated[partId]) return;
            if (!Array.isArray(updated[partId].relations)) updated[partId].relations = [];
            if (kind === "parent") {
              updated[partId].relations = updated[partId].relations.filter((r) => r.kind !== "parent");
            }
            const rel =
              kind === "behind"
                ? sanitizeRelation({
                    kind: "behind",
                    target: targetId,
                    chance: chanceRaw !== undefined && String(chanceRaw).trim() !== "" ? Number(chanceRaw) : 70,
                    direction: directionRaw
                  })
                : sanitizeRelation({ kind, target: targetId });
            if (!rel) return;
            updated[partId].relations.push(rel);
            if (kind === "adjacent") {
              if (!Array.isArray(updated[targetId].relations)) updated[targetId].relations = [];
              if (!updated[targetId].relations.some((r) => r.kind === "adjacent" && r.target === partId)) {
                updated[targetId].relations.push({ kind: "adjacent", target: partId });
              }
            }
            this._normalizeAllBodyPartRelations(updated);
            await this.actor.update({ "system.health.bodyParts": updated });
            this.render();
          }
        },
        { action: "cancel", label: "Отмена", icon: "fa-solid fa-times" }
      ]
    });
  }

  async _removeOrgan(partId, index) {
    const bodyParts = foundry.utils.deepClone(this.actor?.system?.health?.bodyParts ?? {});
    const part = bodyParts[partId];
    if (!part || !Array.isArray(part.organs) || index < 0 || index >= part.organs.length) return;
    part.organs.splice(index, 1);
    await this.actor.update({ "system.health.bodyParts": bodyParts });
    this.render();
  }

  async _addOrgan(partId) {
    const content = `
      <div class="anatomy-add-organ-dialog">
        <div class="form-group"><label>Ключ слота (ID)</label><input type="text" id="ao-slot" placeholder="например eye" style="width:100%;"/></div>
        <div class="form-group"><label>Название</label><input type="text" id="ao-name" placeholder="Глаз" style="width:100%;"/></div>
      </div>`;
    await foundry.applications.api.DialogV2.wait({
      window: { title: "Добавить орган / слот", icon: "fa-solid fa-sitemap" },
      position: { width: 300 },
      content,
      buttons: [
        {
          action: "add",
          label: "Добавить",
          icon: "fa-solid fa-check",
          default: true,
          callback: async () => {
            const slotKey = (document.querySelector("#ao-slot")?.value ?? "").trim() || "organ";
            const name = (document.querySelector("#ao-name")?.value ?? "").trim() || slotKey;
            const bodyParts = foundry.utils.deepClone(this.actor?.system?.health?.bodyParts ?? {});
            const part = bodyParts[partId];
            if (!part) return;
            if (!Array.isArray(part.organs)) part.organs = [];
            part.organs.push({ slotKey, name });
            await this.actor.update({ "system.health.bodyParts": bodyParts });
            this.render();
          }
        },
        { action: "cancel", label: "Отмена", icon: "fa-solid fa-times" }
      ]
    });
  }

  async _deletePart(partId) {
    const bodyParts = foundry.utils.deepClone(this.actor.system.health.bodyParts);
    if (!bodyParts[partId]) return;
    const name = bodyParts[partId].name || partId;
    await foundry.applications.api.DialogV2.confirm({
      window: { title: "Удалить часть тела?", icon: "fa-solid fa-trash" },
      content: `<p>Удалить часть «${name}»? Связи с другими частями будут удалены.</p>`,
      yes: {
        label: "Удалить",
        icon: "fa-solid fa-trash",
        callback: async () => {
          delete bodyParts[partId];
          this._scrubRelationsToDeletedPart(bodyParts, partId);
          await this.actor.update({ "system.health.bodyParts": bodyParts });
          this.selectedPartId = null;
          this.render();
        }
      },
      no: { label: "Отмена", icon: "fa-solid fa-times" }
    });
  }

  async addPart() {
    if (!this.actor) return;
    const addMaterialOptionsHtml = MATERIAL_OPTIONS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
    const content = `
      <div class="anatomy-add-part-dialog">
        <div class="form-group"><label>ID</label><input type="text" id="ap-id" placeholder="например leftArm" style="width:100%;"/></div>
        <div class="form-group"><label>Название</label><input type="text" id="ap-name" placeholder="Левая рука" style="width:100%;"/></div>
        <div class="form-group"><label>Вес</label><input type="number" id="ap-weight" value="500" min="1" style="width:100%;"/></div>
        <div class="form-group"><label>Max HP</label><input type="number" id="ap-maxHp" value="20" min="1" style="width:100%;"/></div>
        <div class="form-group"><label>Материал</label><select id="ap-material" style="width:100%;"><option value="">—</option>${addMaterialOptionsHtml}</select></div>
        <div class="form-group"><label>X</label><input type="number" id="ap-x" value="0" style="width:100%;"/></div>
        <div class="form-group"><label>Y</label><input type="number" id="ap-y" value="0" style="width:100%;"/></div>
      </div>`;
    await foundry.applications.api.DialogV2.wait({
      window: { title: "Добавить часть тела", icon: "fa-solid fa-plus" },
      position: { width: 320 },
      content,
      buttons: [
        {
          action: "add",
          label: "Добавить",
          icon: "fa-solid fa-check",
          default: true,
          callback: async (e) => {
            const root = e.currentTarget;
            const id = (root.querySelector("#ap-id")?.value ?? "").trim().replace(/\s+/g, "") || foundry.utils.randomID();
            const name = (root.querySelector("#ap-name")?.value ?? "").trim() || "";
            const weight = Math.max(1, parseInt(root.querySelector("#ap-weight")?.value ?? "500", 10));
            const maxHp = Math.max(1, parseInt(root.querySelector("#ap-maxHp")?.value ?? "20", 10));
            const material = (root.querySelector("#ap-material")?.value ?? "").trim() || null;
            const x = parseInt(root.querySelector("#ap-x")?.value ?? "0", 10) || 0;
            const y = parseInt(root.querySelector("#ap-y")?.value ?? "0", 10) || 0;
            const bodyParts = foundry.utils.deepClone(this.actor.system.health?.bodyParts ?? {});
            // Для runtime-структуры анатомии актёра ключом выступает slotRef; здесь используем id#N
            const existing = Object.keys(bodyParts).filter((k) => k === id || k.startsWith(`${id}#`));
            const nextIndex = existing.length ? existing.length + 1 : 1;
            const slotRef = `${id}#${nextIndex}`;
            if (bodyParts[slotRef]) {
              ui.notifications.warn("Часть с таким ID уже существует");
              return;
            }
            const uuid = foundry.utils.randomID?.() || globalThis.randomID?.() || globalThis.crypto?.randomUUID?.() || `${id}-${Date.now()}`;
            bodyParts[slotRef] = {
              id,
              name: name || undefined,
              uuid,
              slotRef,
              weight,
              maxHp,
              material,
              x,
              y,
              status: "healthy",
              internal: false,
              tags: [],
              exposure: {},
              relations: [],
              links: [],
              organs: []
            };
            await this.actor.update({ "system.health.bodyParts": bodyParts });
            this.render();
          }
        },
        { action: "cancel", label: "Отмена", icon: "fa-solid fa-times" }
      ]
    });
  }

  async saveAnatomyToWorld() {
    const bodyParts = this.actor?.system?.health?.bodyParts ?? {};
    if (!Object.keys(bodyParts).length) {
      ui.notifications.warn("Нет частей тела для сохранения");
      return;
    }
    const name = await this._promptName("Сохранить анатомию", "Название анатомии");
    if (name == null) return;
    const id = foundry.utils.randomID();
    const grid = this.actor?.system?.health?.anatomyGrid;
    await anatomyManager.saveToWorld({
      id,
      name,
      grid: grid ? { width: grid.width, height: grid.height } : null,
      bodyParts: foundry.utils.deepClone(bodyParts),
      links: this._buildLinksFromBodyParts(bodyParts)
    });
    // Считаем, что после сохранения актёр использует эту именованную анатомию
    await this.actor.update({
      "system.anatomy.id": id,
      "system.anatomy.name": name,
      "system.anatomy.type": id
    });
    ui.notifications.info(`Анатомия «${name}» сохранена в мир`);
  }

  async savePresetToWorld() {
    // Для упрощения больше не различаем «анатомию» и «пресет» — сохраняем в том же формате.
    return this.saveAnatomyToWorld();
  }

  /** Построить массив links [{ from, to }] из bodyParts (единый формат с data/anatomy JSON). */
  _buildLinksFromBodyParts(bodyParts) {
    const seen = new Set();
    const links = [];
    for (const [partId, part] of Object.entries(bodyParts || {})) {
      const arr = part.links;
      if (!Array.isArray(arr)) continue;
      for (const otherId of arr) {
        const key = partId < otherId ? `${partId}-${otherId}` : `${otherId}-${partId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ from: partId, to: otherId });
      }
    }
    return links.length ? links : null;
  }

  async _promptName(title, placeholder) {
    return new Promise((resolve) => {
      const content = `
        <div class="anatomy-save-dialog">
          <label>Название</label>
          <input type="text" id="anatomy-save-name" placeholder="${placeholder}" style="width:100%; padding:6px; margin:6px 0;" />
        </div>`;
      foundry.applications.api.DialogV2.wait({
        window: { title, icon: "fa-solid fa-save" },
        position: { width: 320 },
        content,
        buttons: [
          {
            action: "save",
            label: "Сохранить",
            icon: "fa-solid fa-check",
            default: true,
            callback: (e) => {
              const v = e.currentTarget.querySelector("#anatomy-save-name")?.value?.trim();
              resolve(v || null);
            }
          },
          { action: "cancel", label: "Отмена", icon: "fa-solid fa-times", callback: () => resolve(null) }
        ]
      });
    });
  }
}
