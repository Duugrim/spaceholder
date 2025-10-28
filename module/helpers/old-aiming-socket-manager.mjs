/**
 * ⚠️ LEGACY CODE - ОТКЛЮЧЕН ⚠️
 * Этот файл является устаревшей версией менеджера сокетов прицеливания.
 * Система переработана в новую модульную архитектуру.
 * Файл сохранён для справки, но не используется.
 * Дата архивации: 2025-10-28
 */

// Aiming Socket Manager for SpaceHolder - управление мультиплеерной синхронизацией
// Отвечает за передачу событий выстрелов между всеми клиентами

import { aimingLogger } from './old-aiming-logger.mjs';
import { socketLogger } from './old-socket-logger.mjs';

export class AimingSocketManager {
  constructor(aimingSystem) {
    this.aimingSystem = aimingSystem;
    this.socketName = `system.${game.system.id}`;
    
    // Типы сообщений
    this.MESSAGE_TYPES = {
      FIRE_SHOT: 'aimingSystem.fireShot',
      SHOT_SEGMENT: 'aimingSystem.shotSegment',
      SHOT_HIT: 'aimingSystem.shotHit',
      SHOT_COMPLETE: 'aimingSystem.shotComplete'
    };
  }
  
  /**
   * Инициализация socket-менеджера
   */
  initialize() {
    // Проверяем доступность game.socket
    if (!game.socket) {
      console.error('SpaceHolder | AimingSocketManager: game.socket not available!');
      return;
    }
    
    // Регистрируем обработчики socket-событий
    game.socket.on(this.socketName, (data) => {
      this._handleSocketMessage(data);
    });
    
    console.log('✅ SpaceHolder | AimingSocketManager: Socket handlers registered');
  }
  
  /**
   * Отправить данные о начале выстрела всем клиентам
   * @param {Object} shotData - данные о выстреле
   */
  broadcastFireShot(shotData) {
    const message = {
      type: this.MESSAGE_TYPES.FIRE_SHOT,
      userId: game.user.id,
      timestamp: Date.now(),
      data: shotData
    };
    
    const tokenName = shotData.tokenId ? (canvas.tokens.get(shotData.tokenId)?.name || 'Unknown') : 'Unknown';
    socketLogger.logOutgoing(this.MESSAGE_TYPES.FIRE_SHOT, tokenName);
    
    game.socket.emit(this.socketName, message);
  }
  
  /**
   * Отправить данные о сегменте выстрела
   * @param {Object} segmentData - данные о сегменте траектории
   */
  broadcastShotSegment(segmentData) {
    const message = {
      type: this.MESSAGE_TYPES.SHOT_SEGMENT,
      userId: game.user.id,
      timestamp: Date.now(),
      data: segmentData
    };
    
    game.socket.emit(this.socketName, message);
  }
  
  /**
   * Отправить данные о попадании
   * @param {Object} hitData - данные о попадании
   */
  broadcastShotHit(hitData) {
    const message = {
      type: this.MESSAGE_TYPES.SHOT_HIT,
      userId: game.user.id,
      timestamp: Date.now(),
      data: hitData
    };
    
    game.socket.emit(this.socketName, message);
  }
  
  /**
   * Отправить данные о завершении выстрела
   * @param {Object} completeData - итоговые данные выстрела
   */
  broadcastShotComplete(completeData) {
    const message = {
      type: this.MESSAGE_TYPES.SHOT_COMPLETE,
      userId: game.user.id,
      timestamp: Date.now(),
      data: completeData
    };
    
    game.socket.emit(this.socketName, message);
  }
  
  /**
   * Обработка входящих socket-сообщений
   * @private
   */
  _handleSocketMessage(message) {
    // Проверяем структуру сообщения
    if (!message || !message.userId || !message.type) {
      console.warn('SpaceHolder | AimingSocketManager: Invalid message structure', message);
      return;
    }
    
    // Игнорируем собственные сообщения
    if (message.userId === game.user.id) {
      return;
    }
    
    // Логируем через socketLogger
    const userName = game.users.get(message.userId)?.name || 'Unknown';
    socketLogger.logIncoming(message.type, message.userId, userName, message.data);
    
    // Сохраняем userId и userName для передачи в обработчики
    message.data._socketUserId = message.userId;
    message.data._socketUserName = userName;
    
    switch (message.type) {
      case this.MESSAGE_TYPES.FIRE_SHOT:
        this._handleFireShot(message.data);
        break;
        
      case this.MESSAGE_TYPES.SHOT_SEGMENT:
        this._handleShotSegment(message.data);
        break;
        
      case this.MESSAGE_TYPES.SHOT_HIT:
        this._handleShotHit(message.data);
        break;
        
      case this.MESSAGE_TYPES.SHOT_COMPLETE:
        this._handleShotComplete(message.data);
        break;
        
      default:
        console.warn('SpaceHolder | AimingSocketManager: Unknown message type', message.type);
    }
  }
  
