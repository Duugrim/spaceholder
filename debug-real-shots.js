// Отладочный мониторинг реальных выстрелов
// Проверяет, что происходит при реальной стрельбе

console.log("🎯 Debug monitor for real shots loaded...");

// Глобальная переменная для отслеживания
window.shotDebugMonitor = {
  monitoring: false,
  receivedMessages: [],
  
  start() {
    if (this.monitoring) {
      console.log("📡 Shot monitoring already active");
      return;
    }
    
    console.log("🔴 Starting shot monitoring...");
    this.monitoring = true;
    this.receivedMessages = [];
    
    // Подписываемся на socket events нашей системы
    const socketName = 'spaceholder.aiming';
    
    this.handler = (data, senderId) => {
      console.log(`🎯 REAL SHOT EVENT RECEIVED:`, {
        type: data.type,
        senderId: senderId,
        currentUser: game.user.id,
        isOwnMessage: senderId === game.user.id,
        data: data
      });
      
      this.receivedMessages.push({
        timestamp: Date.now(),
        type: data.type,
        senderId,
        data
      });
      
      // Специальная обработка для отладки
      if (data.type === 'aimingSystem.fireShot') {
        console.log('🔥 FIRE SHOT EVENT DETAILS:');
        console.log('  - Token ID:', data.data?.tokenId);
        console.log('  - Direction:', data.data?.direction);
        console.log('  - Weapon:', data.data?.weaponName);
        console.log('  - Is own message:', senderId === game.user.id);
        
        // Проверяем, найдется ли токен
        const token = canvas.tokens.get(data.data?.tokenId);
        console.log('  - Token found:', !!token, token?.name);
        
        if (token && senderId !== game.user.id) {
          console.log('🌐 This should trigger remote visualization!');
          console.log('  - AimingSystem available:', !!game.spaceholder?.aimingSystem);
          console.log('  - RayRenderer available:', !!game.spaceholder?.aimingSystem?.rayRenderer);
          console.log('  - visualizeRemoteShot available:', typeof game.spaceholder?.aimingSystem?.rayRenderer?.visualizeRemoteShot);
        }
      }
    };
    
    game.socket.on(socketName, this.handler);
    console.log("✅ Shot monitoring active. Perform a shot to see debug info.");
  },
  
  stop() {
    if (!this.monitoring) return;
    
    console.log("🔴 Stopping shot monitoring...");
    this.monitoring = false;
    
    const socketName = 'spaceholder.aiming';
    game.socket.off(socketName, this.handler);
    
    console.log(`📊 Total messages received: ${this.receivedMessages.length}`);
    this.receivedMessages.forEach((msg, i) => {
      console.log(`  ${i+1}. ${msg.type} from ${msg.senderId} at ${new Date(msg.timestamp).toLocaleTimeString()}`);
    });
  },
  
  status() {
    console.log("📡 Shot Monitor Status:");
    console.log("  - Monitoring:", this.monitoring);
    console.log("  - Messages received:", this.receivedMessages.length);
    console.log("  - Socket available:", !!game.socket);
    console.log("  - AimingSystem available:", !!game.spaceholder?.aimingSystem);
    console.log("  - Current user:", game.user.name, game.user.id);
  }
};

// Также добавим перехватчик для методов SocketManager
if (game.spaceholder?.aimingSystem?.socketManager) {
  const originalBroadcastFireShot = game.spaceholder.aimingSystem.socketManager.broadcastFireShot;
  
  game.spaceholder.aimingSystem.socketManager.broadcastFireShot = function(shotData) {
    console.log("🚀 INTERCEPTED broadcastFireShot call:", shotData);
    console.log("  - Current user:", game.user.id, game.user.name);
    console.log("  - Socket name:", this.socketName);
    
    // Вызываем оригинальный метод
    return originalBroadcastFireShot.call(this, shotData);
  };
  
  console.log("✅ SocketManager methods intercepted for debugging");
}

console.log("🎯 Shot debug monitor loaded. Commands:");
console.log("  shotDebugMonitor.start() - start monitoring");
console.log("  shotDebugMonitor.stop() - stop monitoring");  
console.log("  shotDebugMonitor.status() - check status");