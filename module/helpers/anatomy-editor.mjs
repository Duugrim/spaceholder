/**
 * Anatomy Editor - визуализация внешней анатомии: круги на сетке, связи (links).
 * Центрирование по bounding box, Drag&Drop позиции в режиме редактирования.
 * Под сеткой — панель выбранной части (органы, импланты) без всплывающих окон.
 */
import { anatomyManager } from '../anatomy-manager.mjs';

const DEFAULT_CELL_SIZE = 42;
const DEFAULT_CIRCLE_RADIUS = 15;
/** Фиксированный размер блока визуализации (9×10 клеток по умолчанию) */
const FIXED_DISPLAY_WIDTH = 378;
const FIXED_DISPLAY_HEIGHT = 420;
const PADDING = 1;

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
      const x = Number(part.x ?? 0);
      const y = Number(part.y ?? 0);
      partsById[partId] = { ...part, id: partId, x, y };
    }
    return partsById;
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

    const linkSet = new Set();
    for (const [partId, part] of Object.entries(bodyParts)) {
      const links = Array.isArray(part.links) ? part.links : [];
      const from = partsById[partId];
      if (!from) continue;
      for (const toId of links) {
        const to = partsById[toId];
        if (!to) continue;
        const key = [partId, toId].sort().join("--");
        if (linkSet.has(key)) continue;
        linkSet.add(key);
        const fromPx = this._toPx(from.x, from.y, wrapW, wrapH, centerX, centerY, cellSize, circleRadius);
        const toPx = this._toPx(to.x, to.y, wrapW, wrapH, centerX, centerY, cellSize, circleRadius);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", fromPx.centerX);
        line.setAttribute("y1", fromPx.centerY);
        line.setAttribute("x2", toPx.centerX);
        line.setAttribute("y2", toPx.centerY);
        line.setAttribute("class", "anatomy-editor-link");
        if (this.selectedPartId && (partId === this.selectedPartId || toId === this.selectedPartId)) {
          line.setAttribute("data-selected", "true");
        }
        svgG.appendChild(line);
      }
    }
    inner.appendChild(svg);

    const selectedLinks = this.selectedPartId && bodyParts[this.selectedPartId]
      ? (Array.isArray(bodyParts[this.selectedPartId].links) ? bodyParts[this.selectedPartId].links : [])
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
            this._addLinkBidirectional(linkFrom, partId);
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
    const links = Array.isArray(bodyPart.links) ? bodyPart.links : [];
    const organs = Array.isArray(bodyPart.organs) ? bodyPart.organs : [];
    const materialId = bodyPart.material ?? "";
    const materialLabel = MATERIAL_OPTIONS.find((m) => m.id === materialId)?.label ?? "—";
    const linksStr = links.length ? links.join(", ") : "—";

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
    nameEl.textContent = bodyPart.name || partId;
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
      <div class="anatomy-editor-panel-row"><span class="anatomy-editor-panel-label">Связи</span><span class="anatomy-editor-panel-value">${linksStr}</span></div>`;
    colCenter.appendChild(props);

    const linksSection = document.createElement("div");
    linksSection.className = "anatomy-editor-panel-block";
    const linksHead = document.createElement("div");
    linksHead.className = "anatomy-editor-panel-section-title";
    linksHead.textContent = "Связи с другими частями";
    linksSection.appendChild(linksHead);
    if (this.editMode && this.editable) {
      const linksList = document.createElement("div");
      linksList.className = "anatomy-editor-panel-links-list";
      for (const linkId of links) {
        const other = bodyParts[linkId];
        const name = other?.name || linkId;
        const row = document.createElement("div");
        row.className = "anatomy-editor-panel-link-row";
        const nameSpan = document.createElement("span");
        nameSpan.className = "anatomy-editor-panel-link-name";
        nameSpan.textContent = name;
        row.appendChild(nameSpan);
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "anatomy-editor-panel-link-remove";
        removeBtn.title = "Удалить связь";
        removeBtn.innerHTML = "<i class=\"fas fa-minus\"></i>";
        removeBtn.addEventListener("click", () => this._removeLink(partId, linkId));
        row.appendChild(removeBtn);
        linksList.appendChild(row);
      }
      linksSection.appendChild(linksList);
      const addLinkBtn = document.createElement("button");
      addLinkBtn.type = "button";
      addLinkBtn.className = "anatomy-editor-panel-add-link";
      addLinkBtn.innerHTML = "<i class=\"fas fa-plus\"></i> Добавить связь";
      addLinkBtn.addEventListener("click", () => this._addLink(partId));
      linksSection.appendChild(addLinkBtn);
    } else {
      const linksList = document.createElement("ul");
      linksList.className = "anatomy-editor-panel-list";
      for (const linkId of links) {
        const other = bodyParts[linkId];
        const li = document.createElement("li");
        li.textContent = other?.name || linkId;
        linksList.appendChild(li);
      }
      if (links.length === 0) linksList.innerHTML = "<li class=\"anatomy-editor-panel-empty-hint\">—</li>";
      linksSection.appendChild(linksList);
    }
    colCenter.appendChild(linksSection);

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
    const links = Array.isArray(part.links) ? part.links : [];
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
        <div class="form-group"><label>Связи (ID через запятую)</label><input type="text" id="ep-links" value="${links.join(", ").replace(/"/g, "&quot;")}" placeholder="id1, id2" style="width:100%;"/></div>
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
            const linksInput = (document.querySelector("#ep-links")?.value ?? "").trim();
            const newLinks = linksInput ? linksInput.split(",").map((s) => s.trim()).filter(Boolean) : [];

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
              partData.links = newLinks;
              updated[newId] = partData;
              for (const p of Object.values(updated)) {
                if (Array.isArray(p.links)) p.links = p.links.map((id) => (id === partId ? newId : id));
              }
              this.selectedPartId = newId;
            } else {
              updated[partId].name = name;
              updated[partId].weight = weight;
              updated[partId].maxHp = maxHp;
              updated[partId].material = material;
              updated[partId].x = x;
              updated[partId].y = y;
              updated[partId].links = newLinks;
            }
            await this.actor.update({ "system.health.bodyParts": updated });
            this.render();
          }
        },
        { action: "cancel", label: "Отмена", icon: "fa-solid fa-times" }
      ]
    });
  }

  _addLinkBidirectional(fromId, toId) {
    const bodyParts = foundry.utils.deepClone(this.actor?.system?.health?.bodyParts ?? {});
    if (!bodyParts[fromId] || !bodyParts[toId]) return;
    if (!Array.isArray(bodyParts[fromId].links)) bodyParts[fromId].links = [];
    if (!Array.isArray(bodyParts[toId].links)) bodyParts[toId].links = [];
    if (!bodyParts[fromId].links.includes(toId)) bodyParts[fromId].links.push(toId);
    if (!bodyParts[toId].links.includes(fromId)) bodyParts[toId].links.push(fromId);
    this.actor.update({ "system.health.bodyParts": bodyParts }).then(() => this.render());
  }

  async _removeLink(partId, linkId) {
    const bodyParts = foundry.utils.deepClone(this.actor?.system?.health?.bodyParts ?? {});
    const part = bodyParts[partId];
    const other = bodyParts[linkId];
    if (!part || !Array.isArray(part.links)) return;
    part.links = part.links.filter((id) => id !== linkId);
    if (other && Array.isArray(other.links)) other.links = other.links.filter((id) => id !== partId);
    await this.actor.update({ "system.health.bodyParts": bodyParts });
    this.render();
  }

  async _addLink(partId) {
    const bodyParts = this.actor?.system?.health?.bodyParts ?? {};
    const part = bodyParts[partId];
    const currentLinks = Array.isArray(part?.links) ? part.links : [];
    const otherIds = Object.keys(bodyParts).filter((id) => id !== partId && !currentLinks.includes(id));
    if (otherIds.length === 0) {
      ui.notifications.info("Нет других частей тела для добавления связи");
      return;
    }
    const optionsHtml = otherIds
      .map((id) => {
        const name = bodyParts[id]?.name || id;
        return `<option value="${id}">${name}</option>`;
      })
      .join("");
    const content = `
      <div class="anatomy-add-link-dialog">
        <div class="form-group"><label>Часть тела</label><select id="al-target" style="width:100%;">${optionsHtml}</select></div>
      </div>`;
    await foundry.applications.api.DialogV2.wait({
      window: { title: "Добавить связь", icon: "fa-solid fa-link" },
      position: { width: 280 },
      content,
      buttons: [
        {
          action: "add",
          label: "Добавить",
          icon: "fa-solid fa-check",
          default: true,
          callback: async () => {
            const targetId = document.querySelector("#al-target")?.value;
            if (!targetId || currentLinks.includes(targetId)) return;
            const updated = foundry.utils.deepClone(bodyParts);
            if (!Array.isArray(updated[partId].links)) updated[partId].links = [];
            updated[partId].links.push(targetId);
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
          for (const p of Object.values(bodyParts)) {
            if (Array.isArray(p.links)) p.links = p.links.filter((id) => id !== partId);
          }
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
            const name = (root.querySelector("#ap-name")?.value ?? "").trim() || id;
            const weight = Math.max(1, parseInt(root.querySelector("#ap-weight")?.value ?? "500", 10));
            const maxHp = Math.max(1, parseInt(root.querySelector("#ap-maxHp")?.value ?? "20", 10));
            const material = (root.querySelector("#ap-material")?.value ?? "").trim() || null;
            const x = parseInt(root.querySelector("#ap-x")?.value ?? "0", 10) || 0;
            const y = parseInt(root.querySelector("#ap-y")?.value ?? "0", 10) || 0;
            const bodyParts = foundry.utils.deepClone(this.actor.system.health?.bodyParts ?? {});
            if (bodyParts[id]) {
              ui.notifications.warn("Часть с таким ID уже существует");
              return;
            }
            bodyParts[id] = {
              id,
              name,
              weight,
              maxHp,
              material,
              x,
              y,
              status: "healthy",
              internal: false,
              tags: [],
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
