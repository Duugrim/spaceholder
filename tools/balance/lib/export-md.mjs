/**
 * Markdown hand-off of the case base for an agent (or a human reader): the agreed outcomes next to what the
 * current mechanics give for the same shot, plus the items the cases refer to.
 */

import { checkCases } from './outcome.mjs';

const fmt = (n, digits = 1) => (Number.isFinite(n) ? n.toLocaleString('ru-RU', { maximumFractionDigits: digits }) : '—');
const pct = (r) => (Number.isFinite(r) ? `${fmt(r * 100, 0)}%` : '—');
const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

const FACE_LABEL = { front: 'спереди', side: 'сбоку', back: 'сзади' };

/** Human label of a case armour spec. */
export function armorLabel(spec, items) {
  const find = (id) => items.find((it) => it.id === id);
  const matName = (slug) => find(`material.${slug}`)?.name ?? slug;
  if (!spec || spec.kind === 'none' || !spec.kind) return 'Без брони';
  if (spec.kind === 'preset' || spec.kind === 'item') return find(spec.presetId ?? spec.itemId)?.name ?? '(набор не найден)';
  if (spec.kind === 'layers') {
    const text = (spec.layers ?? []).map((l) => `${matName(l.material)} ${l.thickness} мм`).join(' + ');
    return spec.label ? `${spec.label} (${text})` : text || 'Свой набор';
  }
  return '?';
}

const VERDICT_MARK = { match: '✓', near: '≈', miss: '✗', none: '', skip: '—' };

/** Condition of a variant with what the mechanics use from it (second target, melee blow and strength). */
function conditionText(group, row, items) {
  const parts = [];
  if (row.target === 'behind') parts.push('вторая цель за первой');
  const weapon = group.weaponItem ? items.find((it) => it.id === group.weaponItem) : null;
  if (!group.ammoItem && weapon?.kind === 'weapon') {
    const line = (weapon.values?.lines ?? []).find((l) => l.id === row.lineId) ?? (weapon.values?.lines ?? []).find((l) => (l.damage ?? []).length);
    parts.push(`${line?.name ?? 'удар'}, СИЛ ${row.effort ?? 100}`);
  }
  if (row.condition) parts.push(row.condition);
  return parts.join('; ');
}

/** `Смертельная травма / Тяжёлая травма (23 · 45% HP)` — what the mechanics give. */
function mechanicsText(check, outcomeLabel) {
  if (!check?.ok) return '—';
  const name = (o) => `${outcomeLabel(o.id) || o.id}${o.fatal ? ' (смерть)' : ''}`;
  const range = check.best && check.best.id !== check.worst.id ? `${name(check.worst)} / ${name(check.best)}` : name(check.worst);
  return check.ratio == null ? range : `${range} (${fmt(check.total)} · ${pct(check.ratio)} HP)`;
}

/** `Пистолет (9×19)`. */
export function weaponLabel(group) {
  return group.ammo ? `${group.weapon} (${group.ammo})` : group.weapon;
}

/**
 * @param {{ cases: object, items: object, dictionaries: object }} db
 * @returns {string}
 */
