/**
 * ⚠️ LEGACY CODE - ОТКЛЮЧЕН ⚠️
 * Этот файл является устаревшей версией логгера прицеливания.
 * Система переработана в новую модульную архитектуру.
 * Файл сохранён для справки, но не используется.
 * Дата архивации: 2025-10-28
 */

// Aiming Logger for SpaceHolder - утилита для группировки логов
// Собирает множество мелких логов в сводные отчёты

export class AimingLogger {
  constructor() {
    this.isEnabled = true; // Можно отключить логирование
    this.currentShotData = null;
    this.shotCounter = 0;
  }

  /**
   * Начать новый выстрел
   */
  startShot(token, direction, maxDistance) {
    if (!this.isEnabled) return;
    
    const tokenName = token?.document?.name || token?.name || 'Unknown token';
    
    this.shotCounter++;
    this.currentShotData = {
      shotId: this.shotCounter,
      tokenName: tokenName,
      direction: Math.round(direction),
      maxDistance: maxDistance,
      segments: [],
      collisions: [],
      ricochets: [],
      startTime: Date.now(),
      endTime: null
    };

    console.log(`🎯 Shot #${this.shotCounter} started: ${tokenName} firing at ${Math.round(direction)}°`);
  }

  /**
   * Добавить сегмент
   */
  addSegment(segmentIndex, segmentType, fromX, fromY, toX, toY, ricochetCount = 0) {
    if (!this.isEnabled || !this.currentShotData) return;

    this.currentShotData.segments.push({
      index: segmentIndex,
      type: segmentType,
      from: { x: Math.round(fromX), y: Math.round(fromY) },
      to: { x: Math.round(toX), y: Math.round(toY) },
      ricochetCount: ricochetCount
    });
  }

  /**
   * Добавить коллизию
   */
  addCollision(type, distance, point, details = {}) {
    if (!this.isEnabled || !this.currentShotData) return;

    this.currentShotData.collisions.push({
      type: type,
      distance: Math.round(distance * 100) / 100,
      point: { x: Math.round(point.x), y: Math.round(point.y) },
      details: details
    });
  }

  /**
   * Добавить попытку рикошета
   */
  addRicochetAttempt(ricochetNumber, hitData, direction, startPoint, failReason = null) {
    if (!this.isEnabled || !this.currentShotData) return;

    const isSuccess = failReason === null;
    let reason;
    
    if (isSuccess && hitData) {
      reason = `Ricochet #${ricochetNumber} from wall at (${Math.round(hitData.point.x)}, ${Math.round(hitData.point.y)}) → ${Math.round(direction)}°`;
    } else if (failReason) {
      reason = failReason;
    } else {
      reason = 'Unknown ricochet attempt';
    }

    this.currentShotData.ricochets.push({
      success: isSuccess,
      ricochetNumber: ricochetNumber,
      reason: reason,
      direction: direction ? Math.round(direction) : null,
      startPoint: startPoint ? { x: Math.round(startPoint.x), y: Math.round(startPoint.y) } : null
    });
  }

  /**
   * Завершить выстрел и вывести сводный отчёт
   */
  finishShot() {
    if (!this.isEnabled || !this.currentShotData) return;

    this.currentShotData.endTime = Date.now();
    const duration = this.currentShotData.endTime - this.currentShotData.startTime;

    this._printShotReport();
    this.currentShotData = null;
  }