  /**
   * Обработка события начала выстрела от другого игрока
   * @private
   */
  _handleFireShot(data) {
    // Проверяем наличие ключевых полей
    if (!data || !data.tokenId) {
      console.error('SpaceHolder | AimingSocketManager: Invalid fire shot data', data);
      return;
    }
    
    // Проверяем состояние холста
    if (!canvas || !canvas.tokens) {
      console.error('SpaceHolder | AimingSocketManager: Canvas not ready');
      return;
    }
    
    // Найдём токен на сцене
    const token = canvas.tokens.get(data.tokenId);
    if (!token) {
      console.error('SpaceHolder | AimingSocketManager: Token not found for remote fire shot', data.tokenId);
      return;
    }
    
    // Проверяем rayRenderer
    if (!this.aimingSystem || !this.aimingSystem.rayRenderer) {
      console.error('SpaceHolder | AimingSocketManager: RayRenderer not available');
      return;
    }
    
    if (typeof this.aimingSystem.rayRenderer.visualizeRemoteShot !== 'function') {
      console.error('SpaceHolder | AimingSocketManager: visualizeRemoteShot method not found');
      return;
    }
    
    // Начинаем отслеживание в socketLogger
    const userId = data._socketUserId || 'unknown';
    const userName = data._socketUserName || 'Unknown';
    socketLogger.startRemoteShot(data.tokenId, token.name, userId, userName, data.direction, data.weaponName || 'Unknown');
    
    // Начинаем визуализацию удалённого выстрела
    this._startRemoteShotVisualization(token, data);
  }
  
  /**
   * Обработка сегмента выстрела от другого игрока
   * @private
   */
  _handleShotSegment(data) {
    // Обновляем счётчик сегментов в socketLogger
    if (data?.tokenId && data?.segmentIndex !== undefined) {
      const isRicochet = data.segment?.isRicochet || false;
      socketLogger.addSegment(data.tokenId, data.segmentIndex, isRicochet);
    }
    
    // Обновляем визуализацию траектории
    this.aimingSystem.rayRenderer.displayRemoteShotSegment(data);
  }
  
  /**
   * Обработка попадания от другого игрока
   * @private
   */
  _handleShotHit(data) {
    // Добавляем попадание в socketLogger
    if (data?.tokenId) {
      socketLogger.addHit(data.tokenId, data.hitType, data.distance, data.targetId);
    }
    
    // Показываем эффект попадания
    this.aimingSystem.rayRenderer.displayRemoteHitEffect(data);
  }
  
  /**
   * Обработка завершения выстрела от другого игрока
   * @private
   */
  _handleShotComplete(data) {
    // Завершаем отслеживание в socketLogger
    if (data?.tokenId) {
      socketLogger.finishRemoteShot(data.tokenId);
    }
    
    // Проверяем доступность rayRenderer
    if (!this.aimingSystem?.rayRenderer) {
      console.error('⚠️ RayRenderer not available in _handleShotComplete');
      return;
    }
    
    // Завершаем визуализацию
    this.aimingSystem.rayRenderer.completeRemoteShot(data);
  }
  
  /**
   * Начать визуализацию удалённого выстрела
   * @private
   */
  _startRemoteShotVisualization(token, shotData) {
    try {
      // Проверяем доступность animationContainer
      if (!this.aimingSystem.rayRenderer.animationContainer) {
        console.error('SpaceHolder | AimingSocketManager: animationContainer not available');
        return;
      }
      
      // Не очищаем предыдущие выстрелы - они исчезнут автоматически через 10 секунд
      // Но сбрасываем таймер исчезновения для нового выстрела
      this.aimingSystem.rayRenderer._resetRemoteShotTimer(token.id);
      
      // Минимальная визуализация - показываем маркер
      this.aimingSystem.rayRenderer._showRemoteShotMarker(token);
      
      // Полная визуализация (позже)
      setTimeout(() => {
        try {
          this.aimingSystem.rayRenderer.visualizeRemoteShot({
            token: token,
            direction: shotData.direction,
            segments: shotData.segments || [],
            hits: shotData.hits || []
          });
        } catch (err) {
          console.error('Error in full visualization:', err);
        }
      }, 500);
      
    } catch (error) {
      console.error('SpaceHolder | AimingSocketManager: Error in remote shot visualization:', error);
    }
  }
}