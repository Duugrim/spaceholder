// Диагностика данных анатомии у актёра
// Запустить в консоли FoundryVTT

function diagnoseActorAnatomy() {
  console.log("=== ДИАГНОСТИКА ДАННЫХ АНАТОМИИ АКТЁРА ===");
  
  const actor = canvas.tokens.controlled[0]?.actor || game.actors.contents[0];
  if (!actor || actor.type !== 'character') {
    console.error("❌ Нет актёра-персонажа для диагностики");
    return;
  }
  
  console.log(`🎭 Анализируем актёра: ${actor.name}`);
  console.log(`📄 ID актёра: ${actor.id}`);
  
  // 1. Проверяем прямые данные актёра
  console.log("\n=== 1. ПРЯМЫЕ ДАННЫЕ АКТЁРА ===");
  console.log("🔍 actor.system.anatomy:", actor.system.anatomy);
  console.log("🔍 actor.system.health:", actor.system.health);
  
  // 2. Проверяем source данные
  console.log("\n=== 2. SOURCE ДАННЫЕ ===");
  console.log("🔍 actor._source.system.anatomy:", actor._source.system.anatomy);
  console.log("🔍 actor._source.system.health:", actor._source.system.health);
  
  // 3. Проверяем что думает наша система
  console.log("\n=== 3. АНАЛИЗ ЧАСТЕЙ ТЕЛА ===");
  const anatomyBodyParts = actor.system.anatomy?.bodyParts;
  const healthBodyParts = actor.system.health?.bodyParts;
  
  if (anatomyBodyParts) {
    console.log(`🦴 Части тела в anatomy: ${Object.keys(anatomyBodyParts).length}`);
    console.log("📋 Список (anatomy):");
    for (let [id, part] of Object.entries(anatomyBodyParts)) {
      console.log(`  - ${part.name} (${id}): ${part.currentHp}/${part.maxHp} HP`);
    }
  } else {
    console.log("❌ Нет частей тела в anatomy.bodyParts");
  }
  
  if (healthBodyParts) {
    console.log(`🦴 Части тела в health: ${Object.keys(healthBodyParts).length}`);
    console.log("📋 Список (health):");
    for (let [id, part] of Object.entries(healthBodyParts)) {
      console.log(`  - ${part.name} (${id}): ${part.currentHp}/${part.maxHp} HP`);
    }
  } else {
    console.log("❌ Нет частей тела в health.bodyParts");
  }
  
  // 4. Проверяем что показывает лист актёра
  console.log("\n=== 4. ДАННЫЕ ЛИСТА АКТЁРА ===");
  const sheet = actor.sheet;
  if (sheet && sheet.getData) {
    sheet.getData().then(context => {
      console.log("📋 hierarchicalBodyParts в контексте листа:", context.hierarchicalBodyParts?.length || 0);
      if (context.hierarchicalBodyParts) {
        context.hierarchicalBodyParts.forEach(part => {
          console.log(`  - ${part.name}: ${part.currentHp}/${part.maxHp} HP`);
        });
      }
    }).catch(err => {
      console.error("❌ Ошибка получения данных листа:", err);
    });
  }
  
  // 5. Проверяем что думает _prepareHealthData
  console.log("\n=== 5. ТЕСТ _prepareHealthData ===");
  if (sheet && sheet._prepareHealthData) {
    const testContext = { system: actor.system };
    sheet._prepareHealthData(testContext);
    console.log("📋 Результат _prepareHealthData:");
    console.log("  - hierarchicalBodyParts:", testContext.hierarchicalBodyParts?.length || 0);
    console.log("  - injuredParts:", Object.keys(testContext.injuredParts || {}).length);
  }
  
  // 6. Тестируем что произойдёт при обновлении
  console.log("\n=== 6. ТЕСТ ОБНОВЛЕНИЯ ===");
  console.log("🔄 Проверим что происходит при принудительном обновлении...");
  
  // Вызываем prepareDerivedData
  actor.prepareDerivedData().then(() => {
    console.log("✅ prepareDerivedData выполнен");
    console.log("🔍 Состояние после prepareDerivedData:");
    console.log("  - anatomy.bodyParts:", Object.keys(actor.system.anatomy?.bodyParts || {}).length);
    console.log("  - health.bodyParts:", Object.keys(actor.system.health?.bodyParts || {}).length);
  }).catch(err => {
    console.error("❌ Ошибка prepareDerivedData:", err);
  });
}

