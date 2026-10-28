/**
 * The animation of projectiles going through the layers of a penetration view: every projectile has a lane in the
 * energy column and a bullet in it. All the bullets stand at the top, side by side; then they go one at a time,
 * from the rightmost lane to the left one (the rows are listed in that order): a bullet falls down its lane, stops
 * only at the rows that are its own (the head of a group it meets, the layers it goes through), and when it is done
 * — a layer held it, or it flew out — the next one goes. The energy stream of a row fills as a bullet reaches it, a
 * layer that holds a projectile stops it: the bullet fades out and a short red dash
 * (`.spaceholder-penetration__stopmark`) is left at the bottom of its stream, the sharp end resting on it, and a thin
 * line (`__stopline`) leads from the dash to the row of the layer that stopped it. Used by the window
 * (`penetration-view-app.mjs`) and by the cards over the tokens (`penetration-overlay.mjs`) alike.
 *
 * DOM only (Web Animations API), no Foundry. Without it — or once it is over, skipped, or with
 * `prefers-reduced-motion` — the end state is shown: the "not reached yet" look (`is-pending`) is only ever
 * switched on by a running animation.
 *
 * Contract with the markup: a root (`.spaceholder-penetration`) holding a positioned
 * `.spaceholder-penetration__stack`, in it the blocks `.spaceholder-penetration__group` (`data-lanes`: how many
 * lanes the column has; `is-collapsed`: only the head is on the screen) with their rows. Every row says what is
 * its own: `data-here` (the lanes that meet the row, space separated), `data-stops` (the lanes a layer holds; the
 * head of a folded block: `data-stops-folded`, the lanes held anywhere in the block), `data-widths` (the share of
 * the muzzle energy of every lane after the row, 0–100); a layer has `data-index` (the index of the stage). The
 * bullets and the dashes are made here.
 */

const GROUP = '.spaceholder-penetration__group';
const ROW = '.spaceholder-penetration__row';
const STRIP = 'spaceholder-penetration__strip';
const HEAD = 'spaceholder-penetration__row--head';
const CLASS = 'spaceholder-penetration';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Timing (ms): a bullet's travel to a row is proportional to the distance, within these bounds. */
const TRAVEL_MIN_MS = 220;
const TRAVEL_MAX_MS = 1000;
const TRAVEL_PX_PER_MS = 1.1;
/** A long fall (from the top to the rows of a far lane) is quicker than a hop to the next row. */
const FALL_PX_PER_MS = 2.4;
const FALL_FROM_PX = 150;
const FIRST_DELAY_MS = 250;
const DWELL_MS = 520;
/** Between one bullet's end and the next one's start. */
const NEXT_DELAY_MS = 90;
const EXIT_MS = 380;
const STOP_FADE_MS = 320;
const STOP_MARK_MS = 280;

