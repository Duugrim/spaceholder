// Глубокий анализ хранения анатомии актёра
// Запустить в консоли FoundryVTT

function deepAnatomyAnalysis() {
  console.log("=== ГЛУБОКИЙ АНАЛИЗ ХРАНЕНИЯ АНАТОМИИ ===");
  
  const actor = canvas.tokens.controlled[0]?.actor || game.actors.contents[0];
  if (!actor || actor.type !== 'character') {
    console.error("❌ Нет актёра для анализа");
    return;
  }
  
  console.log(`🎭 Актёр: ${actor.name} (${actor.id})`);
  
  // 1. Анализируем все возможные места хранения
  console.log("\n=== 1. ПОЛНЫЙ АНАЛИЗ ДАННЫХ АКТЁРА ===");
  
  console.log("🔍 actor.system:");
  console.log(actor.system);
  
  console.log("\n🔍 actor._source.system:");
  console.log(actor._source.system);
  
  console.log("\n🔍 actor.data?.system (если есть):");
  console.log(actor.data?.system || "НЕТ");
  
  // 2. Ищем части тела везде
  console.log("\n=== 2. ПОИСК ЧАСТЕЙ ТЕЛА ===");
  
  const locations = [
    { name: "system.anatomy.bodyParts", data: actor.system.anatomy?.bodyParts },
    { name: "system.health.bodyParts", data: actor.system.health?.bodyParts },
    { name: "_source.system.anatomy.bodyParts", data: actor._source.system.anatomy?.bodyParts },
    { name: "_source.system.health.bodyParts", data: actor._source.system.health?.bodyParts },
    { name: "data.system.anatomy.bodyParts", data: actor.data?.system?.anatomy?.bodyParts },
    { name: "data.system.health.bodyParts", data: actor.data?.system?.health?.bodyParts }
  ];
  
  locations.forEach(location => {
    if (location.data) {
      console.log(`📍 ${location.name}: ${Object.keys(location.data).length} частей`);
      Object.keys(location.data).forEach(id => {
        console.log(`  - ${id}: ${location.data[id].name}`);
      });
    } else {
      console.log(`❌ ${location.name}: НЕТ ДАННЫХ`);
    }
    console.log("");
  });
  
  // 3. Проверяем флаги и другие возможные места
  console.log("\n=== 3. ДОПОЛНИТЕЛЬНЫЕ МЕСТА ХРАНЕНИЯ ===");
  console.log("🔍 actor.flags:", actor.flags);
  console.log("🔍 actor.system (полностью):");
  
  // Рекурсивно ищем bodyParts
  function findBodyParts(obj, path = "") {
    const found = [];
    
    if (obj && typeof obj === 'object') {
      for (let [key, value] of Object.entries(obj)) {
        const currentPath = path ? `${path}.${key}` : key;
        
        if (key === 'bodyParts' && value && typeof value === 'object') {
          found.push({
            path: currentPath,
            count: Object.keys(value).length,
            data: value
          });
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          found.push(...findBodyParts(value, currentPath));
        }
      }
    }
    
    return found;
  }
  
  const allBodyParts = findBodyParts(actor.system);
  console.log(`🔍 Найдено ${allBodyParts.length} местоположений bodyParts:`);
  allBodyParts.forEach(location => {
    console.log(`  📍 ${location.path}: ${location.count} частей`);
  });
  
  // 4. Проверяем что показывает наш код
  console.log("\n=== 4. ЧТО ВИДИТ НАШ КОД ===");
  
  const bodyPartsUsedByCode = actor.system.anatomy?.bodyParts || actor.system.health?.bodyParts;
  if (bodyPartsUsedByCode) {
    console.log(`🎯 Наш код видит: ${Object.keys(bodyPartsUsedByCode).length} частей`);
    console.log("📋 Список:");
    Object.keys(bodyPartsUsedByCode).forEach(id => {
      console.log(`  - ${id}: ${bodyPartsUsedByCode[id].name}`);
    });
  } else {
    console.log("❌ Наш код не видит частей тела");
  }
}