// Дополнительная функция для тестирования очистки
function testClearAnatomy() {
  console.log("\n=== ТЕСТ ОЧИСТКИ АНАТОМИИ ===");
  
  const actor = canvas.tokens.controlled[0]?.actor || game.actors.contents[0];
  if (!actor || actor.type !== 'character') {
    console.error("❌ Нет актёра для тестирования");
    return;
  }
  
  console.log("🧹 Очищаем анатомию...");
  
  actor.update({
    'system.anatomy.type': null,
    'system.anatomy.bodyParts': {},
    'system.health.bodyParts': {},
    'system.health.totalHealth': { current: 0, max: 0, percentage: 100 }
  }).then(() => {
    console.log("✅ Очистка выполнена");
    setTimeout(() => {
      console.log("🔍 Состояние после очистки:");
      console.log("  - anatomy.type:", actor.system.anatomy?.type);
      console.log("  - anatomy.bodyParts:", Object.keys(actor.system.anatomy?.bodyParts || {}).length);
      console.log("  - health.bodyParts:", Object.keys(actor.system.health?.bodyParts || {}).length);
    }, 500);
  }).catch(err => {
    console.error("❌ Ошибка очистки:", err);
  });
}

// Функция для сравнения до и после смены анатомии
function testAnatomyChange() {
  console.log("\n=== ТЕСТ СМЕНЫ АНАТОМИИ ===");
  
  const actor = canvas.tokens.controlled[0]?.actor || game.actors.contents[0];
  if (!actor || actor.type !== 'character') {
    console.error("❌ Нет актёра для тестирования");
    return;
  }
  
  console.log("📊 СОСТОЯНИЕ ДО:");
  console.log("  - Тип:", actor.system.anatomy?.type);
  console.log("  - Части (anatomy):", Object.keys(actor.system.anatomy?.bodyParts || {}).length);
  console.log("  - Части (health):", Object.keys(actor.system.health?.bodyParts || {}).length);
  
  const currentType = actor.system.anatomy?.type;
  const newType = currentType === 'humanoid' ? 'quadruped' : 'humanoid';
  
  console.log(`🔄 Меняем анатомию: ${currentType || 'none'} → ${newType}`);
  
  // Используем метод из ActorSheet
  const sheet = actor.sheet;
  if (sheet && sheet._performAnatomyChange) {
    sheet._performAnatomyChange(newType).then(() => {
      setTimeout(() => {
        console.log("📊 СОСТОЯНИЕ ПОСЛЕ:");
        console.log("  - Тип:", actor.system.anatomy?.type);
        console.log("  - Части (anatomy):", Object.keys(actor.system.anatomy?.bodyParts || {}).length);
        console.log("  - Части (health):", Object.keys(actor.system.health?.bodyParts || {}).length);
        
        // Возвращаем обратно
        if (currentType) {
          setTimeout(() => {
            console.log("🔙 Возвращаем обратно...");
            sheet._performAnatomyChange(currentType);
          }, 1000);
        }
      }, 1000);
    });
  } else {
    console.error("❌ Метод _performAnatomyChange не найден");
  }
}

// Запускаем основную диагностику
diagnoseActorAnatomy();

// Экспортируем дополнительные функции для ручного тестирования
window.testClearAnatomy = testClearAnatomy;
window.testAnatomyChange = testAnatomyChange;
window.diagnoseActorAnatomy = diagnoseActorAnatomy;

console.log("\n🛠️ Доступны дополнительные функции:");
console.log("  - testClearAnatomy() - тест очистки анатомии");
console.log("  - testAnatomyChange() - тест смены анатомии");
console.log("  - diagnoseActorAnatomy() - повторная диагностика");