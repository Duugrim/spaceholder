// Базовый тест сокетов между клиентами
// Проверяет, работают ли сокеты вообще между двумя браузерами

console.log("🔄 Basic socket connectivity test...");

window.basicSocketTest = {
  testChannel: 'system.spaceholder.basic-test',
  
  // Запустить на первом клиенте (отправитель)
  startSender() {
    console.log("📤 Starting sender mode...");
    
    let counter = 0;
    
    this.senderInterval = setInterval(() => {
      counter++;
      const message = {
        type: 'PING',
        counter: counter,
        timestamp: Date.now(),
        sender: game.user.name,
        senderId: game.user.id
      };
      
      console.log(`📤 Sending message #${counter}:`, message);
      game.socket.emit(this.testChannel, message);
      
      if (counter >= 5) {
        clearInterval(this.senderInterval);
        console.log("📤 Sender finished - sent 5 messages");
      }
    }, 2000);
  },
  
  // Запустить на втором клиенте (получатель)
  startReceiver() {
    console.log("📥 Starting receiver mode...");
    
    this.handler = (data, senderId) => {
      console.log(`📥 RECEIVED MESSAGE:`, {
        data,
        senderId,
        currentUser: game.user.id,
        isFromDifferentUser: senderId !== game.user.id
      });
      
      if (data.type === 'PING') {
        // Отправляем ответ
        const response = {
          type: 'PONG',
          originalCounter: data.counter,
          responder: game.user.name,
          timestamp: Date.now()
        };
        
        console.log("📥 Sending PONG response:", response);
        game.socket.emit(this.testChannel, response);
      }
      
      if (data.type === 'PONG') {
        console.log("📤 Received PONG response for message #" + data.originalCounter);
      }
    };
    
    game.socket.on(this.testChannel, this.handler);
    console.log("✅ Receiver listening for messages...");
  },
  
  stop() {
    console.log("🛑 Stopping basic socket test...");
    
    if (this.senderInterval) {
      clearInterval(this.senderInterval);
    }
    
    if (this.handler) {
      game.socket.off(this.testChannel, this.handler);
    }
    
    console.log("✅ Basic socket test stopped");
  }
};

console.log("🔄 Basic socket test loaded. Instructions:");
console.log("  On FIRST client: basicSocketTest.startSender()");
console.log("  On SECOND client: basicSocketTest.startReceiver()");
console.log("  To stop: basicSocketTest.stop()");
console.log("");
console.log("🎯 This will test if sockets work AT ALL between clients");

// Также проверим текущее состояние сокетов
console.log("🔍 Current socket status:");
console.log("  - game.socket exists:", !!game.socket);
console.log("  - Socket connected:", game.socket?.connected);
console.log("  - User ID:", game.user.id);
console.log("  - User name:", game.user.name);
console.log("  - Is GM:", game.user.isGM);