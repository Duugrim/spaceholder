// Скрипт для тестирования системы нанесения урона
// Запуск в консоли браузера: скопируйте код и выполните

(function() {
    console.log("=== DAMAGE TEST SCRIPT ===");
    
    // Находим выбранного актера
    const selectedTokens = canvas.tokens.controlled;
    const actor = selectedTokens.length > 0 ? selectedTokens[0].actor : game.user.character;
    
    if (!actor) {
        console.error("Не найден выбранный актер!");
        return;
    }
    
    console.log(`Тестируем урон для актера: ${actor.name}`);
    
    // Функция показа текущего здоровья
    function showHealth() {
        console.log("\n--- ТЕКУЩЕЕ ЗДОРОВЬЕ ---");
        const totalHealth = actor.system.health?.totalHealth;
        if (totalHealth) {
            console.log(`Общее здоровье: ${totalHealth.current}/${totalHealth.max} (${totalHealth.percentage}%)`);
        }
        
        const bodyParts = actor.system.health?.bodyParts;
        if (bodyParts) {
            console.log("Части тела:");
            for (let [partId, part] of Object.entries(bodyParts)) {
                const status = part.status || 'healthy';
                console.log(`  ${partId}: ${part.currentHp}/${part.maxHp} HP (${status})`);
            }
        }
    }
    
    // Функция нанесения урона по случайной части
    async function dealRandomDamage(damage = 5) {
        console.log(`\n--- НАНЕСЕНИЕ УРОНА: ${damage} ---`);
        showHealth();
        
        const result = await actor.performHit(damage);
        if (result) {
            console.log(`Попадание в ${result.targetPart} на ${result.damage} урона`);
            console.log("После урона:");
            showHealth();
        } else {
            console.log("Не удалось нанести урон");
        }
    }
    
    // Функция нанесения урона в конкретную часть
    async function dealTargetedDamage(partId, damage = 5) {
        console.log(`\n--- НАНЕСЕНИЕ УРОНА В ${partId.toUpperCase()}: ${damage} ---`);
        showHealth();
        
        const result = await actor.performHit(damage, partId);
        if (result) {
            console.log(`Попадание в ${result.targetPart} на ${result.damage} урона`);
            console.log("После урона:");
            showHealth();
        } else {
            console.log("Не удалось нанести урон");
        }
    }
    
    // Функция прямого нанесения урона в часть тела
    async function dealDirectDamage(partId, damage = 5) {
        console.log(`\n--- ПРЯМОЙ УРОН В ${partId.toUpperCase()}: ${damage} ---`);
        showHealth();
        
        const success = await actor.applyBodyPartDamage(partId, damage);
        if (success) {
            console.log(`Нанесён прямой урон ${damage} в ${partId}`);
            console.log("После урона:");
            showHealth();
        } else {
            console.log("Не удалось нанести урон");
        }
    }
    
    // Функция полного исцеления
    async function fullHeal() {
        console.log("\n--- ПОЛНОЕ ИСЦЕЛЕНИЕ ---");
        
        const bodyParts = actor.system.health?.bodyParts;
        if (!bodyParts) {
            console.log("Нет частей тела для исцеления");
            return;
        }
        
        const updates = {};
        for (let [partId, part] of Object.entries(bodyParts)) {
            const updatePath = actor.system.anatomy?.bodyParts 
                ? `system.anatomy.bodyParts.${partId}.currentHp`
                : `system.health.bodyParts.${partId}.currentHp`;
            updates[updatePath] = part.maxHp;
        }
        
        await actor.update(updates);
        console.log("Персонаж полностью исцелён!");
        showHealth();
    }
    
    // Список доступных частей тела
    function listBodyParts() {
        console.log("\n--- ДОСТУПНЫЕ ЧАСТИ ТЕЛА ---");
        const bodyParts = actor.system.health?.bodyParts;
        if (bodyParts) {
            for (let [partId, part] of Object.entries(bodyParts)) {
                console.log(`  ${partId}: ${part.name}`);
            }
        }
    }
    
    // Показываем начальное состояние
    showHealth();
    
    // Глобальные функции для удобства
    window.damageTest = {
        showHealth: showHealth,
        dealRandomDamage: dealRandomDamage,
        dealTargetedDamage: dealTargetedDamage,
        dealDirectDamage: dealDirectDamage,
        fullHeal: fullHeal,
        listBodyParts: listBodyParts,
        
        // Быстрые команды
        hit: (damage = 5) => dealRandomDamage(damage),
        hitTorso: (damage = 5) => dealTargetedDamage('torso', damage),
        hitHead: (damage = 5) => dealTargetedDamage('head', damage),
        hitLeftArm: (damage = 5) => dealTargetedDamage('left_arm', damage),
        hitRightArm: (damage = 5) => dealTargetedDamage('right_arm', damage),
        hitLeftLeg: (damage = 5) => dealTargetedDamage('left_leg', damage),
        hitRightLeg: (damage = 5) => dealTargetedDamage('right_leg', damage),
        heal: fullHeal
    };
    
    console.log("\n=== ДОСТУПНЫЕ КОМАНДЫ ===");
    console.log("damageTest.showHealth() - показать текущее здоровье");
    console.log("damageTest.hit(урон) - случайный удар");
    console.log("damageTest.hitTorso(урон) - удар в торс");
    console.log("damageTest.hitHead(урон) - удар в голову");
    console.log("damageTest.hitLeftArm(урон) - удар в левую руку");
    console.log("damageTest.hitRightArm(урон) - удар в правую руку");
    console.log("damageTest.hitLeftLeg(урон) - удар в левую ногу");
    console.log("damageTest.hitRightLeg(урон) - удар в правую ногу");
    console.log("damageTest.heal() - полное исцеление");
    console.log("damageTest.listBodyParts() - список частей тела");
    console.log("damageTest.dealDirectDamage('part_id', урон) - прямой урон в часть");
    console.log("damageTest.dealTargetedDamage('part_id', урон) - прицельный урон");
    
    console.log("\nПримеры использования:");
    console.log("damageTest.hit(10) - случайный удар на 10 урона");
    console.log("damageTest.hitTorso(15) - удар в торс на 15 урона");
    console.log("damageTest.dealDirectDamage('left_hand', 8) - прямой урон в левую руку");
    
})();