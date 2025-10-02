// Диагностика проблем с анатомией
// Выполнить в консоли FoundryVTT

function debugAnatomySystem() {
  console.log("=== ДИАГНОСТИКА АНАТОМИИ ===");
  
  const manager = game.spaceholder?.anatomyManager;
  if (!manager) {
    console.error("❌ AnatomyManager не найден");
    return;
  }
  
  console.log("✅ AnatomyManager найден");
  
  // Проверяем доступные анатомии
  const available = manager.getAvailableAnatomies();
  console.log("🔍 Доступные анатомии:", Object.keys(available));
  
  // Проверяем актёра
  const actor = canvas.tokens.controlled[0]?.actor || game.actors.contents[0];
  if (!actor || actor.type !== 'character') {
    console.error("❌ Нет актёра-персонажа для тестирования");
    return;
  }
  
  console.log(`🎭 Актёр: ${actor.name}`);
  console.log(`📍 Текущий тип анатомии: ${actor.system.anatomy?.type || 'не определён'}`);
  
  const bodyParts = actor.system.anatomy?.bodyParts;
  if (bodyParts) {
    console.log(`🦴 Частей тела: ${Object.keys(bodyParts).length}`);
    console.log("📋 Список частей тела:");
    for (let [id, part] of Object.entries(bodyParts)) {
      console.log(`  - ${part.name} (${id}): ${part.currentHp}/${part.maxHp} HP`);
    }
  } else {
    console.warn("⚠️ Части тела не найдены");
  }
  
  // Тестируем смену анатомии
  console.log("🔄 Тестируем смену анатомии...");
  const currentType = actor.system.anatomy?.type || 'humanoid';
  const newType = currentType === 'humanoid' ? 'quadruped' : 'humanoid';
  
  console.log(`🔄 Меняем ${currentType} -> ${newType}`);
  
  actor.changeAnatomyType(newType).then(success => {
    if (success) {
      console.log("✅ Смена анатомии выполнена");
      setTimeout(() => {
        const newBodyParts = actor.system.anatomy?.bodyParts;
        console.log(`🦴 Новое количество частей тела: ${Object.keys(newBodyParts || {}).length}`);
        console.log("📋 Новый список частей тела:");
        for (let [id, part] of Object.entries(newBodyParts || {})) {
          console.log(`  - ${part.name} (${id}): ${part.currentHp}/${part.maxHp} HP`);
        }
        
        // Возвращаем обратно
        actor.changeAnatomyType(currentType).then(() => {
          console.log("🔄 Вернули обратно к " + currentType);
        });
      }, 500);
    } else {
      console.error("❌ Ошибка смены анатомии");
    }
  });
}

debugAnatomySystem();