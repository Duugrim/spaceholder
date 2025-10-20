// Диагностический скрипт для socket-событий системы прицеливания
// Запустите в консоли браузера для проверки

console.log("🔍 Starting socket diagnostics...");

// Функция для детальной диагностики
window.debugAimingSockets = function() {
  console.log("=== AIMING SOCKET DIAGNOSTICS ===");
  
  // 1. Проверяем наличие системы
  if (!game.spaceholder?.aimingSystem) {
    console.error("❌ AimingSystem not found");
    return;
  }
  
  const aimingSystem = game.spaceholder.aimingSystem;
  console.log("✅ AimingSystem found");
  
  // 2. Проверяем SocketManager
  if (!aimingSystem.socketManager) {
    console.error("❌ SocketManager not found");
    return;
  }
  
  const socketManager = aimingSystem.socketManager;
  console.log("✅ SocketManager found");
  console.log("Socket name:", socketManager.socketName);
  
  // 3. Проверяем подключение к game.socket
  console.log("game.socket exists:", !!game.socket);
  
  // 4. Проверяем, что обработчик events зарегистрирован
  console.log("Socket listeners:", game.socket._callbacks?.[socketManager.socketName]?.length || 0);
  
  // 5. Тестируем отправку тестового сообщения
  console.log("🧪 Testing socket broadcast...");
  
  const testData = {
    test: true,
    timestamp: Date.now(),
    user: game.user.name
  };
  
  // Подписываемся на тестовое сообщение временно
  const testHandler = (data) => {
    if (data.type === 'TEST_MESSAGE') {
      console.log("✅ Test message received:", data);
    }
  };
  
  game.socket.on(socketManager.socketName, testHandler);
  
  console.log('Sending test message to:', socketManager.socketName);
  
  // Отправляем тестовое сообщение
  game.socket.emit(socketManager.socketName, {
    type: 'TEST_MESSAGE',
    userId: game.user.id,
    data: testData
  });
  
  // Отписываемся через секунду
  setTimeout(() => {
    game.socket.off(socketManager.socketName, testHandler);
    console.log("🧪 Test completed");
  }, 1000);
  
  // 6. Проверяем состояние токенов на сцене
  console.log("Tokens on scene:", canvas.tokens.placeables.length);
  canvas.tokens.placeables.forEach(token => {
    console.log(`- Token: ${token.name} (ID: ${token.id})`);
  });
  
  console.log("=== DIAGNOSTICS COMPLETED ===");
};

// Функция для тестирования отправки выстрела
window.testRemoteShot = function() {
  console.log("🎯 Testing remote shot simulation...");
  
  if (!game.spaceholder?.aimingSystem?.socketManager) {
    console.error("❌ Socket system not ready");
    return;
  }
  
  // Находим любой токен на сцене
  const testToken = canvas.tokens.placeables[0];
  if (!testToken) {
    console.error("❌ No tokens on scene for testing");
    return;
  }
  
  console.log("Using test token:", testToken.name, testToken.id);
  
  const socketManager = game.spaceholder.aimingSystem.socketManager;
  
  // Симулируем выстрел
  const shotData = {
    tokenId: testToken.id,
    direction: 45, // 45 градусов
    startPosition: testToken.center,
    timestamp: Date.now(),
    weaponName: 'Test Weapon'
  };
  
  console.log("📡 Broadcasting test shot:", shotData);
  socketManager.broadcastFireShot(shotData);
  
  // Симулируем несколько сегментов
  setTimeout(() => {
    for (let i = 0; i < 3; i++) {
      const segmentData = {
        tokenId: testToken.id,
        segmentIndex: i,
        segment: {
          start: { 
            x: testToken.center.x + i * 50, 
            y: testToken.center.y + i * 50 
          },
          end: { 
            x: testToken.center.x + (i + 1) * 50, 
            y: testToken.center.y + (i + 1) * 50 
          },
          isRicochet: i > 1,
          bounceNumber: i > 1 ? i - 1 : 0
        }
      };
      
      console.log(`📡 Broadcasting test segment ${i}:`, segmentData);
      socketManager.broadcastShotSegment(segmentData);
    }
  }, 500);
  
  // Симулируем попадание
  setTimeout(() => {
    const hitData = {
      tokenId: testToken.id,
      hitType: 'wall',
      hitPoint: { 
        x: testToken.center.x + 150, 
        y: testToken.center.y + 150 
      },
      distance: 150
    };
    
    console.log("📡 Broadcasting test hit:", hitData);
    socketManager.broadcastShotHit(hitData);
  }, 1500);
  
  // Завершаем
  setTimeout(() => {
    const completeData = {
      tokenId: testToken.id,
      totalSegments: 3,
      totalHits: 1,
      segments: []
    };
    
    console.log("📡 Broadcasting shot complete:", completeData);
    socketManager.broadcastShotComplete(completeData);
  }, 2000);
  
  console.log("🎯 Test shot sequence initiated");
};

console.log("🔍 Socket diagnostics loaded. Use:");
console.log("  debugAimingSockets() - detailed diagnostics");  
console.log("  testRemoteShot() - simulate remote shot");