function reducedMotion() {
  try {
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  } catch (_) {
    return false;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `"0 2"` → `[0, 2]`. */
function lanesOf(text) {
  return String(text ?? '').split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
}

/** A group folded to its head shows no parts or layers: only the rows on the screen are walked. */
const onScreen = (group) => [...group.querySelectorAll(ROW)].filter((row) => row.classList.contains(HEAD) || !row.closest('.is-collapsed'));

/** The lanes a row holds: a layer's own, or — the head of a folded block — everything held in the block. */
function stopsOf(row) {
  const folded = row.classList.contains(HEAD) && row.closest('.is-collapsed');
  return lanesOf(folded ? row.dataset.stopsFolded : row.dataset.stops);
}

export class PenetrationPlayback {
  #root;

  #speed;

  #follow;

  #onStage;

  #onState;

  /** Counts plays: a play that sees a newer number stops (replay, skip, close). */
  #run = 0;

  #playing = false;

  /**
   * @param {HTMLElement} root `.spaceholder-penetration`
   * @param {Object} [options]
   * @param {number} [options.speed=1] 2 plays twice as fast
   * @param {boolean} [options.follow=true] scroll the row the leading bullet is at into view
   * @param {(index: number, row: HTMLElement) => void} [options.onStage] the leading bullet reached a layer
   * @param {(playing: boolean) => void} [options.onState] the animation started or ended
   */
  constructor(root, { speed = 1, follow = true, onStage = null, onState = null } = {}) {
    this.#root = root;
    this.#speed = Math.max(0.1, Number(speed) || 1);
    this.#follow = follow !== false;
    this.#onStage = onStage;
    this.#onState = onState;
  }

  get playing() {
    return this.#playing;
  }

  #setPlaying(playing) {
    if (this.#playing === playing) return;
    this.#playing = playing;
    this.#onState?.(playing);
  }

  get #stack() {
    return this.#root?.querySelector?.('.spaceholder-penetration__stack') ?? null;
  }

  /** Take away what a run left: the bullets and the dashes. */
  #clear() {
    this.#root?.querySelectorAll?.(`.${CLASS}__bullet, .${CLASS}__stopmark, .${CLASS}__stopline`).forEach((el) => el.remove());
  }

  /** The red dash that says a projectile stopped: at the bottom of the row that held it, in the lane of the projectile. */
  #showMark(row, lane) {
    const stack = this.#stack;
    if (!stack) return null;
    const mark = stack.ownerDocument.createElement('span');
    mark.className = `${CLASS}__stopmark`;
    mark.style.setProperty('--lane', String(lane));
    mark.style.setProperty('--lanes', String(Number(row.closest(GROUP)?.dataset.lanes) || 1));
    mark.style.transform = `translateY(${row.offsetTop + row.offsetHeight - 1}px)`;
    stack.append(mark);
    this.#connect(row, mark);
    return mark;
  }

  /**
   * The thin line from the right edge of a stop dash, at the bottom of its lane, to the left edge of the name of the
   * row that stopped the projectile, at the middle of that row — so it reads which layer stopped which lane.
   */
  #connect(row, mark) {
    const stack = this.#stack;
    const label = row.querySelector(`.${CLASS}__label, .${CLASS}__who`);
    if (!stack || !label) return;
    const x1 = mark.offsetLeft + mark.offsetWidth;
    const y1 = row.offsetTop + row.offsetHeight - 1 + mark.offsetHeight / 2;
    const x2 = row.offsetLeft + row.clientLeft + label.offsetLeft - 3;
    const y2 = row.offsetTop + row.offsetHeight / 2;
    if (!(x2 - x1 > 2)) return;
    const width = x2 - x1;
    const height = Math.max(1, Math.abs(y1 - y2));
    const svg = stack.ownerDocument.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `${CLASS}__stopline`);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.style.left = `${x1}px`;
    svg.style.top = `${Math.min(y1, y2)}px`;
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;
    const line = stack.ownerDocument.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', String(y1 > y2 ? height : 0));
    line.setAttribute('x2', String(width));
    line.setAttribute('y2', String(y1 > y2 ? 0 : height));
    svg.append(line);
    stack.append(svg);
  }

  /** The bullet fades out where it is, then the dash appears in its place. @returns {Promise<boolean>} still the current run */
  async #stop(row, lane, bullet, run) {
    bullet.classList.add('is-stopped');
    await wait(STOP_FADE_MS / this.#speed);
    if (run !== this.#run) return false;
    bullet.remove();
    this.#showMark(row, lane);
    await wait(STOP_MARK_MS / this.#speed);
    return run === this.#run;
  }

  /** Stop at once, leave the picture as it is (the window is closing). */
  cancel() {
    this.#run += 1;
    this.#playing = false;
  }

  /** Stop and show the end state. */
  skip() {
    this.#run += 1;
    this.settle();
  }

  /** The end state, no motion: every row shows its result, no bullets, a dash where a layer held a projectile. */
  settle() {
    const root = this.#root;
    this.#setPlaying(false);
    if (!root) return;
    root.classList.remove('is-animating');
    root.classList.add('is-done');
    for (const row of root.querySelectorAll(ROW)) {
      row.classList.remove('is-pending');
      row.classList.add('is-reached');
    }
    this.#clear();
    for (const group of root.querySelectorAll(GROUP)) {
      for (const row of onScreen(group)) {
        for (const lane of stopsOf(row)) this.#showMark(row, lane);
      }
    }
  }

  /**
   * Play the pass.
   * @returns {Promise<'done'|'cancelled'|'settled'>} `settled`: nothing to animate (or reduced motion), the end state is shown
   */
  async play() {
    const root = this.#root;
    const run = (this.#run += 1);
    const stack = this.#stack;
    const rows = root ? [...root.querySelectorAll(GROUP)].flatMap((group) => onScreen(group)) : [];
    // The way of every lane: the rows on the screen that are its own, from the top down.
    const ways = new Map();
    for (const row of rows) {
      for (const lane of lanesOf(row.dataset.here)) {
        if (!ways.has(lane)) ways.set(lane, []);
        ways.get(lane).push(row);
      }
    }
    // A row no lane is on (a layer behind the one that held the projectile, a gap) is shown as soon as the row before
    // it has been dealt with — not left for the end of the whole animation.
    const followers = new Map();
    let owner = null;
    for (const row of rows) {
      if (lanesOf(row.dataset.here).length) owner = row;
      else if (owner) followers.set(owner, [...(followers.get(owner) ?? []), row]);
    }
    if (!rows.length || !ways.size || !stack || reducedMotion()) {
      this.settle();
      return 'settled';
    }

    this.#setPlaying(true);
    this.#clear();
    root.classList.add('is-animating');
    root.classList.remove('is-done');
    for (const row of root.querySelectorAll(ROW)) {
      row.classList.add('is-pending');
      row.classList.remove('is-reached');
    }

    const doc = stack.ownerDocument;
    const count = Number(rows[0].closest(GROUP)?.dataset.lanes) || 1;
    const bullets = new Map();
    for (const lane of ways.keys()) {
      const bullet = doc.createElement('span');
      bullet.className = `${CLASS}__bullet`;
      bullet.style.setProperty('--lane', String(lane));
      bullet.style.setProperty('--lanes', String(count));
      stack.append(bullet);
      bullet.style.transform = `translateY(${Math.max(0, rows[0].offsetTop - bullet.offsetHeight)}px)`;
      bullets.set(lane, bullet);
    }

    // One bullet at a time, the rightmost lane first: the rows are listed in that order, so the list is read once,
    // from the top down. Many bullets give each a shorter stay on a layer.
    const order = [...ways.keys()].sort((a, b) => b - a);
    const dwell = DWELL_MS / Math.max(1, Math.sqrt(order.length));
    const top = rows[0].offsetTop;
    await wait(FIRST_DELAY_MS / this.#speed);
    for (const lane of order) {
      if (run !== this.#run) return 'cancelled';
      const result = await this.#fly(lane, ways.get(lane), bullets.get(lane), run, { top, dwell, followers });
      if (result === 'cancelled' || run !== this.#run) return 'cancelled';
      await wait(NEXT_DELAY_MS / this.#speed);
    }

    // A row nobody's lane reached (a lane beyond what the column holds) shows its result all the same.
    for (const row of root.querySelectorAll(ROW)) {
      row.classList.remove('is-pending');
      row.classList.add('is-reached');
    }
    root.classList.add('is-done');
    this.#setPlaying(false);
    return 'done';
  }

  /** One bullet falls down its lane to the rows that are its own and stops where a layer holds it. */
  async #fly(lane, way, bullet, run, { top, dwell, followers }) {
    const height = bullet.offsetHeight || 26;
    let y = Math.max(0, top - height);
    for (const row of way) {
      if (run !== this.#run) return 'cancelled';
      const target = row.offsetTop + (row.offsetHeight / 2) - (height / 2);
      const distance = Math.abs(target - y);
      const speed = distance > FALL_FROM_PX ? FALL_PX_PER_MS : TRAVEL_PX_PER_MS;
      const duration = Math.min(TRAVEL_MAX_MS, Math.max(TRAVEL_MIN_MS, distance / speed)) / this.#speed;
      if (this.#follow) row.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      const move = bullet.animate(
        [{ transform: `translateY(${y}px)` }, { transform: `translateY(${target}px)` }],
        { duration, easing: 'ease-in', fill: 'forwards' }
      );
      try {
        await move.finished;
      } catch (_) {
        return 'cancelled';
      }
      if (run !== this.#run) return 'cancelled';
      bullet.style.transform = `translateY(${target}px)`;
      move.cancel();
      y = target;

      row.classList.remove('is-pending');
      row.classList.add('is-reached');
      const energy = String(row.dataset.widths ?? '').split(/\s+/)[lane];
      if (energy !== undefined && energy !== '') bullet.style.setProperty('--bullet-energy', energy);

      if (row.classList.contains(STRIP)) {
        this.#onStage?.(Number(row.dataset.index), row);
        await wait(dwell / this.#speed);
      }
      const held = stopsOf(row).includes(lane);
      if (held && !(await this.#stop(row, lane, bullet, run))) return 'cancelled';
      for (const follower of followers.get(row) ?? []) {
        follower.classList.remove('is-pending');
        follower.classList.add('is-reached');
      }
      if (held) return 'done';
    }

    // A projectile that nothing stopped flies out of its last row and is gone.
    const last = way[way.length - 1];
    const bottom = last.offsetTop + last.offsetHeight;
    const leave = bullet.animate(
      [{ transform: `translateY(${y}px)`, opacity: 1 }, { transform: `translateY(${bottom}px)`, opacity: 0 }],
      { duration: EXIT_MS / this.#speed, easing: 'ease-in', fill: 'forwards' }
    );
    try {
      await leave.finished;
    } catch (_) {
      return 'cancelled';
    }
    if (run !== this.#run) return 'cancelled';
    bullet.remove();
    return 'done';
  }
}

/**
 * A picture that does not load (a deleted file) gives way to the icon next to it.
 * @param {HTMLElement} root
 */
export function bindImageFallbacks(root) {
  for (const img of root?.querySelectorAll?.('img.spaceholder-penetration__img') ?? []) {
    const fallback = () => {
      img.hidden = true;
      img.nextElementSibling?.removeAttribute('hidden');
    };
    if (img.complete && img.naturalWidth === 0) fallback();
    else img.addEventListener('error', fallback, { once: true });
  }
}
