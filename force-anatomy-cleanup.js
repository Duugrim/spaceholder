// Принудительная очистка анатомии актера
// Скопируйте и вставьте в консоль браузера

(async function() {
    const actor = canvas.tokens.controlled[0]?.actor || game.user.character;
    
    if (!actor) {
        console.error("Выберите персонажа!");
        return;
    }
    
    console.log(`Очистка анатомии для: ${actor.name}`);
    
    const anatomyType = actor.system.anatomy?.type || 'humanoid';
    console.log(`Текущий тип анатомии: ${anatomyType}`);
    
    // Полная очистка всех данных
    await actor.update({
        'system.anatomy.bodyParts': {},
        'system.health.bodyParts': {},
        'system.health.totalHealth': { current: 0, max: 0, percentage: 100 },
        '_source.system.anatomy.bodyParts': {},
        '_source.system.health.bodyParts': {}
    });
    
    console.log("Данные очищены, загружаем новую анатомию...");
    
    // Небольшая задержка
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Загружаем свежую анатомию
    const anatomy = await anatomyManager.createActorAnatomy(anatomyType);
    
    // Считаем общее здоровье
    let totalCurrent = 0;
    let totalMax = 0;
    for (let part of Object.values(anatomy.bodyParts)) {
        totalCurrent += part.currentHp;
        totalMax += part.maxHp;
    }
    
    // Устанавливаем новые данные
    await actor.update({
        'system.anatomy.bodyParts': anatomy.bodyParts,
        'system.health.bodyParts': anatomy.bodyParts,
        'system.health.totalHealth': {
            current: totalCurrent,
            max: totalMax,
            percentage: Math.floor((totalCurrent / totalMax) * 100)
        }
    });
    
    console.log(`Анатомия восстановлена: ${Object.keys(anatomy.bodyParts).length} частей`);
    console.log(`Общее здоровье: ${totalCurrent}/${totalMax}`);
    
    // Принудительная перерисовка листа персонажа
    if (actor.sheet?.rendered) {
        actor.sheet.render(true);
    }
    
    console.log("✅ Очистка завершена!");
})();