// Правильная реализация нативных сокетов Foundry VTT
// Основанная на официальной документации

console.log("🔧 Correct native socket implementation...");

// Создаём правильный socket manager
class FoundryNativeSocketManager {
  constructor(namespace) {
    this.namespace = namespace;
    this.handlers = new Map();
    this.initialized = false;
  }
  
  initialize() {
    if (this.initialized) return;
    
    console.log("🔌 Initializing native socket manager for namespace:", this.namespace);
    
    // Регистрируем общий обработчик для нашего пространства имён
    game.socket.on(this.namespace, (data) => {
      console.log(`📨 Socket event received on ${this.namespace}:`, data);
      this._handleMessage(data);
    });
    
    this.initialized = true;
    console.log("✅ Native socket manager initialized");
  }
  
  // Регистрация обработчика для конкретного типа сообщения
  on(messageType, handler) {
    console.log(`📝 Registering handler for: ${messageType}`);
    this.handlers.set(messageType, handler);
  }
  
  // Отправка сообщения всем клиентам
  emit(messageType, data) {
    const message = {
      type: messageType,
      data: data,
      sender: game.user.id,
      timestamp: Date.now()
    };
    
    console.log(`📤 Emitting message type ${messageType} to namespace ${this.namespace}:`, message);
    
    // В Foundry VTT правильный способ - это emit с данными
    game.socket.emit(this.namespace, message);
  }
  
  // Внутренний обработчик сообщений
  _handleMessage(message) {
    // Игнорируем собственные сообщения
    if (message.sender === game.user.id) {
      console.log("😴 Ignoring own message");
      return;
    }
    
    console.log(`🎯 Processing message type: ${message.type} from user: ${message.sender}`);
    
    const handler = this.handlers.get(message.type);
    if (handler) {
      try {
        handler(message.data, message.sender);
      } catch (error) {
        console.error("❌ Error in message handler:", error);
      }
    } else {
      console.warn("⚠️ No handler registered for message type:", message.type);
    }
  }
}

// Создаём глобальный экземпляр для тестирования
window.testSocketManager = new FoundryNativeSocketManager("spaceholder.test");

// Тест функции
window.setupSocketTest = function() {
  console.log("🧪 Setting up socket test...");
  
  // Инициализируем менеджер
  testSocketManager.initialize();
  
  // Регистрируем обработчики
  testSocketManager.on("ping", (data, senderId) => {
    console.log(`🏓 Received PING from ${senderId}:`, data);
    
    // Отправляем PONG обратно
    testSocketManager.emit("pong", {
      message: `PONG from ${game.user.name}`,
      originalMessage: data.message
    });
  });
  
  testSocketManager.on("pong", (data, senderId) => {
    console.log(`🏓 Received PONG from ${senderId}:`, data);
  });
  
  testSocketManager.on("shot", (data, senderId) => {
    console.log(`🎯 Received SHOT from ${senderId}:`, data);
    
    // Здесь мы бы запускали визуализацию
    if (data.tokenId) {
      const token = canvas.tokens.get(data.tokenId);
      if (token) {
        console.log(`✅ Found token ${token.name} for shot visualization`);
        
        // Показываем простое уведомление в чате
        ChatMessage.create({
          content: `🌐 ${token.name} стреляет (через правильные сокеты)!`,
          speaker: { alias: 'Socket Test' }
        });
      }
    }
  });
  
  console.log("✅ Socket test setup complete");
};

window.sendPing = function() {
  console.log("🏓 Sending PING...");
  testSocketManager.emit("ping", {
    message: `Hello from ${game.user.name}!`,
    timestamp: Date.now()
  });
};

window.sendTestShot = function() {
  console.log("🎯 Sending test shot...");
  
  const testToken = canvas.tokens.placeables[0];
  if (!testToken) {
    console.error("❌ No tokens available for test");
    return;
  }
  
  testSocketManager.emit("shot", {
    tokenId: testToken.id,
    direction: 45,
    weapon: "Test Socket Weapon",
    timestamp: Date.now()
  });
};

console.log("🔧 Correct socket implementation loaded!");
console.log("Commands:");
console.log("  setupSocketTest() - initialize the socket test");
console.log("  sendPing() - send a ping message");
console.log("  sendTestShot() - send a test shot");
console.log("");
console.log("📋 Test procedure:");
console.log("  1. Run setupSocketTest() on ALL clients");
console.log("  2. Run sendPing() or sendTestShot() on one client");
console.log("  3. Check console on other clients");