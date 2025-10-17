// ShotChatManager - интеграция выстрелов с системой чата Foundry
// Управляет сохранением shotResult в ChatMessage и воспроизведением из истории

import { ShotHistoryManager } from './shot-history-manager.mjs';

/**
 * Менеджер интеграции выстрелов с чатом
 */
export class ShotChatManager {
  constructor() {
    // Ключ для attachment в ChatMessage
    this.SHOT_ATTACHMENT_KEY = 'spaceholder.shotResult';
    
    // Флаги для системы
    this.CHAT_MESSAGE_TYPE = 'spaceholder-shot';
    this.CHAT_MESSAGE_SUBTYPE = 'shot-result';
    
    // Глобальная ссылка на ShotHistoryManager
    this.shotHistoryManager = null;
  }
  
  /**
   * Инициализация менеджера
   * @param {ShotHistoryManager} shotHistoryManager - менеджер истории выстрелов
   */
  initialize(shotHistoryManager) {
    this.shotHistoryManager = shotHistoryManager;
    
    // Регистрируем hook на рендер ChatMessage для добавления кнопок
    Hooks.on('renderChatMessageHTML', this._onRenderChatMessage.bind(this));
    
    // Регистрируем hook на удаление ChatMessage
    Hooks.on('deleteChatMessage', this._onDeleteChatMessage.bind(this));
    
    // Регистрируем сокет для синхронизации действий с кнопками чата
    game.socket.on('system.spaceholder', this._onSocketMessage.bind(this));
    
    console.log('SpaceHolder | ShotChatManager: Initialized with socket support');
  }
  
  /**
   * Сохранить результат выстрела в чат
   * @param {Object} shotResult - результат выстрела из ShotSystem
   * @param {Object} options - опции сообщения
   * @returns {Promise<ChatMessage>} созданное сообщение
   */
  async saveShotToChat(shotResult, options = {}) {
    const {
      whisperTo = null,
      blind = false,
      speakerToken = null
    } = options;
    
    // Определяем говорящего
    const speaker = speakerToken ? {
      token: speakerToken.id,
      actor: speakerToken.actor?.id,
      alias: speakerToken.name
    } : ChatMessage.getSpeaker();
    
    // Создаем красивое содержимое сообщения
    const content = this._generateShotSummary(shotResult);
    
    // Подготавливаем данные сообщения
    const messageData = {
      style: CONST.CHAT_MESSAGE_STYLES.OTHER,
      speaker: speaker,
      content: content,
      whisper: whisperTo ? [whisperTo] : [],
      blind: blind,
      flags: {
        spaceholder: {
          type: this.CHAT_MESSAGE_TYPE,
          subtype: this.CHAT_MESSAGE_SUBTYPE,
          shotId: shotResult.id,
          // Добавляем shotResult на том же уровне
          shotData: {
            version: '1.0',
            timestamp: Date.now(),
            shotResult: shotResult
          }
        }
      }
    };
    
    try {
      const message = await ChatMessage.create(messageData);
      console.log(`ShotChatManager: Saved shot ${shotResult.id} to chat message ${message.id}`);
      return message;
    } catch (error) {
      console.error('ShotChatManager: Error saving shot to chat:', error);
      throw error;
    }
  }
  
  /**
   * Воспроизвести выстрел из ChatMessage
   * @param {string} messageId - ID сообщения чата
   * @param {Object} options - опции воспроизведения
   * @returns {Promise<boolean>} успех операции
   */
  async replayShotFromChat(messageId, options = {}) {
    console.log(`ShotChatManager: Starting replay for message ${messageId} with options:`, options);
    
    const {
      animate = true,
      fadeDelay = 10000,
      autoFade = true,
      isReplay = true,
      color = null,
      id = null // Для закреплённых выстрелов
    } = options;
    
    // Находим сообщение
    const message = game.messages.get(messageId);
    if (!message) {
      console.error(`ShotChatManager: Message ${messageId} not found`);
      return false;
    }
    console.log(`ShotChatManager: Found message:`, message);
    
    // Извлекаем shotResult из флагов
    const flags = message.flags?.spaceholder;
    const attachment = flags?.shotData;
    console.log(`ShotChatManager: Retrieved attachment:`, attachment);
    
    if (!attachment || !attachment.shotResult) {
      console.error(`ShotChatManager: No shot data found in message ${messageId}`);
      console.log('Available flags:', message.flags);
      return false;
    }
    
    const shotResult = attachment.shotResult;
    console.log(`ShotChatManager: Extracted shotResult:`, shotResult);
    
    // Проверяем наличие ShotHistoryManager
    console.log(`ShotChatManager: shotHistoryManager available:`, !!this.shotHistoryManager);
    if (!this.shotHistoryManager) {
      console.error('ShotChatManager: ShotHistoryManager not available');
      return false;
    }
    
    // Воспроизводим через ShotHistoryManager
    try {
      const shotOptions = {
        isRemote: isReplay, // Воспроизведение считаем "удалённым"
        animate: animate,
        autoFade: autoFade,
        fadeDelay: fadeDelay,
        color: color || (isReplay ? 0x888888 : null), // Используем указанный цвет или серый по умолчанию
        renderAboveFog: false // По умолчанию под туманом войны
      };
      
      // Если указан ID, используем его для сохранения в истории
      if (id) {
        shotOptions.id = id;
      }
      
      this.shotHistoryManager.addShot(shotResult, shotOptions);
      
      console.log(`ShotChatManager: Replayed shot ${shotResult.id} from chat`);
      
      // Показываем уведомление только для временных выстрелов
      if (autoFade) {
        ui.notifications.info(`Воспроизведён выстрел ${shotResult.id}`);
      }
      
      return true;
    } catch (error) {
      console.error('ShotChatManager: Error replaying shot:', error);
      ui.notifications.error('Ошибка при воспроизведении выстрела');
      return false;
    }
  }
  
