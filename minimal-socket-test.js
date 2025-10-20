// Максимально простой тест сокетов - без обёрток, без классов
console.log("🔥 MINIMAL socket test - direct approach");

// Функция для первого клиента (отправитель)
window.startMinimalSender = function() {
  console.log("📤 MINIMAL SENDER STARTED");
  
  let counter = 0;
  
  const interval = setInterval(() => {
    counter++;
    console.log(`📤 Sending minimal message ${counter}...`);
    
    // Максимально простая отправка
    game.socket.emit('minimal-test', {
      id: counter,
      message: `Hello ${counter}`,
      from: game.user.name,
      userId: game.user.id
    });
    
    if (counter >= 3) {
      clearInterval(interval);
      console.log("📤 Minimal sender finished");
    }
  }, 3000);
};

// Функция для второго клиента (получатель)  
window.startMinimalReceiver = function() {
  console.log("📥 MINIMAL RECEIVER STARTED");
  
  // Максимально простой обработчик
  game.socket.on('minimal-test', (data) => {
    console.log("📥 MINIMAL RECEIVER GOT MESSAGE:", data);
    console.log("📥 From user:", data.from, "Current user:", game.user.name);
    console.log("📥 Is from different user:", data.userId !== game.user.id);
  });
  
  console.log("📥 Minimal receiver listening...");
};

// Проверим, что вообще происходит с сокетами
console.log("=== SOCKET DEBUG INFO ===");
console.log("game.socket:", game.socket);
console.log("game.socket.constructor.name:", game.socket?.constructor?.name);
console.log("game.socket.connected:", game.socket?.connected);
console.log("game.socket.id:", game.socket?.id);

// Проверим, есть ли уже обработчики
console.log("Current socket listeners:", Object.keys(game.socket._callbacks || {}));

// Попробуем послушать ВСЕ события сокета
game.socket.onAny((eventName, ...args) => {
  console.log(`🌍 SOCKET EVENT: ${eventName}`, args);
});

console.log("🔥 Minimal test ready!");
console.log("  On CLIENT 1: startMinimalSender()");
console.log("  On CLIENT 2: startMinimalReceiver()");
console.log("");
console.log("💡 This uses the most basic socket approach possible");

// Дополнительно - проверим WebSocket соединение напрямую
if (game.socket.socket) {
  console.log("Raw WebSocket state:", game.socket.socket.readyState);
  console.log("Raw WebSocket URL:", game.socket.socket.url);
}

// И проверим, можем ли мы вообще что-то делать с сокетами
setTimeout(() => {
  console.log("🧪 Testing basic socket functionality...");
  
  // Попробуем самый базовый emit
  console.log("Emitting test event...");
  game.socket.emit('basic-test', 'hello world');
  
  // Попробуем послушать базовое событие
  game.socket.on('basic-test', (data) => {
    console.log("Got basic test event:", data);
  });
  
}, 1000);