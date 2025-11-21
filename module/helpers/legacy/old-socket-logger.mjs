/**
 * ⚠️ УСТАРЕВШИЙ КОД - НЕ ИСПОЛЬЗОВАТЬ ⚠️
 * 
 * Этот модуль является УСТАРЕВШИМ и больше НЕ используется в системе.
 * Код сохранён только для справки и примеров старой реализации.
 * 
 * ❌ НЕ дорабатывайте этот код
 * ❌ НЕ используйте его в новых функциях
 * ✅ Используйте только как справочный материал
 * 
 * @deprecated Используйте новую систему socket logging вместо legacy
 * Дата архивации: 2025-10-28
 */

// Socket Logger for SpaceHolder - утилита для группировки socket-логов
// Собирает множество socket-событий в сводные отчёты по выстрелам

export class SocketLogger {
  constructor() {
    this.isEnabled = true;
    this.activeShotSessions = new Map(); // tokenId -> session data
  }

  /**
   * Начать отслеживание удалённого выстрела
   */
  startRemoteShot(tokenId, tokenName, userId, userName, direction, weaponName) {
    if (!this.isEnabled) return;
    
    const sessionData = {
      tokenId,
      tokenName,
      userId,
      userName,
      direction: Math.round(direction),
      weaponName,
      startTime: Date.now(),
      segments: 0,
      hits: [],
      events: []
    };

    this.activeShotSessions.set(tokenId, sessionData);
    
    console.log(`🌐 Remote shot started: ${tokenName} (${userName}) firing ${weaponName} at ${Math.round(direction)}°`);
  }

  /**
   * Добавить событие сегмента
   */
  addSegment(tokenId, segmentIndex, isRicochet = false) {
    if (!this.isEnabled) return;
    
    const session = this.activeShotSessions.get(tokenId);
    if (session) {
      session.segments++;
      if (isRicochet) {
        session.events.push({ type: 'ricochet', index: segmentIndex });
      }
    }
  }

  /**
   * Добавить событие попадания
   */
  addHit(tokenId, hitType, distance, targetId = null) {
    if (!this.isEnabled) return;
    
    const session = this.activeShotSessions.get(tokenId);
    if (session) {
      session.hits.push({
        type: hitType,
        distance: Math.round(distance * 100) / 100,
        targetId
      });
    }
  }

  /**
   * Завершить отслеживание выстрела
   */
  finishRemoteShot(tokenId) {
    if (!this.isEnabled) return;
    
    const session = this.activeShotSessions.get(tokenId);
    if (!session) return;

    const duration = Date.now() - session.startTime;
    const ricochets = session.events.filter(e => e.type === 'ricochet').length;
    
    // Сводный отчёт
    let report = `🌐 Remote shot complete: ${session.tokenName} → `;
    report += `${session.segments} segments`;
    
    if (session.hits.length > 0) {
      const hitTypes = [...new Set(session.hits.map(h => h.type))];
      report += `, hits: ${hitTypes.join(', ')}`;
    } else {
      report += `, miss`;
    }
    
    if (ricochets > 0) {
      report += `, ${ricochets} ricochets`;
    }
    
    report += ` (${duration}ms)`;
    
    console.log(report);
    
    // Удаляем сессию
    this.activeShotSessions.delete(tokenId);
  }

  /**
   * Логировать исходящий socket-event (краткий)
   */
  logOutgoing(eventType, tokenName, details = '') {
    if (!this.isEnabled) return;
    
    const shortType = eventType.replace('aimingSystem.', '');
    console.log(`📤 Socket out: ${shortType} from ${tokenName} ${details}`);
  }

  /**
   * Логировать входящий socket-event (только важные)
   */
  logIncoming(eventType, userId, userName, data) {
    if (!this.isEnabled) return;
    
    const shortType = eventType.replace('aimingSystem.', '');
    
    switch (eventType) {
      case 'aimingSystem.fireShot':
        // Обработается в startRemoteShot
        break;
      case 'aimingSystem.shotSegment':
        // Тихий - много событий
        break;
      case 'aimingSystem.shotHit':
        // Обработается в addHit
        break;
      case 'aimingSystem.shotComplete':
        // Обработается в finishRemoteShot
        break;
      default:
        console.log(`📨 Socket in: ${shortType} from ${userName}`);
    }
  }

  /**
   * Включить/выключить логирование
   */
  setEnabled(enabled) {
    this.isEnabled = enabled;
    console.log(`📡 Socket logging ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Очистить все активные сессии (при проблемах)
   */
  clearAllSessions() {
    const count = this.activeShotSessions.size;
    this.activeShotSessions.clear();
    if (count > 0) {
      console.log(`🧹 Cleared ${count} active socket sessions`);
    }
  }
}

// Создаём глобальный экземпляр
export const socketLogger = new SocketLogger();