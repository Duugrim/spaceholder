// Быстрая проверка исправления рикошетов
// Запустите в консоли Foundry после исправления

console.log('🔧 Testing Ricochet Fix...');

if (!game.spaceholder?.aimingSystem) {
    console.error('❌ AimingSystem not found!');
} else {
    console.log('✅ AimingSystem found');
    
    // Проверяем методы
    const aimingSystem = game.spaceholder.aimingSystem;
    const hasRicochetMethods = 
        typeof aimingSystem._canRicochet === 'function' &&
        typeof aimingSystem._calculateRicochetDirection === 'function';
    
    console.log(`🎯 Ricochet methods: ${hasRicochetMethods ? '✅' : '❌'}`);
    
    // Проверяем токен
    const token = canvas.tokens.controlled[0];
    if (token) {
        console.log(`🎮 Token ready: ${token.name}`);
        console.log('📋 Instructions:');
        console.log('1. Make sure you have walls on the scene');
        console.log('2. Run: game.spaceholder.aimingSystem.startAiming(canvas.tokens.controlled[0])');
        console.log('3. Aim at a wall and click to fire');
        console.log('4. Check console for ricochet logs with offset calculations');
        console.log('5. Ricochets should now work properly without getting stuck');
    } else {
        console.warn('⚠️ Select a token first');
    }
}

console.log('✅ Fix verification complete!');