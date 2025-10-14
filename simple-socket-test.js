// Простой тест сокетов для проверки базовой функциональности
// Запустите в консоли браузера

console.log("🔌 Simple socket test for SpaceHolder system...");

window.simpleSocketTest = function() {
  console.log("=== SIMPLE SOCKET TEST ===");
  
  const socketName = 'system.spaceholder.test';
  
  // 1. Регистрируем обработчик
  console.log("1. Registering socket handler...");
  
  const handler = (data, senderId) => {
    console.log("✅ Received socket message:", data, "from user:", senderId);
    
    if (data.type === 'PING') {
      console.log("🏓 Got PING, sending PONG...");
      
      // Отправляем ответ
      game.socket.emit(socketName, {
        type: 'PONG',
        originalSender: data.sender,
        timestamp: Date.now()
      });
    }
    
    if (data.type === 'PONG') {
      console.log("🏓 Got PONG response!");
    }
  };
  
  // Регистрируем обработчик
  game.socket.on(socketName, handler);
  
  // 2. Отправляем тестовое сообщение
  console.log("2. Sending PING message...");
  
  game.socket.emit(socketName, {
    type: 'PING',
    sender: game.user.name,
    message: 'Hello from SpaceHolder!',
    timestamp: Date.now()
  });
  
  // 3. Очистка через 10 секунд
  setTimeout(() => {
    console.log("3. Cleaning up socket handler...");
    game.socket.off(socketName, handler);
    console.log("✅ Socket test completed");
  }, 10000);
  
  console.log("🔌 Test initiated. Check console for results...");
};

window.testSpaceholderSocket = function() {
  console.log("=== SPACEHOLDER SOCKET TEST ===");
  
  if (!game.spaceholder?.aimingSystem?.socketManager) {
    console.error("❌ SpaceHolder socket manager not available");
    return;
  }
  
  const socketManager = game.spaceholder.aimingSystem.socketManager;
  console.log("Socket name:", socketManager.socketName);
  
  // Пробуем отправить простое тестовое сообщение через наш SocketManager
  console.log("Sending test message through SocketManager...");
  
  // Создаем тестовый токен данные
  const testToken = canvas.tokens.placeables[0];
  if (!testToken) {
    console.error("❌ No tokens on scene for testing");
    return;
  }
  
  const testShotData = {
    tokenId: testToken.id,
    direction: 0,
    startPosition: testToken.center,
    timestamp: Date.now(),
    weaponName: 'Test Socket Weapon'
  };
  
  console.log("Broadcasting test shot:", testShotData);
  socketManager.broadcastFireShot(testShotData);
  
  console.log("✅ SpaceHolder socket test message sent");
};

console.log("🔌 Socket tests loaded:");
console.log("  simpleSocketTest() - basic socket functionality");
console.log("  testSpaceholderSocket() - SpaceHolder socket manager");