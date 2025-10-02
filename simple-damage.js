// Простой скрипт для нанесения урона
// Скопируйте и вставьте в консоль браузера

// Находим выбранного актера
const actor = canvas.tokens.controlled[0]?.actor || game.user.character;

if (!actor) {
    console.error("Выберите персонажа!");
} else {
    console.log(`Выбран актер: ${actor.name}`);
    
    // Простые функции
    window.hit = async (damage = 5) => {
        const result = await actor.performHit(damage);
        console.log(`Попадание в ${result.targetPart} на ${damage} урона`);
        
        // Принудительно обновляем лист персонажа
        if (actor.sheet?.rendered) {
            actor.sheet.render(false);
        }
        
        const hp = actor.system.health.totalHealth;
        console.log(`Здоровье: ${hp.current}/${hp.max} (${hp.percentage}%)`);
    };
    
    window.heal = async () => {
        const bodyParts = actor.system.health?.bodyParts;
        if (!bodyParts) return;
        const updates = {};
        for (let [id, part] of Object.entries(bodyParts)) {
            updates[`system.health.bodyParts.${id}.currentHp`] = part.maxHp;
        }
        await actor.update(updates);
        console.log("Персонаж исцелён!");
    };
    
    console.log("Команды:");
    console.log("hit(10) - нанести 10 урона");
    console.log("heal() - полное исцеление");
}