  /**
   * Получить информацию о выстреле из ChatMessage
   * @param {string} messageId - ID сообщения
   * @returns {Object|null} данные выстрела
   */
  getShotFromChat(messageId) {
    const message = game.messages.get(messageId);
    if (!message) return null;
    
    const flags = message.flags?.spaceholder;
    const attachment = flags?.shotData;
    
    return attachment?.shotResult || null;
  }
  
  /**
   * Проверить, содержит ли сообщение данные о выстреле
   * @param {ChatMessage} message - сообщение чата
   * @returns {boolean}
   */
  isShotMessage(message) {
    console.log('=== isShotMessage DEBUG ===');
    console.log('game.system.id:', game.system.id);
    console.log('Full message flags:', message.flags);
    console.log('message.flags.spaceholder:', message.flags.spaceholder);
    
    // Пробуем разные способы получения флагов
    const flags1 = message.getFlag('spaceholder');
    const flags2 = message.getFlag(game.system.id);
    const flags3 = message.flags?.spaceholder;
    
    console.log('getFlag("spaceholder"):', flags1);
    console.log('getFlag(game.system.id):', flags2);
    console.log('flags.spaceholder:', flags3);
    
    const flags = flags3; // Используем прямой доступ
    console.log('Using flags:', flags);
    console.log('Looking for type:', this.CHAT_MESSAGE_TYPE, 'subtype:', this.CHAT_MESSAGE_SUBTYPE);
    
    const isShot = flags?.type === this.CHAT_MESSAGE_TYPE && 
                   flags?.subtype === this.CHAT_MESSAGE_SUBTYPE;
    console.log('isShotMessage result:', isShot);
    console.log('========================');
    return isShot;
  }
  
