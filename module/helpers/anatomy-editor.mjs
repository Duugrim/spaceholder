/**
 * Anatomy Editor - визуализация внешней анатомии: круги на сетке, связи (links).
 * Центрирование по bounding box, Drag&Drop позиции в режиме редактирования.
 * Под сеткой — панель выбранной части (органы, импланты) без всплывающих окон.
 */
import { anatomyManager, coerceAnatomyGridCoord } from '../anatomy-manager.mjs';
import {
  sanitizeRelation,
  dedupeRelations,
  deriveAdjacentLinksFromRelations,
  enforceSingleParentRelation,
  legacyLinksToAdjacentRelations,
  ANATOMY_EXPOSURE_DIRECTIONS,
} from './anatomy-relations.mjs';
import { materialsManager } from './damage/materials-manager.mjs';
import { resolveCoverageEntryToActorSlots } from './body-part-coverage.mjs';
import {
  ANATOMY_GROUP_TYPES,
  ANATOMY_FACES,
  DEFAULT_PART_MATERIAL,
  sanitizeFaces,
  sanitizeInners,
  innersFromPart,
  sanitizePartMaterial,
  sanitizeHeightFrac,
  sanitizeAnatomyGroups,
  stripDeprecatedPartFields,
} from './anatomy-groups.mjs';

const DEFAULT_CELL_SIZE = 42;
const DEFAULT_CIRCLE_RADIUS = 15;
/** Фиксированный размер блока визуализации (9×10 клеток по умолчанию) */
const FIXED_DISPLAY_WIDTH = 378;
const FIXED_DISPLAY_HEIGHT = 420;
const PADDING = 1;

/**
 * Категория ткани части тела (используется описателями травм:
 * `biological` → стандартная модель кровотечения; `bionic` → damage/repair).
 * Категория берётся из каталога материалов части (`part.material`).
 */
const MATERIAL_CATEGORY_OPTIONS = [
  { id: "biological", label: "Биологическая", icon: "fa-hand" },
  { id: "bionic",     label: "Бионика",       icon: "fa-microchip" }
];

/**
 * Маппинг устаревших значений `part.material` (MVP-редактор использовал
 * «плоть / кибернетика / броня / другое») в канонические категории
 * описателей травм. При сохранении всегда пишем каноническое значение.
 */
const LEGACY_MATERIAL_CATEGORY_MAP = Object.freeze({
  flesh:      "biological",
  armor:      "biological",
  other:      "biological",
  cybernetic: "bionic"
});

function normalizeMaterialCategory(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  if (MATERIAL_CATEGORY_OPTIONS.some((o) => o.id === v)) return v;
  return LEGACY_MATERIAL_CATEGORY_MAP[v] ?? "";
}

function materialCategoryLabel(raw) {
  const canon = normalizeMaterialCategory(raw);
  if (!canon) return "—";
  return MATERIAL_CATEGORY_OPTIONS.find((o) => o.id === canon)?.label ?? "—";
}

/** Цвета заливки кругов по категории ткани (с поддержкой legacy-значений) */
const MATERIAL_COLORS = {
  biological: "#c48b6a",
  bionic:     "#5eb8c4",
  // legacy — чтобы старые данные до миграции не теряли подсветку
  flesh:      "#c48b6a",
  cybernetic: "#5eb8c4",
  armor:      "#94a3b8",
  other:      "#b8a3c4"
};

function materialColorFor(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  try {
    const md = materialsManager.getMaterial(v);
    const cat = String(md?.category ?? "").toLowerCase();
    if (cat === "bionic" || cat === "mechanical" || cat === "synthetic") return MATERIAL_COLORS.bionic;
  } catch (_) { /* ignore */ }
  return MATERIAL_COLORS[v] ?? MATERIAL_COLORS[normalizeMaterialCategory(v)] ?? MATERIAL_COLORS.biological;
}

/**
 * Собрать варианты материала для слоёв тела (из `materialsManager`).
 * Сортировка: сначала biological (skin/muscle/bone), затем прочие по
 * категории и id. Пустых/пробельных значений не возвращаем. Если
 * `extraId` задан и ещё не в списке — он добавляется в конец (так
 * сохраняются уже проставленные материалы, которых нет в текущем реестре).
 *
 * @param {string} [extraId]
 * @returns {Array<{ id:string, label:string, category:string }>}
 */