export function buildMarkdown({ cases, items, dictionaries }) {
  const outcomeLabel = (id) => dictionaries.outcomes.find((o) => o.id === id)?.label ?? '';
  const partLabel = (id) => dictionaries.parts.find((p) => p.id === id)?.label ?? id;
  const checks = new Map(checkCases({
    groups: cases.groups, rows: cases.rows, dictionaries, items: items.items,
  }).map((c) => [c.rowId, c]));

  const lines = [];
  lines.push('# База случаев баланса');
  lines.push('');
  lines.push('Экспорт утилиты баланса (`tools/balance`). Каждый случай — выстрел оружием определённого типа и патроном по части тела, с бронёй и на дистанции (по умолчанию в упор). Исход — это то, что происходит **с целью**. «Худший исход для цели» и «лучший исход для цели» — две крайности одного и того же выстрела (повезло стрелку / повезло цели); если лучший не задан, исход один. Сторона «сбоку» в текущей механике считается как «спереди» — у анатомий нет боковых граней.');
  lines.push('');
  lines.push('**Шкала исходов** (от худшего):');
  lines.push('');
  for (const o of dictionaries.outcomes) lines.push(`- ${o.label}`);
  lines.push('');
  lines.push('Варианты с пометкой **[ИИ]** предложены ИИ и ещё не проверены владельцем: исход и примечание — догадка ИИ.');
  lines.push('');
  lines.push('«Механика» — что даёт текущая механика (настоящий резолвер, значения предметов из базы, анатомия `humanoid`) по той же шкале: худший / лучший исход среди всех вариантов места попадания (органы, щели в броне) и оружий семейства случая, если вариант не реже 2%; в скобках — урон в часть и доля её HP. «Сверка»: ✓ совпадает, ≈ в пределах договорённого (совпадает один край, второй мягче), ✗ расходится, — не считается (нет патрона или оружия из базы).');
  lines.push('');
  const counts = { match: 0, near: 0, miss: 0, skip: 0 };
  for (const c of checks.values()) counts[c.ok ? (c.status in counts ? c.status : 'skip') : 'skip'] += 1;
  lines.push(`**Сверка:** ✓ ${counts.match} · ≈ ${counts.near} · ✗ ${counts.miss} · не считается ${counts.skip}.`);
  lines.push('');

  const groupsByType = new Map();
  for (const g of cases.groups) {
    if (!groupsByType.has(g.weaponType)) groupsByType.set(g.weaponType, []);
    groupsByType.get(g.weaponType).push(g);
  }

  for (const type of dictionaries.weaponTypes) {
    const groups = groupsByType.get(type.id);
    if (!groups?.length) continue;
    lines.push(`## ${type.label}`);
    lines.push('');
    for (const g of groups) {
      const rows = cases.rows.filter((r) => r.groupId === g.id);
      lines.push(`### ${weaponLabel(g)} → ${partLabel(g.part)}${g.favorite ? ' ★' : ''}${g.proposed ? ' [ИИ]' : ''}`);
      if (g.note) lines.push('', g.note);
      lines.push('');
      lines.push('| Броня | Сторона | Дистанция, м | Условие | Худший исход для цели | Лучший исход для цели | Механика | Сверка | Примечание |');
      lines.push('|---|---|---|---|---|---|---|---|---|');
      for (const r of rows) {
        const c = checks.get(r.id);
        const worst = outcomeLabel(r.worst);
        const best = r.best && r.best !== r.worst ? outcomeLabel(r.best) : '';
        lines.push(`| ${cell(armorLabel(r.armor, items.items))} | ${FACE_LABEL[r.face] ?? FACE_LABEL.front} | ${fmt(r.distance, 2)} | ${cell(conditionText(g, r, items.items))} | ${cell(worst) || '…'} | ${cell(best)} | ${cell(mechanicsText(c, outcomeLabel))} | ${VERDICT_MARK[c?.ok ? c.status : 'skip'] ?? '—'} | ${r.proposed ? '[ИИ] ' : ''}${cell(r.note)} |`);
      }
      lines.push('');
    }
  }

  // Items referenced by the cases.
  const usedAmmo = new Set(cases.groups.map((g) => g.ammoItem).filter(Boolean));
  const usedPresets = new Set();
  const usedMaterials = new Set();
  for (const r of cases.rows) {
    if (r.armor?.kind === 'preset') usedPresets.add(r.armor.presetId);
    if (r.armor?.kind === 'layers') for (const l of r.armor.layers ?? []) usedMaterials.add(l.material);
  }
  const byId = (id) => items.items.find((it) => it.id === id);
  for (const id of usedPresets) for (const l of byId(id)?.values?.layers ?? []) usedMaterials.add(l.material);
  usedMaterials.add('bone');
  usedMaterials.add('muscle');
  usedMaterials.add('skin');

  lines.push('## Предметы, на которые ссылаются случаи');
  lines.push('');
  lines.push('### Боеприпасы');
  lines.push('');
  lines.push('| Патрон | Тип | Урон | Пробитие, % | Твёрдость | Энергия | Спад: полураспад, м | Статус |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const id of usedAmmo) {
    const it = byId(id);
    if (!it) continue;
    for (const e of it.values.damage ?? []) {
      if (!(Number(e.damage) > 0)) continue;
      const energy = e.damage * (e.armorPen / 100) ** 2 * (e.hardness || 1);
      const f = it.values.falloff;
      lines.push(`| ${cell(it.name)} | ${e.damageType} | ${fmt(e.damage)} | ${fmt(e.armorPen)} | ${fmt(e.hardness)} | ${fmt(energy, 2)} | ${f?.enabled ? fmt(f.halfDistance, 0) : 'нет'} | ${it.status} |`);
    }
  }
  lines.push('');
  lines.push('### Наборы брони');
  lines.push('');
  lines.push('| Набор | Слои (снаружи внутрь) | Статус |');
  lines.push('|---|---|---|');
  for (const id of usedPresets) {
    const it = byId(id);
    if (!it) continue;
    lines.push(`| ${cell(it.name)} | ${cell((it.values.layers ?? []).map((l) => `${byId(`material.${l.material}`)?.name ?? l.material} ${l.thickness} мм`).join(' + '))} | ${it.status} |`);
  }
  lines.push('');
  lines.push('### Материалы');
  lines.push('');
  lines.push('| Материал | Твёрдость | Сопротивление баллистике, % | Прочность на мм | Статус |');
  lines.push('|---|---|---|---|---|');
  for (const slug of usedMaterials) {
    const it = byId(`material.${slug}`);
    if (!it) continue;
    lines.push(`| ${cell(it.name)} | ${fmt(it.values.hardness)} | ${fmt(it.values.resistance?.ballistic, 0)} | ${fmt(it.values.integrityPerThickness, 0)} | ${it.status} |`);
  }
  lines.push('');
  lines.push('Правило пробития: энергия снаряда = урон × (пробитие/100)² × твёрдость; слой материала держит энергию `твёрдость материала × толщина² × сопротивление/100`. Энергия, не поглощённая слоем, идёт дальше, а урон следует за ней.');
  lines.push('');
  return lines.join('\n');
}
