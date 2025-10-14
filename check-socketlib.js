// Проверка наличия socketlib и альтернативных методов работы с сокетами

console.log("🔍 Checking socket options...");

console.log("=== SOCKET LIBRARY CHECK ===");
console.log("socketlib available:", typeof socketlib !== 'undefined');
console.log("socketlib.registerModule:", typeof socketlib?.registerModule);

if (typeof socketlib !== 'undefined') {
  console.log("✅ SocketLib is available! We should use it.");
  
  // Тест с socketlib
  console.log("📦 Testing socketlib registration...");
  try {
    const testSocket = socketlib.registerModule("spaceholder");
    console.log("✅ SocketLib registration successful:", testSocket);
    
    // Регистрируем тестовую функцию
    testSocket.register("testFunction", function(message) {
      console.log("📨 SocketLib message received:", message);
      return "Response: " + message;
    });
    
    window.testSocketLib = function() {
      console.log("🧪 Testing socketlib call...");
      testSocket.executeForEveryone("testFunction", "Hello from socketlib!");
    };
    
    console.log("✅ SocketLib test function registered. Use testSocketLib() to test.");
    
  } catch (error) {
    console.error("❌ SocketLib registration failed:", error);
  }
  
} else {
  console.log("❌ SocketLib not available");
}

console.log("\n=== NATIVE SOCKET CHECK ===");
console.log("game.socket available:", !!game.socket);
console.log("game.socket.connected:", game.socket?.connected);

if (game.socket) {
  console.log("📡 Testing native socket approach...");
  
  // Альтернативный подход - через встроенные сокеты с правильным API
  const testChannel = 'test-native-socket';
  
  game.socket.on(testChannel, (data) => {
    console.log("📨 Native socket message received:", data);
  });
  
  window.testNativeSocket = function() {
    console.log("🧪 Testing native socket...");
    
    // Попробуем разные варианты API
    console.log("Method 1: Basic emit");
    game.socket.emit(testChannel, {test: "method1", user: game.user.name});
    
    // Иногда нужно указывать конкретных получателей
    console.log("Method 2: Emit to all");
    game.socket.emit(testChannel, {test: "method2", user: game.user.name}, () => {
      console.log("Emit callback called");
    });
    
    // Возможно нужен другой формат
    console.log("Method 3: Broadcast style");
    if (game.socket.broadcast) {
      game.socket.broadcast(testChannel, {test: "method3", user: game.user.name});
    }
  };
  
  console.log("✅ Native socket test registered. Use testNativeSocket() to test.");
}

console.log("\n=== SYSTEM INFO ===");
console.log("System ID:", game.system.id);
console.log("System title:", game.system.title);
console.log("System socket enabled:", game.system.data?.socket);
console.log("User ID:", game.user.id);
console.log("User name:", game.user.name);
console.log("Is GM:", game.user.isGM);

console.log("\n🎯 Recommendation:");
if (typeof socketlib !== 'undefined') {
  console.log("✅ Use SocketLib - it's the standard way for Foundry modules/systems");
} else {
  console.log("📦 Install SocketLib module from Foundry VTT package manager");
  console.log("   OR try different native socket approaches");
}