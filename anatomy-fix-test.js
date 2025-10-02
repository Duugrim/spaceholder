// Улучшенный диагностический скрипт для тестирования исправлений системы анатомии
// Запуск в консоли браузера: copy(script); затем вставить в консоль

(function() {
    console.log("=== ANATOMY FIX TEST ===");
    
    // Находим выбранного актера
    const selectedTokens = canvas.tokens.controlled;
    const actor = selectedTokens.length > 0 ? selectedTokens[0].actor : game.user.character;
    
    if (!actor) {
        console.error("Не найден выбранный актер!");
        return;
    }
    
    console.log(`Тестируем актера: ${actor.name}`);
    
    // Функция полной диагностики
    function fullDiagnosis() {
        console.log("\n--- ПОЛНАЯ ДИАГНОСТИКА ---");
        
        const anatomyType = actor.system.anatomy?.type;
        const systemParts = actor.system.anatomy?.bodyParts;
        const healthParts = actor.system.health?.bodyParts;
        const sourceParts = actor._source?.system?.anatomy?.bodyParts;
        const sourceHealthParts = actor._source?.system?.health?.bodyParts;
        
        console.log("Тип анатомии:", anatomyType);
        console.log("system.anatomy.bodyParts:", systemParts ? Object.keys(systemParts).length : 0, "частей");
        console.log("system.health.bodyParts:", healthParts ? Object.keys(healthParts).length : 0, "частей");
        console.log("_source.system.anatomy.bodyParts:", sourceParts ? Object.keys(sourceParts).length : 0, "частей");
        console.log("_source.system.health.bodyParts:", sourceHealthParts ? Object.keys(sourceHealthParts).length : 0, "частей");
        
        if (systemParts) {
            console.log("Список частей в system.anatomy.bodyParts:", Object.keys(systemParts));
        }
        
        if (healthParts && systemParts !== healthParts) {
            console.log("Список частей в system.health.bodyParts:", Object.keys(healthParts));
        }
    }
    
    // Функция тестирования смены анатомии
    async function testAnatomyChange(newType) {
        console.log(`\n--- ТЕСТ СМЕНЫ АНАТОМИИ НА '${newType}' ---`);
        
        console.log("Состояние ПЕРЕД сменой:");
        fullDiagnosis();
        
        try {
            const success = await actor.changeAnatomyType(newType);
            console.log("Результат смены анатомии:", success);
            
            // Небольшая задержка для завершения всех обновлений
            await new Promise(resolve => setTimeout(resolve, 200));
            
            console.log("Состояние ПОСЛЕ смены:");
            fullDiagnosis();
            
            // Проверяем, что все очистилось правильно
            const finalSystemParts = actor.system.anatomy?.bodyParts;
            const finalHealthParts = actor.system.health?.bodyParts;
            
            if (finalSystemParts && finalHealthParts) {
                const systemCount = Object.keys(finalSystemParts).length;
                const healthCount = Object.keys(finalHealthParts).length;
                
                if (systemCount === healthCount) {
                    console.log("✅ УСПЕХ: Количество частей в system и health совпадают");
                } else {
                    console.log("❌ ОШИБКА: Количество частей не совпадает!");
                }
                
                // Проверяем на ожидаемое количество частей для каждого типа
                const expectedCounts = {
                    'humanoid': 15,
                    'quadruped': 17
                };
                
                const expected = expectedCounts[newType];
                if (expected && systemCount === expected) {
                    console.log(`✅ УСПЕХ: Правильное количество частей для ${newType}: ${systemCount}`);
                } else if (expected) {
                    console.log(`❌ ОШИБКА: Неправильное количество частей для ${newType}. Ожидается: ${expected}, получено: ${systemCount}`);
                }
            }
            
            return success;
        } catch (error) {
            console.error("Ошибка при тестировании смены анатомии:", error);
            return false;
        }
    }
    
    // Начальная диагностика
    fullDiagnosis();
    
    // Глобальные функции для ручного тестирования
    window.anatomyTest = {
        diagnose: fullDiagnosis,
        changeToHumanoid: () => testAnatomyChange('humanoid'),
        changeToQuadruped: () => testAnatomyChange('quadruped'),
        testComplete: async () => {
            console.log("\n=== ПОЛНОЕ ТЕСТИРОВАНИЕ ===");
            
            // Тестируем смену на humanoid
            await testAnatomyChange('humanoid');
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Тестируем смену на quadruped
            await testAnatomyChange('quadruped');
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Обратно на humanoid
            await testAnatomyChange('humanoid');
            
            console.log("\n=== ТЕСТИРОВАНИЕ ЗАВЕРШЕНО ===");
        }
    };
    
    console.log("\nДоступные команды:");
    console.log("anatomyTest.diagnose() - диагностика текущего состояния");
    console.log("anatomyTest.changeToHumanoid() - смена на humanoid");
    console.log("anatomyTest.changeToQuadruped() - смена на quadruped"); 
    console.log("anatomyTest.testComplete() - полное тестирование всех смен");
    
})();