  /**
   * Вывести сводный отчёт о выстреле
   */
  _printShotReport() {
    const data = this.currentShotData;
    const duration = data.endTime - data.startTime;

    // Заголовок отчёта
    console.groupCollapsed(
      `🎯 Shot Report #${data.shotId}: ${data.tokenName} → ` +
      `${data.segments.length} segments, ${data.collisions.length} hits, ${duration}ms`
    );

    // Основная информация
    console.log(`📊 Shot Details:`);
    console.log(`   Token: ${data.tokenName}`);
    console.log(`   Direction: ${data.direction}°`);
    console.log(`   Max distance: ${data.maxDistance}px`);
    console.log(`   Duration: ${duration}ms`);
    
    // Сегменты (кратко)
    if (data.segments.length > 0) {
      console.log(`\n➡️ Segments (${data.segments.length}):`);
      const primarySegments = data.segments.filter(s => s.ricochetCount === 0).length;
      const ricochetSegments = data.segments.filter(s => s.ricochetCount > 0).length;
      
      console.log(`   Primary: ${primarySegments}, Ricochets: ${ricochetSegments}`);
      
      // Показываем только первые несколько и последние, если много
      if (data.segments.length <= 5) {
        data.segments.forEach(seg => {
          const type = seg.ricochetCount > 0 ? `ricochet-${seg.ricochetCount}` : 'primary';
          console.log(`   ${seg.index + 1}. ${type}: (${seg.from.x}, ${seg.from.y}) → (${seg.to.x}, ${seg.to.y})`);
        });
      } else {
        data.segments.slice(0, 2).forEach(seg => {
          const type = seg.ricochetCount > 0 ? `ricochet-${seg.ricochetCount}` : 'primary';
          console.log(`   ${seg.index + 1}. ${type}: (${seg.from.x}, ${seg.from.y}) → (${seg.to.x}, ${seg.to.y})`);
        });
        console.log(`   ... ${data.segments.length - 4} more segments ...`);
        data.segments.slice(-2).forEach(seg => {
          const type = seg.ricochetCount > 0 ? `ricochet-${seg.ricochetCount}` : 'primary';
          console.log(`   ${seg.index + 1}. ${type}: (${seg.from.x}, ${seg.from.y}) → (${seg.to.x}, ${seg.to.y})`);
        });
      }
    }

    // Коллизии
    if (data.collisions.length > 0) {
      console.log(`\n🎯 Collisions (${data.collisions.length}):`);
      data.collisions.forEach((collision, index) => {
        const icon = this._getCollisionIcon(collision.type);
        console.log(`   ${index + 1}. ${icon} ${collision.type} at (${collision.point.x}, ${collision.point.y}) - ${collision.distance}px`);
      });
    } else {
      console.log(`\n❌ No collisions (miss)`);
    }

    // Рикошеты
    if (data.ricochets.length > 0) {
      console.log(`\n🏀 Ricochet attempts (${data.ricochets.length}):`);
      data.ricochets.forEach((ricochet, index) => {
        const status = ricochet.success ? '✅' : '❌';
        console.log(`   ${index + 1}. ${status} ${ricochet.reason}`);
      });
    }

    console.groupEnd();
  }

  /**
   * Получить иконку для типа коллизии
   */
  _getCollisionIcon(type) {
    const icons = {
      'token': '📺',
      'wall': '🧯',
      'tile': '🏠',
      'door': '🚪'
    };
    return icons[type] || '❓';
  }

  /**
   * Логировать сокет-события (упрощённо)
   */
  logSocket(action, direction, tokenName = 'Unknown') {
    if (!this.isEnabled) return;
    
    const directionText = direction !== undefined ? ` at ${Math.round(direction)}°` : '';
    console.log(`📡 Socket: ${action} from ${tokenName}${directionText}`);
  }

  /**
   * Включить/выключить логирование
   */
  setEnabled(enabled) {
    this.isEnabled = enabled;
    console.log(`📊 Aiming logging ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Простой лог (для сообщений, которые должны быть всегда видны)
   */
  log(message, ...args) {
    if (this.isEnabled) {
      console.log(message, ...args);
    }
  }

  /**
   * Важный лог (для ошибок и важных событий)
   */
  important(message, ...args) {
    console.log(message, ...args); // Всегда показываем важные сообщения
  }
}

// Глобальный экземпляр логгера
export const aimingLogger = new AimingLogger();