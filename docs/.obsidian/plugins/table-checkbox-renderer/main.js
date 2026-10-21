"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => TableCheckboxRendererPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian2 = require("obsidian");

// src/markdown-helpers.ts
function getCheckboxCountsPerCell(line) {
  const cells = line.split("|");
  if (cells.length > 1 && !cells[0].trim()) cells.shift();
  if (cells.length > 1 && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map((cell) => (cell.match(/\[( |x)\]/g) || []).length);
}
function getSourceLineNumber(section, row) {
  if (!section) return null;
  return section.lineStart + row + 2;
}

// src/obsidian-helpers.ts
var import_obsidian = require("obsidian");
async function getSourceLine(plugin, file, idx) {
  try {
    const content = await plugin.app.vault.read(file);
    const lines = content.split(/\r?\n/);
    return idx >= 0 && idx < lines.length ? lines[idx] : null;
  } catch {
    return null;
  }
}

// src/dom-helpers.ts
async function handleCheckboxChange({ box, plugin, file, lineNum, idx }) {
  const vault = plugin?.app?.vault;
  if (!vault || typeof vault.process !== "function") return;
  await vault.process(file, (data) => {
    const lines = data.split(/\r?\n/);
    if (lineNum >= lines.length) return data;
    const line = lines[lineNum];
    const srcMatches = [...line.matchAll(/\[( |x)\]/g)];
    const mIdx = srcMatches[idx]?.index ?? -1;
    if (mIdx === -1) return data;
    const newState = box.checked ? "[x]" : "[ ]";
    lines[lineNum] = line.substring(0, mIdx) + newState + line.substring(mIdx + 3);
    box.checked = newState === "[x]";
    return lines.join("\n");
  });
}

// src/render-cell-checkboxes.ts
var TEXT_NODE = 3;
var ELEMENT_NODE = 1;
function renderCellCheckboxes({
  cell,
  cellIdx,
  counts,
  srcLine,
  lineNum,
  file,
  plugin,
  idx
}) {
  let localIdx = 0;
  const processTextNode = (textNode) => {
    const text = textNode.textContent || "";
    const actions = renderCellCheckboxesPure(text);
    if (actions.length === 1 && actions[0].type === "span") {
      return [textNode];
    }
    const fragment = [];
    actions.forEach((action) => {
      if (action.type === "span") {
        fragment.push(document.createTextNode(action.text));
      } else if (action.type === "checkbox") {
        const globalIdx = idx + localIdx;
        const box = document.createElement("input");
        box.type = "checkbox";
        box.className = "task-list-item-checkbox";
        box.checked = action.checked;
        box.addEventListener("change", () => {
          handleCheckboxChange({ box, plugin, file, lineNum, idx: globalIdx });
        });
        fragment.push(box);
        localIdx++;
      }
    });
    return fragment;
  };
  const processNode = (node) => {
    const childNodes = Array.from(node.childNodes);
    for (const child of childNodes) {
      if (child.nodeType === TEXT_NODE) {
        const replacements = processTextNode(child);
        if (replacements.length === 1 && replacements[0] === child) {
          continue;
        }
        const parent = child.parentNode;
        if (parent) {
          replacements.forEach((newNode) => {
            parent.insertBefore(newNode, child);
          });
          parent.removeChild(child);
        }
      } else if (child.nodeType === ELEMENT_NODE) {
        processNode(child);
      }
    }
  };
  processNode(cell);
  return idx + localIdx;
}
function renderCellCheckboxesPure(text) {
  const pattern = /\[( |x)\]/g;
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return [{ type: "span", text }];
  let last = 0;
  const actions = [];
  matches.forEach((match) => {
    if (match.index > last) {
      actions.push({ type: "span", text: text.slice(last, match.index) });
    }
    actions.push({ type: "checkbox", checked: match[0] === "[x]" });
    last = match.index + match[0].length;
  });
  if (last < text.length) {
    actions.push({ type: "span", text: text.slice(last) });
  }
  return actions;
}

// src/main.ts
var TableCheckboxRendererPlugin = class extends import_obsidian2.Plugin {
  async onload() {
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      el.querySelectorAll("table").forEach((table) => {
        let dataRowIdx = 0;
        table.querySelectorAll("tr").forEach(async (row) => {
          if (!row.querySelector("td")) return;
          const section = typeof ctx.getSectionInfo === "function" ? ctx.getSectionInfo(el) : null;
          const lineNum = getSourceLineNumber(section, dataRowIdx);
          dataRowIdx++;
          const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
          if (!file || lineNum == null) return;
          const srcLine = await getSourceLine(this, file, lineNum);
          if (!srcLine) return;
          const counts = getCheckboxCountsPerCell(srcLine);
          let idx = 0;
          row.querySelectorAll("td").forEach((cell, cellIdx) => {
            idx = renderCellCheckboxes({
              cell,
              cellIdx,
              counts,
              srcLine,
              lineNum,
              file,
              plugin: this,
              idx
            });
          });
        });
      });
    });
  }
};
//# sourceMappingURL=main.js.map

/* nosourcemap */