  /**
   * Сгенерировать красивое описание выстрела для чата
   * @param {Object} shotResult - результат выстрела
   * @returns {string} HTML содержимое
   * @private
   */
  _generateShotSummary(shotResult) {
    const shooterName = shotResult.shooter ? 
      (canvas.tokens.get(shotResult.shooter)?.name || 'Unknown') : 
      'Unknown';
    
    const segmentCount = shotResult.segments?.length || 0;
    const hitCount = shotResult.hits?.length || 0;
    const distance = Math.round(shotResult.totalDistance || 0);
    const payloadName = shotResult.payload?.name || 'Unknown';
    
    // Определяем результат выстрела
    let result = 'Промах';
    let resultClass = 'miss';
    if (hitCount > 0) {
      result = hitCount === 1 ? 'Попадание' : `${hitCount} попаданий`;
      resultClass = 'hit';
    }
    
    const html = `
      <div class="spaceholder-shot-summary">
        <div class="shot-header">
          <h3><i class="fas fa-crosshairs"></i> Выстрел: ${payloadName}</h3>
          <div class="shot-id">ID: ${shotResult.id}</div>
        </div>
        
        <div class="shot-details">
          <div class="detail-row">
            <span class="label"><i class="fas fa-user"></i> Стрелок:</span>
            <span class="value">${shooterName}</span>
          </div>
          
          <div class="detail-row">
            <span class="label"><i class="fas fa-ruler"></i> Дистанция:</span>
            <span class="value">${distance} ft</span>
          </div>
          
          <div class="detail-row">
            <span class="label"><i class="fas fa-route"></i> Сегменты:</span>
            <span class="value">${segmentCount}</span>
          </div>
          
          <div class="detail-row">
            <span class="label"><i class="fas fa-bullseye"></i> Результат:</span>
            <span class="value ${resultClass}">${result}</span>
          </div>
        </div>
        
        <div class="shot-actions">
          <button class="replay-shot-btn" data-message-id="{{messageId}}" data-shot-id="${shotResult.id}">
            <i class="fas fa-play"></i> Воспроизвести
          </button>
          <button class="pin-shot-btn" data-message-id="{{messageId}}" data-shot-id="${shotResult.id}" title="Закрепить выстрел (показывать постоянно)">
            <i class="fas fa-lock"></i>
          </button>
        </div>
      </div>
      
      <style>
      .spaceholder-shot-summary {
        border: 1px solid #666;
        border-radius: 5px;
        padding: 10px;
        background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%);
        margin: 5px 0;
      }
      
      .shot-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
        border-bottom: 1px solid #444;
        padding-bottom: 5px;
      }
      
      .shot-header h3 {
        margin: 0;
        color: #ff6400;
        font-size: 16px;
      }
      
      .shot-id {
        font-size: 12px;
        color: #999;
        font-family: monospace;
      }
      
      .shot-details {
        margin-bottom: 10px;
      }
      
      .detail-row {
        display: flex;
        justify-content: space-between;
        margin: 3px 0;
        font-size: 13px;
      }
      
      .detail-row .label {
        color: #ccc;
      }
      
      .detail-row .value {
        font-weight: bold;
      }
      
      .value.hit {
        color: #4CAF50;
      }
      
      .value.miss {
        color: #f44336;
      }
      
      .shot-actions {
        text-align: center;
        padding-top: 5px;
        border-top: 1px solid #444;
        display: flex;
        gap: 8px;
        justify-content: center;
      }
      
      .replay-shot-btn, .pin-shot-btn {
        border: none;
        padding: 5px 15px;
        border-radius: 3px;
        color: white;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s ease;
      }
      
      .replay-shot-btn {
        background: #ff6400;
      }
      
      .replay-shot-btn:hover {
        background: #e55a00;
      }
      
      .pin-shot-btn {
        background: #666;
        padding: 5px 10px;
        min-width: 30px;
      }
      
      .pin-shot-btn:hover {
        background: #888;
      }
      
      .pin-shot-btn.pinned {
        background: #4CAF50;
      }
      
      .pin-shot-btn.pinned:hover {
        background: #45a049;
      }
      </style>
    `;
    
    return html;
  }
  
  /**
   * Обработка сообщений сокета
   * @param {Object} data - данные сообщения
   * @private
   */
  _onSocketMessage(data) {
    console.log('ShotChatManager: Received socket message:', data);
    
    if (data.type === 'shot-replay') {
      this._handleSocketReplay(data);
    } else if (data.type === 'shot-pin-toggle') {
      this._handleSocketPinToggle(data);
    }
  }
  
  /**
   * Обработка реплея через сокет
   * @param {Object} data - данные реплея
   * @private
   */
  _handleSocketReplay(data) {
    const { messageId, options, userId } = data;
    
    // Пропускаем сообщения от себя
    if (userId === game.userId) return;
    
    console.log(`ShotChatManager: Remote replay request for message ${messageId} from user ${userId}`);
    this.replayShotFromChat(messageId, options);
  }
  
  /**
   * Обработка переключения закрепления через сокет
   * @param {Object} data - данные переключения
   * @private
   */
  _handleSocketPinToggle(data) {
    const { messageId, shotId, isPinned, options, userId } = data;
    
    // Пропускаем сообщения от себя
    if (userId === game.userId) return;
    
    console.log(`ShotChatManager: Remote pin toggle for shot ${shotId}, pinned: ${isPinned}`);
    
    if (isPinned) {
      // Закрепляем
      this.replayShotFromChat(messageId, options);
    } else {
      // Открепляем
      if (this.shotHistoryManager && this.shotHistoryManager.shotHistory.has(shotId)) {
        this.shotHistoryManager.removeShot(shotId);
      }
    }
    
    // Обновляем визуальное состояние кнопки
    this._updatePinButtonState(messageId, shotId, isPinned);
  }
  
  /**
   * Обновление визуального состояния кнопки закрепления
   * @param {string} messageId - ID сообщения
   * @param {string} shotId - ID выстрела
   * @param {boolean} isPinned - закреплён ли
   * @private
   */
  _updatePinButtonState(messageId, shotId, isPinned) {
    // Находим кнопку по messageId
    const chatMessage = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!chatMessage) return;
    
    const pinBtn = chatMessage.querySelector('.pin-shot-btn');
    if (!pinBtn) return;
    
