// Диагностика изменений здоровья
// Скопируйте и вставьте в консоль браузера

(function() {
    const actor = canvas.tokens.controlled[0]?.actor || game.user.character;
    
    if (!actor) {
        console.error("Выберите персонажа!");
        return;
    }
    
    function showDetailedHealth() {
        console.log("\n=== ДЕТАЛЬНАЯ ДИАГНОСТИКА ЗДОРОВЬЯ ===");
        
        const totalHealth = actor.system.health?.totalHealth;
        const anatomyParts = actor.system.anatomy?.bodyParts;
        const healthParts = actor.system.health?.bodyParts;
        
        console.log("Общее здоровье:", totalHealth);
        
        if (anatomyParts) {
            console.log("\nЧасти тела (anatomy):");
            for (let [id, part] of Object.entries(anatomyParts)) {
                console.log(`  ${id}: ${part.currentHp}/${part.maxHp} (${part.name})`);
            }
        }
        
        if (healthParts && healthParts !== anatomyParts) {
            console.log("\nЧасти тела (health):");
            for (let [id, part] of Object.entries(healthParts)) {
                console.log(`  ${id}: ${part.currentHp}/${part.maxHp} (${part.name})`);
            }
        }
        
        // Проверяем данные в _source
        const sourceAnatomy = actor._source?.system?.anatomy?.bodyParts;
        const sourceHealth = actor._source?.system?.health?.bodyParts;
        
        if (sourceAnatomy) {
            console.log(`\n_source anatomy частей: ${Object.keys(sourceAnatomy).length}`);
        }
        if (sourceHealth) {
            console.log(`_source health частей: ${Object.keys(sourceHealth).length}`);
        }
    }
    
    // Функция теста урона с подробной диагностикой
    window.testHit = async (damage = 5) => {
        console.log(`\n--- ТЕСТ УРОНА: ${damage} ---`);
        
        console.log("ДО удара:");
        showDetailedHealth();
        
        const result = await actor.performHit(damage);
        console.log(`\nУдар: ${result.targetPart} получил ${damage} урона`);
        
        // Небольшая задержка для завершения обновления
        await new Promise(resolve => setTimeout(resolve, 100));
        
        console.log("ПОСЛЕ удара:");
        showDetailedHealth();
        
        // Принудительная перерисовка
        if (actor.sheet?.rendered) {
            console.log("Принудительно обновляем лист персонажа...");
            actor.sheet.render(true);
        }
    };
    
    // Показываем текущее состояние
    showDetailedHealth();
    
    console.log("\nДоступные команды:");
    console.log("testHit(10) - тест удара с диагностикой");
    
})();