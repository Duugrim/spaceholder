// Aiming Socket Manager for SpaceHolder - управление мультиплеерной синхронизацией
// Отвечает за передачу событий выстрелов между всеми клиентами

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
    console.log('SpaceHolder | AimingSocketManager: Initializing socket manager');
    console.log('Socket name:', this.socketName);
    console.log('User ID:', game.user.id, 'User name:', game.user.name);
    
    // Проверяем доступность game.socket
    if (!game.socket) {
      console.error('SpaceHolder | AimingSocketManager: game.socket not available!');
      return;
    }
    
    // Регистрируем обработчики socket-событий
    game.socket.on(this.socketName, (data) => {
      console.log(`📨 Socket event received on ${this.socketName}:`, data);
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
    
    console.log('SpaceHolder | AimingSocketManager: Broadcasting fire shot', message);
    
    // Используем game.socket.emit с правильным callback
    game.socket.emit(this.socketName, message, (response) => {
      console.log('Socket emit response:', response);
    });
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
    
    console.log('SpaceHolder | AimingSocketManager: Broadcasting shot hit', message);
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
    
    console.log('SpaceHolder | AimingSocketManager: Broadcasting shot complete', message);
    game.socket.emit(this.socketName, message);
  }
  
  /**
   * Обработка входящих socket-сообщений
   * @private
   */
  _handleSocketMessage(message) {
    console.log('📨 SpaceHolder | AimingSocketManager: Raw message received', message);
    
    // Проверяем структуру сообщения
    if (!message || !message.userId || !message.type) {
      console.warn('SpaceHolder | AimingSocketManager: Invalid message structure', message);
      return;
    }
    
    // Игнорируем собственные сообщения
    if (message.userId === game.user.id) {
      console.log('😴 Ignoring own message from', game.user.name);
      return;
    }
    
    console.log('✅ SpaceHolder | AimingSocketManager: Processing message from', message.userId, 'type:', message.type);
    
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
    console.log('🌐 Remote fire shot received:', data);
    
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
    
    console.log('🔍 Looking for token ID:', data.tokenId);
    console.log('🗺 Available tokens:', canvas.tokens.placeables.map(t => ({id: t.id, name: t.name})));
    
    // Найдём токен на сцене
    const token = canvas.tokens.get(data.tokenId);
    if (!token) {
      console.error('SpaceHolder | AimingSocketManager: Token not found for remote fire shot', data.tokenId);
      console.log('🗺 Available token IDs:', canvas.tokens.placeables.map(t => t.id));
      return;
    }
    
    console.log('✅ Token found:', token.name, 'at', token.center);
    
    // Проверяем rayRenderer
    if (!this.aimingSystem || !this.aimingSystem.rayRenderer) {
      console.error('SpaceHolder | AimingSocketManager: RayRenderer not available');
      return;
    }
    
    console.log('✅ RayRenderer found, checking visualizeRemoteShot method');
    
    if (typeof this.aimingSystem.rayRenderer.visualizeRemoteShot !== 'function') {
      console.error('SpaceHolder | AimingSocketManager: visualizeRemoteShot method not found');
      return;
    }
    
    // Начинаем визуализацию удалённого выстрела
    this._startRemoteShotVisualization(token, data);
  }
  
  /**
   * Обработка сегмента выстрела от другого игрока
   * @private
   */
  _handleShotSegment(data) {
    // Обновляем визуализацию траектории
    this.aimingSystem.rayRenderer.displayRemoteShotSegment(data);
  }
  
  /**
   * Обработка попадания от другого игрока
   * @private
   */
  _handleShotHit(data) {
    console.log('🌐 Remote shot hit received:', data);
    
    // Показываем эффект попадания
    this.aimingSystem.rayRenderer.displayRemoteHitEffect(data);
  }
  
  /**
   * Обработка завершения выстрела от другого игрока
   * @private
   */
  _handleShotComplete(data) {
    console.log('🌐 Remote shot complete received:', data);
    
    // Завершаем визуализацию
    this.aimingSystem.rayRenderer.completeRemoteShot(data);
  }
  
  /**
   * Начать визуализацию удалённого выстрела
   * @private
   */
  _startRemoteShotVisualization(token, shotData) {
    console.log(`🌐 Starting remote shot visualization for ${token.name}`);
    
    try {
      // Проверяем доступность animationContainer
      if (!this.aimingSystem.rayRenderer.animationContainer) {
        console.error('SpaceHolder | AimingSocketManager: animationContainer not available');
        return;
      }
      
      // Очищаем предыдущие выстрелы для этого токена
      this.aimingSystem.rayRenderer.startNewRemoteShot(token.id);
      
      // Минимальная визуализация - показываем маркер
      console.log('🔴 Showing remote shot marker...');
      this.aimingSystem.rayRenderer._showRemoteShotMarker(token);
      
      console.log('✅ Remote shot marker shown successfully');
      
      // Также показываем уведомление в чате
      ChatMessage.create({
        content: `🌐 ${token.name} стреляет (удалённо)!`,
        speaker: { alias: 'System' },
        whisper: [game.user.id] // Только для текущего игрока
      });
      
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
      console.error('Error details:', error.stack);
    }
  }
}