// Функция для проверки того, что происходит при update()
function testUpdateBehavior() {
  console.log("\n=== ТЕСТ ПОВЕДЕНИЯ UPDATE ===");
  
  const actor = canvas.tokens.controlled[0]?.actor || game.actors.contents[0];
  if (!actor || actor.type !== 'character') {
    console.error("❌ Нет актёра для тестирования");
    return;
  }
  
  console.log("📊 ДО update:");
  console.log("  - anatomy.bodyParts:", Object.keys(actor.system.anatomy?.bodyParts || {}).length);
  console.log("  - health.bodyParts:", Object.keys(actor.system.health?.bodyParts || {}).length);
  
  // Попробуем разные способы очистки
  const clearMethods = [
    {
      name: "Способ 1: Очистка через null",
      updateData: {
        'system.anatomy.bodyParts': null,
        'system.health.bodyParts': null
      }
    },
    {
      name: "Способ 2: Очистка через {}",
      updateData: {
        'system.anatomy.bodyParts': {},
        'system.health.bodyParts': {}
      }
    },
    {
      name: "Способ 3: Очистка через -=",
      updateData: {
        'system.anatomy.-=bodyParts': null,
        'system.health.-=bodyParts': null
      }
    }
  ];
  
  let currentMethod = 0;
  
  function testNextMethod() {
    if (currentMethod >= clearMethods.length) {
      console.log("✅ Все методы протестированы");
      return;
    }
    
    const method = clearMethods[currentMethod];
    console.log(`\n🧪 ${method.name}`);
    
    actor.update(method.updateData).then(() => {
      setTimeout(() => {
        console.log("📊 ПОСЛЕ update:");
        console.log("  - anatomy.bodyParts:", Object.keys(actor.system.anatomy?.bodyParts || {}).length);
        console.log("  - health.bodyParts:", Object.keys(actor.system.health?.bodyParts || {}).length);
        console.log("  - _source anatomy.bodyParts:", Object.keys(actor._source.system.anatomy?.bodyParts || {}).length);
        console.log("  - _source health.bodyParts:", Object.keys(actor._source.system.health?.bodyParts || {}).length);
        
        currentMethod++;
        setTimeout(testNextMethod, 1000);
      }, 500);
    }).catch(err => {
      console.error(`❌ Ошибка в ${method.name}:`, err);
      currentMethod++;
      setTimeout(testNextMethod, 1000);
    });
  }
  
  testNextMethod();
}

// Функция для проверки истории изменений актёра
function checkActorHistory() {
  console.log("\n=== ИСТОРИЯ АКТЁРА ===");
  
  const actor = canvas.tokens.controlled[0]?.actor || game.actors.contents[0];
  if (!actor) return;
  
  console.log("🕒 actor.constructor.name:", actor.constructor.name);
  console.log("🕒 actor.documentName:", actor.documentName);
  console.log("🕒 actor.id:", actor.id);
  console.log("🕒 actor.uuid:", actor.uuid);
  
  // Проверяем все свойства актёра
  console.log("\n🔍 Все свойства актёра:");
  const allProps = Object.getOwnPropertyNames(actor);
  allProps.forEach(prop => {
    if (prop.includes('body') || prop.includes('anatomy') || prop.includes('health')) {
      console.log(`  - ${prop}:`, actor[prop]);
    }
  });
}

// Запускаем анализ
deepAnatomyAnalysis();

// Экспортируем функции
window.deepAnatomyAnalysis = deepAnatomyAnalysis;
window.testUpdateBehavior = testUpdateBehavior;
window.checkActorHistory = checkActorHistory;

console.log("\n🛠️ Доступны функции:");
console.log("  - testUpdateBehavior() - тест разных способов очистки");
console.log("  - checkActorHistory() - анализ истории актёра");