// Тест с использованием официального Foundry VTT API для пользовательских событий
console.log("🏛️ Testing Foundry VTT official socket API...");

// В Foundry VTT есть специальный механизм для пользовательских сообщений
// Нужно использовать события определённого формата

// Способ 1: Использовать game.socket для системных сообщений
window.testFoundrySystemMessage = function() {
  console.log("🏛️ Testing system message approach...");
  
  // Слушаем системные сообщения
  game.socket.on("system", (data) => {
    console.log("📥 Received system message:", data);
  });
  
  // Отправляем системное сообщение
  game.socket.emit("system", {
    action: "customMessage",
    data: {
      message: "Hello from SpaceHolder!",
      sender: game.user.name,
      timestamp: Date.now()
    }
  });
};

// Способ 2: Попробовать использовать специфичные для системы события
window.testSystemSpecificMessage = function() {
  console.log("🏛️ Testing system-specific message...");
  
  const systemEvent = `system.${game.system.id}`;
  console.log("System event name:", systemEvent);
  
  // Слушаем события нашей системы
  game.socket.on(systemEvent, (data) => {
    console.log(`📥 Received ${systemEvent} message:`, data);
  });
  
  // Отправляем событие нашей системы
  game.socket.emit(systemEvent, {
    type: "test",
    message: "Hello from SpaceHolder system!",
    sender: game.user.name
  });
};

// Способ 3: Использовать ChatMessage как транспорт
window.testChatTransport = function() {
  console.log("💬 Testing chat message transport...");
  
  // Хук на создание чат-сообщений
  Hooks.on("createChatMessage", (message) => {
    if (message.flags?.spaceholder?.socketData) {
      console.log("📥 Received socket data via chat:", message.flags.spaceholder.socketData);
      
      // Здесь мы можем обработать наши данные
      const data = message.flags.spaceholder.socketData;
      if (data.type === "shot") {
        console.log("🎯 Processing shot via chat transport:", data);
      }
    }
  });
  
  // Отправляем данные через скрытое чат-сообщение
  ChatMessage.create({
    content: ".", // Минимальный контент
    whisper: [], // Отправляем всем
    speaker: {alias: "System"},
    flags: {
      spaceholder: {
        socketData: {
          type: "shot",
          tokenId: canvas.tokens.placeables[0]?.id,
          message: "Test shot via chat transport",
          sender: game.user.id
        }
      }
    }
  });
};

// Способ 4: Попробовать использовать встроенные события Foundry
window.testBuiltinEvents = function() {
  console.log("🔧 Testing builtin event types...");
  
  // Проверим, какие события доступны
  const knownEvents = [
    "message",
    "notification", 
    "userActivity",
    "pause",
    "unpause"
  ];
  
  knownEvents.forEach(eventType => {
    console.log(`Testing event type: ${eventType}`);
    
    // Слушаем событие
    game.socket.on(eventType, (data) => {
      console.log(`📥 Received builtin ${eventType}:`, data);
    });
    
    // Пробуем отправить
    setTimeout(() => {
      try {
        game.socket.emit(eventType, {
          test: true,
          message: `Test ${eventType} event`,
          from: game.user.name
        });
      } catch (error) {
        console.log(`❌ Cannot emit ${eventType}:`, error.message);
      }
    }, eventType === "userActivity" ? 0 : 1000); // userActivity сразу, остальные с задержкой
  });
};

console.log("🏛️ Foundry API socket tests loaded!");
console.log("Commands:");
console.log("  testFoundrySystemMessage() - test system messages");
console.log("  testSystemSpecificMessage() - test system-specific events"); 
console.log("  testChatTransport() - test using chat messages as transport");
console.log("  testBuiltinEvents() - test known Foundry event types");
console.log("");
console.log("💡 These tests try different official Foundry approaches");

// Проверим, какие события уже слушает Foundry
console.log("=== CURRENT FOUNDRY SOCKET LISTENERS ===");
if (game.socket._callbacks) {
  Object.keys(game.socket._callbacks).forEach(eventName => {
    const listeners = game.socket._callbacks[eventName];
    console.log(`${eventName}: ${listeners.length} listeners`);
  });
}