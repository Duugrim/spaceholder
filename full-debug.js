// Полная диагностика процесса обновления данных и UI
// Скопируйте и выполните в консоли браузера

(function() {
    const actor = canvas.tokens.controlled[0]?.actor || game.user.character;
    
    if (!actor) {
        console.error("Выберите персонажа!");
        return;
    }
    
    console.log(`=== ПОЛНАЯ ДИАГНОСТИКА для ${actor.name} ===`);
    
    function deepInspect() {
        console.log("\n--- ГЛУБОКАЯ ИНСПЕКЦИЯ ДАННЫХ ---");
        
        // Проверяем все возможные источники данных
        console.log("1. actor.system.health.totalHealth:", actor.system.health?.totalHealth);
        console.log("2. actor._source.system.health.totalHealth:", actor._source?.system?.health?.totalHealth);
        console.log("3. actor.data?.system?.health?.totalHealth:", actor.data?.system?.health?.totalHealth);
        
        // Проверяем части тела
        const anatomyParts = actor.system.anatomy?.bodyParts;
        const healthParts = actor.system.health?.bodyParts;
        
        if (anatomyParts) {
            console.log(`4. anatomy.bodyParts: ${Object.keys(anatomyParts).length} частей`);
            // Показываем первые 3 части
            let count = 0;
            for (let [id, part] of Object.entries(anatomyParts)) {
                if (count++ < 3) {
                    console.log(`   ${id}: ${part.currentHp}/${part.maxHp}`);
                }
            }
        }
        
        if (healthParts && healthParts !== anatomyParts) {
            console.log(`5. health.bodyParts: ${Object.keys(healthParts).length} частей`);
        }
        
        // Проверяем лист персонажа
        if (actor.sheet) {
            console.log("6. actor.sheet существует:", !!actor.sheet);
            console.log("7. actor.sheet.rendered:", actor.sheet.rendered);
            console.log("8. actor.sheet._state:", actor.sheet._state);
        }
    }
    
    // Функция для мониторинга изменений актера
    function monitorActorUpdates() {
        console.log("\n--- НАСТРОЙКА МОНИТОРИНГА ОБНОВЛЕНИЙ ---");
        
        // Слушаем событие обновления актера
        Hooks.once('updateActor', (document, data, options, userId) => {
            if (document.id === actor.id) {
                console.log("🔄 ОБНОВЛЕНИЕ АКТЕРА ОБНАРУЖЕНО:");
                console.log("  - document:", document.name);
                console.log("  - data:", data);
                console.log("  - options:", options);
                deepInspect();
            }
        });
        
        // Слушаем событие перерисовки листа
        Hooks.once('renderActorSheet', (app, html, data) => {
            if (app.actor.id === actor.id) {
                console.log("🎨 ПЕРЕРИСОВКА ЛИСТА ОБНАРУЖЕНА:");
                console.log("  - app:", app);
                console.log("  - data.system.health.totalHealth:", data.system?.health?.totalHealth);
                
                // Проверяем, что отображается в HTML
                const healthNumbers = html.find('.health-numbers');
                if (healthNumbers.length > 0) {
                    console.log("  - HTML .health-numbers найдено:", healthNumbers.length);
                    healthNumbers.each(function(i, elem) {
                        console.log(`    [${i}]: "${$(elem).text()}"`);
                    });
                } else {
                    console.log("  - HTML .health-numbers НЕ найдено!");
                }
            }
        });
        
        console.log("✅ Мониторинг настроен");
    }
    
    window.fullTest = async (damage = 5) => {
        console.log(`\n=== ПОЛНЫЙ ТЕСТ С МОНИТОРИНГОМ (урон: ${damage}) ===`);
        
        // Настраиваем мониторинг
        monitorActorUpdates();
        
        console.log("СОСТОЯНИЕ ДО:");
        deepInspect();
        
        // Наносим урон
        console.log("\n🔥 НАНЕСЕНИЕ УРОНА...");
        const result = await actor.performHit(damage);
        console.log(`Попадание в ${result.targetPart} на ${damage} урона`);
        
        // Ждем немного
        await new Promise(resolve => setTimeout(resolve, 300));
        
        console.log("\nСОСТОЯНИЕ ПОСЛЕ:");
        deepInspect();
        
        // Принудительная перерисовка
        console.log("\n🔄 ПРИНУДИТЕЛЬНАЯ ПЕРЕРИСОВКА...");
        if (actor.sheet?.rendered) {
            actor.sheet.render(true);
        }
        
        await new Promise(resolve => setTimeout(resolve, 300));
        
        console.log("\nФИНАЛЬНОЕ СОСТОЯНИЕ:");
        deepInspect();
    };
    
    // Функция для прямого тестирования обновления
    window.directUpdate = async (damage = 5) => {
        console.log(`\n=== ПРЯМОЕ ОБНОВЛЕНИЕ ДАННЫХ (урон: ${damage}) ===`);
        
        const bodyParts = actor.system.anatomy?.bodyParts;
        if (!bodyParts) {
            console.log("Нет частей тела!");
            return;
        }
        
        // Найдем любую часть тела для повреждения
        const partId = Object.keys(bodyParts)[0];
        const part = bodyParts[partId];
        
        console.log(`Прямое нанесение ${damage} урона в ${partId}`);
        console.log(`Было: ${part.currentHp}/${part.maxHp}`);
        
        const newHp = Math.max(0, part.currentHp - damage);
        
        // Прямое обновление через actor.update
        await actor.update({
            [`system.anatomy.bodyParts.${partId}.currentHp`]: newHp,
            [`system.health.bodyParts.${partId}.currentHp`]: newHp
        });
        
        console.log(`Стало: ${newHp}/${part.maxHp}`);
        
        // Принудительная перерисовка
        if (actor.sheet?.rendered) {
            actor.sheet.render(true);
        }
    };
    
    // Начальная инспекция
    deepInspect();
    
    console.log("\nДоступные команды:");
    console.log("fullTest(10) - полный тест с мониторингом");
    console.log("directUpdate(5) - прямое обновление данных");
    
})();