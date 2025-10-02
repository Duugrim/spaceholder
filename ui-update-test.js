// Тест обновления UI после нанесения урона
// Скопируйте и выполните в консоли браузера

(function() {
    const actor = canvas.tokens.controlled[0]?.actor || game.user.character;
    
    if (!actor) {
        console.error("Выберите персонажа!");
        return;
    }
    
    console.log(`Тестируем обновление UI для: ${actor.name}`);
    
    window.testUI = async (damage = 5) => {
        console.log(`\n=== ТЕСТ ОБНОВЛЕНИЯ UI (урон: ${damage}) ===`);
        
        // Показываем состояние ДО
        const beforeHP = actor.system.health.totalHealth;
        console.log(`ДО: ${beforeHP.current}/${beforeHP.max} (${beforeHP.percentage}%)`);
        
        // Наносим урон
        const result = await actor.performHit(damage);
        console.log(`Попадание в ${result.targetPart} на ${damage} урона`);
        
        // Небольшая задержка для завершения обновления
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Показываем состояние ПОСЛЕ
        const afterHP = actor.system.health.totalHealth;
        console.log(`ПОСЛЕ: ${afterHP.current}/${afterHP.max} (${afterHP.percentage}%)`);
        
        // Принудительная полная перерисовка листа
        console.log("Принудительно перерисовываем лист...");
        if (actor.sheet?.rendered) {
            actor.sheet.render(true);
        }
        
        // Еще одна небольшая задержка
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Финальная проверка
        const finalHP = actor.system.health.totalHealth;
        console.log(`ФИНАЛЬНОЕ СОСТОЯНИЕ: ${finalHP.current}/${finalHP.max} (${finalHP.percentage}%)`);
        
        console.log("✅ Проверьте лист персонажа - должны появиться изменения!");
    };
    
    console.log("Команда: testUI(10) - тест с уроном 10");
    
})();