    if (isPinned) {
      pinBtn.classList.add('pinned');
      pinBtn.innerHTML = '<i class="fas fa-lock-open"></i>';
      pinBtn.title = 'Открепить выстрел';
    } else {
      pinBtn.classList.remove('pinned');
      pinBtn.innerHTML = '<i class="fas fa-lock"></i>';
      pinBtn.title = 'Закрепить выстрел (показывать постоянно)';
    }
  }
  
  /**
   * Hook на рендер ChatMessage - добавляем кнопки
   * @param {ChatMessage} message - сообщение чата
   * @param {HTMLElement} html - HTML элемент
   * @private
   */
  _onRenderChatMessage(message, html) {
    console.log('_onRenderChatMessage called for message:', message.id);
    
    // Проверяем, это ли наше сообщение с выстрелом
    if (!this.isShotMessage(message)) {
      console.log('Not a shot message, skipping');
      return;
    }
    
    console.log('Processing shot message, looking for replay button');
    
    // Находим кнопки
    const replayBtn = html.querySelector('.replay-shot-btn');
    const pinBtn = html.querySelector('.pin-shot-btn');
    
    if (!replayBtn) {
      console.log('Replay button not found in HTML');
      return;
    }
    
    console.log('Found buttons, setting up event handlers');
    
    // Заменяем {{messageId}} на реальный ID и устанавливаем shotId
    replayBtn.setAttribute('data-message-id', message.id);
    if (pinBtn) {
      pinBtn.setAttribute('data-message-id', message.id);
      // Получаем shotId из сообщения
      const shotId = message.flags?.spaceholder?.shotData?.id;
      if (shotId) {
        pinBtn.setAttribute('data-shot-id', shotId);
      }
    }
    
    // Обработчик для кнопки воспроизведения (временно)
    replayBtn.addEventListener('click', (event) => {
      console.log('Replay button clicked!');
      event.preventDefault();
      const messageId = event.target.closest('.replay-shot-btn').getAttribute('data-message-id');
      console.log('Attempting to replay shot for message:', messageId);
      
      const options = { fadeDelay: 10000 }; // 10 секунд до исчезновения
      
      // Локально воспроизводим
      this.replayShotFromChat(messageId, options);
      
      // Отправляем всем остальным через сокет
      game.socket.emit('system.spaceholder', {
        type: 'shot-replay',
        messageId: messageId,
        options: options,
        userId: game.userId
      });
    });
    
    // Обработчик для кнопки закрепления (постоянно)
    if (pinBtn) {
      pinBtn.addEventListener('click', (event) => {
        console.log('Pin button clicked!');
        event.preventDefault();
        const messageId = event.target.closest('.pin-shot-btn').getAttribute('data-message-id');
        const shotId = event.target.closest('.pin-shot-btn').getAttribute('data-shot-id');
        
        // Проверяем, закреплён ли уже выстрел
        const isPinned = pinBtn.classList.contains('pinned');
        
        const newPinnedState = !isPinned;
        
        if (isPinned) {
          // Открепляем
          console.log('Unpinning shot:', shotId);
          pinBtn.classList.remove('pinned');
          pinBtn.innerHTML = '<i class="fas fa-lock"></i>';
          pinBtn.title = 'Закрепить выстрел (показывать постоянно)';
          
          // Локально удаляем выстрел со сцены
          if (this.shotHistoryManager && this.shotHistoryManager.shotHistory.has(shotId)) {
            this.shotHistoryManager.removeShot(shotId);
          }
        } else {
          // Закрепляем
          console.log('Pinning shot:', shotId);
          pinBtn.classList.add('pinned');
          pinBtn.innerHTML = '<i class="fas fa-lock-open"></i>';
          pinBtn.title = 'Открепить выстрел';
          
          // Локально показываем выстрел постоянно
          this.replayShotFromChat(messageId, { 
            fadeDelay: 0, // Не удалять автоматически
            autoFade: false,
            color: 0xAAAAAA, // Более тусклый цвет для закреплённых
            id: shotId, // Используем shotId для идентификации
            renderAboveFog: false // Закреплённые выстрелы тоже под туманом
          });
        }
        
        // Отправляем сообщение всем остальным через сокет
        game.socket.emit('system.spaceholder', {
          type: 'shot-pin-toggle',
          messageId: messageId,
          shotId: shotId,
          isPinned: newPinnedState,
          options: newPinnedState ? {
            fadeDelay: 0,
            autoFade: false,
            color: 0xAAAAAA,
            id: shotId,
            renderAboveFog: false
          } : null,
          userId: game.userId
        });
      });
    }
    
    console.log('Event handlers set up successfully');
  }
  
  /**
   * Hook на удаление ChatMessage - очищаем связанные визуализации
   * @param {ChatMessage} message - удаляемое сообщение
   * @private
   */
  _onDeleteChatMessage(message) {
    if (!this.isShotMessage(message) || !this.shotHistoryManager) return;
    
    const flags = message.getFlag('spaceholder');
    const shotId = flags?.shotId;
    
    if (shotId && this.shotHistoryManager.shotHistory.has(shotId)) {
      this.shotHistoryManager.removeShot(shotId);
      console.log(`ShotChatManager: Removed shot ${shotId} due to chat message deletion`);
    }
  }
}