function collectMaterialOptions(extraId = "") {
  const L = (key) => (typeof game !== "undefined" ? game.i18n?.localize?.(key) ?? key : key);
  // Anatomy editor is opened post-`ready`, so materialsManager is always
  // initialized from system compendium + world items. If the world somehow
  // has no `material` items at all the dropdown stays empty; the caller
  // will still add `extraId` so already-picked slugs aren't lost.
  const ids = new Set(materialsManager.listMaterialIds());
  const extra = String(extraId ?? "").trim();
  if (extra) ids.add(extra);
  const rows = [];
  for (const id of ids) {
    const md = materialsManager.getMaterial(id);
    const name = md?.nameLocalized ? L(md.nameLocalized) : (md?.name || id);
    const category = String(md?.category ?? "").trim() || "other";
    rows.push({ id, label: name && name !== md?.nameLocalized ? name : (md?.name || id), category });
  }
  const rank = (c) => (c === "biological" ? 0 : 1);
  rows.sort((a, b) => (rank(a.category) - rank(b.category)) || a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  return rows;
}

function materialDisplayName(materialId) {
  const L = (key) => (typeof game !== "undefined" ? game.i18n?.localize?.(key) ?? key : key);
  const id = String(materialId ?? "").trim();
  if (!id) return "—";
  const md = materialsManager.getMaterial(id);
  if (!md) return id;
  const localized = md.nameLocalized ? L(md.nameLocalized) : "";
  return (localized && localized !== md.nameLocalized) ? localized : (md.name || id);
}

function categoryDisplayName(category) {
  const L = (key) => (typeof game !== "undefined" ? game.i18n?.localize?.(key) ?? key : key);
  const c = String(category ?? "").trim();
  if (!c) return "";
  const key = c.charAt(0).toUpperCase() + c.slice(1);
  const translated = L(`SPACEHOLDER.Materials.Categories.${key}`);
  return (translated && translated !== `SPACEHOLDER.Materials.Categories.${key}`) ? translated : c;
}

const RELATION_KIND_LABELS = {
  adjacent: "Рядом",
  behind: "За",
  parent: "Родитель"
};

const PANEL_PROTECTION_TABS = Object.freeze([
  { id: "items", label: "Предметы" },
  { id: "layers", label: "Броня" }
]);

const PANEL_META_TABS = Object.freeze([
  { id: "inners", label: "Органы" },
  { id: "relations", label: "Связи" },
  { id: "info", label: "Инфо" }
]);

const EDIT_DIALOG_TABS = Object.freeze([
  { id: "basic", label: "Основное" },
  { id: "relations", label: "Связи" },
  { id: "inners", label: "Органы" },
  { id: "danger", label: "Удалить" }
]);

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
    /** Активные мини-вкладки панели выбранной части — переживают re-render. */
    this.panelTabs = options.panelTabs ?? { protection: "items", meta: "inners" };
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
      const rawCategory = part.material ?? "";
      const canonCategory = normalizeMaterialCategory(rawCategory) || rawCategory;
      node.dataset.material = canonCategory || "none";
      const fill = materialColorFor(rawCategory);
      if (fill) node.style.setProperty("--part-fill", fill);
      node.dataset.partId = partId;
      node.style.left = `${px.left}px`;
      node.style.top = `${px.top}px`;
      node.style.width = `${circleRadius * 2}px`;
      node.style.height = `${circleRadius * 2}px`;
      node.title = this.linkMode ? `Связь: перетащите на другую часть (${part.name || partId})` : (part.name || partId);
      node.draggable = this.editMode && this.editable;
      if (this.linkMode) node.classList.add("anatomy-editor-part--link-mode");
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

    const cols = document.createElement("div");
    cols.className = "anatomy-editor-panel-cols";
    cols.appendChild(this._buildProtectionColumn(partId, bodyPart));
    cols.appendChild(this._buildCenterColumn(partId, bodyPart));
    cols.appendChild(this._buildMetaColumn(partId, bodyPart));
    panel.appendChild(cols);
  }

  _getPartDisplayName(partId, bodyPart) {
    const allBodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const typeId = String(bodyPart?.id ?? "").trim();
    const hasDup = !!typeId && Object.values(allBodyParts).filter((p) => String(p?.id ?? "").trim() === typeId).length > 1;
    const baseName = bodyPart.displayName || bodyPart.name || bodyPart.id || partId;
    const m = String(partId).match(/#(\d+)$/);
    const dupIndex = hasDup && m ? Number(m[1]) : null;
    return dupIndex ? `${baseName} (${dupIndex})` : baseName;
  }

  /**
   * Универсальный блок мини-вкладок: создаёт панель кнопок и возвращает
   * пустой контейнер под активную вкладку. Переключение вкладок
   * сохраняет id в `this.panelTabs[stateKey]` и делает локальный
   * re-render только правого блока.
   *
   * @param {'protection'|'meta'} stateKey
   * @param {ReadonlyArray<{id:string,label:string}>} tabs
   * @param {(tabId:string, container:HTMLElement) => void} renderTab
   * @returns {HTMLElement}
   */
  _buildMiniTabsColumn(stateKey, tabs, renderTab) {
    const col = document.createElement("div");
    col.className = `anatomy-editor-panel-col anatomy-editor-panel-col--${stateKey}`;

    const tabIds = tabs.map((t) => t.id);
    const saved = this.panelTabs?.[stateKey];
    const activeId = tabIds.includes(saved) ? saved : tabIds[0];
    if (this.panelTabs) this.panelTabs[stateKey] = activeId;

    const tabsBar = document.createElement("div");
    tabsBar.className = "anatomy-editor-panel-minitabs";
    col.appendChild(tabsBar);

    const content = document.createElement("div");
    content.className = "anatomy-editor-panel-minitab-content";
    col.appendChild(content);

    const setActive = (nextId) => {
      if (!tabIds.includes(nextId)) return;
      if (this.panelTabs) this.panelTabs[stateKey] = nextId;
      for (const btn of tabsBar.querySelectorAll("button[data-tab]")) {
        btn.classList.toggle("active", btn.dataset.tab === nextId);
      }
      content.innerHTML = "";
      renderTab(nextId, content);
    };

    for (const t of tabs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "anatomy-editor-panel-minitab";
      if (t.id === activeId) btn.classList.add("active");
      btn.dataset.tab = t.id;
      btn.textContent = t.label;
      btn.addEventListener("click", () => setActive(t.id));
      tabsBar.appendChild(btn);
    }

    renderTab(activeId, content);
    return col;
  }

  _buildProtectionColumn(partId, bodyPart) {
    return this._buildMiniTabsColumn("protection", PANEL_PROTECTION_TABS, (tabId, content) => {
      if (tabId === "items") this._renderProtectionItems(content, partId);
      else this._renderProtectionLayers(content, partId);
    });
  }

  _buildMetaColumn(partId, bodyPart) {
    return this._buildMiniTabsColumn("meta", PANEL_META_TABS, (tabId, content) => {
      switch (tabId) {
        case "inners":
          this._renderOrgansReadonly(content, bodyPart);
          break;
        case "relations":
          this._renderRelationsReadonly(content, bodyPart);
          break;
        case "info":
          this._renderInfoReadonly(content, partId, bodyPart);
          break;
      }
    });
  }

  _buildCenterColumn(partId, bodyPart) {
    const col = document.createElement("div");
    col.className = "anatomy-editor-panel-col anatomy-editor-panel-col--center";

    const header = document.createElement("div");
    header.className = "anatomy-editor-panel-header";
    const nameEl = document.createElement("div");
    nameEl.className = "anatomy-editor-panel-title";
    nameEl.textContent = this._getPartDisplayName(partId, bodyPart);
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
    col.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "anatomy-editor-panel-center-grid";

    const propsCol = document.createElement("div");
    propsCol.className = "anatomy-editor-panel-center-props";
    const materialLabel = materialDisplayName(bodyPart.material) || sanitizePartMaterial(bodyPart.material);
    const facesLabel = sanitizeFaces(bodyPart.faces).join(", ");
    const propsBlock = document.createElement("div");
    propsBlock.className = "anatomy-editor-panel-props";
    propsBlock.innerHTML = `
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">Max HP</span><span class="anatomy-editor-panel-value">${bodyPart.maxHp ?? 0}</span></div>
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">Материал</span><span class="anatomy-editor-panel-value">${materialLabel}</span></div>
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">Стороны</span><span class="anatomy-editor-panel-value">${facesLabel}</span></div>
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">Высота</span><span class="anatomy-editor-panel-value">${sanitizeHeightFrac(bodyPart.heightFrac).toFixed(2)}</span></div>`;
    propsCol.appendChild(propsBlock);

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
      propsCol.appendChild(impSection);
    }
    grid.appendChild(propsCol);

    col.appendChild(grid);
    return col;
  }

  _renderOrgansReadonly(container, bodyPart) {
    const inners = innersFromPart(bodyPart);
    if (!inners.length) {
      const empty = document.createElement("p");
      empty.className = "anatomy-editor-panel-empty-hint";
      empty.textContent = "—";
      container.appendChild(empty);
      return;
    }
    const list = document.createElement("ul");
    list.className = "anatomy-editor-panel-list";
    for (const o of inners) {
      const li = document.createElement("li");
      const pct = Number(o.occupancyPct) ? ` ${o.occupancyPct}%` : "";
      li.textContent = `${o.name || o.id}${pct}`;
      list.appendChild(li);
    }
    container.appendChild(list);
  }

  _renderRelationsReadonly(container, bodyPart) {
    const bodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const rels = this._getRelationsForPart(bodyPart);
    if (!rels.length) {
      const empty = document.createElement("p");
      empty.className = "anatomy-editor-panel-empty-hint";
      empty.textContent = "—";
      container.appendChild(empty);
      return;
    }
    const list = document.createElement("ul");
    list.className = "anatomy-editor-panel-list";
    for (const rel of rels) {
      const other = bodyParts[rel.target];
      const kindLabel = RELATION_KIND_LABELS[rel.kind] || rel.kind;
      const behindExtra =
        rel.kind === "behind"
          ? `${rel.chance !== undefined ? ` (${rel.chance}%)` : ""}${rel.direction ? ` · ${rel.direction}` : ""}`
          : "";
      const li = document.createElement("li");
      li.textContent = `${kindLabel}: ${other?.displayName || other?.name || rel.target}${behindExtra}`;
      list.appendChild(li);
    }
    container.appendChild(list);
  }

  _renderInfoReadonly(container, partId, bodyPart) {
    const props = document.createElement("div");
    props.className = "anatomy-editor-panel-props";
    const slotRefCode = String(partId).replace(/</g, "&lt;");
    const typeIdCode = String(bodyPart.id ?? "—").replace(/</g, "&lt;");
    const uuidCode = String(bodyPart.uuid ?? "—").replace(/</g, "&lt;");
    props.innerHTML = `
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">Слот</span><span class="anatomy-editor-panel-value"><code>${slotRefCode}</code></span></div>
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">Тип</span><span class="anatomy-editor-panel-value"><code>${typeIdCode}</code></span></div>
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">Сетка</span><span class="anatomy-editor-panel-value">(${bodyPart.x ?? 0}, ${bodyPart.y ?? 0})</span></div>
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">UUID</span><span class="anatomy-editor-panel-value"><code>${uuidCode}</code></span></div>`;
    container.appendChild(props);
  }

  /**
   * Собрать экипированные предметы, которые перекрывают указанную часть
   * тела (актёра) хотя бы одним coverage-entry. Возвращает массив
   * `{ item, entries }`, где `entries` — только те записи покрытия,
   * что совпали именно с `partId`.
   *
   * @param {string} partId
   * @returns {Array<{ item: object, entries: object[] }>}
   */
  _collectCoveringItems(partId) {
    const items = this.actor?.items;
    if (!items) return [];
    const bodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const out = [];
    for (const item of items) {
      if (item.type !== "item") continue;
      if (!item.system?.equipped) continue;
      const covered = Array.isArray(item.system?.coveredParts) ? item.system.coveredParts : [];
      const matched = [];
      for (const entry of covered) {
        const { slotRefs } = resolveCoverageEntryToActorSlots(bodyParts, entry);
        if (slotRefs.includes(partId)) matched.push(entry);
      }
      if (matched.length) out.push({ item, entries: matched });
    }
    out.sort((a, b) => String(a.item.name || "").localeCompare(String(b.item.name || ""), game?.i18n?.lang || "en"));
    return out;
  }

  _renderProtectionItems(container, partId) {
    const items = this._collectCoveringItems(partId);
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "anatomy-editor-panel-empty-hint";
      empty.textContent = "Нет защиты.";
      container.appendChild(empty);
      return;
    }
    const list = document.createElement("ul");
    list.className = "anatomy-editor-panel-list anatomy-editor-panel-protection-items";
    for (const { item } of items) {
      const li = document.createElement("li");
      li.textContent = item.name || item.id;
      li.title = item.name || item.id;
      list.appendChild(li);
    }
    container.appendChild(list);
  }

  _renderProtectionLayers(container, partId) {
    const items = this._collectCoveringItems(partId);
    /** @type {Array<{material:string,thickness:number,source:string}>} */
    const rows = [];
    for (const { item, entries } of items) {
      for (const entry of entries) {
        const layers = Array.isArray(entry?.layers) ? entry.layers : [];
        for (const layer of layers) {
          const material = String(layer?.material ?? "").trim();
          const thickness = Number(layer?.thickness);
          if (!material || !Number.isFinite(thickness) || thickness <= 0) continue;
          rows.push({ material, thickness, source: item.name || item.id });
        }
      }
    }
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "anatomy-editor-panel-empty-hint";
      empty.textContent = "Слои не заданы.";
      container.appendChild(empty);
      return;
    }
    const list = document.createElement("div");
    list.className = "anatomy-editor-panel-item-layers-list";
    rows.forEach((layer, idx) => {
      const row = document.createElement("div");
      row.className = "anatomy-editor-panel-item-layer-row";
      const name = document.createElement("span");
      name.className = "anatomy-editor-panel-item-layer-name";
      name.textContent = `${idx + 1}. ${materialDisplayName(layer.material)}`;
      const md = materialsManager.getMaterial(layer.material);
      const cat = categoryDisplayName(md?.category);
      if (cat) name.title = cat;
      row.appendChild(name);
      const thick = document.createElement("span");
      thick.className = "anatomy-editor-panel-body-layer-thickness";
      thick.textContent = `× ${layer.thickness}`;
      row.appendChild(thick);
      const src = document.createElement("span");
      src.className = "anatomy-editor-panel-item-layer-source";
      src.textContent = layer.source;
      src.title = layer.source;
      row.appendChild(src);
      list.appendChild(row);
    });
    container.appendChild(list);
  }

  /**
   * Комплексный диалог редактирования части тела с внутренними вкладками:
   * общие поля, экспозиция, связи, слои тела, органы, опасная зона (удаление).
   * Выносит всю CRUD-логику из панели — чтобы панель оставалась компактной.
   *
   * @param {string} partId
   * @param {object} [opts]
   * @param {string} [opts.initialTab]
   */
  async _openEditPartDialog(partId, { initialTab = "basic" } = {}) {
    const bodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const part = bodyParts[partId];
    if (!part) return;

    /** @type {{ currentPartId: string, activeTab: string }} */
    const state = {
      currentPartId: partId,
      activeTab: EDIT_DIALOG_TABS.some((t) => t.id === initialTab) ? initialTab : "basic"
    };

    const buildTabBar = () => {
      const bar = document.createElement("nav");
      bar.className = "anatomy-edit-part-tabs";
      for (const t of EDIT_DIALOG_TABS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "anatomy-edit-part-tab";
        btn.dataset.tab = t.id;
        btn.textContent = t.label;
        if (t.id === state.activeTab) btn.classList.add("active");
        bar.appendChild(btn);
      }
      return bar;
    };

    const content = `
      <div class="anatomy-edit-part-dialog anatomy-edit-part-dialog--tabbed">
        <div data-edit-part-tabs></div>
        <div class="anatomy-edit-part-body" data-edit-part-body></div>
      </div>`;

    /** @type {HTMLElement|null} */
    let dialogRoot = null;

    const wireTabs = () => {
      const bar = dialogRoot?.querySelector("[data-edit-part-tabs]");
      if (!bar) return;
      bar.innerHTML = "";
      bar.appendChild(buildTabBar());
      for (const btn of bar.querySelectorAll("button[data-tab]")) {
        btn.addEventListener("click", () => {
          state.activeTab = btn.dataset.tab;
          for (const b of bar.querySelectorAll("button[data-tab]")) {
            b.classList.toggle("active", b.dataset.tab === state.activeTab);
          }
          renderActiveTab();
        });
      }
    };

    const renderActiveTab = () => {
      const body = dialogRoot?.querySelector("[data-edit-part-body]");
      if (!body) return;
      body.innerHTML = "";
      const currentPart = this.actor?.system?.health?.bodyParts?.[state.currentPartId];
      if (!currentPart) {
        body.innerHTML = '<p class="notes">Часть не найдена.</p>';
        return;
      }
      switch (state.activeTab) {
        case "basic":
          body.appendChild(this._buildEditBasicSection(state, currentPart));
          break;
        case "relations":
          body.appendChild(this._buildEditRelationsSection(state, currentPart, refresh));
          break;
        case "inners":
          body.appendChild(this._buildEditOrgansSection(state, currentPart, refresh));
          break;
        case "danger":
          body.appendChild(this._buildEditDangerSection(state, refresh, close));
          break;
      }
    };

    /** @type {(() => void) | null} */
    let closeFn = null;
    const close = () => { if (closeFn) closeFn(); };

    const refresh = () => {
      renderActiveTab();
    };

    await foundry.applications.api.DialogV2.wait({
      window: { title: "Редактировать часть тела", icon: "fa-solid fa-pencil-alt" },
      position: { width: 540 },
      classes: ["spaceholder", "anatomy-edit-part-dialog-window"],
      content,
      render: (_event, dialog) => {
        dialogRoot = dialog?.element ?? null;
        closeFn = () => dialog?.close?.();
        wireTabs();
        renderActiveTab();
      },
      buttons: [
        {
          action: "save",
          label: "Сохранить",
          icon: "fa-solid fa-check",
          default: true,
          callback: async () => {
            await this._saveBasicFromDialog(state, dialogRoot);
          }
        },
        { action: "close", label: "Закрыть", icon: "fa-solid fa-times" }
      ]
    });
  }

  /**
   * Собрать и сохранить значения вкладки «Основное».
   *
   * @param {{ currentPartId: string }} state
   * @param {HTMLElement|null} dialogRoot
   */
  async _saveBasicFromDialog(state, dialogRoot) {
    if (!dialogRoot) return;
    const bodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const partId = state.currentPartId;
    const part = bodyParts[partId];
    if (!part) return;

    const basicForm = dialogRoot.querySelector("[data-edit-part-basic-form]");
    const readField = (scope, selector) => scope?.querySelector(selector);

    const newIdRaw = readField(basicForm, "#ep-id")?.value;
    const newId = newIdRaw !== undefined ? (String(newIdRaw).trim().replace(/\s+/g, "") || partId) : partId;
    const nameRaw = readField(basicForm, "#ep-name")?.value;
    const name = nameRaw !== undefined ? (String(nameRaw).trim() || newId) : part.name;
    const maxHpRaw = readField(basicForm, "#ep-maxHp")?.value;
    const maxHp = maxHpRaw !== undefined ? Math.max(0, parseInt(maxHpRaw, 10) || 0) : (part.maxHp ?? 0);
    const materialRaw = readField(basicForm, "#ep-material")?.value;
    const material = materialRaw !== undefined
      ? sanitizePartMaterial(materialRaw)
      : sanitizePartMaterial(part.material);
    const xRaw = readField(basicForm, "#ep-x")?.value;
    const x = xRaw !== undefined ? (parseInt(xRaw, 10) || 0) : (part.x ?? 0);
    const yRaw = readField(basicForm, "#ep-y")?.value;
    const y = yRaw !== undefined ? (parseInt(yRaw, 10) || 0) : (part.y ?? 0);
    const hfRaw = readField(basicForm, "#ep-heightFrac")?.value;
    const heightFrac = hfRaw !== undefined ? sanitizeHeightFrac(hfRaw, 0.5) : sanitizeHeightFrac(part.heightFrac, 0.5);

    const faceChecks = ANATOMY_FACES.filter((face) => readField(basicForm, `#ep-face-${face}`)?.checked);
    const faces = sanitizeFaces(faceChecks.length ? faceChecks : part.faces);

    const applyFields = (partData) => {
      partData.name = name;
      partData.maxHp = maxHp;
      partData.material = material;
      partData.x = x;
      partData.y = y;
      partData.heightFrac = heightFrac;
      partData.faces = faces;
      stripDeprecatedPartFields(partData);
    };

    const updated = foundry.utils.deepClone(bodyParts);
    if (newId !== partId) {
      if (updated[newId]) {
        ui.notifications.warn("Часть с таким ID уже существует");
        return;
      }
      const partData = updated[partId];
      delete updated[partId];
      applyFields(partData);
      partData.slotRef = newId;
      updated[newId] = partData;
      this._remapRelationTargetsInAll(updated, partId, newId);
      this.selectedPartId = newId;
      state.currentPartId = newId;
    } else {
      applyFields(updated[partId]);
    }
    this._normalizeAllBodyPartRelations(updated);
    await this.actor.update({ "system.health.bodyParts": updated });
    this.render();
  }

  _buildEditBasicSection(state, part) {
    const partId = state.currentPartId;
    const section = document.createElement("section");
    section.className = "anatomy-edit-part-section";
    section.dataset.tabContent = "basic";
    const materialVal = sanitizePartMaterial(part.material);
    const materialOptionsHtml = collectMaterialOptions(materialVal).map(
      (m) => `<option value="${m.id}" ${m.id === materialVal ? "selected" : ""}>${m.label}</option>`
    ).join("");
    const esc = (s) => String(s ?? "").replace(/"/g, "&quot;");
    const faces = sanitizeFaces(part.faces);
    const faceChecks = ANATOMY_FACES.map((face) => {
      const checked = faces.includes(face) ? "checked" : "";
      const label = face === "front" ? "Спереди" : "Сзади";
      return `<label class="anatomy-edit-face-check"><input type="checkbox" id="ep-face-${face}" ${checked}/> ${label}</label>`;
    }).join("");
    section.innerHTML = `
      <form data-edit-part-basic-form class="anatomy-edit-part-form">
        <div class="anatomy-edit-part-form-grid">
          <div class="form-group"><label>ID</label><input type="text" id="ep-id" value="${esc(partId)}" placeholder="например leftArm"/></div>
          <div class="form-group"><label>Название</label><input type="text" id="ep-name" value="${esc(part.name || "")}" placeholder="Название части"/></div>
          <div class="form-group"><label>Max HP</label><input type="number" id="ep-maxHp" value="${part.maxHp ?? 0}" min="0"/></div>
          <div class="form-group"><label>Высота (0–1)</label><input type="number" id="ep-heightFrac" value="${sanitizeHeightFrac(part.heightFrac)}" min="0" max="1" step="0.01"/></div>
          <div class="form-group"><label>Сетка X</label><input type="number" id="ep-x" value="${part.x ?? 0}"/></div>
          <div class="form-group"><label>Сетка Y</label><input type="number" id="ep-y" value="${part.y ?? 0}"/></div>
        </div>
        <div class="form-group">
          <label>Материал</label>
          <select id="ep-material">${materialOptionsHtml}</select>
        </div>
        <div class="form-group">
          <label>Стороны (слоты брони)</label>
          <div class="anatomy-edit-faces">${faceChecks}</div>
        </div>
      </form>`;
    return section;
  }

  _buildEditRelationsSection(state, part, refresh) {
    const partId = state.currentPartId;
    const bodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const section = document.createElement("section");
    section.className = "anatomy-edit-part-section";
    section.dataset.tabContent = "relations";
    const rels = this._getRelationsForPart(part);
    const list = document.createElement("div");
    list.className = "anatomy-editor-panel-links-list";
    if (!rels.length) {
      const empty = document.createElement("p");
      empty.className = "anatomy-editor-panel-empty-hint";
      empty.textContent = "Связей нет.";
      list.appendChild(empty);
    } else {
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
        removeBtn.innerHTML = '<i class="fas fa-minus"></i>';
        removeBtn.addEventListener("click", async () => {
          await this._removeRelation(partId, idx);
          refresh();
        });
        row.appendChild(removeBtn);
        list.appendChild(row);
      });
    }
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "anatomy-editor-panel-add-link";
    addBtn.innerHTML = '<i class="fas fa-plus"></i> Добавить связь';
    addBtn.addEventListener("click", async () => {
      await this._openAddRelationDialog(partId);
      refresh();
    });
    section.appendChild(list);
    section.appendChild(addBtn);
    return section;
  }

  _buildEditOrgansSection(state, part, refresh) {
    const partId = state.currentPartId;
    const section = document.createElement("section");
    section.className = "anatomy-edit-part-section";
    section.dataset.tabContent = "inners";
    const inners = innersFromPart(part);
    const list = document.createElement("div");
    list.className = "anatomy-editor-panel-organs-list";
    if (!inners.length) {
      const empty = document.createElement("p");
      empty.className = "anatomy-editor-panel-empty-hint";
      empty.textContent = "Органов нет.";
      list.appendChild(empty);
    } else {
      inners.forEach((o, i) => {
        const row = document.createElement("div");
        row.className = "anatomy-editor-panel-organ-row";
        const nameSpan = document.createElement("span");
        nameSpan.className = "anatomy-editor-panel-organ-name";
        nameSpan.textContent = `${o.name || o.id} · ${o.occupancyPct || 0}% · ${o.material || ""}`;
        row.appendChild(nameSpan);
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "anatomy-editor-panel-organ-remove";
        removeBtn.title = "Удалить орган";
        removeBtn.innerHTML = '<i class="fas fa-minus"></i>';
        removeBtn.addEventListener("click", async () => {
          await this._removeOrgan(partId, i);
          refresh();
        });
        row.appendChild(removeBtn);
        list.appendChild(row);
      });
    }
    section.appendChild(list);
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "anatomy-editor-panel-add-organ";
    addBtn.innerHTML = '<i class="fas fa-plus"></i> Добавить орган';
    addBtn.addEventListener("click", async () => {
      await this._addOrgan(partId);
      refresh();
    });
    section.appendChild(addBtn);
    return section;
  }

  _buildEditDangerSection(state, refresh, close) {
    const partId = state.currentPartId;
    const section = document.createElement("section");
    section.className = "anatomy-edit-part-section anatomy-edit-part-section--danger";
    section.dataset.tabContent = "danger";
    const warn = document.createElement("p");
    warn.className = "notes";
    warn.textContent = "Удаление части тела безвозвратно. Связи с другими частями будут вычищены.";
    section.appendChild(warn);
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "anatomy-editor-panel-delete";
    delBtn.innerHTML = '<i class="fas fa-trash"></i> Удалить часть';
    delBtn.addEventListener("click", async () => {
      const deleted = await this._deletePart(partId);
      if (deleted) close();
      else refresh();
    });
    section.appendChild(delBtn);
    return section;
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
    if (!part) return;
    const inners = innersFromPart(part);
    if (index < 0 || index >= inners.length) return;
    inners.splice(index, 1);
    part.inners = sanitizeInners(inners);
    delete part.organs;
    await this.actor.update({ "system.health.bodyParts": bodyParts });
    this.render();
  }

  async _addOrgan(partId) {
    const matOpts = collectMaterialOptions(DEFAULT_PART_MATERIAL).map(
      (m) => `<option value="${m.id}" ${m.id === DEFAULT_PART_MATERIAL ? "selected" : ""}>${m.label}</option>`
    ).join("");
    const content = `
      <div class="anatomy-add-organ-dialog">
        <div class="form-group"><label>ID</label><input type="text" id="ao-slot" placeholder="например eye" style="width:100%;"/></div>
        <div class="form-group"><label>Название</label><input type="text" id="ao-name" placeholder="Глаз" style="width:100%;"/></div>
        <div class="form-group"><label>Доля %</label><input type="number" id="ao-pct" value="10" min="0" max="100" style="width:100%;"/></div>
        <div class="form-group"><label>Материал</label><select id="ao-mat" style="width:100%;">${matOpts}</select></div>
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
          callback: async (ev) => {
            const root = ev?.currentTarget ?? document;
            const slotKey = (root.querySelector("#ao-slot")?.value ?? "").trim() || "organ";
            const name = (root.querySelector("#ao-name")?.value ?? "").trim() || slotKey;
            const occupancyPct = Math.max(0, Number(root.querySelector("#ao-pct")?.value) || 0);
            const material = sanitizePartMaterial(root.querySelector("#ao-mat")?.value);
            const bodyParts = foundry.utils.deepClone(this.actor?.system?.health?.bodyParts ?? {});
            const part = bodyParts[partId];
            if (!part) return;
            const inners = innersFromPart(part);
            inners.push({ id: slotKey, name, occupancyPct, material, statuses: [] });
            part.inners = sanitizeInners(inners);
            delete part.organs;
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
    if (!bodyParts[partId]) return false;
    const name = bodyParts[partId].name || partId;
    let deleted = false;
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
          deleted = true;
        }
      },
      no: { label: "Отмена", icon: "fa-solid fa-times" }
    });
    return deleted;
  }

  async addPart() {
    if (!this.actor) return;
    const addMaterialOptionsHtml = collectMaterialOptions(DEFAULT_PART_MATERIAL).map(
      (m) => `<option value="${m.id}" ${m.id === DEFAULT_PART_MATERIAL ? "selected" : ""}>${m.label}</option>`
    ).join("");
    const content = `
      <div class="anatomy-add-part-dialog">
        <div class="form-group"><label>ID</label><input type="text" id="ap-id" placeholder="например leftArm" style="width:100%;"/></div>
        <div class="form-group"><label>Название</label><input type="text" id="ap-name" placeholder="Левая рука" style="width:100%;"/></div>
        <div class="form-group"><label>Max HP</label><input type="number" id="ap-maxHp" value="20" min="1" style="width:100%;"/></div>
        <div class="form-group"><label>Материал</label><select id="ap-material" style="width:100%;">${addMaterialOptionsHtml}</select></div>
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
            const maxHp = Math.max(1, parseInt(root.querySelector("#ap-maxHp")?.value ?? "20", 10));
            const material = sanitizePartMaterial(root.querySelector("#ap-material")?.value);
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
              maxHp,
              material,
              x,
              y,
              heightFrac: 0.5,
              faces: ["front"],
              tags: [],
              relations: [],
              links: [],
              inners: []
            };
            await this.actor.update({ "system.health.bodyParts": bodyParts });
            this.render();
          }
        },
        { action: "cancel", label: "Отмена", icon: "fa-solid fa-times" }
      ]
    });
  }

  async openGroupsDialog() {
    if (!this.actor) return;
    const bodyParts = this.actor.system?.health?.bodyParts ?? {};
    const partOptions = Object.entries(bodyParts).map(([slot, p]) => {
      const label = p.displayName || p.name || p.id || slot;
      return { slot, label };
    });
    const typeLabels = {
      manipulation: game.i18n?.localize?.("SPACEHOLDER.AnatomyGroups.TypeManipulation") ?? "manipulation",
      movement: game.i18n?.localize?.("SPACEHOLDER.AnatomyGroups.TypeMovement") ?? "movement",
      sensory: game.i18n?.localize?.("SPACEHOLDER.AnatomyGroups.TypeSensory") ?? "sensory",
      critical: game.i18n?.localize?.("SPACEHOLDER.AnatomyGroups.TypeCritical") ?? "critical",
    };
    const groups = sanitizeAnatomyGroups(this.actor.system?.anatomy?.groups, [
      ...Object.keys(bodyParts),
      ...Object.values(bodyParts).map((p) => String(p?.id ?? "")).filter(Boolean),
    ]);
    const override = String(this.actor.system?.anatomy?.hitGroupOverride ?? "").trim();
    const groupRows = groups.map((g, i) => {
      const typeOpts = ANATOMY_GROUP_TYPES.map((t) =>
        `<option value="${t}" ${g.type === t ? "selected" : ""}>${typeLabels[t] || t}</option>`
      ).join("");
      const partsVal = (g.parts ?? []).join(", ");
      return `<div class="form-group anatomy-group-row" data-idx="${i}">
        <input type="text" data-g="id" value="${g.id}" placeholder="id"/>
        <input type="text" data-g="name" value="${g.name}" placeholder="name"/>
        <select data-g="type">${typeOpts}</select>
        <input type="text" data-g="parts" value="${partsVal}" placeholder="part ids, comma-separated"/>
      </div>`;
    }).join("");
    const overrideOpts = [`<option value="">—</option>`]
      .concat(groups.map((g) => `<option value="${g.id}" ${g.id === override ? "selected" : ""}>${g.name}</option>`))
      .join("");
    const partHint = partOptions.map((p) => p.slot).join(", ");
    const content = `
      <div class="anatomy-groups-dialog">
        <p class="notes">${game.i18n?.localize?.("SPACEHOLDER.AnatomyGroups.Title") ?? "Groups"}</p>
        ${groupRows || "<p class='notes'>—</p>"}
        <button type="button" data-add-group><i class="fas fa-plus"></i></button>
        <div class="form-group">
          <label>${game.i18n?.localize?.("SPACEHOLDER.AnatomyGroups.Override") ?? "Override"}</label>
          <select id="ag-override">${overrideOpts}</select>
        </div>
        <p class="notes">${partHint}</p>
      </div>`;
    await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n?.localize?.("SPACEHOLDER.AnatomyGroups.Title") ?? "Groups", icon: "fa-solid fa-layer-group" },
      position: { width: 560 },
      content,
      render: (_ev, dialog) => {
        dialog?.element?.querySelector("[data-add-group]")?.addEventListener("click", () => {
          const wrap = dialog.element.querySelector(".anatomy-groups-dialog");
          if (!wrap) return;
          const row = document.createElement("div");
          row.className = "form-group anatomy-group-row";
          const typeOpts = ANATOMY_GROUP_TYPES.map((t) => `<option value="${t}">${typeLabels[t] || t}</option>`).join("");
          row.innerHTML = `<input type="text" data-g="id" placeholder="id"/>
            <input type="text" data-g="name" placeholder="name"/>
            <select data-g="type">${typeOpts}</select>
            <input type="text" data-g="parts" placeholder="part ids"/>`;
          wrap.querySelector("[data-add-group]")?.before(row);
        });
      },
      buttons: [
        {
          action: "save",
          label: "Сохранить",
          icon: "fa-solid fa-check",
          default: true,
          callback: async (ev) => {
            const root = ev?.currentTarget ?? document;
            const next = [];
            for (const row of root.querySelectorAll(".anatomy-group-row")) {
              const id = String(row.querySelector('[data-g="id"]')?.value ?? "").trim();
              if (!id) continue;
              next.push({
                id,
                name: String(row.querySelector('[data-g="name"]')?.value ?? "").trim() || id,
                type: String(row.querySelector('[data-g="type"]')?.value ?? "").trim(),
                parts: String(row.querySelector('[data-g="parts"]')?.value ?? "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              });
            }
            const hitGroupOverride = String(root.querySelector("#ag-override")?.value ?? "").trim();
            await this.actor.update({
              "system.anatomy.groups": sanitizeAnatomyGroups(next, [
                ...Object.keys(bodyParts),
                ...Object.values(bodyParts).map((p) => String(p?.id ?? "")).filter(Boolean),
              ]),
              "system.anatomy.hitGroupOverride": hitGroupOverride,
            });
            this.render();
          }
        },
        { action: "close", label: "Закрыть", icon: "fa-solid fa-times" }
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
      heightM: this.actor?.system?.heightM,
      groups: this.actor?.system?.anatomy?.groups ?? [],
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
